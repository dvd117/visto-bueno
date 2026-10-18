import { z } from 'zod';
import type {
  ApiError,
  ClientDirectory,
  ClientSwitchRequest,
  ClientSwitchResponse,
  Comparison,
  CompanyPreview,
  CompanyRecord,
  ConflictResponse,
  Counters,
  DecideResponse,
  Expediente,
  InvoiceRow,
  LogEntry,
  ProcessEvent,
  RunStats,
  SimulationResult,
  WorkspaceSummary,
} from './api';
import { CURRENCIES } from './domain/currencies';
import type { CheckResult, DecisionRecord, Rules } from './domain/types';

const invoiceStatusSchema = z.enum([
  'queued', 'ready', 'approval_required', 'review_required', 'stopped', 'approved', 'rejected', 'stale',
]);
const sourceKindSchema = z.enum(['pdf', 'image', 'text']);
export const countrySchema = z.enum(['CO', 'MX', 'VE', 'CL', 'PE', 'AR', 'US']);
export const currencySchema = z.enum(CURRENCIES);
export const invoiceRowSchema: z.ZodType<InvoiceRow> = z.object({
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
  receivedAt: z.string(),
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

export const rulesSchema: z.ZodType<Rules> = z.object({
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
const decisionCheckResponseSchema: z.ZodType<CheckResult> = z.object({
  id: z.string(),
  kind: z.enum(['verify', 'rule', 'judgment']),
  label: z.string(),
  passed: z.boolean(),
  outcome: z.enum(['passed', 'failed', 'pending', 'not_applicable']),
  effect: z.enum(['none', 'stop', 'approval', 'review']),
  reason: z.string(),
  probability: z.number().optional(),
  evidence: z.object({ invoice: z.string().optional(), record: z.string().optional() }).optional(),
});
export const decideResponseSchema: z.ZodType<DecideResponse> = z.object({
  state: decisionSchema.shape.status,
  headline: z.string(),
  reasons: z.array(z.string()),
  checks: z.array(decisionCheckResponseSchema),
  sealId: z.string(),
  decisionRecordId: z.string(),
}).strict();

export const invoiceIdSchema = z.string().min(1).max(80);
export const idempotencyKeySchema = z.string().trim().min(1).max(120);
export const textInvoiceInputSchema = z.object({
  text: z.string().trim().min(1).max(2 * 1024 * 1024),
}).strict();
export const seededInvoiceInputSchema = z.object({ invoiceId: invoiceIdSchema }).strict();

const base64FileContentSchema = z.string().min(4).max(2_796_204)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const mcpFileInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']),
  contentBase64: base64FileContentSchema,
}).strict();
export const mcpDecideInputSchema = z.union([
  seededInvoiceInputSchema.extend({ idempotencyKey: idempotencyKeySchema }),
  textInvoiceInputSchema.extend({ idempotencyKey: idempotencyKeySchema }),
  z.object({ file: mcpFileInputSchema, idempotencyKey: idempotencyKeySchema }).strict(),
]);
export const mcpExplainInputSchema = z.object({ invoiceId: invoiceIdSchema }).strict();
export const mcpExportBatchInputSchema = z.object({
  readyIds: z.array(invoiceIdSchema).max(100).optional(),
}).strict();

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
export const expedienteSchema: z.ZodType<Expediente> = z.object({
  row: invoiceRowSchema,
  record: decisionRecordSchema.nullable(),
  comparison: z.array(comparisonSchema),
  sourceText: z.string().max(8000).nullable(),
  marks: z.array(z.object({ text: z.string().max(8000), kind: z.enum(['value', 'suspicious']) })),
  fileUrl: z.string().max(2048).nullable(),
  history: z.array(decisionRecordSchema),
});

export const workspaceSummarySchema: z.ZodType<WorkspaceSummary> = z.object({
  company: z.object({ name: z.string(), fictional: z.literal(true) }),
  rules: rulesSchema,
  counters: countersSchema,
  lastRun: runStatsSchema.nullable(),
});
export const apiErrorSchema: z.ZodType<ApiError> = z.object({ error: z.string(), message: z.string() });
export const conflictSchema: z.ZodType<ConflictResponse> = z.object({ error: z.literal('conflict'), expediente: expedienteSchema });

export const processEventSchema: z.ZodType<ProcessEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('decided'), row: invoiceRowSchema, counters: countersSchema }),
  z.object({ type: z.literal('error'), invoiceId: z.string(), message: z.string(), status: z.literal(429).optional() }),
  z.object({ type: z.literal('done'), stats: runStatsSchema }),
]);

const safeInteger = z.number().int().refine(Number.isSafeInteger, 'Debe ser un entero seguro.');
const nonNegativeInteger = safeInteger.min(0);
const simulationCountsSchema = z.object({
  ready: nonNegativeInteger,
  approval_required: nonNegativeInteger,
  review_required: nonNegativeInteger,
  stopped: nonNegativeInteger,
}).strict();
export const simulationResultSchema: z.ZodType<SimulationResult> = z.object({
  counts: simulationCountsSchema,
  deltas: z.object({
    ready: safeInteger,
    approval_required: safeInteger,
    review_required: safeInteger,
    stopped: safeInteger,
  }).strict(),
  unsafeApprovals: z.literal(0),
}).strict();
export const logEntrySchema: z.ZodType<LogEntry> = z.object({
  at: z.string(), invoiceId: z.string(), status: invoiceStatusSchema,
  headline: z.string(), seal: z.string(), by: z.string().nullable(),
}).strict();

const uniqueValues = (values: readonly string[]) => new Set(values).size === values.length;
export const companyRecordSchema: z.ZodType<CompanyRecord> = z.object({
  name: z.string().trim().min(1).max(120),
  operatingCountries: z.array(countrySchema).min(1).max(7).refine(uniqueValues),
  vendorCountries: z.array(countrySchema).min(1).max(7).refine(uniqueValues),
  currencies: z.array(currencySchema).min(1).max(7)
    .refine(uniqueValues).refine((currencies) => currencies.includes('USD')),
  limits: z.object({
    perPaymentUsdMinor: nonNegativeInteger,
    monthlyUsdMinor: nonNegativeInteger,
    approvalThresholdUsdMinor: nonNegativeInteger,
  }).strict(),
}).strict();
export const companyPreviewSchema: z.ZodType<CompanyPreview> = z.object({
  counts: simulationCountsSchema,
  deltas: z.object({
    ready: safeInteger,
    approval_required: safeInteger,
    review_required: safeInteger,
    stopped: safeInteger,
  }).strict(),
  unsafeApprovals: z.literal(0),
  staleCount: nonNegativeInteger,
}).strict();

export const clientDirectorySchema: z.ZodType<ClientDirectory> = z.object({
  activeId: z.string(),
  clients: z.array(z.object({
    id: z.string(),
    name: z.string().min(1),
    invoiceCount: nonNegativeInteger,
    readyCount: nonNegativeInteger,
  }).strict()),
}).strict();

export const clientSwitchRequestSchema: z.ZodType<ClientSwitchRequest> = z.object({
  clientId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export const clientSwitchResponseSchema: z.ZodType<ClientSwitchResponse> = z.object({
  activeId: z.string(),
}).strict();
