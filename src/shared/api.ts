// API request/response types (plan Task 11). Routes live under /api, scoped to the workspace cookie.
import { z } from 'zod';
import type {
  CompanyProfile, Currency, DecisionRecord, InvoiceStatus, Rules, SourceKind, VendorCountry,
} from './domain/types';

export interface InvoiceRow {
  id: string; payee: string; concept: string; /** formatted */ amount: string;
  amountUsd: string | null; fxDate?: string | null; due: string | null; status: InvoiceStatus; reason: string; subtitle?: string; sourceKind: SourceKind;
  country: VendorCountry | null; currency: Currency | null;
  reevaluatedFrom?: InvoiceStatus;
}

export interface Counters {
  ready: number; approval_required: number; review_required: number; stopped: number;
  approved: number; rejected: number; stale: number; queued: number;
}

export interface RunStats { invoices: number; ms: number; costUsd: string; mode: 'replay' | 'live' }

export type ProcessEvent =
  | { type: 'decided'; row: InvoiceRow; counters: Counters }
  | { type: 'error'; invoiceId: string; message: string; status?: 429 }
  | { type: 'done'; stats: RunStats };

export interface Comparison { field: string; invoice: string | null; record: string | null; differs: boolean }

export interface Expediente {
  row: InvoiceRow; record: DecisionRecord | null; comparison: Comparison[];
  sourceText: string | null; marks: Array<{ text: string; kind: 'value' | 'suspicious' }>;
  fileUrl: string | null; history: DecisionRecord[];
}

export type DecidedStatus = 'ready' | 'approval_required' | 'review_required' | 'stopped';

export interface SimulationResult {
  counts: Record<DecidedStatus, number>;
  deltas: Record<DecidedStatus, number>;
  unsafeApprovals: 0;
}

export interface EvalReport {
  regression: { tests: number; unsafeApprovals: number };
  labeled: { total: number; correct: number; autonomyPct: number; falseEscalations: number; mode: 'replay' | 'live' };
  live?: { sample: number; p50Ms: number; costUsd: string; failures: number };
}

const safeInteger = z.number().int().refine(Number.isSafeInteger);
const nonNegativeInteger = safeInteger.min(0);
const evalRegressionAvailableSchema = z.object({
  status: z.literal('available'),
  tests: nonNegativeInteger,
  unsafeApprovals: nonNegativeInteger,
  source: z.string().min(1),
  safetyGate: z.enum(['passed', 'failed']),
}).strict();
const evalRegressionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unavailable'), reason: z.enum(['evidence_not_supplied', 'invalid_evidence']) }).strict(),
  evalRegressionAvailableSchema,
]);
const evalLabeledAvailableSchema = z.object({
  status: z.literal('available'),
  mode: z.literal('replay'),
  total: nonNegativeInteger,
  correct: nonNegativeInteger,
  falseEscalations: nonNegativeInteger,
  autonomyPct: z.number().finite().min(0).max(100),
  unsafeApprovals: nonNegativeInteger,
  unsafeInvoiceIds: z.array(z.string()),
  safetyGate: z.enum(['passed', 'failed']),
}).strict();
const evalLabeledSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum([
      'empty_labeled_set', 'invalid_labeled_set', 'runner_unavailable', 'missing_recording',
      'incomplete_set', 'runner_failed', 'not_replay', 'invalid_decision',
    ]),
    invoiceId: z.string().optional(),
  }).strict(),
  evalLabeledAvailableSchema,
]);
const evalLiveSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum(['sample_not_supplied', 'empty_sample', 'invalid_sample']),
  }).strict(),
  z.object({
    status: z.literal('available'),
    mode: z.literal('live'),
    sample: nonNegativeInteger,
    p50Ms: z.number().finite().nonnegative(),
    costUsd: z.string().regex(/^\d+(?:\.\d+)?$/),
    failures: nonNegativeInteger,
  }).strict(),
]);
const evalReportSchema = z.object({
  regression: z.object({ tests: nonNegativeInteger, unsafeApprovals: nonNegativeInteger }).strict(),
  labeled: z.object({
    total: nonNegativeInteger,
    correct: nonNegativeInteger,
    autonomyPct: z.number().finite().min(0).max(100),
    falseEscalations: nonNegativeInteger,
    mode: z.enum(['replay', 'live']),
  }).strict(),
  live: z.object({
    sample: nonNegativeInteger,
    p50Ms: z.number().finite().nonnegative(),
    costUsd: z.string().regex(/^\d+(?:\.\d+)?$/),
    failures: nonNegativeInteger,
  }).strict().optional(),
}).strict();

const evaluationResultUnionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('blocked'),
    regression: evalRegressionSchema,
    labeled: evalLabeledSchema,
    live: evalLiveSchema,
  }).strict(),
  z.object({
    status: z.literal('available'),
    report: evalReportSchema,
    regression: evalRegressionAvailableSchema,
    labeled: evalLabeledAvailableSchema,
    live: evalLiveSchema,
    safetyGate: z.enum(['passed', 'failed']),
  }).strict(),
]);

export const evaluationResultSchema = evaluationResultUnionSchema.superRefine((result, context) => {
  if (result.status !== 'available') return;
  const issue = (path: Array<string | number>, message: string) => {
    context.addIssue({ code: 'custom', path, message });
  };
  if (result.regression.tests === 0 || result.regression.unsafeApprovals > result.regression.tests) {
    issue(['regression'], 'La evidencia de regresión no es consistente.');
  }
  if (result.labeled.total === 0 || result.labeled.correct > result.labeled.total
    || result.labeled.falseEscalations > result.labeled.total
    || result.labeled.unsafeApprovals > result.labeled.total
    || result.labeled.unsafeInvoiceIds.length !== result.labeled.unsafeApprovals) {
    issue(['labeled'], 'Los resultados etiquetados no son consistentes.');
  }
  if (result.regression.safetyGate !== (result.regression.unsafeApprovals === 0 ? 'passed' : 'failed')
    || result.labeled.safetyGate !== (result.labeled.unsafeApprovals === 0 ? 'passed' : 'failed')
    || result.safetyGate !== (result.regression.unsafeApprovals === 0 && result.labeled.unsafeApprovals === 0 ? 'passed' : 'failed')) {
    issue(['safetyGate'], 'Los estados de seguridad no coinciden con las mediciones.');
  }
  if (result.report.regression.tests !== result.regression.tests
    || result.report.regression.unsafeApprovals !== result.regression.unsafeApprovals
    || result.report.labeled.total !== result.labeled.total
    || result.report.labeled.correct !== result.labeled.correct
    || result.report.labeled.falseEscalations !== result.labeled.falseEscalations
    || result.report.labeled.autonomyPct !== result.labeled.autonomyPct
    || result.report.labeled.mode !== result.labeled.mode) {
    issue(['report'], 'El resumen no coincide con las secciones de evidencia.');
  }
  if (result.live.status === 'available') {
    if (result.live.sample === 0 || result.live.failures > result.live.sample
      || !result.report.live || result.report.live.sample !== result.live.sample
      || result.report.live.p50Ms !== result.live.p50Ms || result.report.live.costUsd !== result.live.costUsd
      || result.report.live.failures !== result.live.failures) {
      issue(['live'], 'La muestra en vivo no coincide con el resumen.');
    }
  } else if (result.report.live !== undefined) {
    issue(['report', 'live'], 'El resumen no puede inventar una muestra en vivo.');
  }
});

export type ApiEvaluationResult = z.infer<typeof evaluationResultSchema>;

// Request bodies and smaller responses for the routes listed in plan Task 11.

/** GET /api/workspace */
export interface WorkspaceSummary {
  company: { name: string; fictional: true };
  rules: Rules; counters: Counters; lastRun: RunStats | null;
}

/** GET /api/clients; client ids are opaque and only usable by their owning visitor. */
export interface ClientSummary {
  id: string;
  name: string;
  invoiceCount: number;
  readyCount: number;
}

export interface ClientDirectory {
  activeId: string;
  clients: ClientSummary[];
}

export interface ClientSwitchRequest { clientId: string }
export interface ClientSwitchResponse { activeId: string }

/** POST /api/process (response is an SSE stream of ProcessEvent) */
export interface ProcessRequest { ids?: string[]; mode?: 'replay' | 'live'; examples?: true }

/** POST /api/invoices with JSON (multipart `file` is the other form) */
export interface NewInvoiceText { text: string }

/** POST /api/invoices/:id/approve and /reject. 409 returns ConflictResponse. */
export interface DecisionAction { approver: string; reason: string; idempotencyKey: string; accountLast4?: string }

/** POST /api/invoices/:id/flags/:flagId/resolve */
export interface FlagResolution { choice: string; reason: string; approver: string }

/** POST /api/rules/simulate */
export interface SimulateRequest { rules: Rules }

/** GET and PUT /api/company; POST /api/company/preview takes the same body. */
export interface CompanyRecord extends CompanyProfile {
  limits: { perPaymentUsdMinor: number; monthlyUsdMinor: number; approvalThresholdUsdMinor: number };
}

/** POST /api/company/preview: the rules simulation plus pending invoices a save would mark stale. */
export interface CompanyPreview extends SimulationResult { staleCount: number }

/** Body of a 409 from approve/reject. */
export interface ConflictResponse { error: 'conflict'; expediente: Expediente }

/** Error body for 4xx/5xx (Spanish `message`, never secrets). */
export interface ApiError { error: string; message: string }

/** GET /api/log */
export interface LogEntry {
  at: string; invoiceId: string; status: InvoiceStatus; headline: string; seal: string; by: string | null;
}
