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
          {
            name: 'X-Client-Id', in: 'header', required: false,
            schema: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$' },
          },
          { name: 'batch', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'ready', in: 'query', required: false, style: 'form', explode: true,
            schema: { type: 'array', items: { type: 'string' } },
          },
          { name: 'client_id', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$' } },
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

  it('documents the optional client header and direct-download client query', async () => {
    const { app } = makeRuntime();
    const response = await app.request('/api/openapi.json');
    const document = await response.json() as { paths?: Record<string, Record<string, Record<string, unknown>>> };
    const mutation = document.paths?.['/api/data/{table}']?.put;
    const file = document.paths?.['/api/files/{invoiceId}']?.get;
    const exportPayment = document.paths?.['/api/export/payments.csv']?.get;
    const parameters = mutation?.parameters as Array<Record<string, unknown>> | undefined;

    expect(parameters).toContainEqual(expect.objectContaining({
      name: 'X-Client-Id', in: 'header', required: false,
      description: expect.stringContaining('Si se omite, se usa active_client_id'),
    }));
    expect(mutation?.responses).not.toHaveProperty('409');
    expect(file?.parameters).toContainEqual(expect.objectContaining({
      name: 'client_id', in: 'query', required: false,
      description: expect.stringContaining('debe pertenecer al owner'),
    }));
    expect(exportPayment?.parameters).toContainEqual(expect.objectContaining({ name: 'client_id', in: 'query' }));
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

  it('documents company profile read, save, and preview routes', async () => {
    const { app } = makeRuntime();
    const response = await app.request('/api/openapi.json');
    const document = await response.json() as {
      paths?: Record<string, Record<string, unknown>>;
      components?: { schemas?: Record<string, JsonSchema> };
    };
    const schemas = document.components?.schemas ?? {};

    expect(document.paths?.['/api/company']).toMatchObject({
      get: {
        operationId: 'getCompanyProfile',
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/CompanyRecord' } } } } },
      },
      put: {
        operationId: 'putCompanyProfile',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CompanyRecord' } } } },
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/CompanyRecord' } } } } },
      },
    });
    expect(document.paths?.['/api/company/preview']).toMatchObject({
      post: {
        operationId: 'previewCompanyProfile',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CompanyRecord' } } } },
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/CompanyPreview' } } } } },
      },
    });
    expect(schemas.CompanyRecord).toMatchObject({
      type: 'object',
      properties: {
        name: {
          pattern: '^\\s*[\\s\\S]{0,119}\\S\\s*$',
          'x-maxLengthAfterTrim': 120,
        },
        operatingCountries: { type: 'array', uniqueItems: true, items: { enum: ['CO', 'MX', 'VE', 'CL', 'PE', 'AR', 'US'] } },
        currencies: { type: 'array', contains: { const: 'USD' } },
        limits: {
          description: 'approvalThresholdUsdMinor debe ser menor que perPaymentUsdMinor.',
          'x-runtime-constraints': [{
            fields: ['approvalThresholdUsdMinor', 'perPaymentUsdMinor'],
            relation: 'approvalThresholdUsdMinor < perPaymentUsdMinor',
          }],
          properties: { perPaymentUsdMinor: { maximum: Number.MAX_SAFE_INTEGER } },
        },
      },
    });
    expect(schemas.CompanyRecord?.properties?.name?.maxLength).toBeUndefined();
    expect(schemas.CompanyPreview?.properties?.staleCount).toMatchObject({ type: 'integer', minimum: 0 });
  });

  it('documents the K1 client directory and switching request and responses', async () => {
    const { app } = makeRuntime();
    const response = await app.request('/api/openapi.json');
    const document = await response.json() as {
      paths?: Record<string, Record<string, unknown>>;
      components?: { schemas?: Record<string, JsonSchema> };
    };
    const schemas = document.components?.schemas ?? {};

    expect(document.paths?.['/api/clients']?.get).toMatchObject({
      operationId: 'listClients',
      responses: {
        '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientDirectory' } } } },
      },
    });
    expect(document.paths?.['/api/clients/switch']?.post).toMatchObject({
      operationId: 'switchClient',
      requestBody: {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientSwitchRequest' } } },
      },
      responses: {
        '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientSwitchResponse' } } } },
        '400': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        '404': { content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
      },
    });
    expect(schemas.ClientDirectory).toMatchObject({
      type: 'object', required: ['activeId', 'clients'],
      properties: {
        activeId: { type: 'string' },
        clients: { type: 'array', items: { type: 'object', required: ['id', 'name', 'invoiceCount', 'readyCount'] } },
      },
    });
    expect(schemas.ClientSwitchRequest).toMatchObject({
      type: 'object', required: ['clientId'], properties: {
        clientId: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$' },
      },
    });
    expect(schemas.ClientSwitchResponse).toMatchObject({
      type: 'object', required: ['activeId'], properties: { activeId: { type: 'string' } },
    });
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
