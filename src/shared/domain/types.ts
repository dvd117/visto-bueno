// Domain contract (plan Task 2). Every unit depends on these names; change them only by
// agreement with the coordinator.

export type Currency = 'USD' | 'COP' | 'MXN';
/** Integer minor units plus an ISO currency. Never a float. */
export interface Money { currency: Currency; minor: number }
/** `perUsd` is a decimal string, e.g. '4171.30'. */
export interface FxRate { currency: Currency; perUsd: string; date: string }

export interface Vendor {
  id: string; name: string; taxId: string; country: 'CO' | 'MX' | 'VE' | 'US';
  payoutCurrency: Currency; payoutAccount: string; status: 'allowed' | 'blocked'; version: number;
}

export type CostCenter = 'ingenieria' | 'diseno' | 'operaciones' | 'legal';

export interface Contract {
  id: string; vendorId: string; scope: string; type: 'fixed' | 'variable';
  currency: Currency; amountMinor?: number; rateMinor?: number; unit?: string;
  maxUnitsPerPeriod?: number; billingFrequency: 'monthly' | 'one_time' | 'annual';
  costCenter: CostCenter; start: string; end: string; version: number;
}

/** `month` is 'YYYY-MM', e.g. '2026-10'. */
export interface Budget { costCenter: CostCenter; month: string; approvedUsdMinor: number }
export interface Treasury { balanceUsdMinor: number; fx: FxRate[] }

export type Preset = 'estricto' | 'equilibrado' | 'permisivo';
export interface Rules {
  version: number; perPaymentLimitUsdMinor: number; monthlyLimitUsdMinor: number;
  approvalThresholdUsdMinor: number; fuzzyDuplicateWindowDays: number; preset: Preset;
}

export type SourceKind = 'pdf' | 'image' | 'text';

export interface ExtractionClaims {
  amountsFound: string[]; accountsFound: string[]; taxIdsFound: string[];
  invoiceIdsFound: string[]; currenciesFound: string[];
  payeeName: string | null; payeeTaxId: string | null; payoutAccount: string | null;
  invoiceId: string | null; invoiceDate: string | null; dueDate: string | null; // dates are ISO
  currency: string | null; amountRaw: string | null; subtotalRaw: string | null; taxesRaw: string | null;
  quantity: string | null; rateRaw: string | null; description: string | null;
  documentTypeHint: string | null; hasMultipleCurrenciesShown: boolean;
  /** Field name -> exact substring from the source. */
  evidenceQuotes: Record<string, string>;
  /** Exact substrings. */
  suspiciousPassages: string[];
}

export type ExtractionResult =
  | { ok: true; claims: ExtractionClaims; sourceText: string; sourceKind: SourceKind }
  | { ok: false; error: 'rate_limited' | 'timeout' | 'unreadable' | 'too_large'; sourceKind: SourceKind };

export type CheckKind = 'verify' | 'rule' | 'judgment';
export type CheckEffect = 'none' | 'stop' | 'approval' | 'review';
export interface CheckResult {
  id: string; kind: CheckKind; label: string; passed: boolean;
  effect: CheckEffect; reason: string; probability?: number;
  evidence?: { invoice?: string; record?: string };
}

export interface Flag {
  id: string; checkId: string; reason: string;
  resolution?: { choice: string; reason: string; by: string; at: string };
}

export type JevQuestionId =
  | 'instructs_agent' | 'artificial_urgency' | 'scope_match' | 'fuzzy_duplicate' | 'document_type' | 'cost_center';
export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };
export type JevAnswers =
  | { ok: true; answers: Partial<Record<JevQuestionId, JevAnswer>>; latencyMs: number; recorded: boolean; inputTokens: number }
  | { ok: false; error: 'no_key' | 'timeout' | 'malformed' | 'http_error' | 'missing_recording' };

export type InvoiceStatus =
  | 'queued' | 'ready' | 'approval_required' | 'review_required' | 'stopped' | 'approved' | 'rejected' | 'stale';

export interface Decision {
  status: Exclude<InvoiceStatus, 'queued' | 'approved' | 'rejected' | 'stale'>;
  checks: CheckResult[]; flags: Flag[]; canApprove: boolean; headline: string; nextStep: string | null;
  amountUsdMinor: number | null; contractId: string | null; costCenter: CostCenter | null;
}

export interface DecisionRecord {
  id: string; invoiceId: string; decision: Decision; rulesSnapshot: Rules;
  dataVersions: { vendor?: number; contract?: number; fxDate: string }; jev: JevAnswers;
  seal: string; createdAt: string; supersedes?: string;
}
