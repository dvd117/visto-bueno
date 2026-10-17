import { createHash, randomUUID } from 'node:crypto';
import type { Decision, DecisionRecord, ExtractionResult, InvoiceStatus, JevAnswers } from '../../shared/domain/types';
import { combine } from '../../shared/engine/combine';
import { mapJev } from '../../shared/engine/jev-map';
import { normalize, normalizeAccount } from '../../shared/engine/normalize';
import { evaluateRules } from '../../shared/engine/rules';
import { verifyClaims } from '../../shared/engine/verify';
import { buildRecord } from '../engine/record';
import { getInvoice, getWorkspaceData, nowIso, touchWorkspace, type Db, type StoredInvoice } from './db';
import { ledgerView } from './ledger';

export const DEFAULT_DEMO_TODAY = '2026-10-16';

export interface DecisionInputs {
  extraction: ExtractionResult;
  jev: JevAnswers;
}

export interface EvaluationOptions {
  today?: string;
}

export interface InvoiceAction {
  approver: string;
  reason: string;
  idempotencyKey: string;
  accountLast4?: string;
}

export interface FlagResolutionInput {
  choice: string;
  reason: string;
  approver: string;
}

export type ApprovalResult =
  | { ok: true; record: DecisionRecord }
  | { ok: false; status: 409; record: DecisionRecord };

const NON_RESOLVABLE_CHECK_IDS = new Set([
  'missing_amount',
  'ambiguous_amount',
  'source_amountRaw',
  'source_payoutAccount',
  'source_payeeTaxId',
  'source_invoiceId',
  'multiple_tax_ids',
  'multiple_currencies',
  'multiple_totals',
  'sum_mismatch',
  'missing_payee',
  'extraction_failed',
  'jev_unavailable',
]);

function recordOrThrow(invoice: StoredInvoice): DecisionRecord {
  if (!invoice.latestRecord) throw new Error(`Invoice has no decision record: ${invoice.id}`);
  return invoice.latestRecord;
}

function validateAction(by: InvoiceAction): void {
  if (!by.approver.trim() || !by.reason.trim() || !by.idempotencyKey.trim()) {
    throw new Error('An approver, reason and idempotency key are required.');
  }
}

function invoiceOrThrow(db: Db, workspaceId: string, invoiceId: string): StoredInvoice {
  const invoice = getInvoice(db, workspaceId, invoiceId);
  if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);
  return invoice;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function computeInvoiceHash(invoice: StoredInvoice, extraction: ExtractionResult): string {
  const sourceText = extraction.ok ? extraction.sourceText : invoice.sourceText;
  return sha256(JSON.stringify({ sourceKind: invoice.sourceKind, sourceText, extraction }));
}

function latestFxDate(dbFxDates: string[]): string {
  return [...dbFxDates].sort().at(-1) ?? 'unknown';
}

function currentDataVersions(
  vendorVersion: number | undefined,
  contractVersion: number | undefined,
  fxDate: string,
): DecisionRecord['dataVersions'] {
  return {
    ...(vendorVersion === undefined ? {} : { vendor: vendorVersion }),
    ...(contractVersion === undefined ? {} : { contract: contractVersion }),
    fxDate,
  };
}

function periodFor(contract: NonNullable<ReturnType<typeof evaluateRules>['contract']>, invoiceDate: string | null): string | null {
  if (!invoiceDate || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return null;
  if (contract.billingFrequency === 'monthly') return invoiceDate.slice(0, 7);
  if (contract.billingFrequency === 'annual') return invoiceDate.slice(0, 4);
  return 'once';
}

function evaluate(db: Db, workspaceId: string, invoice: StoredInvoice, inputs: DecisionInputs, options: EvaluationOptions, resolvedFlagIds: string[]) {
  const data = getWorkspaceData(db, workspaceId);
  const today = options.today ?? DEFAULT_DEMO_TODAY;
  const extraction: ExtractionResult = inputs.extraction.sourceKind === invoice.sourceKind
    ? inputs.extraction
    : { ok: false, error: 'unreadable', sourceKind: invoice.sourceKind };
  const verified = verifyClaims(extraction, data.vendors);
  const rules = extraction.ok
    ? evaluateRules({
        vendor: verified.vendor,
        contracts: data.contracts,
        money: verified.money,
        claims: extraction.claims,
        sourceKind: invoice.sourceKind,
        treasury: data.treasury,
        budgets: data.budgets,
        rules: data.rules,
        ledger: ledgerView(db, workspaceId, { excludeInvoiceId: invoice.id, today }),
        today,
      })
    : null;
  const combined = combine({
    verify: verified.checks,
    rules: rules?.checks ?? [],
    jev: mapJev(inputs.jev, data.rules.preset, { scope: Boolean(rules?.contract) }),
    resolvedFlagIds,
  });
  const contract = rules?.contract ?? null;
  const date = extraction.ok ? extraction.claims.invoiceDate : null;
  const month = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(0, 7) : null;
  const amountUsdMinor = rules?.amountUsdMinor ?? null;
  const decision: Decision = {
    ...combined,
    amountUsdMinor,
    contractId: contract?.id ?? null,
    costCenter: contract?.costCenter ?? null,
  };
  const invoiceHash = computeInvoiceHash(invoice, extraction);
  const dataVersions = currentDataVersions(
    verified.vendor?.version,
    contract?.version,
    latestFxDate(data.treasury.fx.map((rate) => rate.date)),
  );
  const record = buildRecord({
    id: randomUUID(),
    invoiceId: invoice.id,
    invoiceHash,
    decision,
    rulesSnapshot: data.rules,
    dataVersions,
    jev: inputs.jev,
    createdAt: nowIso(),
    ...(invoice.latestRecord ? { supersedes: invoice.latestRecord.id } : {}),
  });
  return {
    data,
    verified,
    rules,
    record,
    invoiceHash,
    extraction,
    jev: inputs.jev,
    today,
    sourceText: extraction.ok ? extraction.sourceText : invoice.sourceText,
    invoiceDate: date,
    dueDate: extraction.ok ? extraction.claims.dueDate : null,
    month,
    contractPeriod: contract ? periodFor(contract, date) : null,
    normalizedInvoiceId: inputs.extraction.ok && inputs.extraction.claims.invoiceId
      ? normalize(inputs.extraction.claims.invoiceId)
      : null,
  };
}

function insertRecord(db: Db, workspaceId: string, record: DecisionRecord): void {
  db.prepare(`INSERT INTO decision_records(workspace_id, id, invoice_id, record_json, created_at, supersedes_id)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(workspaceId, record.id, record.invoiceId, JSON.stringify(record), record.createdAt, record.supersedes ?? null);
}

function writeCommitment(
  db: Db,
  workspaceId: string,
  invoiceId: string,
  state: 'committed' | 'reserved' | null,
  fields: {
    vendorId: string | null; contractId: string | null; period: string | null; month: string | null;
    costCenter: string | null; amountUsdMinor: number | null; normalizedInvoiceId: string | null;
  },
): void {
  if (state === null) {
    db.prepare('DELETE FROM commitments WHERE workspace_id = ? AND invoice_id = ?').run(workspaceId, invoiceId);
    return;
  }
  db.prepare(`INSERT INTO commitments(
    workspace_id, invoice_id, state, vendor_id, contract_id, period, month, cost_center,
    amount_usd_minor, normalized_invoice_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(workspace_id, invoice_id) DO UPDATE SET
    state = excluded.state,
    vendor_id = excluded.vendor_id,
    contract_id = excluded.contract_id,
    period = excluded.period,
    month = excluded.month,
    cost_center = excluded.cost_center,
    amount_usd_minor = excluded.amount_usd_minor,
    normalized_invoice_id = excluded.normalized_invoice_id`)
    .run(
      workspaceId, invoiceId, state, fields.vendorId, fields.contractId, fields.period, fields.month,
      fields.costCenter, fields.amountUsdMinor, fields.normalizedInvoiceId,
    );
}

function commitmentFields(result: ReturnType<typeof evaluate>) {
  return {
    vendorId: result.verified.vendor?.id ?? null,
    contractId: result.rules?.contract?.id ?? null,
    period: result.contractPeriod,
    month: result.month,
    costCenter: result.rules?.contract?.costCenter ?? null,
    amountUsdMinor: result.record.decision.amountUsdMinor,
    normalizedInvoiceId: result.normalizedInvoiceId,
  };
}

function writeEvaluation(
  db: Db,
  workspaceId: string,
  result: ReturnType<typeof evaluate>,
  status: InvoiceStatus,
): void {
  const { record } = result;
  insertRecord(db, workspaceId, record);
  db.prepare(`UPDATE invoices SET status = ?, source_text = ?, extraction_json = ?, jev_json = ?, invoice_hash = ?,
    vendor_id = ?, contract_id = ?, invoice_date = ?, due_date = ?, evaluated_today = ?, month = ?, contract_period = ?, cost_center = ?,
    amount_usd_minor = ?, normalized_invoice_id = ?, latest_record_id = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`)
    .run(
      status,
      result.sourceText,
      JSON.stringify(result.extraction),
      JSON.stringify(result.jev),
      result.invoiceHash,
      result.verified.vendor?.id ?? null,
      result.rules?.contract?.id ?? null,
      result.invoiceDate,
      result.dueDate,
      result.today,
      result.month,
      result.contractPeriod,
      result.rules?.contract?.costCenter ?? null,
      record.decision.amountUsdMinor,
      result.normalizedInvoiceId,
      record.id,
      nowIso(),
      workspaceId,
      record.invoiceId,
    );
}

function writeAudit(
  db: Db,
  workspaceId: string,
  input: {
    invoiceId: string; event: string; status: string; actor?: string | null; reason?: string | null;
    headline: string; seal?: string | null; recordId?: string | null;
  },
): void {
  db.prepare(`INSERT INTO audit_events(workspace_id, invoice_id, event, status, actor, reason, headline, seal, record_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      workspaceId, input.invoiceId, input.event, input.status, input.actor ?? null, input.reason ?? null,
      input.headline, input.seal ?? null, input.recordId ?? null, nowIso(),
    );
}

function stopForApproval(
  db: Db,
  workspaceId: string,
  invoice: StoredInvoice,
  record: DecisionRecord,
  checkId: string,
  reason: string,
  evaluation?: ReturnType<typeof evaluate>,
  by?: InvoiceAction,
): DecisionRecord {
  const sourceRecord = evaluation?.record ?? record;
  const baseDecision = sourceRecord.decision;
  const decision: Decision = {
    ...baseDecision,
    status: 'stopped',
    canApprove: false,
    checks: baseDecision.checks.some((check) => check.id === checkId)
      ? baseDecision.checks.map((check) => check.id === checkId
        ? { ...check, passed: false, outcome: 'failed', effect: 'stop', reason }
        : check)
      : [...baseDecision.checks, {
          id: checkId, kind: 'rule', label: 'Aprobación segura', passed: false, outcome: 'failed', effect: 'stop', reason,
        }],
    headline: 'No se puede aprobar esta factura',
    nextStep: 'Corrige la causa y vuelve a evaluar la factura.',
  };
  const next = buildRecord({
    id: randomUUID(),
    invoiceId: invoice.id,
    invoiceHash: invoice.invoiceHash ?? evaluation?.invoiceHash ?? sha256(invoice.id),
    decision,
    rulesSnapshot: sourceRecord.rulesSnapshot,
    dataVersions: sourceRecord.dataVersions,
    jev: sourceRecord.jev,
    createdAt: nowIso(),
    supersedes: record.id,
  });
  if (evaluation && invoice.extraction && invoice.jev) {
    writeEvaluation(db, workspaceId, { ...evaluation, record: next }, 'stopped');
  } else {
    insertRecord(db, workspaceId, next);
    db.prepare("UPDATE invoices SET status = 'stopped', latest_record_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(next.id, nowIso(), workspaceId, invoice.id);
  }
  writeCommitment(db, workspaceId, invoice.id, null, {
    vendorId: null, contractId: null, period: null, month: null, costCenter: null, amountUsdMinor: null, normalizedInvoiceId: null,
  });
  writeAudit(db, workspaceId, {
    invoiceId: invoice.id, event: 'approval_refused', status: 'stopped', actor: by?.approver,
    headline: next.decision.headline, reason: by?.reason ?? reason, seal: next.seal, recordId: next.id,
  });
  return next;
}

function conflictingRecord(record: DecisionRecord): ApprovalResult {
  return { ok: false, status: 409, record };
}

function idempotencyExists(db: Db, workspaceId: string, key: string): boolean {
  return db.prepare('SELECT 1 FROM idempotency_keys WHERE workspace_id = ? AND idempotency_key = ?')
    .get(workspaceId, key) !== undefined;
}

function imageAccountConfirmationMatches(db: Db, workspaceId: string, invoice: StoredInvoice, accountLast4?: string): boolean {
  if (!/^\d{4}$/.test(accountLast4 ?? '') || !invoice.vendorId) return false;
  const vendor = getWorkspaceData(db, workspaceId).vendors.find(({ id }) => id === invoice.vendorId);
  const registeredLast4 = vendor ? /:([0-9]{4})$/u.exec(normalizeAccount(vendor.payoutAccount))?.[1] : undefined;
  return registeredLast4 !== undefined && registeredLast4 === accountLast4;
}

function recordIdempotency(db: Db, workspaceId: string, invoiceId: string, recordId: string, action: 'approved' | 'rejected', key: string): void {
  db.prepare(`INSERT INTO idempotency_keys(workspace_id, idempotency_key, invoice_id, record_id, action, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(workspaceId, key, invoiceId, recordId, action, nowIso());
}

export function decideInvoice(
  db: Db,
  workspaceId: string,
  invoiceId: string,
  inputs: DecisionInputs,
  options: EvaluationOptions = {},
): DecisionRecord {
  return db.transaction(() => {
    touchWorkspace(db, workspaceId);
    const invoice = invoiceOrThrow(db, workspaceId, invoiceId);
    if (invoice.status === 'approved' || invoice.status === 'rejected') {
      throw new Error(`Terminal invoice cannot be re-evaluated: ${invoice.status}`);
    }
    const result = evaluate(db, workspaceId, invoice, inputs, options, []);
    const status = result.record.decision.status;
    writeEvaluation(db, workspaceId, result, status);
    db.prepare('DELETE FROM flag_resolutions WHERE workspace_id = ? AND invoice_id = ?').run(workspaceId, invoiceId);
    const commitmentState = status === 'ready' ? 'committed'
      : status === 'approval_required' || status === 'review_required' ? 'reserved' : null;
    writeCommitment(db, workspaceId, invoiceId, commitmentState, commitmentFields(result));
    writeAudit(db, workspaceId, {
      invoiceId,
      event: 'decided',
      status,
      headline: result.record.decision.headline,
      seal: result.record.seal,
      recordId: result.record.id,
    });
    return result.record;
  }).immediate();
}

export function approveInvoice(
  db: Db,
  workspaceId: string,
  invoiceId: string,
  by: InvoiceAction,
  options: EvaluationOptions = {},
): ApprovalResult {
  return db.transaction(() => {
    touchWorkspace(db, workspaceId);
    validateAction(by);
    const invoice = invoiceOrThrow(db, workspaceId, invoiceId);
    const previous = recordOrThrow(invoice);
    const jevUnavailable = invoice.jev?.ok === false
      || previous.decision.checks.some((check) => check.id === 'jev_unavailable');
    if (invoice.status !== 'approval_required'
      && !(invoice.status === 'review_required' && jevUnavailable)) return conflictingRecord(previous);

    if (invoice.status === 'review_required' && jevUnavailable) {
      if (idempotencyExists(db, workspaceId, by.idempotencyKey)) return conflictingRecord(previous);
      const stopped = stopForApproval(
        db, workspaceId, invoice, previous, 'jev_unavailable',
        'La evaluación JEV no se completó; no se puede aprobar esta factura.', undefined, by,
      );
      return conflictingRecord(stopped);
    }
    if (invoice.sourceKind === 'image' && !imageAccountConfirmationMatches(db, workspaceId, invoice, by.accountLast4)) {
      return conflictingRecord(previous);
    }
    if (jevUnavailable && idempotencyExists(db, workspaceId, by.idempotencyKey)) return conflictingRecord(previous);

    if (previous.decision.amountUsdMinor === null) {
      const stopped = stopForApproval(
        db,
        workspaceId,
        invoice,
        previous,
        'approval_amount_missing',
        'No se puede aprobar sin un monto verificable en USD.',
        undefined,
        by,
      );
      return conflictingRecord(stopped);
    }
    if (idempotencyExists(db, workspaceId, by.idempotencyKey)) return conflictingRecord(previous);
    if (!previous.decision.canApprove && !jevUnavailable) return conflictingRecord(previous);
    if (!invoice.extraction || !invoice.jev) {
      const stopped = stopForApproval(
        db, workspaceId, invoice, previous, 'approval_inputs_missing',
        'No se puede revalidar la factura con sus datos guardados.', undefined, by,
      );
      return conflictingRecord(stopped);
    }

    const resolvedFlagIds = db.prepare('SELECT flag_id FROM flag_resolutions WHERE workspace_id = ? AND invoice_id = ?')
      .all(workspaceId, invoiceId).map((row) => (row as { flag_id: string }).flag_id);
    const refreshed = evaluate(
      db,
      workspaceId,
      invoice,
      { extraction: invoice.extraction, jev: invoice.jev },
      { today: options.today ?? invoice.evaluatedToday ?? DEFAULT_DEMO_TODAY },
      resolvedFlagIds,
    );
    const currentDecision = refreshed.record.decision;
    const hardFailure = currentDecision.checks.some((check) => check.effect === 'stop');
    if (currentDecision.amountUsdMinor === null) {
      const stopped = stopForApproval(
        db, workspaceId, invoice, previous, 'approval_amount_missing',
        'No se puede aprobar sin un monto verificable en USD.', refreshed, by,
      );
      return conflictingRecord(stopped);
    }
    if (hardFailure) {
      const stopped = buildRecord({
        ...refreshed.record,
        id: randomUUID(),
        invoiceHash: invoice.invoiceHash ?? refreshed.invoiceHash,
        decision: { ...currentDecision, status: 'stopped', canApprove: false },
        createdAt: nowIso(),
        supersedes: previous.id,
      });
      writeEvaluation(db, workspaceId, { ...refreshed, record: stopped }, 'stopped');
      writeCommitment(db, workspaceId, invoiceId, null, commitmentFields(refreshed));
      writeAudit(db, workspaceId, {
        invoiceId, event: 'approval_refused', status: 'stopped',
        headline: stopped.decision.headline, actor: by.approver, reason: by.reason,
        seal: stopped.seal, recordId: stopped.id,
      });
      return conflictingRecord(stopped);
    }
    if (!currentDecision.canApprove || currentDecision.status !== 'approval_required') {
      const stopped = stopForApproval(
        db, workspaceId, invoice, previous, 'approval_revalidation',
        'La reevaluación actual no permite aprobar esta factura.', refreshed, by,
      );
      return conflictingRecord(stopped);
    }

    const approvedRecord = buildRecord({
      ...refreshed.record,
      id: randomUUID(),
      invoiceHash: invoice.invoiceHash ?? refreshed.invoiceHash,
      decision: currentDecision,
      createdAt: nowIso(),
      supersedes: previous.id,
    });
    writeEvaluation(db, workspaceId, { ...refreshed, record: approvedRecord }, 'approved');
    writeCommitment(db, workspaceId, invoiceId, 'committed', commitmentFields(refreshed));
    writeAudit(db, workspaceId, {
      invoiceId, event: 'approved', status: 'approved', actor: by.approver, reason: by.reason,
      headline: 'Aprobación registrada', seal: approvedRecord.seal, recordId: approvedRecord.id,
    });
    recordIdempotency(db, workspaceId, invoiceId, approvedRecord.id, 'approved', by.idempotencyKey);
    return { ok: true as const, record: approvedRecord };
  }).immediate();
}

export function rejectInvoice(db: Db, workspaceId: string, invoiceId: string, by: InvoiceAction): StoredInvoice {
  return db.transaction(() => {
    touchWorkspace(db, workspaceId);
    validateAction(by);
    const invoice = invoiceOrThrow(db, workspaceId, invoiceId);
    const record = recordOrThrow(invoice);
    if (idempotencyExists(db, workspaceId, by.idempotencyKey)) throw new Error('Action already used.');
    if (invoice.status !== 'approval_required' && invoice.status !== 'review_required' && invoice.status !== 'stopped') {
      throw new Error('Only pending or stopped invoices can be rejected.');
    }
    const now = nowIso();
    db.prepare("UPDATE invoices SET status = 'rejected', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, workspaceId, invoiceId);
    writeCommitment(db, workspaceId, invoiceId, null, {
      vendorId: null, contractId: null, period: null, month: null, costCenter: null, amountUsdMinor: null, normalizedInvoiceId: null,
    });
    writeAudit(db, workspaceId, {
      invoiceId, event: 'rejected', status: 'rejected', actor: by.approver, reason: by.reason,
      headline: 'Factura rechazada', seal: record.seal, recordId: record.id,
    });
    recordIdempotency(db, workspaceId, invoiceId, record.id, 'rejected', by.idempotencyKey);
    return invoiceOrThrow(db, workspaceId, invoiceId);
  }).immediate();
}

export function resolveFlag(
  db: Db,
  workspaceId: string,
  invoiceId: string,
  flagId: string,
  resolution: FlagResolutionInput,
): DecisionRecord {
  return db.transaction(() => {
    touchWorkspace(db, workspaceId);
    const invoice = invoiceOrThrow(db, workspaceId, invoiceId);
    const previous = recordOrThrow(invoice);
    const flag = previous.decision.flags.find((candidate) => candidate.id === flagId);
    if (!flag) throw new Error(`Flag not found: ${flagId}`);
    if (NON_RESOLVABLE_CHECK_IDS.has(flag.checkId)) {
      throw new Error('This integrity check needs corrected invoice inputs and re-evaluation.');
    }
    if (invoice.status !== 'review_required') throw new Error('Only review flags can be resolved.');
    if (!resolution.choice.trim() || !resolution.reason.trim() || !resolution.approver.trim()) {
      throw new Error('Flag resolution requires a choice, reason and approver.');
    }
    if (db.prepare('SELECT 1 FROM flag_resolutions WHERE workspace_id = ? AND invoice_id = ? AND flag_id = ?')
      .get(workspaceId, invoiceId, flagId)) throw new Error(`Flag already resolved: ${flagId}`);
    if (!invoice.extraction || !invoice.jev) {
      throw new Error('Cannot re-evaluate current invoice data to resolve this flag.');
    }

    const at = nowIso();
    const resolved = { choice: resolution.choice, reason: resolution.reason, by: resolution.approver, at };
    db.prepare(`INSERT INTO flag_resolutions(workspace_id, invoice_id, flag_id, resolution_json, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(workspaceId, invoiceId, flagId, JSON.stringify(resolved), at);
    const resolvedFlagIds = db.prepare('SELECT flag_id FROM flag_resolutions WHERE workspace_id = ? AND invoice_id = ?')
      .all(workspaceId, invoiceId).map((row) => (row as { flag_id: string }).flag_id);
    const refreshed = evaluate(
      db,
      workspaceId,
      invoice,
      { extraction: invoice.extraction, jev: invoice.jev },
      { today: invoice.evaluatedToday ?? DEFAULT_DEMO_TODAY },
      resolvedFlagIds,
    );
    const decision = refreshed.record.decision;
    const next = buildRecord({
      ...refreshed.record,
      id: randomUUID(),
      invoiceHash: invoice.invoiceHash ?? refreshed.invoiceHash,
      decision,
      createdAt: at,
      supersedes: previous.id,
    });
    writeEvaluation(db, workspaceId, { ...refreshed, record: next }, decision.status);
    const commitmentState = decision.status === 'stopped' ? null
      : decision.status === 'ready' ? 'committed' : 'reserved';
    writeCommitment(db, workspaceId, invoiceId, commitmentState, commitmentFields(refreshed));
    writeAudit(db, workspaceId, {
      invoiceId, event: 'flag_resolved', status: next.decision.status, actor: resolution.approver,
      reason: resolution.reason, headline: next.decision.headline, seal: next.seal, recordId: next.id,
    });
    return next;
  }).immediate();
}

export function markStale(
  db: Db,
  workspaceId: string,
  scope: { rules?: true; vendorId?: string; contractId?: string },
): void {
  db.transaction(() => {
    touchWorkspace(db, workspaceId);
    if (!scope.rules && !scope.vendorId && !scope.contractId) throw new Error('A stale scope is required.');
    const pending = db.prepare(`SELECT id FROM invoices WHERE workspace_id = ?
      AND status IN ('ready', 'approval_required', 'review_required')`).all(workspaceId) as Array<{ id: string }>;
    const contractVendorId = scope.contractId === undefined
      ? undefined
      : getWorkspaceData(db, workspaceId).contracts.find(({ id }) => id === scope.contractId)?.vendorId;
    const timestamp = nowIso();
    for (const { id } of pending) {
      const invoice = invoiceOrThrow(db, workspaceId, id);
      const affected = scope.rules === true
        || (scope.vendorId !== undefined && invoice.vendorId === scope.vendorId)
        || (scope.contractId !== undefined && (invoice.contractId === scope.contractId
          || (contractVendorId !== undefined && invoice.vendorId === contractVendorId)));
      if (!affected) continue;
      db.prepare("UPDATE invoices SET status = 'stale', updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(timestamp, workspaceId, id);
      writeCommitment(db, workspaceId, id, null, {
        vendorId: null, contractId: null, period: null, month: null, costCenter: null, amountUsdMinor: null, normalizedInvoiceId: null,
      });
      writeAudit(db, workspaceId, {
        invoiceId: id, event: 'stale', status: 'stale', headline: 'Desactualizada: reevalúa',
        reason: 'Los datos que sustentaban esta decisión cambiaron.', seal: invoice.latestRecord?.seal ?? null,
        recordId: invoice.latestRecord?.id ?? null,
      });
    }
  }).immediate();
}
