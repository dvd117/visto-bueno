import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/db';
import { createServerApp, serverRuntime } from '../../src/server/app';

const runtimes: Array<ReturnType<typeof createServerApp>> = [];

type JsonSchema = {
  [key: string]: unknown;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  allOf?: JsonSchema[];
};

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
      components?: {
        securitySchemes?: Record<string, Record<string, unknown>>;
        schemas?: Record<string, JsonSchema>;
      };
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

  it('documents runtime input refinements and cross-field constraints', async () => {
    const { app } = makeRuntime();
    const response = await app.request('/api/openapi.json');
    const document = await response.json() as {
      components?: { schemas?: Record<string, JsonSchema> };
    };
    const schemas = document.components?.schemas ?? {};
    const contract = schemas.Contract;
    const fx = schemas.Treasury?.properties?.fx;

    expect(schemas.NewInvoiceText?.properties?.text).toMatchObject({
      minLength: 1, maxLength: 2 * 1024 * 1024, pattern: '\\S',
    });
    expect(contract?.properties?.start).toMatchObject({
      type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    });
    expect(contract?.properties?.end).toMatchObject({
      type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    });
    expect(contract?.properties?.version?.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(contract?.allOf?.[0]).toMatchObject({
      if: { properties: { type: { const: 'fixed' } } },
      then: { required: ['amountMinor'] },
      else: { required: ['rateMinor', 'unit', 'maxUnitsPerPeriod'] },
    });
    expect(contract?.['x-runtime-constraints']).toContainEqual({ fields: ['start', 'end'], relation: 'start <= end' });
    expect(fx?.items?.properties?.perUsd?.pattern).toBe('^(?=.*[1-9])\\d+(?:\\.\\d+)?$');
    expect(fx?.items?.properties?.date).toMatchObject({ format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
    expect(fx?.allOf).toHaveLength(3);
    expect(fx?.allOf?.[0]).toMatchObject({ minContains: 0, maxContains: 1 });
    expect(schemas.ProcessRequest?.properties?.ids?.items).toMatchObject({ minLength: 1, pattern: '\\S' });
    expect(schemas.ProcessRequest?.allOf).toHaveLength(2);
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
