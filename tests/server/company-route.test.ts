import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInvoice, getWorkspaceData, openDb, type Db } from '../../src/server/db/db';
import { ensureWorkspace } from '../../src/server/db/workspace';
import { readLimitedBody } from '../../src/server/middleware/limits';
import type { ServerEnv } from '../../src/server/middleware/workspace';
import { createCompanyRoutes } from '../../src/server/routes/company';

const WORKSPACE = 'company-route';

function companyBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Andina Labs Inc.',
    operatingCountries: ['US'],
    vendorCountries: ['CO', 'MX', 'VE', 'CL', 'US'],
    currencies: ['USD', 'COP', 'MXN'],
    limits: { perPaymentUsdMinor: 1_500_000, monthlyUsdMinor: 6_000_000, approvalThresholdUsdMinor: 300_000 },
    ...overrides,
  };
}

function routeApp(db: Db): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  app.use('/api/*', async (c, next) => {
    c.set('workspaceId', WORKSPACE);
    if (c.req.method === 'PUT' || c.req.method === 'POST') {
      const body = await readLimitedBody(c.req.raw);
      if (!body.ok) return c.json({ error: 'too_large', message: body.message }, 413);
      c.set('requestBytes', body.bytes);
    }
    await next();
  });
  app.route('/api', createCompanyRoutes({ db }));
  return app;
}

function send(app: Hono<ServerEnv>, method: 'PUT' | 'POST', path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

function persistenceSnapshot(db: Db) {
  return {
    values: db.prepare('SELECT key, value_json FROM workspace_values WHERE workspace_id = ? ORDER BY key').all(WORKSPACE),
    statuses: db.prepare('SELECT id, status FROM invoices WHERE workspace_id = ? ORDER BY id').all(WORKSPACE),
  };
}

function addPendingInvoice(db: Db, id: string): void {
  createInvoice(db, WORKSPACE, { id, sourceKind: 'text' });
  db.prepare("UPDATE invoices SET status = 'approval_required' WHERE workspace_id = ? AND id = ?").run(WORKSPACE, id);
}

describe('company profile routes', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    ensureWorkspace(db, WORKSPACE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (db.open) db.close();
  });

  it('serves the seeded profile with limits read from the rules', async () => {
    const response = await routeApp(db).request('/api/company');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(companyBody());
    expect(db.prepare("SELECT value_json FROM workspace_values WHERE workspace_id = ? AND key = 'company'")
      .get(WORKSPACE)).toEqual({ value_json: JSON.stringify({
      name: 'Andina Labs Inc.',
      operatingCountries: ['US'],
      vendorCountries: ['CO', 'MX', 'VE', 'CL', 'US'],
      currencies: ['USD', 'COP', 'MXN'],
    }) });
  });

  it('saves the profile and changed limits, bumps the rules version once, and stales pending invoices', async () => {
    addPendingInvoice(db, 'PENDING-COMPANY');
    const versionBefore = getWorkspaceData(db, WORKSPACE).rules.version;
    const next = companyBody({
      name: 'Marea Norte SpA',
      limits: { perPaymentUsdMinor: 1_500_000, monthlyUsdMinor: 6_000_000, approvalThresholdUsdMinor: 90_000 },
    });

    const response = await send(routeApp(db), 'PUT', '/api/company', next);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(next);
    const rules = getWorkspaceData(db, WORKSPACE).rules;
    expect(rules.version).toBe(versionBefore + 1);
    expect(rules.approvalThresholdUsdMinor).toBe(90_000);
    expect(db.prepare('SELECT status FROM invoices WHERE workspace_id = ? AND id = ?')
      .get(WORKSPACE, 'PENDING-COMPANY')).toEqual({ status: 'stale' });
    expect(await (await routeApp(db).request('/api/company')).json()).toEqual(next);
  });

  it('keeps the rules version and pending invoices when only the profile changes', async () => {
    addPendingInvoice(db, 'PENDING-PROFILE');
    const versionBefore = getWorkspaceData(db, WORKSPACE).rules.version;

    const response = await send(routeApp(db), 'PUT', '/api/company', companyBody({ currencies: ['USD', 'COP', 'MXN', 'CLP'] }));

    expect(response.status).toBe(200);
    expect(getWorkspaceData(db, WORKSPACE).rules.version).toBe(versionBefore);
    expect(db.prepare('SELECT status FROM invoices WHERE workspace_id = ? AND id = ?')
      .get(WORKSPACE, 'PENDING-PROFILE')).toEqual({ status: 'approval_required' });
  });

  it('rejects invalid bodies with a generic message and no persisted change', async () => {
    addPendingInvoice(db, 'PENDING-INVALID');
    const app = routeApp(db);
    const before = persistenceSnapshot(db);
    const invalidBodies: unknown[] = [
      companyBody({ limits: { perPaymentUsdMinor: 300_000, monthlyUsdMinor: 6_000_000, approvalThresholdUsdMinor: 300_000 } }),
      companyBody({ currencies: ['COP', 'MXN'] }),
      companyBody({ vendorCountries: ['CO', 'CO'] }),
      companyBody({ name: '   ' }),
      companyBody({ operatingCountries: [] }),
      companyBody({ limits: { perPaymentUsdMinor: -1, monthlyUsdMinor: 0, approvalThresholdUsdMinor: 0 } }),
      companyBody({ unknownOverride: true }),
      '{bad json',
    ];

    for (const body of invalidBodies) {
      const response = await send(app, 'PUT', '/api/company', body);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Solicitud inválida');
      expect(text).not.toMatch(/SyntaxError|stack|unknownOverride|perPaymentUsdMinor/i);
      expect(persistenceSnapshot(db)).toEqual(before);
    }
  });

  it('previews the limit impact without network calls or persistence changes', async () => {
    addPendingInvoice(db, 'PENDING-PREVIEW');
    const before = persistenceSnapshot(db);
    const fetchMock = vi.fn(() => { throw new Error('unexpected network call'); });
    vi.stubGlobal('fetch', fetchMock);

    const response = await send(routeApp(db), 'POST', '/api/company/preview', companyBody({
      limits: { perPaymentUsdMinor: 1_500_000, monthlyUsdMinor: 6_000_000, approvalThresholdUsdMinor: 90_000 },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      counts: expect.any(Object),
      deltas: expect.any(Object),
      unsafeApprovals: 0,
      staleCount: 1,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistenceSnapshot(db)).toEqual(before);
  });

  it('reports no stale invoices for a preview that changes only the profile', async () => {
    addPendingInvoice(db, 'PENDING-NAME');

    const response = await send(routeApp(db), 'POST', '/api/company/preview', companyBody({ name: 'Marea Norte SpA' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ staleCount: 0, unsafeApprovals: 0 });
  });

  it('rejects an invalid preview with the generic message', async () => {
    const response = await send(routeApp(db), 'POST', '/api/company/preview', companyBody({
      limits: { perPaymentUsdMinor: 100, monthlyUsdMinor: 0, approvalThresholdUsdMinor: 100 },
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Solicitud inválida');
  });
});
