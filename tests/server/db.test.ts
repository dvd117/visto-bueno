import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtractionClaims, ExtractionResult, JevAnswers } from '../../src/shared/domain/types';
import {
  createInvoice,
  getInvoice,
  getWorkspaceData,
  openDb,
  putContract,
  putRules,
} from '../../src/server/db/db';
import { ensureWorkspace, resetWorkspace } from '../../src/server/db/workspace';
import { approveInvoice, decideInvoice, resolveFlag } from '../../src/server/db/decide';
import { ledgerView } from '../../src/server/db/ledger';

const jev: JevAnswers = {
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

function extraction(invoiceId: string, changes: Partial<ExtractionClaims> = {}, date = '2026-10-16', due = date): ExtractionResult {
  const amountRaw = changes.amountRaw === undefined ? 'USD 850.00' : changes.amountRaw;
  const payoutAccount = changes.payoutAccount === undefined ? 'Bancolombia ···· 8890' : changes.payoutAccount;
  const payeeTaxId = changes.payeeTaxId === undefined ? '901.234.567-8' : changes.payeeTaxId;
  const baseClaims: ExtractionClaims = {
    amountsFound: amountRaw ? [amountRaw] : [],
    accountsFound: payoutAccount ? [payoutAccount] : [],
    taxIdsFound: payeeTaxId ? [payeeTaxId] : [],
    invoiceIdsFound: [invoiceId],
    currenciesFound: ['USD'],
    payeeName: 'NUBE ANDINA S.A.S.',
    payeeTaxId,
    payoutAccount,
    invoiceId,
    invoiceDate: date,
    dueDate: due,
    currency: 'USD',
    amountRaw,
    subtotalRaw: null,
    taxesRaw: null,
    quantity: null,
    rateRaw: null,
    description: 'Hosting administrado y respaldo de infraestructura',
    documentTypeHint: 'factura',
    hasMultipleCurrenciesShown: false,
    evidenceQuotes: {
      ...(amountRaw ? { amountRaw } : {}),
      ...(payoutAccount ? { payoutAccount } : {}),
      ...(payeeTaxId ? { payeeTaxId } : {}),
      invoiceId,
    },
    suspiciousPassages: [],
  };
  const claims: ExtractionClaims = {
    ...baseClaims,
    ...changes,
    amountsFound: changes.amountsFound ?? (amountRaw ? [amountRaw] : []),
    accountsFound: changes.accountsFound ?? (payoutAccount ? [payoutAccount] : []),
    taxIdsFound: changes.taxIdsFound ?? (payeeTaxId ? [payeeTaxId] : []),
  };
  const sourceText = [
    claims.payeeName,
    claims.payeeTaxId,
    claims.payoutAccount,
    claims.invoiceId,
    claims.amountRaw,
  ].filter((value): value is string => Boolean(value)).join('\n');
  return { ok: true, claims, sourceText, sourceKind: 'text' };
}

function readyInput(invoiceId: string, changes: Partial<ExtractionClaims> = {}, date = '2026-10-16', due = date) {
  return { extraction: extraction(invoiceId, changes, date, due), jev };
}

describe('database persistence', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    if (db.open) db.close();
  });

  it('clones seed data and prior committed payments with their vendor, contract and period', () => {
    const workspaceId = 'seeded';
    ensureWorkspace(db, workspaceId);

    const data = getWorkspaceData(db, workspaceId);
    const ledger = ledgerView(db, workspaceId);
    expect(data.vendors).toHaveLength(10);
    expect(ledger.committedUsdMinor('2026-10')).toBe(185_000);
    expect(ledger.hasCommitmentForContractPeriod('datos-soporte-monthly', '2026-10')).toBe(true);
    expect(ledger.hasCommitmentForContractPeriod('datos-soporte-monthly', '2026-11')).toBe(false);
    expect(db.prepare('SELECT vendor_id, contract_id, period FROM commitments WHERE workspace_id = ? AND invoice_id = ?')
      .get(workspaceId, 'DA-2026-10')).toMatchObject({
      vendor_id: 'datos-avila', contract_id: 'datos-soporte-monthly', period: '2026-10',
    });
  });

  it('keeps the seed decision date fixed and allows an injected evaluation date', () => {
    const workspaceId = 'dates';
    ensureWorkspace(db, workspaceId);
    createInvoice(db, workspaceId, { id: 'DATE-001', sourceKind: 'text' });

    const defaultDecision = decideInvoice(db, workspaceId, 'DATE-001', readyInput('DATE-001'));
    expect(defaultDecision.decision.checks.find((check) => check.id === 'R10')?.passed).toBe(true);

    resetWorkspace(db, workspaceId);
    createInvoice(db, workspaceId, { id: 'DATE-001', sourceKind: 'text' });
    const laterDecision = decideInvoice(db, workspaceId, 'DATE-001', readyInput('DATE-001'), { today: '2026-10-17' });
    expect(laterDecision.decision.checks.find((check) => check.id === 'R10')).toMatchObject({ passed: false, effect: 'review' });
    expect(laterDecision.decision.status).toBe('review_required');
    expect(getInvoice(db, workspaceId, 'DATE-001')?.evaluatedToday).toBe('2026-10-17');

    resolveFlag(db, workspaceId, 'DATE-001', 'R10', {
      choice: 'Vencimiento confirmado', reason: 'La persona confirmó la fecha', approver: 'Demo Reviewer',
    });
    const approval = approveInvoice(db, workspaceId, 'DATE-001', {
      approver: 'Demo Reviewer', reason: 'Aprobar tras revisar vencimiento', idempotencyKey: 'date-approval',
    });
    expect(approval.ok).toBe(true);
    expect(approval.record.decision.checks.find((check) => check.id === 'R10')).toMatchObject({ passed: false, effect: 'review' });
  });

  it('keeps image confirmation as an approval gate without source-text checks', () => {
    const workspaceId = 'image-confirmation';
    ensureWorkspace(db, workspaceId);
    createInvoice(db, workspaceId, { id: 'IMAGE-001', sourceKind: 'image' });
    const inputs = readyInput('IMAGE-001');
    if (!inputs.extraction.ok) throw new Error('test setup');
    inputs.extraction = { ...inputs.extraction, sourceKind: 'image' };

    const record = decideInvoice(db, workspaceId, 'IMAGE-001', inputs);

    expect(record.decision.status).toBe('approval_required');
    expect(record.decision.checks.find((check) => check.id === 'image_confirmation'))
      .toMatchObject({ passed: true, effect: 'approval' });
    expect(record.decision.checks.some((check) => check.id.startsWith('source_'))).toBe(false);
    expect(getInvoice(db, workspaceId, 'IMAGE-001')?.status).toBe('approval_required');
  });

  it('counts reserved spend in limits but only committed spend for contract-period uniqueness', () => {
    const workspaceId = 'reserved-ledger';
    ensureWorkspace(db, workspaceId);
    putRules(db, workspaceId, { ...getWorkspaceData(db, workspaceId).rules, approvalThresholdUsdMinor: 0 });
    createInvoice(db, workspaceId, { id: 'NUBE-001', sourceKind: 'text' });
    createInvoice(db, workspaceId, { id: 'NUBE-002', sourceKind: 'text' });

    const first = decideInvoice(db, workspaceId, 'NUBE-001', readyInput('NUBE-001'));
    expect(first.decision.status).toBe('approval_required');
    expect(ledgerView(db, workspaceId).reservedUsdMinor('2026-10')).toBe(85_000);

    const second = decideInvoice(db, workspaceId, 'NUBE-002', readyInput('NUBE-002'));
    expect(second.decision.checks.find((check) => check.id === 'R7')?.passed).toBe(true);
    expect(second.decision.checks.find((check) => check.id === 'R12')?.passed).toBe(true);
  });

  it('compares the per-payment limit in exact integer cents at the boundary', () => {
    const workspaceId = 'cents';
    ensureWorkspace(db, workspaceId);
    const data = getWorkspaceData(db, workspaceId);
    putRules(db, workspaceId, {
      ...data.rules,
      perPaymentLimitUsdMinor: 85_000,
      monthlyLimitUsdMinor: 270_000,
    });
    createInvoice(db, workspaceId, { id: 'CENT-AT', sourceKind: 'text' });
    const atBoundary = decideInvoice(db, workspaceId, 'CENT-AT', readyInput('CENT-AT'));
    expect(atBoundary.decision.checks.find((check) => check.id === 'R11')?.passed).toBe(true);
    expect(atBoundary.decision.checks.find((check) => check.id === 'R12')?.passed).toBe(true);

    resetWorkspace(db, workspaceId);
    const resetData = getWorkspaceData(db, workspaceId);
    putRules(db, workspaceId, { ...resetData.rules, perPaymentLimitUsdMinor: 85_000 });
    const contract = resetData.contracts.find((candidate) => candidate.id === 'nube-hosting-monthly')!;
    putContract(db, workspaceId, { ...contract, amountMinor: 85_001 });
    createInvoice(db, workspaceId, { id: 'CENT-OVER', sourceKind: 'text' });
    const oneCentOver = decideInvoice(db, workspaceId, 'CENT-OVER', readyInput('CENT-OVER', { amountRaw: 'USD 850.01' }));
    expect(oneCentOver.decision.checks.find((check) => check.id === 'R5')?.passed).toBe(true);
    expect(oneCentOver.decision.checks.find((check) => check.id === 'R11')).toMatchObject({ passed: false, effect: 'stop' });
  });

  it('normalizes invoice identifiers before looking up committed duplicates', () => {
    const workspaceId = 'normalized-ledger';
    ensureWorkspace(db, workspaceId);
    createInvoice(db, workspaceId, { id: 'NORM-001', sourceKind: 'text' });
    decideInvoice(db, workspaceId, 'NORM-001', readyInput('AL-042'));

    expect(ledgerView(db, workspaceId).hasInvoiceId('nube-andina', ' al.042 ')).toBe(true);
  });

  it('does not let an extraction change the queued source kind to skip source checks', () => {
    const workspaceId = 'source-kind';
    ensureWorkspace(db, workspaceId);
    createInvoice(db, workspaceId, { id: 'SRC-001', sourceKind: 'text', sourceText: 'Original pasted text' });
    const supplied = readyInput('SRC-001');
    if (supplied.extraction.ok) {
      supplied.extraction = { ...supplied.extraction, sourceKind: 'image', sourceText: 'Different claimed source' };
    }

    const record = decideInvoice(db, workspaceId, 'SRC-001', supplied);
    expect(record.decision.status).toBe('review_required');
    expect(record.decision.flags.map((flag) => flag.id)).toContain('extraction_failed');
    expect(getInvoice(db, workspaceId, 'SRC-001')?.extraction).toMatchObject({ ok: false, error: 'unreadable', sourceKind: 'text' });
  });

  it('returns persisted current state and leaves prior decisions in history', () => {
    const workspaceId = 'history';
    ensureWorkspace(db, workspaceId);
    createInvoice(db, workspaceId, { id: 'HIST-001', sourceKind: 'text' });
    const first = decideInvoice(db, workspaceId, 'HIST-001', readyInput('HIST-001'));
    const persisted = getInvoice(db, workspaceId, 'HIST-001');

    expect(persisted?.latestRecord).toEqual(first);
    expect(persisted?.status).toBe('ready');
  });

  it('persists decision history and ledger state across file-backed connections', () => {
    const workspaceId = 'file-backed';
    const dbPath = resolve(process.cwd(), '.w', 't', `visto-bueno-${randomUUID()}.sqlite`);
    let fileDb = openDb(dbPath);
    try {
      ensureWorkspace(fileDb, workspaceId);
      createInvoice(fileDb, workspaceId, { id: 'FILE-001', sourceKind: 'text' });
      const record = decideInvoice(fileDb, workspaceId, 'FILE-001', readyInput('FILE-001'));
      fileDb.close();

      fileDb = openDb(dbPath);
      expect(getInvoice(fileDb, workspaceId, 'FILE-001')?.latestRecord?.id).toBe(record.id);
      expect(getInvoice(fileDb, workspaceId, 'FILE-001')?.status).toBe('ready');
      expect(ledgerView(fileDb, workspaceId).committedUsdMinor('2026-10')).toBe(270_000);
    } finally {
      if (fileDb.open) fileDb.close();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });
});
