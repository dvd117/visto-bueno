import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/db';
import { createServerApp, serverRuntime } from '../../src/server/app';

const runtimes: Array<ReturnType<typeof createServerApp>> = [];

type JsonSchema = {
  [key: string]: unknown;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  allOf?: JsonSchema[];
  enum?: string[];
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
  it('documents the single-invoice decision endpoint and its idempotency contract', async () => {
    const { app } = makeRuntime();
    const response = await app.request('/api/openapi.json');
    const document = await response.json() as {
      paths?: Record<string, Record<string, {
        parameters?: Array<{ name?: string; in?: string; required?: boolean; schema?: JsonSchema }>;
        requestBody?: { required?: boolean; content?: Record<string, { schema?: JsonSchema }> };
        responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
      }>>;
      components?: { schemas?: Record<string, JsonSchema> };
    };
    const decide = document.paths?.['/api/v1/decide']?.post;
    const key = decide?.parameters?.[0];

    expect(decide).toBeDefined();
    expect(key).toMatchObject({ name: 'Idempotency-Key', in: 'header', required: true });
    expect(key?.schema?.['x-maxLengthAfterTrim']).toBe(120);
    const keyPattern = new RegExp(key?.schema?.pattern as string);
    expect(keyPattern.test(` ${'x'.repeat(120)} `)).toBe(true);
    expect(keyPattern.test(` ${'x'.repeat(121)} `)).toBe(false);
    expect(keyPattern.test('   ')).toBe(false);
    expect(decide?.requestBody).toMatchObject({
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/DecideRequest' } },
        'multipart/form-data': { schema: { $ref: '#/components/schemas/DecideFile' } },
      },
    });
    expect(decide?.responses?.['200']?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/DecideResponse',
    });
    expect(document.components?.schemas?.DecideResponse).toMatchObject({
      type: 'object',
      required: ['state', 'headline', 'reasons', 'checks', 'sealId', 'decisionRecordId'],
      properties: {
        state: { enum: ['ready', 'approval_required', 'review_required', 'stopped'] },
        reasons: { type: 'array', items: { type: 'string' } },
        checks: { type: 'array', items: { properties: { outcome: { enum: ['passed', 'failed', 'pending', 'not_applicable'] } } } },
      },
    });
    expect(document.components?.schemas?.DecideRequest?.oneOf).toBeDefined();
    expect(document.components?.schemas?.DecideFile?.properties?.file).toMatchObject({ type: 'string', format: 'binary' });
  });

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
    for (const path of ['/api/export/payments.csv', '/api/export/reconciliation.csv']) {
      expect(document.paths?.[path]?.get).toMatchObject({
        parameters: [
          { name: 'batch', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'ready', in: 'query', required: false, style: 'form', explode: true,
            schema: { type: 'array', items: { type: 'string' } },
          },
        ],
        responses: { '200': { content: { 'text/csv': { schema: { type: 'string' } } } } },
      });
    }

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
    expect(fx?.items?.properties?.currency?.enum).toEqual(['USD', 'COP', 'MXN', 'CLP', 'PEN', 'ARS', 'VES']);
    expect(fx?.allOf).toHaveLength(7);
    expect(fx?.allOf?.[0]).toMatchObject({ minContains: 0, maxContains: 1 });
    const processId = schemas.ProcessRequest?.properties?.ids?.items;
    expect(processId).toMatchObject({
      minLength: 1,
      pattern: '^\\s*[\\s\\S]{0,79}\\S\\s*$',
      'x-maxLengthAfterTrim': 80,
    });
    expect(processId?.maxLength).toBeUndefined();
    const processIdPattern = new RegExp(processId?.pattern as string);
    expect(processIdPattern.test(`${' '.repeat(40)}AL-030${' '.repeat(40)}`)).toBe(true);
    expect(processIdPattern.test(' '.repeat(3))).toBe(false);
    expect(processIdPattern.test('A'.repeat(80))).toBe(true);
    expect(processIdPattern.test('A'.repeat(81))).toBe(false);
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
