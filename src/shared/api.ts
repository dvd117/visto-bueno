// API request/response types (plan Task 11). Routes live under /api, scoped to the workspace cookie.
import type { DecisionRecord, InvoiceStatus, Rules, SourceKind } from './domain/types';

export interface InvoiceRow {
  id: string; payee: string; concept: string; /** formatted */ amount: string;
  amountUsd: string | null; due: string | null; status: InvoiceStatus; reason: string; sourceKind: SourceKind;
  reevaluatedFrom?: InvoiceStatus;
}

export interface Counters {
  ready: number; approval_required: number; review_required: number; stopped: number;
  approved: number; rejected: number; stale: number; queued: number;
}

export interface RunStats { invoices: number; ms: number; costUsd: string; mode: 'replay' | 'live' }

export type ProcessEvent =
  | { type: 'decided'; row: InvoiceRow; counters: Counters }
  | { type: 'error'; invoiceId: string; message: string }
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

// Request bodies and smaller responses for the routes listed in plan Task 11.

/** GET /api/workspace */
export interface WorkspaceSummary {
  company: { name: string; fictional: true };
  rules: Rules; counters: Counters; lastRun: RunStats | null;
}

/** POST /api/process (response is an SSE stream of ProcessEvent) */
export interface ProcessRequest { ids?: string[]; mode?: 'replay' | 'live' }

/** POST /api/invoices with JSON (multipart `file` is the other form) */
export interface NewInvoiceText { text: string }

/** POST /api/invoices/:id/approve and /reject. 409 returns ConflictResponse. */
export interface DecisionAction { approver: string; reason: string; idempotencyKey: string }

/** POST /api/invoices/:id/flags/:flagId/resolve */
export interface FlagResolution { choice: string; reason: string; approver: string }

/** POST /api/rules/simulate */
export interface SimulateRequest { rules: Rules }

/** Body of a 409 from approve/reject. */
export interface ConflictResponse { error: 'conflict'; expediente: Expediente }

/** Error body for 4xx/5xx (Spanish `message`, never secrets). */
export interface ApiError { error: string; message: string }

/** GET /api/log */
export interface LogEntry {
  at: string; invoiceId: string; status: InvoiceStatus; headline: string; seal: string; by: string | null;
}
