import { afterEach, afterAll, describe, expect, it } from 'vitest';
import { createServerApp, serverRuntime } from '../../src/server/app';
import { openDb } from '../../src/server/db/db';

const runtimes: Array<ReturnType<typeof createServerApp>> = [];

function makeRuntime() {
  const runtime = createServerApp({ db: openDb(':memory:'), autoCleanup: false });
  runtimes.push(runtime);
  return runtime;
}

function workspaceCount(db: ReturnType<typeof openDb>): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

afterAll(() => serverRuntime.dispose());

describe('workspace cold start', () => {
  it('sets the document cookie before parallel API calls use one workspace', async () => {
    const runtime = makeRuntime();
    runtime.app.get('/', (c) => c.html('<!doctype html><html><body>app</body></html>'));
    runtime.app.get('/api/test/workspace-id', (c) => c.json({ workspaceId: c.get('workspaceId') }));

    const document = await runtime.app.request('/', { headers: { accept: 'text/html' } });
    const setCookie = document.headers.get('set-cookie');

    expect(document.headers.get('content-type')).toContain('text/html');
    expect(setCookie ?? '').toMatch(/^workspace_id=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400/);
    expect(workspaceCount(runtime.db)).toBe(0);
    const workspaceId = setCookie!.slice('workspace_id='.length).split(';')[0];

    const responses = await Promise.all(Array.from({ length: 4 }, () => runtime.app.request('/api/test/workspace-id', {
      headers: { cookie: `workspace_id=${workspaceId}` },
    })));
    const ids = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(200);
      return (await response.json() as { workspaceId: string }).workspaceId;
    }));

    expect(ids).toEqual(Array(4).fill(workspaceId));
    expect(workspaceCount(runtime.db)).toBe(1);
    expect(runtime.db.prepare('SELECT COUNT(*) AS count FROM invoices WHERE workspace_id = ?').get(workspaceId))
      .toMatchObject({ count: 20 });
  });

  it('sets the cookie on a successful HTML SPA fallback without seeding it', async () => {
    const runtime = makeRuntime();
    runtime.app.get('/deep-link', (c) => c.html('<!doctype html><html><body>app</body></html>'));

    const response = await runtime.app.request('/deep-link', { headers: { accept: 'text/html' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('set-cookie') ?? '')
      .toMatch(/^workspace_id=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400/);
    expect(workspaceCount(runtime.db)).toBe(0);
  });

  it('seeds the examples once for parallel first API calls with the same new cookie id', async () => {
    const runtime = makeRuntime();
    const cookie = 'workspace_id=cold-start-shared';

    const responses = await Promise.all(Array.from({ length: 2 }, () => runtime.app.request('/api/invoices', { headers: { cookie } })));
    const invoiceLists = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
      return response.json() as Promise<unknown[]>;
    }));

    expect(invoiceLists.map((invoices) => invoices.length)).toEqual([20, 20]);
    expect(workspaceCount(runtime.db)).toBe(1);
    expect(runtime.db.prepare('SELECT COUNT(*) AS count FROM invoices WHERE workspace_id = ?').get('cold-start-shared'))
      .toMatchObject({ count: 20 });
  });

  it('keeps the API-only no-cookie fallback', async () => {
    const runtime = makeRuntime();
    const response = await runtime.app.request('/api/workspace');
    const setCookie = response.headers.get('set-cookie');

    expect(response.status).toBe(200);
    expect(setCookie).toMatch(/^workspace_id=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400/);
    expect(workspaceCount(runtime.db)).toBe(1);
  });

  it('does not mint a workspace for static assets or health', async () => {
    const runtime = makeRuntime();
    runtime.app.get('/assets/app.js', () => new Response('export {}', {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    }));

    const [asset, health, favicon] = await Promise.all([
      runtime.app.request('/assets/app.js', { headers: { accept: 'text/javascript' } }),
      runtime.app.request('/health', { headers: { accept: 'text/html' } }),
      runtime.app.request('/favicon.ico', { headers: { accept: 'text/html' } }),
    ]);

    expect(asset.status).toBe(200);
    expect(asset.headers.get('set-cookie')).toBeNull();
    expect(health.status).toBe(200);
    expect(health.headers.get('set-cookie')).toBeNull();
    expect(favicon.headers.get('set-cookie')).toBeNull();
    expect(workspaceCount(runtime.db)).toBe(0);
  });
});
