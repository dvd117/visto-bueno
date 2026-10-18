import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluationResultSchema } from '../../src/shared/api';
import { getInvoice, getWorkspaceData, openDb, putRules } from '../../src/server/db/db';
import { createServerApp, serverRuntime } from '../../src/server/app';
import { readExampleFixtures } from '../../src/server/fixtures';
import { createLiveCallLimiter } from '../../src/server/middleware/limits';
import type { ExtractionClaims, ExtractionResult, JevAnswers, SourceKind, Vendor } from '../../src/shared/domain/types';

const runtimes: Array<ReturnType<typeof createServerApp>> = [];

function makeRuntime(options: Partial<Parameters<typeof createServerApp>[0]> = {}) {
  const runtime = createServerApp({
    db: openDb(':memory:'),
    autoCleanup: false,
    remoteAddress: () => '192.0.2.10',
    ...options,
  });
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  rmSync(resolve('.w', 'api-image-approval'), { recursive: true, force: true });
  rmSync(resolve('.w', 'api-reset'), { recursive: true, force: true });
  rmSync(resolve('.w', 'api-eval'), { recursive: true, force: true });
  vi.unstubAllEnvs();
});

afterAll(() => serverRuntime.dispose());

function assertLabeledReplayEvidenceAvailable(complete: boolean, required: boolean): void {
  if (required && !complete) throw new Error('REQUIRE_LABELED_SET=1 but genuine replay evidence is incomplete.');
}

describe('T11 API', () => {
  it('purges uploaded invoices and their history on reset without touching another workspace', async () => {
    const uploadDirectory = resolve('.w', 'api-reset');
    const sources = new Map<string, { vendorId: string; reference: string; amount: string; description: string }>();
    let db: ReturnType<typeof openDb>;
    let workspaceA = '';
    const jev: JevAnswers = {
      ok: true,
      answers: {
        instructs_agent: { type: 'noul', noul: 0 },
        artificial_urgency: { type: 'noul', noul: 0 },
        scope_match: { type: 'score', score: 0, probabilities: { '0': 1, '1': 0, '2': 0 }, confidence: 1 },
        document_type: { type: 'choice', choice: 'factura', probabilities: { factura: 1 }, confidence: 1 },
      },
      latencyMs: 0, recorded: true, inputTokens: 1,
    };
    const runtime = makeRuntime({
      uploadDirectory,
      seedExamples: false,
      extractProvider: async (input) => {
        const source = input.invoiceId ? sources.get(input.invoiceId) : undefined;
        if (!source) return { ok: false, error: 'unreadable', sourceKind: input.kind };
        const vendor = getWorkspaceData(db, workspaceA).vendors.find(({ id }) => id === source.vendorId)!;
        const account = vendor.payoutAccount;
        const amount = `USD ${source.amount}`;
        const sourceText = [source.reference, vendor.name, vendor.taxId, account, amount].join('\n');
        return {
          ok: true,
          sourceKind: input.kind,
          sourceText,
          claims: {
            amountsFound: [amount], accountsFound: [account], taxIdsFound: [vendor.taxId],
            invoiceIdsFound: [source.reference], currenciesFound: ['USD'], payeeName: vendor.name,
            payeeTaxId: vendor.taxId, payoutAccount: account, invoiceId: source.reference,
            invoiceDate: '2026-10-16', dueDate: '2026-10-31', currency: 'USD', amountRaw: amount,
            subtotalRaw: null, taxesRaw: null, quantity: null, rateRaw: null,
            description: source.description, documentTypeHint: 'factura', hasMultipleCurrenciesShown: false,
            evidenceQuotes: { amountRaw: amount, payoutAccount: account, payeeTaxId: vendor.taxId, invoiceId: source.reference },
            suspiciousPassages: [],
          },
        };
      },
      jevProvider: async (input) => (input.state as { claims: { invoiceId: string } }).claims.invoiceId === 'RESET-IMAGE-001'
        ? { ...jev, answers: { ...jev.answers, artificial_urgency: { type: 'noul', noul: 0.4 } } }
        : jev,
    });
    const { app } = runtime;
    db = runtime.db;

    const firstWorkspace = await app.request('/api/invoices');
    const cookieA = firstWorkspace.headers.get('set-cookie')?.split(';')[0] ?? '';
    workspaceA = cookieA.slice('workspace_id='.length);
    const secondWorkspace = await app.request('/api/invoices');
    const cookieB = secondWorkspace.headers.get('set-cookie')?.split(';')[0] ?? '';
    const workspaceB = cookieB.slice('workspace_id='.length);
    expect(workspaceB).not.toBe(workspaceA);
    putRules(db, workspaceA, { ...getWorkspaceData(db, workspaceA).rules, approvalThresholdUsdMinor: 0 });

    const createText = await app.request('/api/invoices', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ text: 'RESET-TEXT-001\nImprenta Caribe C.A.\nFactura de prueba' }),
    });
    const textInvoice = await createText.json() as { id: string };
    sources.set(textInvoice.id, {
      vendorId: 'imprenta-caribe', reference: 'RESET-TEXT-001',
      amount: '500.00', description: 'Reimpresión puntual de afiches',
    });

    const createFile = async (cookie: string, name: string, type: string, bytes: Uint8Array, source?: {
      vendorId: string; reference: string; amount: string; description: string;
    }) => {
      const form = new FormData();
      form.set('file', new File([bytes], name, { type }));
      const response = await app.request('/api/invoices', { method: 'POST', headers: { cookie }, body: form });
      const invoice = await response.json() as { id: string };
      if (source) sources.set(invoice.id, source);
      return invoice;
    };
    const pdfInvoice = await createFile(cookieA, 'reset.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.7\n'), {
      vendorId: 'estacion-solar', reference: 'RESET-PDF-001', amount: '430.00', description: 'Mantenimiento de equipos de energía',
    });
    const imageInvoice = await createFile(cookieA, 'reset.png', 'image/png', Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), {
      vendorId: 'taller-lumbre', reference: 'RESET-IMAGE-001', amount: '450.00', description: 'Revisión puntual de plataforma y equipos',
    });
    const otherInvoice = await createFile(cookieB, 'other.png', 'image/png', Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const resetIds = [textInvoice.id, pdfInvoice.id, imageInvoice.id];

    const processResponse = await app.request('/api/process', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ ids: resetIds, mode: 'replay' }),
    });
    expect(await processResponse.text()).toContain('approval_required');
    expect(getInvoice(db, workspaceA, textInvoice.id)?.status).toBe('approval_required');
    const pdfPath = getInvoice(db, workspaceA, pdfInvoice.id)!.filePath!;
    const imagePath = getInvoice(db, workspaceA, imageInvoice.id)!.filePath!;
    expect(getInvoice(db, workspaceA, pdfInvoice.id)?.status).toBe('approval_required');
    expect(getInvoice(db, workspaceA, imageInvoice.id)?.status).toBe('review_required');

    const approval = await app.request(`/api/invoices/${pdfInvoice.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ approver: 'Demo', reason: 'Verificada', idempotencyKey: 'reset-approval' }),
    });
    expect(approval.status).toBe(200);
    const rejection = await app.request(`/api/invoices/${textInvoice.id}/reject`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ approver: 'Demo', reason: 'No corresponde', idempotencyKey: 'reset-rejection' }),
    });
    expect(rejection.status).toBe(200);
    const resolution = await app.request(`/api/invoices/${imageInvoice.id}/flags/artificial_urgency/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ choice: 'not_applicable', approver: 'Demo', reason: 'No hay urgencia artificial' }),
    });
    expect(resolution.status).toBe(200);
    const rejectResolvedImage = await app.request(`/api/invoices/${imageInvoice.id}/reject`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ approver: 'Demo', reason: 'No corresponde', idempotencyKey: 'reset-image-rejection' }),
    });
    expect(rejectResolvedImage.status).toBe(200);
    expect(getInvoice(db, workspaceA, textInvoice.id)?.status).toBe('rejected');
    expect(getInvoice(db, workspaceA, pdfInvoice.id)?.status).toBe('approved');
    expect(getInvoice(db, workspaceA, imageInvoice.id)?.status).toBe('rejected');
    expect(db.prepare('SELECT COUNT(*) AS count FROM decision_records WHERE workspace_id = ? AND invoice_id IN (?, ?, ?)')
      .get(workspaceA, ...resetIds)).toMatchObject({ count: 5 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND invoice_id IN (?, ?, ?)')
      .get(workspaceA, ...resetIds)).toMatchObject({ count: 7 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM commitments WHERE workspace_id = ? AND invoice_id IN (?, ?, ?)')
      .get(workspaceA, ...resetIds)).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM idempotency_keys WHERE workspace_id = ? AND invoice_id IN (?, ?, ?)')
      .get(workspaceA, ...resetIds)).toMatchObject({ count: 3 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM flag_resolutions WHERE workspace_id = ? AND invoice_id = ?')
      .get(workspaceA, imageInvoice.id)).toMatchObject({ count: 1 });

    expect(existsSync(resolve(uploadDirectory, pdfPath.replace(/^uploads\//, '')))).toBe(true);
    expect(existsSync(resolve(uploadDirectory, imagePath.replace(/^uploads\//, '')))).toBe(true);
    const reset = await app.request('/api/workspace/reset', { method: 'POST', headers: { cookie: cookieA } });

    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true });
    const seededInvoicesResponse = await app.request('/api/invoices', { headers: { cookie: cookieA } });
    expect(await seededInvoicesResponse.json()).toHaveLength(20);
    for (const id of resetIds) {
      for (const [table, idColumn] of [
        ['invoices', 'id'], ['decision_records', 'invoice_id'], ['commitments', 'invoice_id'],
        ['audit_events', 'invoice_id'], ['idempotency_keys', 'invoice_id'], ['flag_resolutions', 'invoice_id'],
      ]) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ? AND ${idColumn} = ?`)
          .get(workspaceA, id)).toMatchObject({ count: 0 });
      }
    }
    expect(existsSync(resolve(uploadDirectory, pdfPath.replace(/^uploads\//, '')))).toBe(false);
    expect(existsSync(resolve(uploadDirectory, imagePath.replace(/^uploads\//, '')))).toBe(false);
    expect(getInvoice(db, workspaceB, otherInvoice.id)?.filePath).toMatch(/^uploads\//);
    const otherPath = getInvoice(db, workspaceB, otherInvoice.id)!.filePath!;
    expect(existsSync(resolve(uploadDirectory, otherPath.replace(/^uploads\//, '')))).toBe(true);
  });

  it('sets an isolated workspace cookie and lists the 20 queued examples', async () => {
    const { app } = makeRuntime();
    const response = await app.request('/api/invoices');

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/workspace_id=.*HttpOnly.*SameSite=Lax/i);
    const invoices = await response.json() as Array<{ id: string; status: string }>;
    expect(invoices).toHaveLength(20);
    expect(invoices.every((invoice) => invoice.status === 'queued')).toBe(true);
  });

  it.each([
    ['CL', 'CLP', 'FICTICIO-CL'],
    ['PE', 'PEN', '20-00000000-1'],
    ['AR', 'ARS', '30-00000000-7'],
    ['VE', 'VES', 'J-00000000-0'],
  ] as const)('accepts %s vendors paid in %s through the data API', async (country, payoutCurrency, taxId) => {
    const { app } = makeRuntime();
    const vendor = {
      id: `proveedor-${country.toLowerCase()}`, name: `Proveedor ficticio ${country}`, taxId, country,
      payoutCurrency, payoutAccount: 'Banco Niebla Azul ···· 6341', status: 'allowed', version: 1,
    };

    const response = await app.request('/api/data/vendors', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(vendor),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ country, payoutCurrency });
  });

  it.each([
    ['VE', 'VES', 'J-00000000-1'],
    ['PE', 'PEN', '20-00000000-0'],
    ['AR', 'ARS', '30-00000000-6'],
  ] as const)('rejects a new %s vendor with a wrong tax-ID checksum', async (country, payoutCurrency, taxId) => {
    const { app } = makeRuntime();
    const response = await app.request('/api/data/vendors', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: `proveedor-${country.toLowerCase()}`, name: `Proveedor ficticio ${country}`, taxId, country,
        payoutCurrency, payoutAccount: 'Banco Niebla Azul ···· 6342', status: 'allowed', version: 1,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('allows other edits to legacy synthetic vendor IDs without changing their tax ID', async () => {
    const { app } = makeRuntime();
    const listResponse = await app.request('/api/data/vendors');
    const vendors = await listResponse.json() as Vendor[];
    const legacyVendor = vendors.find(({ id }) => id === 'imprenta-caribe');
    expect(legacyVendor).toBeDefined();

    const response = await app.request('/api/data/vendors', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...legacyVendor, status: 'blocked' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'imprenta-caribe', taxId: 'J-40123456-1', status: 'blocked' });
  });

  it('applies checksum validation to new vendor rows in CSV imports but allows unchanged legacy IDs', async () => {
    const { app } = makeRuntime();
    const upload = async (csv: string) => {
      const form = new FormData();
      form.set('file', new File([csv], 'vendors.csv', { type: 'text/csv' }));
      return app.request('/api/data/vendors/csv', { method: 'POST', body: form });
    };
    const invalid = await upload([
      'id,name,taxId,country,payoutCurrency,payoutAccount,status,version',
      'proveedor-ve,Proveedor ficticio VE,J-00000000-1,VE,VES,Banco Niebla Azul ···· 6342,allowed,1',
    ].join('\n'));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_csv' });

    const legacy = await upload([
      'id,name,taxId,country,payoutCurrency,payoutAccount,status,version',
      'imprenta-caribe,Imprenta Caribe C.A.,J-40123456-1,VE,USD,Banco Cielarroyo ···· 6130,allowed,1',
    ].join('\n'));
    expect(legacy.status).toBe(200);
  });

  it('serves the real committed invoice file from the workspace-scoped files route', async () => {
    const { app } = makeRuntime();
    const response = await app.request('/api/files/AL-032');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('replays the genuine sample, blocks unrecorded JEV from ready, and gates labels when all recordings exist', async () => {
    const reserveCall = vi.fn(createLiveCallLimiter().reserveCall);
    const { app, db } = makeRuntime({ limiter: { reserveCall } });
    const response = await app.request('/api/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'replay' }),
    });
    const frames = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean)
      .map((frame) => frame.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim())
      .filter((data): data is string => Boolean(data))
      .map((data) => JSON.parse(data) as { type: string; row?: { id: string; status: string } });
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    const workspaceId = cookie.slice('workspace_id='.length);
    const fixtures = readExampleFixtures();
    const decisions = fixtures.map((fixture) => {
      const invoice = getInvoice(db, workspaceId, fixture.invoiceId);
      const jev = invoice?.latestRecord?.jev;
      const row = frames.find((frame) => frame.type === 'decided' && frame.row?.id === fixture.invoiceId)?.row;
      return {
        fixture,
        status: row?.status,
        jevRecorded: Boolean(jev?.ok && jev.recorded),
      };
    });
    const recordingsComplete = decisions.every(({ jevRecorded }) => jevRecorded);

    assertLabeledReplayEvidenceAvailable(recordingsComplete, process.env.REQUIRE_LABELED_SET === '1');

    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/i);
    expect(frames.filter((frame) => frame.type === 'decided')).toHaveLength(20);
    expect(frames.filter((frame) => frame.type === 'done')).toHaveLength(1);
    expect(decisions).toHaveLength(20);
    for (const decision of decisions) {
      expect(decision.status).toBeDefined();
      expect(decision.status !== 'ready' || decision.fixture.expected === 'ready').toBe(true);
      if (!decision.jevRecorded) expect(decision.status).not.toBe('ready');
    }
    if (recordingsComplete) {
      expect(decisions.map(({ fixture, status }) => [fixture.invoiceId, status]))
        .toEqual(fixtures.map(({ invoiceId, expected }) => [invoiceId, expected]));
    }
    const readyIds = decisions.filter(({ status }) => status === 'ready').map(({ fixture }) => fixture.invoiceId);
    expect(readyIds.length).toBeGreaterThan(0);
    const batchQuery = new URLSearchParams({ batch: '1' });
    batchQuery.append('ready', readyIds[0]!);
    const batchResponse = await app.request(`/api/export/payments.csv?${batchQuery}`, { headers: { cookie } });
    const batchCsv = await batchResponse.text();
    expect(batchResponse.status).toBe(200);
    expect(batchCsv.split('\n')).toHaveLength(2);

    const reconciliationResponse = await app.request(`/api/export/reconciliation.csv?${batchQuery}`, { headers: { cookie } });
    const reconciliationCsv = await reconciliationResponse.text();
    expect(reconciliationResponse.status).toBe(200);
    expect(reconciliationCsv.split('\n')[0]).toContain('rules_version,vendor_version,contract_version,fx_date');
    expect(reconciliationCsv).toContain(readyIds[0]!);
    for (const heldId of readyIds.slice(1)) expect(reconciliationCsv).not.toContain(heldId);
    expect(reserveCall).not.toHaveBeenCalled();
  });

  it('fails closed when the mandatory labeled-set gate is activated without complete recordings', () => {
    expect(() => assertLabeledReplayEvidenceAvailable(false, true))
      .toThrow('REQUIRE_LABELED_SET=1 but genuine replay evidence is incomplete.');
  });

  it('handles non-invoice text as review and refuses approval of a stopped example', async () => {
    const { app } = makeRuntime();
    const created = await app.request('/api/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hola, ¿me pagan?' }),
    });
    const invoice = await created.json() as { id: string };
    const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';

    const stream = await app.request('/api/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: [invoice.id], mode: 'replay' }),
    });
    expect(await stream.text()).toContain('review_required');

    const stopped = await app.request('/api/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: ['AL-039'], mode: 'replay' }),
    });
    expect(await stopped.text()).toContain('stopped');
    const approval = await app.request('/api/invoices/AL-039/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ approver: 'Demo', reason: 'Revisado', idempotencyKey: 'stop-approval' }),
    });
    expect(approval.status).toBe(409);

    const rejection = await app.request('/api/invoices/AL-039/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ approver: 'Demo', reason: 'La cuenta no coincide', idempotencyKey: 'stop-rejection' }),
    });
    expect(rejection.status).toBe(200);
    expect((await rejection.json() as { row: { status: string } }).row.status).toBe('rejected');
  });

  it('requires the registered account suffix for image approval over HTTP', async () => {
    const claims: ExtractionClaims = {
      amountsFound: ['USD 850.00'], accountsFound: ['Banco Ventaluz ···· 8890'], taxIdsFound: ['NAT010101AB6'],
      invoiceIdsFound: ['IMG-API-001'], currenciesFound: ['USD'], payeeName: 'Nube Andina Tecnología S. de R.L.',
      payeeTaxId: 'NAT010101AB6', payoutAccount: 'Banco Ventaluz ···· 8890', invoiceId: 'IMG-API-001',
      invoiceDate: '2026-10-16', dueDate: '2026-10-20', currency: 'USD', amountRaw: 'USD 850.00',
      subtotalRaw: null, taxesRaw: null, quantity: null, rateRaw: null, description: 'Hosting',
      documentTypeHint: 'factura', hasMultipleCurrenciesShown: false, evidenceQuotes: {}, suspiciousPassages: [],
    };
    const jev: JevAnswers = {
      ok: true,
      answers: {
        instructs_agent: { type: 'noul', noul: 0 },
        artificial_urgency: { type: 'noul', noul: 0 },
        scope_match: { type: 'score', score: 0, probabilities: { '0': 1, '1': 0, '2': 0 }, confidence: 1 },
        document_type: { type: 'choice', choice: 'factura', probabilities: { factura: 1 }, confidence: 1 },
      },
      latencyMs: 0, recorded: true, inputTokens: 1,
    };
    const extractProvider = vi.fn(async (input: { kind: SourceKind }): Promise<ExtractionResult> => ({
      ok: true, claims, sourceText: '', sourceKind: input.kind,
    }));
    const { app, db } = makeRuntime({
      uploadDirectory: resolve('.w', 'api-image-approval'),
      extractProvider,
      jevProvider: async () => jev,
    });
    const form = new FormData();
    form.set('file', new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], 'invoice.png', { type: 'image/png' }));
    const created = await app.request('/api/invoices', { method: 'POST', body: form });
    expect(created.status).toBe(201);
    const invoice = await created.json() as { id: string };
    const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
    const workspaceId = cookie.slice('workspace_id='.length);

    const process = await app.request('/api/process', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: [invoice.id], mode: 'replay' }),
    });
    expect(await process.text()).toContain('approval_required');

    const approve = (body: Record<string, string>) => app.request(`/api/invoices/${invoice.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
    });
    const base = { approver: 'Demo', reason: 'Revisada', idempotencyKey: 'image-route-missing' };
    expect((await approve(base)).status).toBe(409);
    expect((await approve({ ...base, idempotencyKey: 'image-route-wrong', accountLast4: '4412' })).status).toBe(409);
    expect((await approve({ ...base, idempotencyKey: 'image-route-correct', accountLast4: '8890' })).status).toBe(200);
    expect(getInvoice(db, workspaceId, invoice.id)?.status).toBe('approved');
  });

  it('rejects an oversized upload before parsing and leaves live quota untouched', async () => {
    const reserveCall = vi.fn(createLiveCallLimiter().reserveCall);
    const { app } = makeRuntime({ limiter: { reserveCall } });
    const body = new Uint8Array(2 * 1024 * 1024 + 1);
    const response = await app.request('/api/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) },
      body,
    });

    expect(response.status).toBe(413);
    expect(reserveCall).not.toHaveBeenCalled();
  });

  it('does not reserve quota when the live extractor has no key', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const reserveCall = vi.fn(createLiveCallLimiter().reserveCall);
    const { app } = makeRuntime({ limiter: { reserveCall } });
    const created = await app.request('/api/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hola, ¿me pagan?' }),
    });
    const { id } = await created.json() as { id: string };
    const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
    const response = await app.request('/api/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: [id], mode: 'live' }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('review_required');
    expect(reserveCall).not.toHaveBeenCalled();
  });

  it('charges a failed started attempt and reports a later quota denial as safe SSE 429', async () => {
    const limiter = createLiveCallLimiter({ maxWorkspaceCalls: 1, maxIpCalls: 100, dailyCap: 100 });
    let requestsStarted = 0;
    const { app } = makeRuntime({
      limiter,
      extractProvider: async (input) => {
        input.onAttempt?.();
        requestsStarted += 1;
        return { ok: false, error: 'unreadable', sourceKind: input.kind };
      },
    });
    const first = await app.request('/api/invoices', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Primera factura de prueba' }),
    });
    const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? '';
    const second = await app.request('/api/invoices', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: 'Segunda factura de prueba' }),
    });
    const firstId = (await first.json() as { id: string }).id;
    const secondId = (await second.json() as { id: string }).id;
    const process = (id: string) => app.request('/api/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: [id], mode: 'live' }),
    });

    await process(firstId);
    const denied = await process(secondId);
    const stream = await denied.text();

    expect(requestsStarted).toBe(1);
    expect(denied.status).toBe(200);
    expect(stream).toContain('"status":429');
    expect(stream).toContain('Alcanzaste el límite de llamadas en vivo del demo. Inténtalo más tarde.');
    expect(stream).not.toContain('provider');
    expect(stream).toContain('"type":"done"');
  });

  it('cancels a reservation that cannot start and does not issue a provider request', async () => {
    const start = vi.fn(() => false);
    const cancel = vi.fn();
    const reserveCall = vi.fn(() => ({ ok: true as const, reservation: { start, cancel } }));
    let requestsStarted = 0;
    const { app } = makeRuntime({
      limiter: { reserveCall },
      extractProvider: async (input) => {
        input.onAttempt?.();
        requestsStarted += 1;
        return { ok: false, error: 'unreadable', sourceKind: input.kind };
      },
    });
    const created = await app.request('/api/invoices', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Factura de prueba' }),
    });
    const { id } = await created.json() as { id: string };
    const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
    const response = await app.request('/api/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: [id], mode: 'live' }),
    });
    const stream = await response.text();

    expect(start).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(requestsStarted).toBe(0);
    expect(stream).toContain('"status":429');
    expect(stream).toContain('"type":"done"');
  });

  it('uses the socket peer by default and the rightmost forwarded peer only with explicit trust', async () => {
    for (const [trustProxy, expectedIp] of [['0', '192.0.2.10'], ['1', '203.0.113.19']] as const) {
      const limiter = createLiveCallLimiter();
      const reserveCall = vi.spyOn(limiter, 'reserveCall');
      const { app } = makeRuntime({
        limiter,
        trustProxy,
        remoteAddress: () => '192.0.2.10',
        extractProvider: async (input) => {
          input.onAttempt?.();
          return { ok: false, error: 'unreadable', sourceKind: input.kind };
        },
      });
      const created = await app.request('/api/invoices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Factura de prueba' }),
      });
      const { id } = await created.json() as { id: string };
      const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
      await app.request('/api/process', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', cookie,
          'x-forwarded-for': '198.51.100.7, 203.0.113.19',
        },
        body: JSON.stringify({ ids: [id], mode: 'live' }),
      });
      expect(reserveCall).toHaveBeenCalledWith(expect.objectContaining({ ip: expectedIp, mode: 'live' }));
    }
  });

  it('serves the committed evaluation artifact after schema validation', async () => {
    const { app } = makeRuntime();
    const response = await app.request('/api/eval');

    expect(response.status).toBe(200);
    const result: unknown = await response.json();
    expect(evaluationResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: 'available',
      regression: { status: 'available', unsafeApprovals: 0 },
      labeled: { status: 'available', total: 20, correct: 20, unsafeApprovals: 0 },
      live: { status: 'unavailable', reason: 'sample_not_supplied' },
    });
  });

  it('keeps GET /api/eval unavailable when the artifact is missing or invalid', async () => {
    const missing = makeRuntime({ evaluationReportPath: resolve('.w', 'api-eval', 'missing.json') });
    expect((await missing.app.request('/api/eval')).status).toBe(503);

    const reportPath = resolve('.w', 'api-eval', 'invalid.json');
    mkdirSync(resolve('.w', 'api-eval'), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({ status: 'available' }));
    const invalid = makeRuntime({ evaluationReportPath: reportPath });
    expect((await invalid.app.request('/api/eval')).status).toBe(503);
  });
});
