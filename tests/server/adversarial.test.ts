import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decision, DecisionRecord, ExtractionClaims, ExtractionResult, JevAnswers } from '../../src/shared/domain/types';
import { buildRecord } from '../../src/server/engine/record';
import {
  createInvoice,
  getDecisionHistory,
  getInvoice,
  getWorkspaceData,
  listInvoices,
  openDb,
  putBudget,
  putRules,
  putTreasury,
} from '../../src/server/db/db';
import { ensureWorkspace, resetWorkspace } from '../../src/server/db/workspace';
import { approveInvoice, decideInvoice, markStale, rejectInvoice, resolveFlag } from '../../src/server/db/decide';
import { ledgerView } from '../../src/server/db/ledger';

const goodJev: JevAnswers = {
  ok: true,
  answers: {
    instructs_agent: { type: 'noul', noul: 0 },
    artificial_urgency: { type: 'noul', noul: 0 },
    scope_match: { type: 'score', score: 0, probabilities: { '0': 1, '1': 0, '2': 0 }, confidence: 1 },
    document_type: { type: 'choice', choice: 'factura', probabilities: { factura: 1 }, confidence: 1 },
  },
  latencyMs: 0,
  recorded: true,
  inputTokens: 1,
};

const urgentJev: JevAnswers = {
  ...goodJev,
  answers: {
    ...goodJev.answers,
    artificial_urgency: { type: 'noul', noul: 0.5 },
  },
};

type VendorKey = 'nube' | 'norte' | 'datos';

const vendorClaims: Record<VendorKey, {
  payeeName: string; payeeTaxId: string; payoutAccount: string; amountRaw: string; description: string;
}> = {
  nube: {
    payeeName: 'NUBE ANDINA S.A.S.', payeeTaxId: '901.234.567-8', payoutAccount: 'Bancolombia ···· 8890',
    amountRaw: 'USD 850.00', description: 'Hosting administrado y respaldo de infraestructura',
  },
  norte: {
    payeeName: 'NORTE CLARO SOLUCIONES S.A.S.', payeeTaxId: '900.000.202-5', payoutAccount: 'Banco Andino ···· 2295',
    amountRaw: 'USD 950.00', description: 'Consultoría de seguridad de aplicaciones',
  },
  datos: {
    payeeName: 'Datos del Ávila C.A.', payeeTaxId: 'J-30987654-2', payoutAccount: 'Mercantil ···· 5206',
    amountRaw: 'USD 640.00', description: 'Restablecimiento urgente de enlace',
  },
};

function makeExtraction(
  invoiceId: string,
  vendor: VendorKey = 'nube',
  changes: Partial<ExtractionClaims> = {},
  sourceOverride?: string,
): ExtractionResult {
  const source = vendorClaims[vendor];
  const base: ExtractionClaims = {
    amountsFound: [source.amountRaw],
    accountsFound: [source.payoutAccount],
    taxIdsFound: [source.payeeTaxId],
    invoiceIdsFound: [invoiceId],
    currenciesFound: ['USD'],
    ...source,
    invoiceId,
    invoiceDate: '2026-10-16',
    dueDate: '2026-10-25',
    currency: 'USD',
    subtotalRaw: null,
    taxesRaw: null,
    quantity: null,
    rateRaw: null,
    documentTypeHint: 'factura',
    hasMultipleCurrenciesShown: false,
    evidenceQuotes: {
      amountRaw: source.amountRaw,
      payoutAccount: source.payoutAccount,
      payeeTaxId: source.payeeTaxId,
      invoiceId,
    },
    suspiciousPassages: [],
    ...changes,
  };
  const claims: ExtractionClaims = {
    ...base,
    amountsFound: changes.amountsFound ?? (base.amountRaw ? [base.amountRaw] : []),
    accountsFound: changes.accountsFound ?? (base.payoutAccount ? [base.payoutAccount] : []),
    taxIdsFound: changes.taxIdsFound ?? (base.payeeTaxId ? [base.payeeTaxId] : []),
    invoiceIdsFound: changes.invoiceIdsFound ?? (base.invoiceId ? [base.invoiceId] : []),
  };
  const sourceText = sourceOverride ?? [
    claims.payeeName,
    claims.payeeTaxId,
    claims.payoutAccount,
    claims.invoiceId,
    claims.amountRaw,
    ...(claims.amountsFound.length > 1 ? claims.amountsFound : []),
    claims.subtotalRaw,
    claims.taxesRaw,
  ].filter((value): value is string => Boolean(value)).join('\n');
  return { ok: true, claims, sourceText, sourceKind: 'text' };
}

function input(invoiceId: string, vendor: VendorKey = 'nube', changes: Partial<ExtractionClaims> = {}, jev = goodJev) {
  return { extraction: makeExtraction(invoiceId, vendor, changes), jev };
}

function queueAndDecide(
  db: ReturnType<typeof openDb>,
  workspaceId: string,
  invoiceId: string,
  vendor: VendorKey = 'nube',
  changes: Partial<ExtractionClaims> = {},
  jev = goodJev,
) {
  createInvoice(db, workspaceId, { id: invoiceId, sourceKind: 'text' });
  return decideInvoice(db, workspaceId, invoiceId, input(invoiceId, vendor, changes, jev));
}

describe('transactional safety and adversarial cases', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    if (db.open) db.close();
  });

  it('stops an in-batch exact duplicate after the original was committed', () => {
    const workspaceId = 'batch-duplicate';
    ensureWorkspace(db, workspaceId);
    const first = queueAndDecide(db, workspaceId, 'BATCH-001', 'nube', { invoiceId: 'AL-042' });
    const second = queueAndDecide(db, workspaceId, 'BATCH-002', 'nube', { invoiceId: 'al.042' });

    expect(first.decision.status).toBe('ready');
    expect(second.decision.status).toBe('stopped');
    expect(second.decision.checks.find((check) => check.id === 'R8')).toMatchObject({ passed: false, effect: 'stop' });
    expect(ledgerView(db, workspaceId).committedUsdMinor('2026-10')).toBe(270_000);
  });

  it('stops the second invoice when both fit the balance individually but not together', () => {
    const workspaceId = 'combined-balance';
    ensureWorkspace(db, workspaceId);
    const data = getWorkspaceData(db, workspaceId);
    putTreasury(db, workspaceId, { ...data.treasury, balanceUsdMinor: 350_000 });

    const first = queueAndDecide(db, workspaceId, 'BAL-NUBE');
    const second = queueAndDecide(db, workspaceId, 'BAL-NORTE', 'norte');
    expect(first.decision.status).toBe('ready');
    expect(second.decision.status).toBe('stopped');
    expect(second.decision.checks.find((check) => check.id === 'R14')).toMatchObject({ passed: false, effect: 'stop' });
  });

  it('rechecks approval after another invoice consumes available treasury balance', () => {
    const workspaceId = 'approval-balance';
    ensureWorkspace(db, workspaceId);
    putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 90_000 });
    const committed = queueAndDecide(db, workspaceId, 'COMMITTED-NUBE');
    const pending = queueAndDecide(db, workspaceId, 'PENDING-NORTE', 'norte');
    expect(committed.decision.status).toBe('ready');
    expect(pending.decision.status).toBe('approval_required');

    const data = getWorkspaceData(db, workspaceId);
    putTreasury(db, workspaceId, { ...data.treasury, balanceUsdMinor: 364_999 });
    const result = approveInvoice(db, workspaceId, 'PENDING-NORTE', {
      approver: 'Demo Reviewer', reason: 'Validar factura', idempotencyKey: 'approval-budget-1',
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.record.decision.status).toBe('stopped');
    expect(result.record.decision.checks.find((check) => check.id === 'R14')).toMatchObject({ passed: false, effect: 'stop' });
    expect(getInvoice(db, workspaceId, 'PENDING-NORTE')?.status).toBe('stopped');
    expect(ledgerView(db, workspaceId).reservedUsdMinor('2026-10')).toBe(0);
  });

  it('rechecks the cost-center budget after a competing commitment and budget reduction', () => {
    const workspaceId = 'approval-cost-center-budget';
    ensureWorkspace(db, workspaceId);
    putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 80_000 });

    const pending = queueAndDecide(db, workspaceId, 'PENDING-NUBE-BUDGET');
    expect(pending.decision.status).toBe('approval_required');
    expect(ledgerView(db, workspaceId).reservedByCostCenter('operaciones', '2026-10')).toBe(85_000);

    const competing = queueAndDecide(db, workspaceId, 'COMMITTED-DATOS-BUDGET', 'datos');
    expect(competing.decision.status).toBe('ready');
    expect(competing.decision.costCenter).toBe('operaciones');
    expect(ledgerView(db, workspaceId).committedByCostCenter('operaciones', '2026-10')).toBe(249_000);

    const originalBudget = getWorkspaceData(db, workspaceId).budgets.find((item) =>
      item.costCenter === 'operaciones' && item.month === '2026-10');
    expect(originalBudget).toBeDefined();
    putBudget(db, workspaceId, { ...originalBudget!, approvedUsdMinor: 333_999 });
    const historyBefore = getDecisionHistory(db, workspaceId, 'PENDING-NUBE-BUDGET');
    const originalRecordJson = db.prepare('SELECT record_json FROM decision_records WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, pending.id);

    const result = approveInvoice(db, workspaceId, 'PENDING-NUBE-BUDGET', {
      approver: 'Demo Reviewer', reason: 'Validar factura', idempotencyKey: 'cost-center-budget-1',
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.record.decision.status).toBe('stopped');
    expect(result.record.decision.checks.find((check) => check.id === 'R13')).toMatchObject({ passed: false, effect: 'stop' });
    expect(result.record.supersedes).toBe(pending.id);
    expect(getInvoice(db, workspaceId, 'PENDING-NUBE-BUDGET')?.status).toBe('stopped');
    expect(getDecisionHistory(db, workspaceId, 'PENDING-NUBE-BUDGET')).toHaveLength(2);
    expect(getDecisionHistory(db, workspaceId, 'PENDING-NUBE-BUDGET')[0]).toEqual(historyBefore[0]);
    expect(db.prepare('SELECT record_json FROM decision_records WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, pending.id)).toEqual(originalRecordJson);
    expect(ledgerView(db, workspaceId).reservedByCostCenter('operaciones', '2026-10')).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM commitments WHERE workspace_id = ? AND invoice_id = ?')
      .get(workspaceId, 'PENDING-NUBE-BUDGET')).toMatchObject({ count: 0 });
  });

  it('approves exactly once under repeated concurrent calls with the same key', async () => {
    const workspaceId = 'idempotent-approval';
    ensureWorkspace(db, workspaceId);
    putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 0 });
    const record = queueAndDecide(db, workspaceId, 'IDEMP-001');
    expect(record.decision.status).toBe('approval_required');
    const action = { approver: 'Demo Reviewer', reason: 'Validar factura', idempotencyKey: 'same-key' };

    const results = await Promise.all([
      Promise.resolve().then(() => approveInvoice(db, workspaceId, 'IDEMP-001', action)),
      Promise.resolve().then(() => approveInvoice(db, workspaceId, 'IDEMP-001', action)),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(getInvoice(db, workspaceId, 'IDEMP-001')?.status).toBe('approved');
    expect(db.prepare("SELECT COUNT(*) AS count FROM commitments WHERE workspace_id = ? AND invoice_id = ? AND state = 'committed'")
      .get(workspaceId, 'IDEMP-001')).toMatchObject({ count: 1 });
    expect(getDecisionHistory(db, workspaceId, 'IDEMP-001')).toHaveLength(2);
  });

  it('prevents a double-click with distinct idempotency keys from committing twice', async () => {
    const workspaceId = 'distinct-keys-approval';
    ensureWorkspace(db, workspaceId);
    putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 0 });
    const record = queueAndDecide(db, workspaceId, 'DISTINCT-KEYS-001');
    expect(record.decision.status).toBe('approval_required');

    const results = await Promise.all([
      Promise.resolve().then(() => approveInvoice(db, workspaceId, 'DISTINCT-KEYS-001', {
        approver: 'Demo Reviewer', reason: 'Validar factura', idempotencyKey: 'distinct-key-a',
      })),
      Promise.resolve().then(() => approveInvoice(db, workspaceId, 'DISTINCT-KEYS-001', {
        approver: 'Demo Reviewer', reason: 'Validar factura', idempotencyKey: 'distinct-key-b',
      })),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, status: 409 });
    expect(getInvoice(db, workspaceId, 'DISTINCT-KEYS-001')?.status).toBe('approved');
    expect(db.prepare("SELECT COUNT(*) AS count FROM commitments WHERE workspace_id = ? AND invoice_id = ? AND state = 'committed'")
      .get(workspaceId, 'DISTINCT-KEYS-001')).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM idempotency_keys WHERE workspace_id = ? AND invoice_id = ?')
      .get(workspaceId, 'DISTINCT-KEYS-001')).toMatchObject({ count: 1 });
    expect(getDecisionHistory(db, workspaceId, 'DISTINCT-KEYS-001')).toHaveLength(2);
  });

  it('rolls back the approval, commitment, record and idempotency key if audit insertion fails', () => {
    const workspaceId = 'audit-rollback';
    ensureWorkspace(db, workspaceId);
    putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 0 });
    queueAndDecide(db, workspaceId, 'AUDIT-001');
    const historyBefore = getDecisionHistory(db, workspaceId, 'AUDIT-001');
    db.exec("CREATE TRIGGER fail_approval_audit BEFORE INSERT ON audit_events WHEN NEW.event = 'approved' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;");

    expect(() => approveInvoice(db, workspaceId, 'AUDIT-001', {
      approver: 'Demo Reviewer', reason: 'Validar factura', idempotencyKey: 'rollback-key',
    })).toThrow(/test audit failure/);

    expect(getInvoice(db, workspaceId, 'AUDIT-001')?.status).toBe('approval_required');
    expect(getDecisionHistory(db, workspaceId, 'AUDIT-001')).toEqual(historyBefore);
    expect(ledgerView(db, workspaceId).reservedUsdMinor('2026-10')).toBe(85_000);
    expect(db.prepare('SELECT COUNT(*) AS count FROM idempotency_keys WHERE workspace_id = ?')
      .get(workspaceId)).toMatchObject({ count: 0 });
  });

  it('marks pending invoices stale and releases reservations when rules change', () => {
    const workspaceId = 'rules-stale';
    ensureWorkspace(db, workspaceId);
    putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 0 });
    queueAndDecide(db, workspaceId, 'STALE-001');
    const changed = { ...getWorkspaceData(db, workspaceId).rules, monthlyLimitUsdMinor: 5_900_000 };
    putRules(db, workspaceId, changed);
    markStale(db, workspaceId, { rules: true });

    expect(getInvoice(db, workspaceId, 'STALE-001')?.status).toBe('stale');
    expect(ledgerView(db, workspaceId).reservedUsdMinor('2026-10')).toBe(0);
  });

  it('refuses to approve a stale invoice', () => {
    const workspaceId = 'stale-approval';
    ensureWorkspace(db, workspaceId);
    putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 0 });
    queueAndDecide(db, workspaceId, 'STALE-002');
    markStale(db, workspaceId, { rules: true });

    const result = approveInvoice(db, workspaceId, 'STALE-002', {
      approver: 'Demo Reviewer', reason: 'Validar factura', idempotencyKey: 'stale-key',
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.record.decision.status).toBe('approval_required');
    expect(getInvoice(db, workspaceId, 'STALE-002')?.status).toBe('stale');
  });

  it('isolates invoice states and commitments between workspaces', () => {
    const workspaceA = 'isolated-a';
    const workspaceB = 'isolated-b';
    ensureWorkspace(db, workspaceA);
    ensureWorkspace(db, workspaceB);
    for (const workspaceId of [workspaceA, workspaceB]) {
      putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 0 });
      queueAndDecide(db, workspaceId, 'SAME-ID');
    }

    const approval = approveInvoice(db, workspaceA, 'SAME-ID', {
      approver: 'Demo Reviewer', reason: 'Validar factura', idempotencyKey: 'workspace-a-key',
    });
    expect(approval.ok).toBe(true);
    expect(getInvoice(db, workspaceA, 'SAME-ID')?.status).toBe('approved');
    expect(getInvoice(db, workspaceB, 'SAME-ID')?.status).toBe('approval_required');
    expect(ledgerView(db, workspaceA).committedUsdMinor('2026-10')).toBe(270_000);
    expect(ledgerView(db, workspaceB).committedUsdMinor('2026-10')).toBe(185_000);
    expect(ledgerView(db, workspaceB).reservedUsdMinor('2026-10')).toBe(85_000);
  });

  it('restores the original seed on workspace reset', () => {
    const workspaceId = 'reset-workspace';
    ensureWorkspace(db, workspaceId);
    putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 0 });
    queueAndDecide(db, workspaceId, 'RESET-001');
    resetWorkspace(db, workspaceId);

    expect(listInvoices(db, workspaceId)).toEqual([]);
    expect(getWorkspaceData(db, workspaceId).rules.approvalThresholdUsdMinor).toBe(300_000);
    expect(ledgerView(db, workspaceId).committedUsdMinor('2026-10')).toBe(185_000);
    expect(ledgerView(db, workspaceId).reservedUsdMinor('2026-10')).toBe(0);
    expect(ledgerView(db, workspaceId).hasCommitmentForContractPeriod('datos-soporte-monthly', '2026-10')).toBe(true);
  });

  it.each([
    'missing_amount', 'ambiguous_amount', 'source_amountRaw', 'source_payoutAccount', 'source_payeeTaxId',
    'source_invoiceId', 'multiple_tax_ids', 'multiple_currencies',
    'multiple_totals', 'sum_mismatch', 'missing_payee', 'extraction_failed',
  ])('cannot resolve or approve protected source-integrity flag %s', (checkId) => {
    const workspaceId = `integrity-${checkId}`;
    const invoiceId = `INV-${checkId}`;
    ensureWorkspace(db, workspaceId);
    createInvoice(db, workspaceId, { id: invoiceId, sourceKind: 'text' });
    const { extraction, jev } = protectedFlagInput(invoiceId, checkId);
    const record = decideInvoice(db, workspaceId, invoiceId, { extraction, jev });
    expect(record.decision.flags.map((flag) => flag.id)).toContain(checkId);
    const statusBefore = getInvoice(db, workspaceId, invoiceId)!.status;
    const historyBefore = getDecisionHistory(db, workspaceId, invoiceId);
    const auditCountBefore = (db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND invoice_id = ?')
      .get(workspaceId, invoiceId) as { count: number }).count;
    const reservedBefore = ledgerView(db, workspaceId).reservedUsdMinor('2026-10');

    expect(() => resolveFlag(db, workspaceId, invoiceId, checkId, {
      choice: 'Confirmado', reason: 'Revisado manualmente', approver: 'Demo Reviewer',
    })).toThrow(/correct.*re-evaluat/i);

    expect(getDecisionHistory(db, workspaceId, invoiceId)).toEqual(historyBefore);
    expect(getInvoice(db, workspaceId, invoiceId)).toMatchObject({ status: statusBefore, latestRecord: record });
    expect(ledgerView(db, workspaceId).reservedUsdMinor('2026-10')).toBe(reservedBefore);
    expect(db.prepare('SELECT COUNT(*) AS count FROM flag_resolutions WHERE workspace_id = ? AND invoice_id = ?')
      .get(workspaceId, invoiceId)).toMatchObject({ count: 0 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND invoice_id = ?')
      .get(workspaceId, invoiceId) as { count: number }).count).toBe(auditCountBefore);

    const approval = approveInvoice(db, workspaceId, invoiceId, {
      approver: 'Demo Reviewer', reason: 'Intento de aprobación genérico', idempotencyKey: `blocked-${checkId}`,
    });
    expect(approval).toMatchObject({ ok: false, status: 409 });
    expect(approval.record.id).toBe(record.id);
    expect(getInvoice(db, workspaceId, invoiceId)?.status).toBe(statusBefore);
    expect(getDecisionHistory(db, workspaceId, invoiceId)).toEqual(historyBefore);
    expect(db.prepare("SELECT COUNT(*) AS count FROM commitments WHERE workspace_id = ? AND invoice_id = ? AND state = 'committed'")
      .get(workspaceId, invoiceId)).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM idempotency_keys WHERE workspace_id = ? AND invoice_id = ?')
      .get(workspaceId, invoiceId)).toMatchObject({ count: 0 });
  });

  it('clears an integrity failure only after corrected inputs are re-evaluated', () => {
    const workspaceId = 'integrity-reevaluation';
    ensureWorkspace(db, workspaceId);
    const original = queueAndDecide(db, workspaceId, 'FIX-ME', 'nube', { amountRaw: null });
    expect(original.decision.status).toBe('review_required');
    expect(() => resolveFlag(db, workspaceId, 'FIX-ME', 'missing_amount', {
      choice: 'Sí', reason: 'Manual override', approver: 'Demo Reviewer',
    })).toThrow(/correct.*re-evaluat/i);

    const corrected = decideInvoice(db, workspaceId, 'FIX-ME', input('FIX-ME'));
    expect(corrected.decision.status).toBe('ready');
    expect(corrected.supersedes).toBe(original.id);
    expect(getDecisionHistory(db, workspaceId, 'FIX-ME')).toHaveLength(2);
  });

  it('creates an immutable resolution record for a non-integrity judgment flag', () => {
    const workspaceId = 'resolve-judgment';
    ensureWorkspace(db, workspaceId);
    const initial = queueAndDecide(db, workspaceId, 'REVIEW-001', 'nube', {}, urgentJev);
    expect(initial.decision.status).toBe('review_required');
    const originalJson = db.prepare('SELECT record_json FROM decision_records WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, initial.id) as { record_json: string };

    const resolved = resolveFlag(db, workspaceId, 'REVIEW-001', 'artificial_urgency', {
      choice: 'No es urgencia artificial', reason: 'La fecha de vencimiento es normal', approver: 'Demo Reviewer',
    });
    expect(resolved.decision.status).toBe('approval_required');
    expect(getInvoice(db, workspaceId, 'REVIEW-001')?.status).toBe('approval_required');
    expect(db.prepare('SELECT record_json FROM decision_records WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, initial.id)).toEqual(originalJson);
    expect(resolved.supersedes).toBe(initial.id);
  });

  it('rejects an approval with a null USD amount and records a new stopped decision', () => {
    const workspaceId = 'null-amount-approval';
    ensureWorkspace(db, workspaceId);
    const invoiceId = 'NULL-AMOUNT-001';
    createInvoice(db, workspaceId, { id: invoiceId, sourceKind: 'text' });
    const data = getWorkspaceData(db, workspaceId);
    const decision: Decision = {
      status: 'approval_required', checks: [], flags: [], canApprove: true,
      headline: 'Requiere tu aprobación', nextStep: null, amountUsdMinor: null, contractId: null, costCenter: null,
    };
    const record: DecisionRecord = buildRecord({
      id: 'corrupt-null-amount', invoiceId, invoiceHash: 'legacy-record', decision,
      rulesSnapshot: data.rules, dataVersions: { fxDate: '2026-10-15' }, jev: goodJev, createdAt: '2026-10-16T00:00:00.000Z',
    });
    db.prepare(`INSERT INTO decision_records(workspace_id, id, invoice_id, record_json, created_at, supersedes_id)
      VALUES (?, ?, ?, ?, ?, NULL)`).run(workspaceId, record.id, invoiceId, JSON.stringify(record), record.createdAt);
    db.prepare(`UPDATE invoices SET status = 'approval_required', latest_record_id = ?
      WHERE workspace_id = ? AND id = ?`).run(record.id, workspaceId, invoiceId);

    const result = approveInvoice(db, workspaceId, invoiceId, {
      approver: 'Demo Reviewer', reason: 'Validar factura', idempotencyKey: 'null-amount-key',
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.record.id).not.toBe(record.id);
    expect(result.record.supersedes).toBe(record.id);
    expect(result.record.decision.status).toBe('stopped');
    expect(result.record.decision.amountUsdMinor).toBeNull();
    expect(result.record.decision.checks).toContainEqual(expect.objectContaining({ id: 'approval_amount_missing', passed: false, effect: 'stop' }));
    expect(getInvoice(db, workspaceId, invoiceId)?.status).toBe('stopped');
  });

  it('rejects pending invoices, releases their reservation and records the actor', () => {
    const workspaceId = 'reject-pending';
    ensureWorkspace(db, workspaceId);
    putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 0 });
    queueAndDecide(db, workspaceId, 'REJECT-001');
    const result = rejectInvoice(db, workspaceId, 'REJECT-001', {
      approver: 'Demo Reviewer', reason: 'El servicio no fue solicitado', idempotencyKey: 'reject-key',
    });

    expect(result.status).toBe('rejected');
    expect(ledgerView(db, workspaceId).reservedUsdMinor('2026-10')).toBe(0);
    expect(db.prepare("SELECT event, actor, reason FROM audit_events WHERE workspace_id = ? AND event = 'rejected'")
      .get(workspaceId)).toMatchObject({ event: 'rejected', actor: 'Demo Reviewer', reason: 'El servicio no fue solicitado' });
  });
});

function protectedFlagInput(invoiceId: string, checkId: string): { extraction: ExtractionResult; jev: JevAnswers } {
  const source = vendorClaims.nube;
  const claims: ExtractionClaims = {
    amountsFound: [source.amountRaw], accountsFound: [source.payoutAccount], taxIdsFound: [source.payeeTaxId],
    invoiceIdsFound: [invoiceId], currenciesFound: ['USD'], ...source, invoiceId,
    invoiceDate: '2026-10-16', dueDate: '2026-10-25', currency: 'USD', subtotalRaw: null, taxesRaw: null,
    quantity: null, rateRaw: null, documentTypeHint: 'factura', hasMultipleCurrenciesShown: false,
    evidenceQuotes: { amountRaw: source.amountRaw, payoutAccount: source.payoutAccount, payeeTaxId: source.payeeTaxId, invoiceId },
    suspiciousPassages: [],
  };
  const sourceLines = [source.payeeName, source.payeeTaxId, source.payoutAccount, invoiceId, source.amountRaw];
  let extraction: ExtractionResult;
  if (checkId === 'extraction_failed') {
    extraction = { ok: false, error: 'rate_limited', sourceKind: 'text' };
  } else {
    const changed: ExtractionClaims = { ...claims };
    let sourceText = sourceLines.join('\n');
    switch (checkId) {
      case 'missing_amount':
        changed.amountRaw = null;
        changed.amountsFound = [];
        sourceText = [source.payeeName, source.payeeTaxId, source.payoutAccount, invoiceId].join('\n');
        break;
      case 'ambiguous_amount':
        changed.amountRaw = 'USD 2.500';
        changed.amountsFound = ['USD 2.500'];
        sourceText = [source.payeeName, source.payeeTaxId, source.payoutAccount, invoiceId, 'USD 2.500'].join('\n');
        break;
      case 'source_amountRaw':
        sourceText = [source.payeeName, source.payeeTaxId, source.payoutAccount, invoiceId].join('\n');
        break;
      case 'source_payoutAccount':
        changed.payoutAccount = 'Bancolombia 8890';
        changed.accountsFound = ['Bancolombia 8890'];
        sourceText = [source.payeeName, source.payeeTaxId, invoiceId, source.amountRaw].join('\n');
        break;
      case 'source_payeeTaxId':
        changed.payeeTaxId = '9012345678';
        changed.taxIdsFound = ['9012345678'];
        sourceText = [source.payeeName, source.payoutAccount, invoiceId, source.amountRaw].join('\n');
        break;
      case 'source_invoiceId':
        sourceText = [source.payeeName, source.payeeTaxId, source.payoutAccount, 'ACTUAL-ID', source.amountRaw].join('\n');
        break;
      case 'multiple_tax_ids':
        changed.taxIdsFound = [source.payeeTaxId, '900.000.000-0'];
        sourceText = [...sourceLines, '900.000.000-0'].join('\n');
        break;
      case 'multiple_currencies':
        changed.currenciesFound = ['USD', 'COP'];
        sourceText = [...sourceLines, 'COP'].join('\n');
        break;
      case 'multiple_totals':
        changed.amountsFound = [source.amountRaw, 'USD 851.00'];
        sourceText = [...sourceLines, 'USD 851.00'].join('\n');
        break;
      case 'sum_mismatch':
        changed.subtotalRaw = 'USD 800.00';
        changed.taxesRaw = 'USD 1.00';
        sourceText = [...sourceLines, 'USD 800.00', 'USD 1.00'].join('\n');
        break;
      case 'missing_payee':
        changed.payeeName = null;
        changed.payeeTaxId = null;
        changed.payoutAccount = null;
        changed.accountsFound = [];
        changed.taxIdsFound = [];
        sourceText = [invoiceId, source.amountRaw].join('\n');
        break;
      default:
        throw new Error(`No protected fixture for ${checkId}`);
    }
    extraction = { ok: true, claims: changed, sourceText, sourceKind: 'text' };
  }
  return { extraction, jev: goodJev };
}
