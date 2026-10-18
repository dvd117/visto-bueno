import Decimal from 'decimal.js';
import { z } from 'zod';
import type {
  ApiError,
  ConflictResponse,
  DecisionAction,
  Expediente,
  FlagResolution,
  InvoiceRow,
  LogEntry,
  NewInvoiceText,
  ProcessEvent,
  ProcessRequest,
  WorkspaceSummary,
} from '../../shared/api';
import { evaluationResultSchema } from '../../shared/api';
import type { Budget, Contract, FxRate, Treasury, Vendor } from '../../shared/domain/types';
import {
  apiErrorSchema,
  companyPreviewSchema,
  companyRecordSchema,
  conflictSchema,
  countrySchema,
  currencySchema,
  expedienteSchema,
  invoiceRowSchema,
  logEntrySchema,
  processEventSchema,
  rulesSchema,
  simulationResultSchema,
  workspaceSummarySchema,
} from '../../shared/api-schemas';
export {
  apiErrorSchema,
  companyPreviewSchema,
  companyRecordSchema,
  conflictSchema,
  expedienteSchema,
  invoiceRowSchema,
  logEntrySchema,
  processEventSchema,
  simulationResultSchema,
  workspaceSummarySchema,
} from '../../shared/api-schemas';
import type {
  BitacoraApi, CsvTable, DataRowMap, DataTable, DataTableValues, DataUploadResult, DatosApi, EvaluationResult, ReglasApi,
} from './api-types';

const safeInteger = z.number().int().refine(Number.isSafeInteger, 'Debe ser un entero seguro.');
const positiveInteger = safeInteger.min(1);
const nonNegativeInteger = safeInteger.min(0);
const costCenterSchema = z.enum(['ingenieria', 'diseno', 'operaciones', 'legal']);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const vendorSchema: z.ZodType<Vendor> = z.object({
  id: z.string().min(1), name: z.string().min(1), taxId: z.string().min(1),
  country: countrySchema, payoutCurrency: currencySchema,
  payoutAccount: z.string().min(1), status: z.enum(['allowed', 'blocked']), version: positiveInteger,
}).strict();
const contractSchema: z.ZodType<Contract> = z.object({
  id: z.string().min(1), vendorId: z.string().min(1), scope: z.string().min(1),
  type: z.enum(['fixed', 'variable']), currency: currencySchema,
  amountMinor: positiveInteger.optional(), rateMinor: positiveInteger.optional(),
  unit: z.string().min(1).optional(), maxUnitsPerPeriod: positiveInteger.optional(),
  billingFrequency: z.enum(['monthly', 'one_time', 'annual']), costCenter: costCenterSchema,
  start: isoDateSchema, end: isoDateSchema, version: positiveInteger,
}).strict().superRefine((contract, context) => {
  if (contract.start > contract.end) context.addIssue({ code: 'custom', path: ['end'], message: 'Invalid range.' });
  if (contract.type === 'fixed' && (contract.amountMinor === undefined || contract.rateMinor !== undefined
    || contract.unit !== undefined || contract.maxUnitsPerPeriod !== undefined)) {
    context.addIssue({ code: 'custom', path: ['type'], message: 'Invalid fixed contract.' });
  }
  if (contract.type === 'variable' && (contract.rateMinor === undefined || !contract.unit
    || contract.maxUnitsPerPeriod === undefined || contract.amountMinor !== undefined)) {
    context.addIssue({ code: 'custom', path: ['type'], message: 'Invalid variable contract.' });
  }
});
const budgetSchema: z.ZodType<Budget> = z.object({
  costCenter: costCenterSchema, month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  approvedUsdMinor: nonNegativeInteger,
}).strict();
const fxSchema: z.ZodType<FxRate> = z.object({
  currency: currencySchema,
  perUsd: z.string().regex(/^\d+(?:\.\d+)?$/).refine((value) => new Decimal(value).isPositive()),
  date: isoDateSchema,
}).strict();
const treasurySchema: z.ZodType<Treasury> = z.object({
  balanceUsdMinor: nonNegativeInteger, fx: z.array(fxSchema).min(1).max(20),
}).strict().superRefine((treasury, context) => {
  const currencies = treasury.fx.map(({ currency }) => currency);
  if (new Set(currencies).size !== currencies.length) {
    context.addIssue({ code: 'custom', path: ['fx'], message: 'Duplicate FX currency.' });
  }
});
const dataSchemas: Record<DataTable, z.ZodType<unknown>> = {
  vendors: z.array(vendorSchema), contracts: z.array(contractSchema),
  budgets: z.array(budgetSchema), treasury: treasurySchema,
};
const dataRowSchemas: Record<DataTable, z.ZodType<unknown>> = {
  vendors: vendorSchema, contracts: contractSchema, budgets: budgetSchema, treasury: treasurySchema,
};
export class ApiRequestError extends Error {
  readonly status: number;
  readonly payload: ApiError | ConflictResponse | null;

  constructor(
    message: string,
    status: number,
    payload: ApiError | ConflictResponse | null = null,
  ) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.name = 'ApiRequestError';
  }
}

async function readError(response: Response): Promise<ApiRequestError> {
  let raw: unknown = null;
  try {
    raw = await response.json();
  } catch {
    // An empty or non-JSON error body still gets a useful status-based message.
  }
  const apiError = apiErrorSchema.safeParse(raw);
  if (apiError.success) return new ApiRequestError(apiError.data.message, response.status, apiError.data);
  const conflict = conflictSchema.safeParse(raw);
  if (conflict.success) return new ApiRequestError('La factura cambió. Revisa el expediente actualizado.', response.status, conflict.data);
  return new ApiRequestError('No pude completar la solicitud.', response.status);
}

async function requestJson<T>(url: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw await readError(response);
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new ApiRequestError('El servidor devolvió una respuesta vacía o inválida.', response.status);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiRequestError('El servidor devolvió una respuesta inválida.', response.status);
  return parsed.data;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export function getWorkspace(): Promise<WorkspaceSummary> {
  return requestJson('/api/workspace', workspaceSummarySchema);
}

export function getInvoices(): Promise<InvoiceRow[]> {
  return requestJson('/api/invoices', z.array(invoiceRowSchema));
}

export async function getEvaluation(): Promise<EvaluationResult | null> {
  const response = await fetch('/api/eval');
  if (response.status === 503) return null;
  if (!response.ok) throw await readError(response);

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new ApiRequestError('El servidor devolvió una respuesta vacía o inválida.', response.status);
  }
  const parsed = evaluationResultSchema.safeParse(raw);
  if (!parsed.success) throw new ApiRequestError('El servidor devolvió una respuesta inválida.', response.status);
  return parsed.data;
}

export function getExpediente(id: string): Promise<Expediente> {
  return requestJson(`/api/invoices/${encodeURIComponent(id)}`, expedienteSchema);
}

function isNewInvoiceText(input: File | NewInvoiceText): input is NewInvoiceText {
  return 'text' in input && typeof input.text === 'string';
}

export function createInvoice(input: File | NewInvoiceText): Promise<InvoiceRow> {
  if (isNewInvoiceText(input)) {
    return requestJson('/api/invoices', invoiceRowSchema, {
      ...jsonInit('POST', input),
    });
  }
  const body = new FormData();
  body.append('file', input);
  return requestJson('/api/invoices', invoiceRowSchema, { method: 'POST', body });
}

export async function resetWorkspace(): Promise<void> {
  const response = await fetch('/api/workspace/reset', { method: 'POST' });
  if (!response.ok) throw await readError(response);
}

export async function processInvoices(
  request: ProcessRequest,
  onEvent: (event: ProcessEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/process', {
    ...jsonInit('POST', request),
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok) throw await readError(response);
  if (!response.body) throw new ApiRequestError('El servidor no abrió el flujo de procesamiento.', response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (frame: string) => {
    const data = frame
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (data.length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(data.join('\n'));
    } catch {
      throw new ApiRequestError('El servidor envió un evento inválido.', response.status);
    }
    const parsed = processEventSchema.safeParse(raw);
    if (!parsed.success) throw new ApiRequestError('El servidor envió un evento de proceso inválido.', response.status);
    onEvent(parsed.data);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator: RegExpMatchArray | null;
      while ((separator = buffer.match(/\r\n\r\n|\n\n|\r\r/))) {
        const index = separator.index ?? -1;
        if (index < 0) break;
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + separator[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }
}

export async function* processInvoiceEvents(
  request: ProcessRequest,
  onEvent: (event: ProcessEvent) => void,
): AsyncGenerator<ProcessEvent> {
  const events: ProcessEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let failure: unknown;
  void processInvoices(request, (event) => {
    events.push(event);
    onEvent(event);
    wake?.();
    wake = undefined;
  }).then(
    () => { finished = true; wake?.(); wake = undefined; },
    (cause: unknown) => { failure = cause; finished = true; wake?.(); wake = undefined; },
  );

  while (true) {
    if (events.length > 0) {
      yield events.shift()!;
      continue;
    }
    if (finished) {
      if (failure !== undefined) throw failure;
      return;
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      if (events.length > 0 || finished) {
        wake = undefined;
        resolve();
      }
    });
  }
}

function decisionActionUrl(id: string, action: 'approve' | 'reject'): string {
  return `/api/invoices/${encodeURIComponent(id)}/${action}`;
}

export function approveInvoice(id: string, action: DecisionAction): Promise<Expediente> {
  return requestJson(decisionActionUrl(id, 'approve'), expedienteSchema, jsonInit('POST', action));
}

export function rejectInvoice(id: string, action: DecisionAction): Promise<Expediente> {
  return requestJson(decisionActionUrl(id, 'reject'), expedienteSchema, jsonInit('POST', action));
}

export function resolveFlag(id: string, flagId: string, resolution: FlagResolution): Promise<Expediente> {
  return requestJson(
    `/api/invoices/${encodeURIComponent(id)}/flags/${encodeURIComponent(flagId)}/resolve`,
    expedienteSchema,
    jsonInit('POST', resolution),
  );
}

export function reevaluateInvoice(id: string): Promise<Expediente> {
  return requestJson(`/api/invoices/${encodeURIComponent(id)}/reevaluate`, expedienteSchema, jsonInit('POST'));
}

export async function getTable<T extends DataTable>(table: T): Promise<DataTableValues[T]> {
  const result: unknown = await requestJson(`/api/data/${table}`, dataSchemas[table]);
  return result as DataTableValues[T];
}

export async function putRow<T extends DataTable>(table: T, row: DataRowMap[T]): Promise<DataRowMap[T]> {
  const result: unknown = await requestJson(`/api/data/${table}`, dataRowSchemas[table], jsonInit('PUT', row));
  return result as DataRowMap[T];
}

export async function uploadCsv(table: CsvTable, file: File): Promise<DataUploadResult> {
  const body = new FormData();
  body.append('file', file);
  const response = await fetch(`/api/data/${table}/csv`, { method: 'POST', body });
  if (response.ok) {
    try {
      const result: unknown = await response.json();
      if (z.object({ ok: z.literal(true) }).strict().safeParse(result).success) return { ok: true };
    } catch {
      // Fall through to a safe invalid-response error.
    }
    throw new ApiRequestError('El servidor devolvió una respuesta inválida.', response.status);
  }
  const cause = await readError(response);
  if (cause.payload && 'message' in cause.payload) return { ok: false, error: cause.payload };
  return { ok: false, error: { error: 'invalid_csv', message: cause.message } };
}

export function templateUrl(table: CsvTable): string {
  return `/api/data/${table}/template.csv`;
}

export function getLog(): Promise<LogEntry[]> {
  return requestJson('/api/log', z.array(logEntrySchema));
}

async function getExportText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) throw await readError(response);
  return response.text();
}

export function exportPaymentsCsv(): Promise<string> {
  return getExportText('/api/export/payments.csv');
}

export function exportLogCsv(): Promise<string> {
  return getExportText('/api/export/log.csv');
}

export function exportReportMd(): Promise<string> {
  return getExportText('/api/export/report.md');
}

export const datosApi: DatosApi = {
  getTable,
  putRow,
  uploadCsv,
  templateUrl,
  getCompany: () => requestJson('/api/company', companyRecordSchema),
  saveCompany: (company) => requestJson('/api/company', companyRecordSchema, jsonInit('PUT', company)),
  previewCompany: (company) => requestJson('/api/company/preview', companyPreviewSchema, jsonInit('POST', company)),
};
export const reglasApi: ReglasApi = {
  getRules: () => requestJson('/api/rules', rulesSchema),
  saveRules: (rules) => requestJson('/api/rules', rulesSchema, jsonInit('PUT', rules)),
  simulate: (rules) => requestJson('/api/rules/simulate', simulationResultSchema, jsonInit('POST', { rules })),
  getVendors: () => getTable('vendors'),
  saveVendor: (vendor) => putRow('vendors', vendor),
};
export const bitacoraApi: BitacoraApi = { getLog, exportPaymentsCsv, exportLogCsv, exportReportMd };

