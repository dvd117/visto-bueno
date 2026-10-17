import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/db';
import { createServerApp, serverRuntime } from '../../src/server/app';

const runtimes: Array<ReturnType<typeof createServerApp>> = [];

function makeRuntime() {
  const runtime = createServerApp({ db: openDb(':memory:'), autoCleanup: false });
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

afterAll(() => serverRuntime.dispose());

describe('OpenAPI document', () => {
  it('is an OpenAPI 3.1 document and includes every registered API route', async () => {
    const { app } = makeRuntime();
    const response = await app.request('/api/openapi.json');
    const document = await response.json() as {
      openapi?: string;
      info?: { title?: string; version?: string; description?: string };
      paths?: Record<string, Record<string, unknown>>;
      components?: { securitySchemes?: Record<string, Record<string, unknown>> };
    };

    expect(response.status).toBe(200);
    expect(document.openapi).toMatch(/^3\.1\./);
    expect(document.info).toMatchObject({ title: 'Visto Bueno API' });
    expect(document.info?.version).toBeTruthy();
    expect(document.info?.description).toContain('identidad declarada');
    expect(Object.keys(document.paths ?? {})).not.toHaveLength(0);
    expect(document.components?.securitySchemes?.workspaceCookie).toMatchObject({
      type: 'apiKey', in: 'cookie', name: 'workspace_id',
    });

    const registeredApiRoutes = app.routes.filter(({ method, path }) =>
      path.startsWith('/api/') && path !== '/api/openapi.json' && method !== 'ALL');
    for (const route of registeredApiRoutes) {
      const path = route.path.replace(/:([^/]+)/g, '{$1}');
      expect(
        document.paths?.[path]?.[route.method.toLowerCase()],
        `${route.method} ${route.path} must be documented`,
      ).toBeDefined();
    }
  });

  it('is available without creating a workspace or setting a cookie', async () => {
    const { app, db } = makeRuntime();
    const response = await app.request('/api/openapi.json');

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    const row = db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number };
    expect(row.count).toBe(0);
  });
});
