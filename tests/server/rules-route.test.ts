import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractionClaims, ExtractionResult, JevAnswers, Rules } from '../../src/shared/domain/types';
import { createInvoice, getWorkspaceData, openDb, putRules } from '../../src/server/db/db';
import { approveInvoice, decideInvoice } from '../../src/server/db/decide';
import { ensureWorkspace } from '../../src/server/db/workspace';
import { createRulesRoutes } from '../../src/server/routes/rules';
import type { Db } from '../../src/server/db/db';

const WORKSPACE = 'rules-route-a';
type RulesApp = Hono<{ Variables: { workspaceId: string } }>;

const jevTestMock: JevAnswers = {
  ok: true,
  answers: {
    instructs_agent: { type: 'noul', noul: 0 },
    artificial_urgency: { type: 'noul', noul: 0 },
    scope_match: { type: 'score', score: 0, probabilities: { '0': 1, '1': 0, '2': 0 }, confidence: 1 },
    document_type: { type: 'choice', choice: 'factura', probabilities: { factura: 1 }, confidence: 1 },
  },
  latencyMs: 0,
  recorded: false,
  inputTokens: 1,
};

function routeApp(db: Db, workspaceId = WORKSPACE): RulesApp {
  const app = new Hono<{ Variables: { workspaceId: string } }>();
  app.use('/api/*', async (c, next) => {
    c.set('workspaceId', workspaceId);
    await next();
  });
  app.route('/api', createRulesRoutes({ db }));
  return app;
}

function rulesFor(db: Db, workspaceId = WORKSPACE): Rules {
  const row = db.prepare("SELECT value_json FROM workspace_values WHERE workspace_id = ? AND key = 'rules'")
    .get(workspaceId) as { value_json: string };
  return JSON.parse(row.value_json) as Rules;
}

function extraction(
  invoiceId: string,
  input: { amountRaw?: string | null; vendor?: 'nube' | 'datos'; invoiceDate?: string; invoiceNumber?: string } = {},
): ExtractionResult {
  const vendor = input.vendor ?? 'nube';
  const invoiceNumber = input.invoiceNumber ?? invoiceId;
  const amountRaw = input.amountRaw === undefined
    ? (vendor === 'nube' ? 'USD 850.00' : 'USD 640.00')
    : input.amountRaw;
  const payeeName = vendor === 'nube' ? 'Nube Andina Tecnología S. de R.L.' : 'Ladera Austral SpA';
  const payeeTaxId = vendor === 'nube' ? 'NAT010101AB6' : '99.876.543-9';
  const payoutAccount = vendor === 'nube' ? 'Banco Ventaluz ···· 8890' : 'Banco Alborvia ···· 5206';
  const date = input.invoiceDate ?? '2026-10-16';
  const claims: ExtractionClaims = {
    amountsFound: amountRaw === null ? [] : [amountRaw],
    accountsFound: [payoutAccount],
    taxIdsFound: [payeeTaxId],
    invoiceIdsFound: [invoiceNumber],
    currenciesFound: ['USD'],
    payeeName,
    payeeTaxId,
    payoutAccount,
    invoiceId: invoiceNumber,
    invoiceDate: date,
    dueDate: '2026-10-16',
    currency: 'USD',
    amountRaw,
    subtotalRaw: null,
    taxesRaw: null,
    quantity: null,
    rateRaw: null,
    description: vendor === 'nube' ? 'Hosting administrado y respaldo de infraestructura' : 'Soporte de datos y conectividad',
    documentTypeHint: 'factura',
    hasMultipleCurrenciesShown: false,
    evidenceQuotes: {
      ...(amountRaw === null ? {} : { amountRaw }), payoutAccount, payeeTaxId, invoiceId: invoiceNumber,
    },
    suspiciousPassages: [],
  };
  const sourceText = [payeeName, payeeTaxId, payoutAccount, invoiceNumber, amountRaw].join('\n');
  return { ok: true, claims, sourceText, sourceKind: 'text' };
}

function addEvaluatedInvoice(
  db: Db,
  invoiceId: string,
  options: { amountRaw?: string | null; vendor?: 'nube' | 'datos'; invoiceDate?: string; invoiceNumber?: string; jev?: JevAnswers } = {},
) {
  createInvoice(db, WORKSPACE, { id: invoiceId, sourceKind: 'text' });
  return decideInvoice(db, WORKSPACE, invoiceId, {
    extraction: extraction(invoiceId, options),
    jev: options.jev ?? jevTestMock,
  });
}

function rows(db: Db, sql: string): unknown[] {
  return db.prepare(sql).all(WORKSPACE);
}

function persistenceSnapshot(db: Db) {
  return {
    values: rows(db, 'SELECT key, value_json FROM workspace_values WHERE workspace_id = ? ORDER BY key'),
    invoices: rows(db, 'SELECT * FROM invoices WHERE workspace_id = ? ORDER BY id'),
    commitments: rows(db, 'SELECT * FROM commitments WHERE workspace_id = ? ORDER BY invoice_id'),
    decisions: rows(db, 'SELECT * FROM decision_records WHERE workspace_id = ? ORDER BY id'),
    audit: rows(db, 'SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY id'),
    lastSeen: db.prepare('SELECT last_seen FROM workspaces WHERE id = ?').get(WORKSPACE),
  };
}

async function postJson(app: RulesApp, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function putJson(app: RulesApp, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('rules persistence routes', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    ensureWorkspace(db, WORKSPACE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (db.open) db.close();
  });

  it('returns workspace rules and atomically bumps version, stales pending invoices, and releases reservations', async () => {
    ensureWorkspace(db, 'rules-route-b');
    const current = rulesFor(db);
    putRules(db, WORKSPACE, { ...current, approvalThresholdUsdMinor: 0 });
    const pending = addEvaluatedInvoice(db, 'PENDING-RULES');
    expect(pending.decision.status).toBe('approval_required');
    expect(db.prepare('SELECT state FROM commitments WHERE workspace_id = ? AND invoice_id = ?')
      .get(WORKSPACE, 'PENDING-RULES')).toEqual({ state: 'reserved' });

    const app = routeApp(db);
    const getResponse = await app.request('/api/rules?workspaceId=rules-route-b');
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual(rulesFor(db));

    const beforeVersion = rulesFor(db).version;
    const response = await putJson(app, '/api/rules?workspaceId=rules-route-b', {
      ...rulesFor(db),
      version: 1,
      approvalThresholdUsdMinor: 50_000,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...rulesFor(db), version: beforeVersion + 1 });
    expect(rulesFor(db).version).toBe(beforeVersion + 1);
    expect(db.prepare('SELECT status FROM invoices WHERE workspace_id = ? AND id = ?')
      .get(WORKSPACE, 'PENDING-RULES')).toEqual({ status: 'stale' });
    expect(db.prepare('SELECT 1 FROM commitments WHERE workspace_id = ? AND invoice_id = ?')
      .get(WORKSPACE, 'PENDING-RULES')).toBeUndefined();
    expect(rulesFor(db, 'rules-route-b')).toEqual(current);
    expect(db.prepare("SELECT event, status FROM audit_events WHERE workspace_id = ? AND invoice_id = 'PENDING-RULES' ORDER BY id DESC LIMIT 1")
      .get(WORKSPACE)).toEqual({ event: 'stale', status: 'stale' });
  });

  it('rejects unknown fields and invalid money/threshold values without changing persisted state', async () => {
    const current = rulesFor(db);
    putRules(db, WORKSPACE, { ...current, approvalThresholdUsdMinor: 0 });
    addEvaluatedInvoice(db, 'PENDING-INVALID');
    const app = routeApp(db);
    const before = persistenceSnapshot(db);
    const valid = rulesFor(db);

    const invalidBodies = [
      { ...valid, allowListRequired: false },
      { ...valid, approvalThresholdUsdMinor: valid.perPaymentLimitUsdMinor },
      { ...valid, perPaymentLimitUsdMinor: 1.5 },
      { ...valid, monthlyLimitUsdMinor: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const body of invalidBodies) {
      const response = await putJson(app, '/api/rules', body);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Solicitud inválida');
      expect(text).not.toMatch(/allowListRequired|perPaymentLimitUsdMinor|SyntaxError|stack/i);
      expect(persistenceSnapshot(db)).toEqual(before);
    }
  });

  it('accepts zero-valued controls allowed by the core validator', async () => {
    const current = rulesFor(db);
    const candidate = {
      ...current,
      approvalThresholdUsdMinor: 0,
      monthlyLimitUsdMinor: 0,
      fuzzyDuplicateWindowDays: 0,
    };

    const response = await putJson(routeApp(db), '/api/rules', candidate);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      approvalThresholdUsdMinor: 0,
      monthlyLimitUsdMinor: 0,
      fuzzyDuplicateWindowDays: 0,
    });
    expect(rulesFor(db)).toMatchObject({
      approvalThresholdUsdMinor: 0,
      monthlyLimitUsdMinor: 0,
      fuzzyDuplicateWindowDays: 0,
    });
  });

  it('returns generic 400 for malformed JSON and 413 for oversized actual streamed bytes', async () => {
    const app = routeApp(db);
    const malformed = await app.request('/api/rules', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{bad json',
    });
    expect(malformed.status).toBe(400);
    const malformedText = await malformed.text();
    expect(malformedText).toContain('Solicitud inválida');
    expect(malformedText).not.toMatch(/SyntaxError|stack|unexpected token/i);

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    const request = new Request('http://localhost/api/rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-length': '1' },
      body: oversized,
      duplex: 'half',
    } as RequestInit);
    const response = await app.fetch(request);
    expect(response.status).toBe(413);
    const text = await response.text();
    expect(text).toContain('2 MB');
    expect(text).not.toMatch(/SyntaxError|stack|perPaymentLimitUsdMinor/i);
  });

  it('simulates from a stable snapshot without network calls or persistence mutations', async () => {
    const decision = addEvaluatedInvoice(db, 'SIM-CURRENT');
    expect(decision.decision.status).toBe('ready');
    const before = persistenceSnapshot(db);
    const app = routeApp(db);
    const fetchMock = vi.fn(() => { throw new Error('unexpected network call'); });
    vi.stubGlobal('fetch', fetchMock);
    const current = rulesFor(db);
    const response = await postJson(app, '/api/rules/simulate', {
      rules: { ...current, monthlyLimitUsdMinor: 200_000, approvalThresholdUsdMinor: 50_000 },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      counts: { stopped: 1 },
      unsafeApprovals: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistenceSnapshot(db)).toEqual(before);

    const exactBudget = await postJson(app, '/api/rules/simulate', {
      rules: { ...current, monthlyLimitUsdMinor: 270_000, approvalThresholdUsdMinor: 50_000 },
    });
    expect(exactBudget.status).toBe(200);
    expect(await exactBudget.json()).toMatchObject({
      counts: { approval_required: 1, stopped: 0 },
      deltas: { approval_required: 1 },
      unsafeApprovals: 0,
    });
    expect(persistenceSnapshot(db)).toEqual(before);
  });

  it('keeps an approved invoice as an external committed row during simulation', async () => {
    const current = rulesFor(db);
    putRules(db, WORKSPACE, { ...current, approvalThresholdUsdMinor: 0 });
    const pending = addEvaluatedInvoice(db, 'APPROVED-EXTERNAL');
    expect(pending.decision.status).toBe('approval_required');
    const approved = approveInvoice(db, WORKSPACE, 'APPROVED-EXTERNAL', {
      approver: 'Demo Reviewer', reason: 'Aprobación de prueba', idempotencyKey: 'rules-route-approval',
    });
    expect(approved.ok).toBe(true);
    expect(db.prepare('SELECT state FROM commitments WHERE workspace_id = ? AND invoice_id = ?')
      .get(WORKSPACE, 'APPROVED-EXTERNAL')).toEqual({ state: 'committed' });

    const target = addEvaluatedInvoice(db, 'TARGET-EXTERNAL');
    expect(target.decision.status).toBe('stopped');
    const response = await postJson(routeApp(db), '/api/rules/simulate', {
      rules: { ...rulesFor(db), approvalThresholdUsdMinor: 300_000 },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ counts: { stopped: 1 }, unsafeApprovals: 0 });
  });

  it('preserves normalized seeded invoice ids for exact-duplicate checks', async () => {
    const target = addEvaluatedInvoice(db, 'SIMULATED-DUPLICATE', {
      vendor: 'datos',
      invoiceDate: '2026-10-16',
      invoiceNumber: 'DA-2026-10',
    });
    expect(target.decision.checks.find((check) => check.id === 'R7')?.passed).toBe(true);
    expect(target.decision.checks.find((check) => check.id === 'R8')?.effect).toBe('stop');

    const response = await postJson(routeApp(db), '/api/rules/simulate', { rules: rulesFor(db) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ counts: { stopped: 1, ready: 0 }, unsafeApprovals: 0 });
  });

  it('does not treat a simulated reserved invoice as an R8 duplicate', async () => {
    const lowRiskFuzzyJev: JevAnswers = {
      ok: true,
      answers: {
        ...jevTestMock.answers,
        fuzzy_duplicate: { type: 'noul', noul: 0 },
      },
      latencyMs: 0,
      recorded: false,
      inputTokens: 1,
    };
    addEvaluatedInvoice(db, 'RESERVED-R8-A', {
      invoiceDate: '2026-10-14', invoiceNumber: 'REPEATED-RESERVED-17', jev: lowRiskFuzzyJev,
    });
    addEvaluatedInvoice(db, 'RESERVED-R8-B', {
      invoiceDate: '2026-10-16', invoiceNumber: 'REPEATED-RESERVED-17', jev: lowRiskFuzzyJev,
    });

    const response = await postJson(routeApp(db), '/api/rules/simulate', {
      rules: { ...rulesFor(db), approvalThresholdUsdMinor: 0, fuzzyDuplicateWindowDays: 1 },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      counts: { approval_required: 2, review_required: 0, stopped: 0, ready: 0 },
      unsafeApprovals: 0,
    });
  });

  it('counts simulated approval reservations against later invoice spend but not committed-only duplicate rules', async () => {
    addEvaluatedInvoice(db, 'A-RESERVED');
    addEvaluatedInvoice(db, 'B-FOLLOWING');
    const response = await postJson(routeApp(db), '/api/rules/simulate', {
      rules: { ...rulesFor(db), monthlyLimitUsdMinor: 300_000, approvalThresholdUsdMinor: 0 },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      counts: { approval_required: 1, stopped: 1, ready: 0 },
      unsafeApprovals: 0,
    });
  });

  it('does not fabricate queued extraction or replace a missing JEV recording', async () => {
    const missingJev: JevAnswers = { ok: false, error: 'missing_recording' };
    const reviewed = addEvaluatedInvoice(db, 'MISSING-RECORDING', { jev: missingJev });
    expect(reviewed.decision.status).toBe('review_required');
    const unknownMoney = addEvaluatedInvoice(db, 'UNKNOWN-MONEY', { amountRaw: null, jev: missingJev });
    expect(unknownMoney.decision.status).toBe('review_required');
    expect(unknownMoney.decision.amountUsdMinor).toBeNull();
    createInvoice(db, WORKSPACE, { id: 'QUEUED-EMPTY', sourceKind: 'text' });

    const response = await postJson(routeApp(db), '/api/rules/simulate', { rules: rulesFor(db) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      counts: { review_required: 2, ready: 0, approval_required: 0, stopped: 0 },
      unsafeApprovals: 0,
    });
  });

  it('keeps failed extraction in review without making an automatic approval', async () => {
    createInvoice(db, WORKSPACE, { id: 'FAILED-EXTRACTION', sourceKind: 'text' });
    const record = decideInvoice(db, WORKSPACE, 'FAILED-EXTRACTION', {
      extraction: { ok: false, error: 'unreadable', sourceKind: 'text' },
      jev: { ok: false, error: 'missing_recording' },
    });
    expect(record.decision.status).toBe('review_required');

    const response = await postJson(routeApp(db), '/api/rules/simulate', { rules: rulesFor(db) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      counts: { review_required: 1, ready: 0, stopped: 0 },
      unsafeApprovals: 0,
    });
  });

  it('never returns ready when the candidate per-payment rule fails', async () => {
    addEvaluatedInvoice(db, 'LIMIT-FAILS');
    const response = await postJson(routeApp(db), '/api/rules/simulate', {
      rules: { ...rulesFor(db), perPaymentLimitUsdMinor: 80_000, approvalThresholdUsdMinor: 50_000 },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      counts: { stopped: 1, ready: 0 },
      unsafeApprovals: 0,
    });
  });

  it('returns generic 400 for malformed simulation rules', async () => {
    const response = await postJson(routeApp(db), '/api/rules/simulate', {
      rules: { ...getWorkspaceData(db, WORKSPACE).rules, unknownSafetyOverride: true },
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('Solicitud inválida');
    expect(text).not.toMatch(/unknownSafetyOverride|Unknown rules field|stack/i);
  });
});
