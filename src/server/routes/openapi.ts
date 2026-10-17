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
  const result = { ...z.toJSONSchema(schema) } as JsonSchema;
  delete result.$schema;
  return result;
}

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
  ProcessRequest: zodSchema(processSchema),
  NewInvoiceText: zodSchema(textInvoiceSchema),
  DecisionAction: zodSchema(actionSchema),
  FlagResolution: zodSchema(resolutionSchema),
  Vendor: zodSchema(vendorSchema),
  Vendors: zodSchema(z.array(vendorSchema)),
  Contract: zodSchema(contractSchema),
  Contracts: zodSchema(z.array(contractSchema)),
  Budget: zodSchema(budgetSchema),
  Budgets: zodSchema(z.array(budgetSchema)),
  Treasury: zodSchema(treasurySchema),
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
  EvaluationResult: zodSchema(evaluationResultSchema),
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
