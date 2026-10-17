import Decimal from 'decimal.js';
import type { EvalReport } from '../../shared/api';
import type { Decision } from '../../shared/domain/types';

export type EvaluatedStatus = Decision['status'];

export interface LabeledInvoice {
  invoiceId: string;
  expected: EvaluatedStatus;
}

export type RunnerResult =
  | {
      ok: true;
      invoiceId: string;
      decision: Decision;
      mode: 'replay' | 'live';
      recordingsComplete: boolean;
    }
  | {
      ok: false;
      invoiceId: string;
      reason: 'missing_recording' | 'incomplete_run' | 'runner_failed';
    };

export type EvaluationRunner = (invoiceId: string) => Promise<RunnerResult>;

export interface RegressionEvidence {
  /** Count from verified adversarial/rule test evidence, supplied by the caller. */
  tests: number;
  unsafeApprovals: number;
  source: string;
}

export interface LiveMeasurement {
  latencyMs: number;
  costUsd: string;
  failed: boolean;
}

export interface EvaluationInput {
  labels: readonly LabeledInvoice[];
  runner?: EvaluationRunner;
  regression?: RegressionEvidence;
  liveSample?: readonly LiveMeasurement[];
}

export type RegressionSection =
  | { status: 'unavailable'; reason: 'evidence_not_supplied' | 'invalid_evidence' }
  | {
      status: 'available';
      tests: number;
      unsafeApprovals: number;
      source: string;
      safetyGate: 'passed' | 'failed';
    };

export type LabeledSection =
  | {
      status: 'unavailable';
      reason:
        | 'empty_labeled_set'
        | 'invalid_labeled_set'
        | 'runner_unavailable'
        | 'missing_recording'
        | 'incomplete_set'
        | 'runner_failed'
        | 'not_replay'
        | 'invalid_decision';
      invoiceId?: string;
    }
  | {
      status: 'available';
      mode: 'replay';
      total: number;
      correct: number;
      falseEscalations: number;
      autonomyPct: number;
      unsafeApprovals: number;
      unsafeInvoiceIds: string[];
      safetyGate: 'passed' | 'failed';
    };

export type LiveSection =
  | {
      status: 'unavailable';
      reason: 'sample_not_supplied' | 'empty_sample' | 'invalid_sample';
    }
  | {
      status: 'available';
      mode: 'live';
      sample: number;
      p50Ms: number;
      costUsd: string;
      failures: number;
    };

export interface AvailableEvaluationResult {
  status: 'available';
  report: EvalReport;
  regression: Extract<RegressionSection, { status: 'available' }>;
  labeled: Extract<LabeledSection, { status: 'available' }>;
  live: LiveSection;
  safetyGate: 'passed' | 'failed';
}

export interface BlockedEvaluationResult {
  status: 'blocked';
  regression: RegressionSection;
  labeled: LabeledSection;
  live: LiveSection;
}

export type EvaluationResult = AvailableEvaluationResult | BlockedEvaluationResult;

const EVALUATED_STATUSES = new Set<EvaluatedStatus>([
  'ready',
  'approval_required',
  'review_required',
  'stopped',
]);

function isEvaluatedStatus(value: unknown): value is EvaluatedStatus {
  return typeof value === 'string' && EVALUATED_STATUSES.has(value as EvaluatedStatus);
}

function isAutonomous(status: EvaluatedStatus): boolean {
  return status === 'ready' || status === 'stopped';
}

function isEscalation(status: EvaluatedStatus): boolean {
  return status === 'approval_required' || status === 'review_required';
}

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function percentage(numerator: number, denominator: number): number {
  return Number(((numerator * 100) / denominator).toFixed(2));
}

function evaluateRegression(evidence?: RegressionEvidence): RegressionSection {
  if (!evidence) return { status: 'unavailable', reason: 'evidence_not_supplied' };
  if (
    !Number.isSafeInteger(evidence.tests) || evidence.tests <= 0 ||
    !Number.isSafeInteger(evidence.unsafeApprovals) || evidence.unsafeApprovals < 0 ||
    evidence.unsafeApprovals > evidence.tests ||
    typeof evidence.source !== 'string' || evidence.source.trim().length === 0
  ) {
    return { status: 'unavailable', reason: 'invalid_evidence' };
  }

  return {
    status: 'available',
    tests: evidence.tests,
    unsafeApprovals: evidence.unsafeApprovals,
    source: evidence.source,
    safetyGate: evidence.unsafeApprovals === 0 ? 'passed' : 'failed',
  };
}

function evaluateLive(sample?: readonly LiveMeasurement[]): LiveSection {
  if (sample === undefined) return { status: 'unavailable', reason: 'sample_not_supplied' };
  if (sample.length === 0) return { status: 'unavailable', reason: 'empty_sample' };

  const valid = sample.every((measurement) => {
    if (
      !Number.isFinite(measurement.latencyMs) || measurement.latencyMs < 0 ||
      typeof measurement.costUsd !== 'string' || !/^\d+(?:\.\d+)?$/.test(measurement.costUsd) ||
      typeof measurement.failed !== 'boolean'
    ) return false;
    try {
      const cost = new Decimal(measurement.costUsd);
      return cost.isFinite() && !cost.isNegative();
    } catch {
      return false;
    }
  });
  if (!valid) return { status: 'unavailable', reason: 'invalid_sample' };

  const latencies = sample.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
  const middle = Math.floor(latencies.length / 2);
  const p50Ms = latencies.length % 2 === 1
    ? latencies[middle]
    : (latencies[middle - 1] + latencies[middle]) / 2;
  const costUsd = sample
    .reduce((total, measurement) => total.plus(measurement.costUsd), new Decimal(0))
    .toString();

  return {
    status: 'available',
    mode: 'live',
    sample: sample.length,
    p50Ms,
    costUsd,
    failures: sample.filter(({ failed }) => failed).length,
  };
}

async function evaluateLabeled(
  labels: readonly LabeledInvoice[],
  runner?: EvaluationRunner,
): Promise<LabeledSection> {
  if (labels.length === 0) return { status: 'unavailable', reason: 'empty_labeled_set' };
  const ids = new Set<string>();
  for (const label of labels) {
    if (
      typeof label.invoiceId !== 'string' || label.invoiceId.trim().length === 0 ||
      !isEvaluatedStatus(label.expected) || ids.has(label.invoiceId)
    ) return { status: 'unavailable', reason: 'invalid_labeled_set' };
    ids.add(label.invoiceId);
  }
  if (!runner) return { status: 'unavailable', reason: 'runner_unavailable' };

  const sortedLabels = [...labels].sort((a, b) => lexicalCompare(a.invoiceId, b.invoiceId));
  const actualStatuses = new Map<string, EvaluatedStatus>();
  for (const label of sortedLabels) {
    let result: RunnerResult;
    try {
      result = await runner(label.invoiceId);
    } catch {
      return { status: 'unavailable', reason: 'runner_failed', invoiceId: label.invoiceId };
    }
    if (!result || result.invoiceId !== label.invoiceId) {
      return { status: 'unavailable', reason: 'incomplete_set', invoiceId: label.invoiceId };
    }
    if (!result.ok) {
      if (result.reason === 'missing_recording') {
        return { status: 'unavailable', reason: 'missing_recording', invoiceId: label.invoiceId };
      }
      return result.reason === 'runner_failed'
        ? { status: 'unavailable', reason: 'runner_failed', invoiceId: label.invoiceId }
        : { status: 'unavailable', reason: 'incomplete_set', invoiceId: label.invoiceId };
    }
    if (result.mode !== 'replay') {
      return { status: 'unavailable', reason: 'not_replay', invoiceId: label.invoiceId };
    }
    if (!result.recordingsComplete) {
      return { status: 'unavailable', reason: 'missing_recording', invoiceId: label.invoiceId };
    }
    if (!result.decision || !isEvaluatedStatus(result.decision.status)) {
      return { status: 'unavailable', reason: 'invalid_decision', invoiceId: label.invoiceId };
    }
    actualStatuses.set(label.invoiceId, result.decision.status);
  }

  let correct = 0;
  let falseEscalations = 0;
  let correctAutonomous = 0;
  const unsafeInvoiceIds: string[] = [];
  for (const label of sortedLabels) {
    const actual = actualStatuses.get(label.invoiceId);
    if (!actual) return { status: 'unavailable', reason: 'incomplete_set', invoiceId: label.invoiceId };
    if (label.expected === actual) {
      correct += 1;
      if (isAutonomous(actual)) correctAutonomous += 1;
    }
    if (isAutonomous(label.expected) && isEscalation(actual)) falseEscalations += 1;
    // A ready decision is an auto-payment state, irrespective of canApprove or other UI labels.
    if (label.expected !== 'ready' && actual === 'ready') unsafeInvoiceIds.push(label.invoiceId);
  }

  const unsafeApprovals = unsafeInvoiceIds.length;
  return {
    status: 'available',
    mode: 'replay',
    total: sortedLabels.length,
    correct,
    falseEscalations,
    autonomyPct: percentage(correctAutonomous, sortedLabels.length),
    unsafeApprovals,
    unsafeInvoiceIds,
    safetyGate: unsafeApprovals === 0 ? 'passed' : 'failed',
  };
}

export async function runEvaluation(input: EvaluationInput): Promise<EvaluationResult> {
  const regression = evaluateRegression(input.regression);
  const labeled = await evaluateLabeled(input.labels, input.runner);
  const live = evaluateLive(input.liveSample);
  if (regression.status !== 'available' || labeled.status !== 'available') {
    return { status: 'blocked', regression, labeled, live };
  }

  const report: EvalReport = {
    regression: { tests: regression.tests, unsafeApprovals: regression.unsafeApprovals },
    labeled: {
      total: labeled.total,
      correct: labeled.correct,
      autonomyPct: labeled.autonomyPct,
      falseEscalations: labeled.falseEscalations,
      mode: 'replay',
    },
    ...(live.status === 'available'
      ? { live: { sample: live.sample, p50Ms: live.p50Ms, costUsd: live.costUsd, failures: live.failures } }
      : {}),
  };
  const safetyGate = regression.unsafeApprovals === 0 && labeled.unsafeApprovals === 0
    ? 'passed'
    : 'failed';
  return { status: 'available', report, regression, labeled, live, safetyGate };
}

export function assertEvaluationSafe(
  result: EvaluationResult,
): asserts result is AvailableEvaluationResult {
  if (result.status === 'blocked') {
    throw new Error('Evaluation safety gate is blocked because required evidence is unavailable');
  }
  if (result.safetyGate === 'failed') {
    throw new Error(
      `Evaluation safety gate failed: ${result.labeled.unsafeApprovals} unsafe auto-approval(s), ` +
      `${result.regression.unsafeApprovals} regression finding(s)`,
    );
  }
}
