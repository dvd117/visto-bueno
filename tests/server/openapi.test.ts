import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/db';
import { actionSchema } from '../../src/server/routes/api';
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

    const trimmedProperties: Array<{ property: JsonSchema | undefined; maxLength: number }> = [
      { property: schemas.NewInvoiceText?.properties?.text, maxLength: 2 * 1024 * 1024 },
      { property: schemas.DecisionAction?.properties?.approver, maxLength: 120 },
      { property: schemas.DecisionAction?.properties?.reason, maxLength: 500 },
      { property: schemas.DecisionAction?.properties?.idempotencyKey, maxLength: 120 },
      { property: schemas.FlagResolution?.properties?.choice, maxLength: 120 },
      { property: schemas.FlagResolution?.properties?.reason, maxLength: 500 },
      { property: schemas.FlagResolution?.properties?.approver, maxLength: 120 },
      { property: schemas.Vendor?.properties?.id, maxLength: 100 },
      { property: schemas.Vendor?.properties?.name, maxLength: 200 },
      { property: schemas.Vendor?.properties?.taxId, maxLength: 100 },
      { property: schemas.Vendor?.properties?.payoutAccount, maxLength: 200 },
      { property: schemas.Contract?.properties?.id, maxLength: 100 },
      { property: schemas.Contract?.properties?.vendorId, maxLength: 100 },
      { property: schemas.Contract?.properties?.scope, maxLength: 500 },
      { property: schemas.Contract?.properties?.unit, maxLength: 100 },
    ];
    for (const { property, maxLength } of trimmedProperties) {
      expect(property?.minLength).toBe(1);
      expect(property?.maxLength).toBeUndefined();
      expect(property?.['x-maxLengthAfterTrim']).toBe(maxLength);
      expect(typeof property?.pattern).toBe('string');
      if (maxLength <= 1000) {
        const pattern = new RegExp(property?.pattern as string);
        expect(pattern.test(`  ${'x'.repeat(maxLength)}  `)).toBe(true);
        expect(pattern.test(`  ${'x'.repeat(maxLength + 1)}  `)).toBe(false);
        expect(pattern.test('   ')).toBe(false);
      }
    }
    expect(schemas.DecisionAction?.properties?.accountLast4?.maxLength).toBe(32);
    const paddedApprover = `  ${'A'.repeat(120)}  `;
    expect(actionSchema.safeParse({
      approver: paddedApprover, reason: 'Validar', idempotencyKey: 'approve-1',
    }).success).toBe(true);
    const approverPattern = new RegExp(schemas.DecisionAction?.properties?.approver?.pattern as string);
    expect(approverPattern.test(paddedApprover)).toBe(true);
    expect(approverPattern.test(`  ${'A'.repeat(121)}  `)).toBe(false);
    expect(approverPattern.test('   ')).toBe(false);
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
