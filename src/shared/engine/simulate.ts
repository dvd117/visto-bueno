import type { SimulationResult } from '../api';
import type {
  Budget, Contract, CostCenter, Decision, ExtractionResult, JevAnswers, Rules, Treasury, Vendor,
} from '../domain/types';
import { combine } from './combine';
import { mapJev } from './jev-map';
import { normalize } from './normalize';
import { evaluateRules, type LedgerView } from './rules';
import { validateRulesConfig } from './rules-config';
import { verifyClaims } from './verify';

export const DEFAULT_SIMULATION_TODAY = '2026-10-16';

export interface SimulationInvoice {
  /** Persisted invoice row id, used for deterministic processing order. */
  id: string;
  extraction: ExtractionResult;
  /** Null or omitted means the stored JEV response is missing. */
  jev?: JevAnswers | null;
}

export interface SimulationPriorCommitment {
  /** Persisted invoice row id. If also in `invoices`, its old commitment is excluded. */
  invoiceId: string;
  state: 'committed' | 'reserved';
  amountUsdMinor: number;
  month: string;
  costCenter: CostCenter | null;
  vendorId?: string | null;
  /** Raw invoice number, normalized by the simulator for exact-duplicate checks. */
  invoiceNumber?: string | null;
  contractId?: string | null;
  /** `YYYY-MM`, `YYYY`, or `once`, according to the contract billing frequency. */
  contractPeriod?: string | null;
  invoiceDate?: string | null;
  description?: string | null;
}

/** Pure input snapshot; prior commitments must be explicitly supplied when relevant. */
export interface SimulationInput {
  invoices: readonly SimulationInvoice[];
  vendors: readonly Vendor[];
  contracts: readonly Contract[];
  budgets: readonly Budget[];
  treasury: Treasury;
  /** Current persisted rules used as the baseline. */
  rules: Rules;
  priorCommitments?: readonly SimulationPriorCommitment[];
  /** No wall clock is read; omitted dates use the pinned demo date. */
  today?: string;
}

type DecidedStatus = keyof SimulationResult['counts'];
type Commitment = SimulationPriorCommitment;

interface InvoiceIdentity {
  invoiceId: string;
  vendorId: string | null;
  normalizedInvoiceId: string | null;
  invoiceDate: string | null;
  description: string;
}

const JEV_ERRORS = ['no_key', 'timeout', 'malformed', 'http_error', 'missing_recording'] as const;
const COST_CENTERS: readonly CostCenter[] = ['ingenieria', 'diseno', 'operaciones', 'legal'];
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailableJev(error: 'malformed' | 'missing_recording'): JevAnswers {
  return { ok: false, error };
}

function normalizeJev(value: unknown): JevAnswers {
  if (value === null || value === undefined) return unavailableJev('missing_recording');
  if (!isRecord(value)) return unavailableJev('malformed');
  if (value.ok === false && typeof value.error === 'string' && JEV_ERRORS.includes(value.error as typeof JEV_ERRORS[number])) {
    return value as JevAnswers;
  }
  if (value.ok === true && isRecord(value.answers)) return value as JevAnswers;
  return unavailableJev('malformed');
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function dateNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function monthOf(date: string | null): string | null {
  return isIsoDate(date) ? date.slice(0, 7) : null;
}

function contractPeriod(contract: Contract, invoiceDate: string): string {
  if (contract.billingFrequency === 'monthly') return invoiceDate.slice(0, 7);
  if (contract.billingFrequency === 'annual') return invoiceDate.slice(0, 4);
  return 'once';
}

function assertPriorCommitment(value: Commitment): void {
  if (!value || typeof value !== 'object' || typeof value.invoiceId !== 'string' || value.invoiceId.length === 0) {
    throw new TypeError('Each prior commitment requires an invoiceId');
  }
  if (value.state !== 'committed' && value.state !== 'reserved') {
    throw new TypeError(`Invalid commitment state for ${value.invoiceId}`);
  }
  if (!Number.isSafeInteger(value.amountUsdMinor) || value.amountUsdMinor < 0) {
    throw new TypeError(`Invalid amountUsdMinor for ${value.invoiceId}`);
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month)) {
    throw new TypeError(`Invalid month for ${value.invoiceId}`);
  }
  if (value.costCenter !== null && !COST_CENTERS.includes(value.costCenter)) {
    throw new TypeError(`Invalid costCenter for ${value.invoiceId}`);
  }
  if (value.invoiceDate != null && !isIsoDate(value.invoiceDate)) {
    throw new TypeError(`Invalid invoiceDate for ${value.invoiceId}`);
  }
  if (value.contractPeriod != null && !/^(\d{4}-\d{2}|\d{4}|once)$/.test(value.contractPeriod)) {
    throw new TypeError(`Invalid contractPeriod for ${value.invoiceId}`);
  }
}

function sum(entries: readonly Commitment[], predicate: (entry: Commitment) => boolean, state: Commitment['state']): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.state !== state || !predicate(entry)) continue;
    total += entry.amountUsdMinor;
    if (!Number.isSafeInteger(total)) throw new RangeError('Prior and simulated commitments exceed safe USD-minor precision');
  }
  return total;
}

function createLedger(
  commitments: Commitment[],
  knownInvoices: InvoiceIdentity[],
  today: string,
): LedgerView {
  return {
    committedUsdMinor: (month) => sum(commitments, (entry) => entry.month === month, 'committed'),
    reservedUsdMinor: (month) => sum(commitments, (entry) => entry.month === month, 'reserved'),
    committedByCostCenter: (costCenter, month) => sum(
      commitments, (entry) => entry.month === month && entry.costCenter === costCenter, 'committed',
    ),
    reservedByCostCenter: (costCenter, month) => sum(
      commitments, (entry) => entry.month === month && entry.costCenter === costCenter, 'reserved',
    ),
    hasInvoiceId: (vendorId, normalizedId) => knownInvoices.some((entry) => (
      entry.vendorId === vendorId && entry.normalizedInvoiceId === normalizedId
    )),
    hasCommitmentForContractPeriod: (contractId, period) => commitments.some((entry) => (
      entry.state === 'committed' && entry.contractId === contractId && entry.contractPeriod === period
    )),
    recentByVendor: (vendorId, days) => {
      const todayNumber = dateNumber(today);
      return knownInvoices.filter((entry) => {
        if (entry.vendorId !== vendorId || !entry.invoiceDate || !entry.description || !isIsoDate(entry.invoiceDate)) return false;
        const daysAgo = (todayNumber - dateNumber(entry.invoiceDate)) / DAY_MS;
        return daysAgo >= 0 && daysAgo <= days;
      }).map((entry) => ({ invoiceId: entry.invoiceId, description: entry.description }));
    },
  };
}

function assertDecisionSafety(decision: Decision, invoiceId: string): void {
  const hasStop = decision.checks.some((check) => check.effect === 'stop');
  const hasUnresolvedCheck = decision.checks.some((check) => check.effect === 'review');
  const failedDeterministicCheck = decision.checks.some((check) => (
    (check.kind === 'verify' || check.kind === 'rule') && !check.passed
  ));
  const authorized = decision.status === 'ready' || (decision.status as string) === 'approved';

  if (decision.canApprove && (hasStop || hasUnresolvedCheck || failedDeterministicCheck)) {
    throw new Error(`Engine invariant violated for ${invoiceId}: canApprove conflicts with checks`);
  }
  if (authorized && (hasStop || hasUnresolvedCheck || failedDeterministicCheck || !decision.canApprove)) {
    throw new Error(`Engine invariant violated for ${invoiceId}: unsafe authorization`);
  }
}

function simulateUnderRules(input: SimulationInput, rules: Rules, today: string): Record<DecidedStatus, number> {
  const invoices = [...input.invoices].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));
  const currentIds = new Set<string>();
  for (const invoice of invoices) {
    if (!invoice.id || currentIds.has(invoice.id)) throw new TypeError(`Simulation invoice ids must be unique: ${invoice.id}`);
    currentIds.add(invoice.id);
  }

  const prior = [...(input.priorCommitments ?? [])];
  for (const commitment of prior) assertPriorCommitment(commitment);
  const externalPrior = prior.filter((commitment) => !currentIds.has(commitment.invoiceId));
  const commitments: Commitment[] = externalPrior.map((commitment) => ({ ...commitment }));
  const knownInvoices: InvoiceIdentity[] = externalPrior.map((commitment) => ({
    invoiceId: commitment.invoiceId,
    vendorId: commitment.vendorId ?? null,
    normalizedInvoiceId: commitment.invoiceNumber ? normalize(commitment.invoiceNumber) : null,
    invoiceDate: commitment.invoiceDate ?? null,
    description: commitment.description ?? '',
  }));
  const counts: Record<DecidedStatus, number> = { ready: 0, approval_required: 0, review_required: 0, stopped: 0 };

  for (const invoice of invoices) {
    const extraction = invoice.extraction;
    const verified = verifyClaims(extraction, [...input.vendors]);
    const ledger = createLedger(commitments, knownInvoices, today);
    const evaluation = evaluateRules({
      vendor: verified.vendor,
      contracts: [...input.contracts],
      money: verified.money,
      claims: extraction.ok ? extraction.claims : {
        amountsFound: [], accountsFound: [], taxIdsFound: [], invoiceIdsFound: [], currenciesFound: [],
        payeeName: null, payeeTaxId: null, payoutAccount: null, invoiceId: null, invoiceDate: null, dueDate: null,
        currency: null, amountRaw: null, subtotalRaw: null, taxesRaw: null, quantity: null, rateRaw: null,
        description: null, documentTypeHint: null, hasMultipleCurrenciesShown: false, evidenceQuotes: {}, suspiciousPassages: [],
      },
      treasury: { ...input.treasury, fx: [...input.treasury.fx] },
      budgets: [...input.budgets],
      rules,
      ledger,
      today,
    });
    const recent = verified.vendor
      ? ledger.recentByVendor(verified.vendor.id, rules.fuzzyDuplicateWindowDays)
      : [];
    const jevChecks = mapJev(normalizeJev(invoice.jev), rules.preset, { fuzzy: recent.length > 0 });
    const decision = combine({
      verify: verified.checks,
      rules: evaluation.checks,
      jev: jevChecks,
      resolvedFlagIds: [],
    });
    assertDecisionSafety(decision, invoice.id);
    counts[decision.status] += 1;

    if (extraction.ok) {
      const claims = extraction.claims;
      if (verified.vendor && claims.invoiceId?.trim()) {
        knownInvoices.push({
          invoiceId: invoice.id,
          vendorId: verified.vendor.id,
          normalizedInvoiceId: normalize(claims.invoiceId),
          invoiceDate: isIsoDate(claims.invoiceDate) ? claims.invoiceDate : null,
          description: claims.description ?? '',
        });
      }

      const month = monthOf(claims.invoiceDate);
      if (month && evaluation.amountUsdMinor !== null && decision.status !== 'stopped') {
        const isCommitted = decision.status === 'ready';
        commitments.push({
          invoiceId: invoice.id,
          state: isCommitted ? 'committed' : 'reserved',
          amountUsdMinor: evaluation.amountUsdMinor,
          month,
          costCenter: evaluation.contract?.costCenter ?? null,
          vendorId: verified.vendor?.id ?? null,
          invoiceNumber: claims.invoiceId,
          contractId: evaluation.contract?.id ?? null,
          contractPeriod: evaluation.contract ? contractPeriod(evaluation.contract, claims.invoiceDate!) : null,
          invoiceDate: isIsoDate(claims.invoiceDate) ? claims.invoiceDate : null,
          description: claims.description ?? null,
        });
      }
    }
  }

  return counts;
}

function deltas(candidate: Record<DecidedStatus, number>, baseline: Record<DecidedStatus, number>): Record<DecidedStatus, number> {
  return {
    ready: candidate.ready - baseline.ready,
    approval_required: candidate.approval_required - baseline.approval_required,
    review_required: candidate.review_required - baseline.review_required,
    stopped: candidate.stopped - baseline.stopped,
  };
}

/** Re-evaluates the same stored inputs under baseline and candidate rules; it never calls providers. */
export function simulateImpact(input: SimulationInput, candidateRules: unknown): SimulationResult {
  const baselineRules = validateRulesConfig(input.rules);
  const safeCandidateRules = validateRulesConfig(candidateRules);
  const today = input.today ?? DEFAULT_SIMULATION_TODAY;
  if (!isIsoDate(today)) throw new TypeError('today must be a valid ISO date');

  const baseline = simulateUnderRules(input, baselineRules, today);
  const candidate = simulateUnderRules(input, safeCandidateRules, today);
  // Both runs throw before returning if an authorized decision violates any check.
  return {
    counts: candidate,
    deltas: deltas(candidate, baseline),
    unsafeApprovals: 0,
  };
}
