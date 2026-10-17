import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractionClaims, ExtractionResult, JevAnswers } from '../../src/shared/domain/types';
import { createInvoice, getInvoice, getWorkspaceData, openDb } from '../../src/server/db/db';
import { decideInvoice, resolveFlag } from '../../src/server/db/decide';
import { ensureWorkspace } from '../../src/server/db/workspace';
import { createServerApp, serverRuntime } from '../../src/server/app';

const workspaceId = 't11-stale-revalidation';
const cookie = `workspace_id=${workspaceId}`;

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

const urgentJev: JevAnswers = {
  ...jev,
  answers: { ...jev.answers, artificial_urgency: { type: 'noul', noul: 0.5 } },
};

function invoiceInput(invoiceId: string, answers = jev) {
  const claims: ExtractionClaims = {
    amountsFound: ['USD 850.00'],
    accountsFound: ['Banco Ventaluz ···· 8890'],
    taxIdsFound: ['NAT010101AB6'],
    invoiceIdsFound: [invoiceId],
    currenciesFound: ['USD'],
    payeeName: 'Nube Andina Tecnología S. de R.L.',
    payeeTaxId: 'NAT010101AB6',
    payoutAccount: 'Banco Ventaluz ···· 8890',
    invoiceId,
    invoiceDate: '2026-10-16',
    dueDate: '2026-10-25',
    currency: 'USD',
    amountRaw: 'USD 850.00',
    subtotalRaw: null,
    taxesRaw: null,
    quantity: null,
    rateRaw: null,
    description: 'Hosting administrado y respaldo de infraestructura',
    documentTypeHint: 'factura',
    hasMultipleCurrenciesShown: false,
    evidenceQuotes: {
      amountRaw: 'USD 850.00', payoutAccount: 'Banco Ventaluz ···· 8890',
      payeeTaxId: 'NAT010101AB6', invoiceId,
    },
    suspiciousPassages: [],
  };
  const sourceText = [claims.payeeName, claims.payeeTaxId, claims.payoutAccount, invoiceId, claims.amountRaw].join('\n');
  const extraction: ExtractionResult = { ok: true, claims, sourceText, sourceKind: 'text' };
  return { extraction, jev: answers };
}

describe('T11 stale decision revalidation', () => {
  let db: ReturnType<typeof openDb>;
  let runtime: ReturnType<typeof createServerApp>;

  beforeEach(() => {
    db = openDb(':memory:');
    ensureWorkspace(db, workspaceId);
    runtime = createServerApp({ db, autoCleanup: false, closeDbOnDispose: false, seedExamples: false });
  });

  afterEach(() => {
    runtime.dispose();
    if (db.open) db.close();
  });

  it('stales a ready decision after a vendor account edit and excludes it from the payment export', async () => {
    createInvoice(db, workspaceId, { id: 'AL-037', sourceKind: 'text' });
    const original = decideInvoice(db, workspaceId, 'AL-037', invoiceInput('AL-037'));
    expect(original.decision.status).toBe('ready');

    const before = await runtime.app.request('/api/export/payments.csv', { headers: { cookie } });
    expect(await before.text()).toContain('Banco Ventaluz ···· 8890');

    const vendor = getWorkspaceData(db, workspaceId).vendors.find(({ id }) => id === 'nube-andina')!;
    const edited = await runtime.app.request('/api/data/vendors', {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...vendor, payoutAccount: 'Banco Ventaluz ···· 9999' }),
    });
    expect(edited.status).toBe(200);

    const invoice = getInvoice(db, workspaceId, 'AL-037')!;
    expect(invoice.status).toBe('stale');
    expect(invoice.latestRecord?.dataVersions.vendor).toBe(1);
    expect(getWorkspaceData(db, workspaceId).vendors.find(({ id }) => id === 'nube-andina')?.version).toBe(2);
    expect(db.prepare('SELECT 1 FROM commitments WHERE workspace_id = ? AND invoice_id = ?')
      .get(workspaceId, 'AL-037')).toBeUndefined();

    const after = await runtime.app.request('/api/export/payments.csv', { headers: { cookie } });
    expect(await after.text()).not.toContain('Banco Ventaluz ···· 9999');
  });

  it('stales a ready decision when a new overlapping contract changes R3', async () => {
    createInvoice(db, workspaceId, { id: 'AL-037', sourceKind: 'text' });
    const input = invoiceInput('AL-037');
    const original = decideInvoice(db, workspaceId, 'AL-037', input);
    expect(original.decision.status).toBe('ready');

    const contract = getWorkspaceData(db, workspaceId).contracts.find(({ id }) => id === 'nube-hosting-monthly')!;
    const response = await runtime.app.request('/api/data/contracts', {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...contract, id: 'nube-overlapping-monthly', scope: 'Hosting ampliado', version: 1 }),
    });
    expect(response.status).toBe(200);
    expect(getInvoice(db, workspaceId, 'AL-037')?.status).toBe('stale');

    const reevaluated = decideInvoice(db, workspaceId, 'AL-037', input);
    expect(reevaluated.decision.status).toBe('stopped');
    expect(reevaluated.decision.checks.find(({ id }) => id === 'R3')).toMatchObject({ passed: false, effect: 'stop' });
  });

  it('re-evaluates current rules and committed ledger when resolving a review flag', () => {
    createInvoice(db, workspaceId, { id: 'AL-044', sourceKind: 'text' });
    const original = decideInvoice(db, workspaceId, 'AL-044', invoiceInput('AL-044', urgentJev));
    expect(original.decision.status).toBe('review_required');
    expect(original.decision.checks.find(({ id }) => id === 'R7')).toMatchObject({ passed: true, effect: 'none' });

    db.prepare(`INSERT INTO commitments(
      workspace_id, invoice_id, state, vendor_id, contract_id, period, month, cost_center,
      amount_usd_minor, normalized_invoice_id
    ) VALUES (?, ?, 'committed', ?, ?, ?, ?, ?, ?, ?)`)
      .run(workspaceId, 'EXTERNAL-COMMITMENT', 'nube-andina', 'nube-hosting-monthly', '2026-10', '2026-10', 'operaciones', 85_000, 'external-commitment');

    const resolved = resolveFlag(db, workspaceId, 'AL-044', 'artificial_urgency', {
      choice: 'Urgencia no artificial', reason: 'Se revisó el contexto', approver: 'Demo Reviewer',
    });
    expect(resolved.decision.status).toBe('stopped');
    expect(resolved.decision.canApprove).toBe(false);
    expect(resolved.decision.checks.find(({ id }) => id === 'R7')).toMatchObject({ passed: false, effect: 'stop' });
  });
});

afterAll(() => serverRuntime.dispose());
