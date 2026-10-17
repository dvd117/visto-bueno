import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getTable, putRow, reglasApi } from '../../src/client/lib/api';
import { createInvoice, getDecisionHistory, getInvoice, openDb } from '../../src/server/db/db';
import { createServerApp, serverRuntime } from '../../src/server/app';
import type { Rules } from '../../src/shared/domain/types';

// SQLite setup and route work can exceed Vitest's 5s default when the full suite is parallel.
const parallelTimeoutMs = 15_000;

const runtimes: Array<ReturnType<typeof createServerApp>> = [];

function makeRuntime() {
  const runtime = createServerApp({ db: openDb(':memory:'), autoCleanup: false, remoteAddress: () => '192.0.2.10' });
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

afterAll(() => serverRuntime.dispose());

describe('T11 correction regressions', () => {
  it('accepts committed PDF magic and rejects a mislabeled fake PDF', async () => {
    const { app } = makeRuntime();
    const bytes = await readFile('fixtures/invoices/AL-037.pdf');
    const form = new FormData();
    form.set('file', new File([bytes], 'AL-037.pdf', { type: 'application/pdf' }));
    const valid = await app.request('/api/invoices', { method: 'POST', body: form });
    expect(valid.status).toBe(201);

    const fake = new FormData();
    fake.set('file', new File([new Uint8Array([0x4e, 0x4f, 0x50, 0x45, 0x21])], 'fake.pdf', { type: 'application/pdf' }));
    const invalid = await app.request('/api/invoices', { method: 'POST', body: fake });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('El archivo debe ser un PDF o una imagen válida.');
  }, parallelTimeoutMs);

  it('parses all four real data-table PUT responses and applies version/stale effects', async () => {
    const { app, db } = makeRuntime();
    const initial = await app.request('/api/invoices');
    const cookie = initial.headers.get('set-cookie')?.split(';')[0] ?? '';
    const workspaceId = cookie.slice('workspace_id='.length);
    createInvoice(db, workspaceId, { id: 'PENDING-VENDOR-EDIT', sourceKind: 'text', sourceText: 'Factura pendiente' });
    db.prepare("UPDATE invoices SET status = 'review_required', vendor_id = ? WHERE workspace_id = ? AND id = ?")
      .run('nube-andina', workspaceId, 'PENDING-VENDOR-EDIT');

    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set('cookie', cookie);
      return app.request(String(input), { ...init, headers });
    });

    const vendors = await getTable('vendors');
    const vendor = vendors.find(({ id }) => id === 'nube-andina')!;
    const savedVendor = await putRow('vendors', { ...vendor, name: `${vendor.name} QA` });
    expect(savedVendor.version).toBe(vendor.version + 1);
    expect(savedVendor.name).toBe(`${vendor.name} QA`);

    const contracts = await getTable('contracts');
    const contract = contracts.find(({ id }) => id === 'nube-hosting-monthly')!;
    const savedContract = await putRow('contracts', { ...contract, scope: `${contract.scope} QA` });
    expect(savedContract.version).toBe(contract.version + 1);

    const budgets = await getTable('budgets');
    const budget = budgets.find(({ costCenter, month }) => costCenter === 'ingenieria' && month === '2026-10')!;
    expect(await putRow('budgets', { ...budget, approvedUsdMinor: budget.approvedUsdMinor + 1 }))
      .toMatchObject({ approvedUsdMinor: budget.approvedUsdMinor + 1 });

    const treasury = await getTable('treasury');
    expect(await putRow('treasury', { ...treasury, balanceUsdMinor: treasury.balanceUsdMinor + 1 }))
      .toMatchObject({ balanceUsdMinor: treasury.balanceUsdMinor + 1 });

    expect(db.prepare('SELECT status FROM invoices WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, 'PENDING-VENDOR-EDIT')).toEqual({ status: 'stale' });
  }, parallelTimeoutMs);

  it('processes queued received invoices by default without enabling live mode', async () => {
    const limiter = { reserveCall: vi.fn(() => ({ ok: true as const, reservation: { start: () => true, cancel: () => undefined } })) };
    const runtime = createServerApp({ db: openDb(':memory:'), autoCleanup: false, limiter });
    runtimes.push(runtime);
    const { app } = runtime;
    const created = await app.request('/api/invoices', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hola, ¿me pagan?' }),
    });
    const { id } = await created.json() as { id: string };
    const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
    const response = await app.request('/api/process', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mode: 'replay' }),
    });
    const stream = await response.text();

    expect(stream).toContain(id);
    expect(stream).toContain('"type":"done"');
    expect(limiter.reserveCall).not.toHaveBeenCalled();
  }, parallelTimeoutMs);

  it('keeps replay subsets isolated and gives the examples control a seed-only requeue', async () => {
    const { app, db } = makeRuntime();
    const initial = await app.request('/api/invoices');
    const cookie = initial.headers.get('set-cookie')?.split(';')[0] ?? '';
    const workspaceId = cookie.slice('workspace_id='.length);

    const subset = await app.request('/api/process', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: ['AL-030'], mode: 'replay' }),
    });
    const subsetStream = await subset.text();
    expect(subsetStream).toContain('"id":"AL-030"');
    expect(subsetStream).not.toContain('"id":"AL-031"');

    const userInvoice = await app.request('/api/invoices', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: 'Factura propia recibida.' }),
    });
    const { id: userInvoiceId } = await userInvoice.json() as { id: string };
    const historyBefore = getDecisionHistory(db, workspaceId, 'AL-032').length;
    db.prepare("UPDATE invoices SET status = 'approved' WHERE workspace_id = ? AND id = 'AL-030'").run(workspaceId);
    db.prepare("UPDATE invoices SET status = 'rejected' WHERE workspace_id = ? AND id = 'AL-031'").run(workspaceId);

    const examples = await app.request('/api/process', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mode: 'replay', examples: true }),
    });
    await examples.text();

    expect(getInvoice(db, workspaceId, 'AL-030')?.status).toBe('approved');
    expect(getInvoice(db, workspaceId, 'AL-031')?.status).toBe('rejected');
    expect(getInvoice(db, workspaceId, userInvoiceId)?.status).toBe('queued');
    expect(getDecisionHistory(db, workspaceId, 'AL-032')).toHaveLength(historyBefore + 1);
  }, parallelTimeoutMs);

  it('mounts rules routes under the real bounded server app and enforces validation/version/staleness', async () => {
    const { app, db } = makeRuntime();
    const workspaceResponse = await app.request('/api/workspace');
    const cookie = workspaceResponse.headers.get('set-cookie')?.split(';')[0] ?? '';
    const workspaceId = cookie.slice('workspace_id='.length);
    createInvoice(db, workspaceId, { id: 'PENDING-RULE-EDIT', sourceKind: 'text', sourceText: 'Factura pendiente' });
    db.prepare("UPDATE invoices SET status = 'approval_required' WHERE workspace_id = ? AND id = ?")
      .run(workspaceId, 'PENDING-RULE-EDIT');

    const headers = { 'content-type': 'application/json', cookie };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const requestHeaders = new Headers(init?.headers);
      requestHeaders.set('cookie', cookie);
      return app.request(String(input), { ...init, headers: requestHeaders });
    });

    const current = await reglasApi.getRules();
    const simulation = await reglasApi.simulate(current);
    expect(simulation.unsafeApprovals).toBe(0);

    const invalid = await app.request('/api/rules', {
      method: 'PUT', headers,
      body: JSON.stringify({ ...current, unknown: true }),
    });
    expect(invalid.status).toBe(400);

    const saved = await reglasApi.saveRules({ ...current, approvalThresholdUsdMinor: current.approvalThresholdUsdMinor - 1 });
    expect(saved.version).toBe(current.version + 1);
    expect(db.prepare('SELECT status FROM invoices WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, 'PENDING-RULE-EDIT')).toEqual({ status: 'stale' });

    const oversized = await app.request('/api/rules', {
      method: 'PUT', headers,
      body: JSON.stringify({ ...current, padding: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    const afterOversize = await (await app.request('/api/rules', { headers })).json() as Rules;
    expect(afterOversize.version).toBe(current.version + 1);
  }, parallelTimeoutMs);
});
