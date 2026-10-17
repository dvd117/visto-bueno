import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { evaluationResultSchema } from '../../shared/api';
import {
  apiErrorSchema,
  conflictSchema,
  expedienteSchema,
  invoiceRowSchema,
  logEntrySchema,
  processEventSchema,
  simulationResultSchema,
  workspaceSummarySchema,
} from '../../client/lib/api';
import {
  actionSchema,
  budgetSchema,
  contractSchema,
  processSchema,
  resolutionSchema,
  textInvoiceSchema,
  treasurySchema,
  vendorSchema,
} from './api';

type JsonSchema = Record<string, unknown>;
type Operation = Record<string, unknown>;

function zodSchema(schema: z.ZodType): JsonSchema {
  // The wire contract is the shape before any client-side normalization transforms.
  const result = { ...z.toJSONSchema(schema, { io: 'input' }) } as JsonSchema;
  delete result.$schema;
  return result;
}

function propertySchema(schema: JsonSchema, name: string): JsonSchema {
  return ((schema.properties as Record<string, JsonSchema> | undefined)?.[name] ?? {});
}

function withProperties(
  schema: JsonSchema,
  overrides: Record<string, JsonSchema>,
  extensions: Record<string, unknown> = {},
): JsonSchema {
  return {
    ...schema,
    ...extensions,
    properties: {
      ...((schema.properties as Record<string, JsonSchema> | undefined) ?? {}),
      ...overrides,
    },
  };
}

function mapProperties(
  schema: JsonSchema,
  names: string[],
  map: (property: JsonSchema) => JsonSchema,
): JsonSchema {
  return withProperties(schema, Object.fromEntries(names.map((name) => [
    name, map(propertySchema(schema, name)),
  ])));
}

function nonBlankProperties(schema: JsonSchema, names: string[]): JsonSchema {
  return mapProperties(schema, names, (property) => ({ ...property, pattern: '\\S' }));
}

function safeIntegerProperties(schema: JsonSchema, names: string[]): JsonSchema {
  return mapProperties(schema, names, (property) => ({ ...property, maximum: Number.MAX_SAFE_INTEGER }));
}

const contractShapeConstraints = [{
  if: { properties: { type: { const: 'fixed' } }, required: ['type'] },
  then: {
    properties: { amountMinor: {} },
    required: ['amountMinor'],
    not: { anyOf: [
      { properties: { rateMinor: {} }, required: ['rateMinor'] },
      { properties: { unit: {} }, required: ['unit'] },
      { properties: { maxUnitsPerPeriod: {} }, required: ['maxUnitsPerPeriod'] },
    ] },
  },
  else: {
    properties: { rateMinor: {}, unit: {}, maxUnitsPerPeriod: {}, amountMinor: {} },
    required: ['rateMinor', 'unit', 'maxUnitsPerPeriod'],
    not: { properties: { amountMinor: {} }, required: ['amountMinor'] },
  },
}];

const invoiceTextSchema = nonBlankProperties(zodSchema(textInvoiceSchema), ['text']);
const decisionActionSchema = nonBlankProperties(zodSchema(actionSchema), ['approver', 'reason', 'idempotencyKey']);
const flagResolutionSchema = nonBlankProperties(zodSchema(resolutionSchema), ['choice', 'reason', 'approver']);
const processRequestBase = zodSchema(processSchema);
const processIds = propertySchema(processRequestBase, 'ids');
const processRequestSchema = withProperties(processRequestBase, {
  ids: {
    ...processIds,
    items: { ...(processIds.items as JsonSchema), pattern: '\\S' },
  },
}, {
  description: 'examples=true procesa los ejemplos sembrados en replay y excluye ids; mode=live requiere ids.',
  allOf: [
    {
      if: { properties: { examples: { const: true } }, required: ['examples'] },
      then: {
        properties: { ids: {} },
        not: { anyOf: [
          { properties: { ids: {} }, required: ['ids'] },
          { properties: { mode: { const: 'live' } }, required: ['mode'] },
        ] },
      },
    },
    {
      if: { properties: { mode: { const: 'live' } }, required: ['mode'] },
      then: { properties: { ids: {} }, required: ['ids'] },
    },
  ],
});

const vendorSchemaBase = safeIntegerProperties(
  nonBlankProperties(zodSchema(vendorSchema), ['id', 'name', 'taxId', 'payoutAccount']),
  ['version'],
);
const contractSchemaBase = safeIntegerProperties(
  nonBlankProperties(zodSchema(contractSchema), ['id', 'vendorId', 'scope', 'unit']),
  ['amountMinor', 'rateMinor', 'maxUnitsPerPeriod', 'version'],
);
const contractProperties = {
  start: { ...propertySchema(contractSchemaBase, 'start'), format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  end: { ...propertySchema(contractSchemaBase, 'end'), format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
};
const contractSchemaDocument = withProperties(contractSchemaBase, contractProperties, {
  description: 'start y end son fechas ISO válidas; start debe ser anterior o igual a end.',
  allOf: contractShapeConstraints,
  'x-runtime-constraints': [{
    fields: ['start', 'end'],
    relation: 'start <= end',
  }],
});
const budgetSchemaDocument = safeIntegerProperties(zodSchema(budgetSchema), ['approvedUsdMinor']);
const treasurySchemaBase = safeIntegerProperties(zodSchema(treasurySchema), ['balanceUsdMinor']);
const fxArray = propertySchema(treasurySchemaBase, 'fx');
const fxItem = fxArray.items as JsonSchema;
const fxItemWithConstraints = withProperties(fxItem, {
  perUsd: { ...propertySchema(fxItem, 'perUsd'), pattern: '^(?=.*[1-9])\\d+(?:\\.\\d+)?$' },
  date: { ...propertySchema(fxItem, 'date'), format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
});
const treasurySchemaDocument = withProperties(treasurySchemaBase, {
  fx: {
    ...fxArray,
    description: 'Cada moneda puede aparecer una sola vez.',
    items: fxItemWithConstraints,
    allOf: ['USD', 'COP', 'MXN'].map((currency) => ({
      contains: {
        properties: { currency: { const: currency } },
        required: ['currency'],
      },
      minContains: 0,
      maxContains: 1,
    })),
  },
});

const evaluationResultJsonSchema = {
  ...zodSchema(evaluationResultSchema),
  'x-runtime-constraints': [
    'Los resultados disponibles exigen métricas de regresión y de etiquetas no vacías y coherentes.',
    'Los estados de seguridad deben coincidir con los conteos de aprobaciones inseguras; los resúmenes deben coincidir con la evidencia principal.',
    'Una muestra en vivo disponible debe ser no vacía, tener fallas no mayores que la muestra y coincidir con report.live; si no está disponible, se omite report.live.',
  ],
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: JsonSchema | ReturnType<typeof ref>) => ({ 'application/json': { schema } });
const jsonResponse = (description: string, schema: JsonSchema | ReturnType<typeof ref>) => ({
  description,
  content: jsonContent(schema),
});
const errorResponse = jsonResponse('La solicitud no se pudo completar.', ref('ApiError'));

function operation(
  operationId: string,
  summary: string,
  responses: Record<string, unknown>,
  options: {
    description?: string;
    parameters?: Array<Record<string, unknown>>;
    requestBody?: Record<string, unknown>;
  } = {},
): Operation {
  return {
    operationId,
    summary,
    ...(options.description ? { description: options.description } : {}),
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.requestBody ? { requestBody: options.requestBody } : {}),
    responses: { default: errorResponse, ...responses },
  };
}

function pathParameter(name: string, description: string, enumValues?: string[]): Record<string, unknown> {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: enumValues ? { type: 'string', enum: enumValues } : { type: 'string' },
  };
}

function requestBody(
  description: string,
  content: Record<string, unknown>,
): Record<string, unknown> {
  return { required: true, description, content };
}

const rulesSchema: JsonSchema = {
  type: 'object',
  description: 'approvalThresholdUsdMinor debe ser menor que perPaymentLimitUsdMinor.',
  'x-runtime-constraints': [{
    fields: ['approvalThresholdUsdMinor', 'perPaymentLimitUsdMinor'],
    relation: 'approvalThresholdUsdMinor < perPaymentLimitUsdMinor',
  }],
  properties: {
    version: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    perPaymentLimitUsdMinor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    monthlyLimitUsdMinor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    approvalThresholdUsdMinor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    fuzzyDuplicateWindowDays: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    preset: { type: 'string', enum: ['estricto', 'equilibrado', 'permisivo'] },
  },
  required: [
    'version', 'perPaymentLimitUsdMinor', 'monthlyLimitUsdMinor',
    'approvalThresholdUsdMinor', 'fuzzyDuplicateWindowDays', 'preset',
  ],
  additionalProperties: false,
};

const components: Record<string, JsonSchema> = {
  ApiError: zodSchema(apiErrorSchema),
  ConflictResponse: zodSchema(conflictSchema),
  WorkspaceSummary: zodSchema(workspaceSummarySchema),
  InvoiceRow: zodSchema(invoiceRowSchema),
  InvoiceRows: zodSchema(z.array(invoiceRowSchema)),
  Expediente: zodSchema(expedienteSchema),
  ProcessEvent: zodSchema(processEventSchema),
  ProcessRequest: processRequestSchema,
  NewInvoiceText: invoiceTextSchema,
  DecisionAction: decisionActionSchema,
  FlagResolution: flagResolutionSchema,
  Vendor: vendorSchemaBase,
  Vendors: { ...zodSchema(z.array(vendorSchema)), items: vendorSchemaBase },
  Contract: contractSchemaDocument,
  Contracts: { ...zodSchema(z.array(contractSchema)), items: contractSchemaDocument },
  Budget: budgetSchemaDocument,
  Budgets: { ...zodSchema(z.array(budgetSchema)), items: budgetSchemaDocument },
  Treasury: treasurySchemaDocument,
  Rules: rulesSchema,
  SimulationRequest: {
    type: 'object',
    properties: { rules: ref('Rules') },
    required: ['rules'],
    additionalProperties: false,
  },
  SimulationResult: zodSchema(simulationResultSchema),
  LogEntry: zodSchema(logEntrySchema),
  LogEntries: zodSchema(z.array(logEntrySchema)),
  EvaluationResult: evaluationResultJsonSchema,
  ResetResult: {
    type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false,
  },
  CsvUploadResult: {
    type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false,
  },
  InvoiceFileUpload: {
    type: 'object',
    properties: { file: { type: 'string', format: 'binary', description: 'PDF, PNG, JPEG o WebP.' } },
    required: ['file'],
  },
  CsvFileUpload: {
    type: 'object',
    properties: { file: { type: 'string', format: 'binary', description: 'Archivo CSV.' } },
    required: ['file'],
  },
  DataTableValue: {
    oneOf: [ref('Vendors'), ref('Contracts'), ref('Budgets'), ref('Treasury')],
  },
  DataTableRow: {
    oneOf: [ref('Vendor'), ref('Contract'), ref('Budget'), ref('Treasury')],
  },
};

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Visto Bueno API',
    version: packageJson.version,
    description: 'Demo con datos ficticios: no se realizan pagos reales. Las aprobaciones y los rechazos son acciones humanas registradas con una identidad declarada ("identidad declarada").',
  },
  servers: [{ url: '/', description: 'Servidor actual' }],
  security: [{ workspaceCookie: [] }],
  components: {
    securitySchemes: {
      workspaceCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'workspace_id',
        description: 'Cookie de workspace establecida por el middleware; aísla las solicitudes de cada espacio de trabajo.',
      },
    },
    schemas: components,
  },
  paths: {
    '/api/workspace': {
      get: operation('getWorkspace', 'Consultar el workspace', {
        '200': jsonResponse('Resumen del workspace.', ref('WorkspaceSummary')),
      }),
    },
    '/api/workspace/reset': {
      post: operation('resetWorkspace', 'Reiniciar el workspace', {
        '200': jsonResponse('Workspace reiniciado.', ref('ResetResult')),
      }, {
        description: 'Restablece los datos de demostración del workspace actual.',
      }),
    },
    '/api/invoices': {
      get: operation('listInvoices', 'Listar facturas', {
        '200': jsonResponse('Facturas del workspace.', ref('InvoiceRows')),
      }),
      post: operation('createInvoice', 'Recibir una factura', {
        '201': jsonResponse('Factura recibida.', ref('InvoiceRow')),
      }, {
        requestBody: requestBody('Envía texto JSON o un archivo PDF/imagen.', {
          'application/json': { schema: ref('NewInvoiceText') },
          'multipart/form-data': { schema: ref('InvoiceFileUpload') },
        }),
      }),
    },
    '/api/invoices/{id}': {
      get: operation('getInvoice', 'Leer el expediente de una factura', {
        '200': jsonResponse('Expediente de la factura.', ref('Expediente')),
      }, { parameters: [pathParameter('id', 'Identificador de la factura.')] }),
    },
    '/api/process': {
      post: operation('processInvoices', 'Procesar facturas', {
        '200': {
          description: 'Flujo SSE; cada campo data contiene un ProcessEvent JSON.',
          content: {
            'text/event-stream': {
              schema: { type: 'string' },
              'x-event-payload-schema': ref('ProcessEvent'),
            },
          },
        },
      }, {
        requestBody: requestBody('IDs y modo opcionales; examples=true procesa las facturas de demostración.', {
          'application/json': { schema: ref('ProcessRequest') },
        }),
      }),
    },
    '/api/invoices/{id}/approve': {
      post: operation('approveInvoice', 'Registrar aprobación humana', {
        '200': jsonResponse('Expediente actualizado.', ref('Expediente')),
        '409': jsonResponse('La factura cambió o no puede aprobarse.', ref('ConflictResponse')),
      }, {
        description: 'Acción humana existente; requiere identidad declarada y no convierte una factura frenada en aprobable.',
        parameters: [pathParameter('id', 'Identificador de la factura.')],
        requestBody: requestBody('Identidad, motivo, clave de idempotencia y, para imágenes, los últimos 4 dígitos de la cuenta.', {
          'application/json': { schema: ref('DecisionAction') },
        }),
      }),
    },
    '/api/invoices/{id}/reject': {
      post: operation('rejectInvoice', 'Registrar rechazo humano', {
        '200': jsonResponse('Expediente actualizado.', ref('Expediente')),
        '409': jsonResponse('La factura cambió y no se pudo registrar el rechazo.', ref('ConflictResponse')),
      }, {
        description: 'Acción humana existente registrada con identidad declarada.',
        parameters: [pathParameter('id', 'Identificador de la factura.')],
        requestBody: requestBody('Identidad declarada, motivo y clave de idempotencia.', {
          'application/json': { schema: ref('DecisionAction') },
        }),
      }),
    },
    '/api/invoices/{id}/flags/{flagId}/resolve': {
      post: operation('resolveInvoiceFlag', 'Resolver una observación', {
        '200': jsonResponse('Expediente actualizado.', ref('Expediente')),
        '409': jsonResponse('La observación ya no se pudo resolver.', ref('ConflictResponse')),
      }, {
        parameters: [
          pathParameter('id', 'Identificador de la factura.'),
          pathParameter('flagId', 'Identificador de la observación.'),
        ],
        requestBody: requestBody('Decisión, motivo e identidad declarada.', {
          'application/json': { schema: ref('FlagResolution') },
        }),
      }),
    },
    '/api/invoices/{id}/reevaluate': {
      post: operation('reevaluateInvoice', 'Reevaluar una factura', {
        '200': jsonResponse('Expediente reevaluado.', ref('Expediente')),
      }, { parameters: [pathParameter('id', 'Identificador de la factura.')] }),
    },
    '/api/data/{table}': {
      get: operation('getDataTable', 'Consultar datos del workspace', {
        '200': jsonResponse('Filas de la tabla seleccionada.', ref('DataTableValue')),
      }, {
        parameters: [pathParameter('table', 'Tabla disponible.', ['vendors', 'contracts', 'budgets', 'treasury'])],
      }),
      put: operation('putDataRow', 'Guardar una fila de datos', {
        '200': jsonResponse('Fila guardada.', ref('DataTableRow')),
      }, {
        parameters: [pathParameter('table', 'Tabla disponible.', ['vendors', 'contracts', 'budgets', 'treasury'])],
        requestBody: requestBody('Envía una fila del tipo indicado por table.', {
          'application/json': { schema: ref('DataTableRow') },
        }),
      }),
    },
    '/api/data/{table}/csv': {
      post: operation('uploadDataCsv', 'Importar datos CSV', {
        '200': jsonResponse('CSV importado.', ref('CsvUploadResult')),
      }, {
        parameters: [pathParameter('table', 'Tabla CSV disponible.', ['vendors', 'contracts', 'budgets', 'fx'])],
        requestBody: requestBody('Archivo CSV enviado como campo file.', {
          'multipart/form-data': { schema: ref('CsvFileUpload') },
        }),
      }),
    },
    '/api/data/{table}/template.csv': {
      get: operation('getDataCsvTemplate', 'Descargar una plantilla CSV', {
        '200': {
          description: 'Plantilla CSV para la tabla.',
          content: { 'text/csv': { schema: { type: 'string' } } },
        },
      }, {
        parameters: [pathParameter('table', 'Plantilla disponible.', ['vendors', 'contracts', 'budgets', 'fx'])],
      }),
    },
    '/api/log': {
      get: operation('getAuditLog', 'Consultar la bitácora', {
        '200': jsonResponse('Eventos de auditoría del workspace.', ref('LogEntries')),
      }),
    },
    '/api/export/payments.csv': {
      get: operation('exportPaymentsCsv', 'Exportar el lote de pagos', {
        '200': { description: 'CSV de exportación.', content: { 'text/csv': { schema: { type: 'string' } } } },
      }),
    },
    '/api/export/log.csv': {
      get: operation('exportLogCsv', 'Exportar la bitácora CSV', {
        '200': { description: 'CSV de bitácora.', content: { 'text/csv': { schema: { type: 'string' } } } },
      }),
    },
    '/api/export/report.md': {
      get: operation('exportReportMarkdown', 'Exportar la bitácora Markdown', {
        '200': { description: 'Informe Markdown.', content: { 'text/markdown': { schema: { type: 'string' } } } },
      }),
    },
    '/api/files/{invoiceId}': {
      get: operation('getInvoiceFile', 'Consultar el archivo de una factura', {
        '200': {
          description: 'Archivo PDF o imagen de la factura.',
          content: Object.fromEntries(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].map((type) => [
            type, { schema: { type: 'string', format: 'binary' } },
          ])),
        },
      }, { parameters: [pathParameter('invoiceId', 'Identificador de la factura.')] }),
    },
    '/api/eval': {
      get: operation('getEvaluation', 'Consultar el informe de evaluación', {
        '200': jsonResponse('Resultados de evaluación.', ref('EvaluationResult')),
        '503': jsonResponse('La evaluación todavía no está disponible.', ref('ApiError')),
      }),
    },
    '/api/rules': {
      get: operation('getRules', 'Consultar las reglas', {
        '200': jsonResponse('Configuración de reglas del workspace.', ref('Rules')),
      }),
      put: operation('putRules', 'Guardar las reglas', {
        '200': jsonResponse('Configuración guardada.', ref('Rules')),
      }, {
        requestBody: requestBody('Configuración completa de reglas.', {
          'application/json': { schema: ref('Rules') },
        }),
      }),
    },
    '/api/rules/simulate': {
      post: operation('simulateRules', 'Simular el impacto de las reglas', {
        '200': jsonResponse('Resultado de la simulación.', ref('SimulationResult')),
      }, {
        requestBody: requestBody('Reglas candidatas para la simulación.', {
          'application/json': { schema: ref('SimulationRequest') },
        }),
      }),
    },
  },
} as const;

export function createOpenApiRoutes(): Hono {
  const routes = new Hono();
  routes.get('/openapi.json', (c) => c.json(openApiDocument));
  return routes;
}
