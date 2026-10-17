import Decimal from 'decimal.js';
import { z } from 'zod';
import type {
  ApiError,
  Comparison,
  ConflictResponse,
  Counters,
  DecisionAction,
  Expediente,
  FlagResolution,
  InvoiceRow,
  LogEntry,
  NewInvoiceText,
  ProcessEvent,
  ProcessRequest,
  RunStats,
  SimulationResult,
  WorkspaceSummary,
} from '../../shared/api';
import { evaluationResultSchema } from '../../shared/api';
import { CURRENCIES } from '../../shared/domain/currencies';
import type { Budget, Contract, DecisionRecord, FxRate, Rules, Treasury, Vendor } from '../../shared/domain/types';
import type {
  BitacoraApi, CsvTable, DataRowMap, DataTable, DataTableValues, DataUploadResult, DatosApi, EvaluationResult, ReglasApi,
} from './api-types';

const invoiceStatusSchema = z.enum([
  'queued', 'ready', 'approval_required', 'review_required', 'stopped', 'approved', 'rejected', 'stale',
]);
const sourceKindSchema = z.enum(['pdf', 'image', 'text']);
const countrySchema = z.enum(['CO', 'MX', 'VE', 'CL', 'PE', 'AR', 'US']);
const currencySchema = z.enum(CURRENCIES);
const invoiceRowSchema: z.ZodType<InvoiceRow> = z.object({
  id: z.string(),
  payee: z.string(),
  concept: z.string(),
  amount: z.string(),
  amountUsd: z.string().nullable(),
  fxDate: z.string().nullable().optional(),
  due: z.string().nullable(),
  status: invoiceStatusSchema,
  reason: z.string(),
  subtitle: z.string().optional(),
  sourceKind: sourceKindSchema,
  country: countrySchema.nullable(),
  currency: currencySchema.nullable(),
  reevaluatedFrom: invoiceStatusSchema.optional(),
});

const countersSchema: z.ZodType<Counters> = z.object({
  ready: z.number().int(),
  approval_required: z.number().int(),
  review_required: z.number().int(),
  stopped: z.number().int(),
  approved: z.number().int(),
  rejected: z.number().int(),
  stale: z.number().int(),
  queued: z.number().int(),
});

const runStatsSchema: z.ZodType<RunStats> = z.object({
  invoices: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
  costUsd: z.string(),
  mode: z.enum(['replay', 'live']),
});

const rulesSchema: z.ZodType<Rules> = z.object({
  version: z.number().int(),
  perPaymentLimitUsdMinor: z.number().int(),
  monthlyLimitUsdMinor: z.number().int(),
  approvalThresholdUsdMinor: z.number().int(),
  fuzzyDuplicateWindowDays: z.number().int(),
  preset: z.enum(['estricto', 'equilibrado', 'permisivo']),
});

const jevAnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number() }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
]);
const jevAnswersSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    answers: z.partialRecord(z.enum([
      'instructs_agent', 'artificial_urgency', 'scope_match', 'fuzzy_duplicate', 'document_type', 'cost_center',
    ]), jevAnswerSchema),
    latencyMs: z.number().nonnegative(),
    recorded: z.boolean(),
    inputTokens: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.enum(['no_key', 'timeout', 'malformed', 'http_error', 'missing_recording']),
  }),
]);

const checkSchema = z.object({
  id: z.string(),
  kind: z.enum(['verify', 'rule', 'judgment']),
  label: z.string(),
  passed: z.boolean(),
  outcome: z.enum(['passed', 'failed', 'pending', 'not_applicable']).optional(),
  effect: z.enum(['none', 'stop', 'approval', 'review']),
  reason: z.string(),
  probability: z.number().optional(),
  evidence: z.object({ invoice: z.string().optional(), record: z.string().optional() }).optional(),
}).transform((check) => ({
  ...check,
  outcome: check.outcome ?? (check.passed ? 'passed' as const : 'failed' as const),
}));
const flagSchema = z.object({
  id: z.string(),
  checkId: z.string(),
  reason: z.string(),
  resolution: z.object({ choice: z.string(), reason: z.string(), by: z.string(), at: z.string() }).optional(),
});
const decisionSchema = z.object({
  status: z.enum(['ready', 'approval_required', 'review_required', 'stopped']),
  checks: z.array(checkSchema),
  flags: z.array(flagSchema),
  canApprove: z.boolean(),
  headline: z.string(),
  nextStep: z.string().nullable(),
  amountUsdMinor: z.number().int().nullable(),
  contractId: z.string().nullable(),
  costCenter: z.enum(['ingenieria', 'diseno', 'operaciones', 'legal']).nullable(),
});
const decisionRecordSchema: z.ZodType<DecisionRecord> = z.object({
  id: z.string(),
  invoiceId: z.string(),
  decision: decisionSchema,
  rulesSnapshot: rulesSchema,
  dataVersions: z.object({ vendor: z.number().int().optional(), contract: z.number().int().optional(), fxDate: z.string() }),
  jev: jevAnswersSchema,
  seal: z.string(),
  createdAt: z.string(),
  supersedes: z.string().optional(),
});

const comparisonSchema: z.ZodType<Comparison> = z.object({
  field: z.string(),
  invoice: z.string().nullable(),
  record: z.string().nullable(),
  differs: z.boolean(),
});
const expedienteSchema: z.ZodType<Expediente> = z.object({
  row: invoiceRowSchema,
  record: decisionRecordSchema.nullable(),
  comparison: z.array(comparisonSchema),
  sourceText: z.string().max(8000).nullable(),
  marks: z.array(z.object({ text: z.string().max(8000), kind: z.enum(['value', 'suspicious']) })),
  fileUrl: z.string().max(2048).nullable(),
  history: z.array(decisionRecordSchema),
});

const workspaceSummarySchema: z.ZodType<WorkspaceSummary> = z.object({
  company: z.object({ name: z.string(), fictional: z.literal(true) }),
  rules: rulesSchema,
  counters: countersSchema,
  lastRun: runStatsSchema.nullable(),
});
const apiErrorSchema: z.ZodType<ApiError> = z.object({ error: z.string(), message: z.string() });
const conflictSchema: z.ZodType<ConflictResponse> = z.object({ error: z.literal('conflict'), expediente: expedienteSchema });

const processEventSchema: z.ZodType<ProcessEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('decided'), row: invoiceRowSchema, counters: countersSchema }),
  z.object({ type: z.literal('error'), invoiceId: z.string(), message: z.string(), status: z.literal(429).optional() }),
  z.object({ type: z.literal('done'), stats: runStatsSchema }),
]);

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
const simulationCountsSchema = z.object({
  ready: nonNegativeInteger,
  approval_required: nonNegativeInteger,
  review_required: nonNegativeInteger,
  stopped: nonNegativeInteger,
}).strict();
const simulationResultSchema: z.ZodType<SimulationResult> = z.object({
  counts: simulationCountsSchema,
  deltas: z.object({
    ready: safeInteger,
    approval_required: safeInteger,
    review_required: safeInteger,
    stopped: safeInteger,
  }).strict(),
  unsafeApprovals: z.literal(0),
}).strict();
const logEntrySchema: z.ZodType<LogEntry> = z.object({
  at: z.string(), invoiceId: z.string(), status: invoiceStatusSchema,
  headline: z.string(), seal: z.string(), by: z.string().nullable(),
}).strict();

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

export const datosApi: DatosApi = { getTable, putRow, uploadCsv, templateUrl };
export const reglasApi: ReglasApi = {
  getRules: () => requestJson('/api/rules', rulesSchema),
  saveRules: (rules) => requestJson('/api/rules', rulesSchema, jsonInit('PUT', rules)),
  simulate: (rules) => requestJson('/api/rules/simulate', simulationResultSchema, jsonInit('POST', { rules })),
};
export const bitacoraApi: BitacoraApi = { getLog, exportPaymentsCsv, exportLogCsv, exportReportMd };

