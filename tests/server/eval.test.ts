import { describe, expect, it } from 'vitest';
import type { Decision } from '../../src/shared/domain/types';
import {
  assertEvaluationSafe,
  runEvaluation,
  type EvaluationRunner,
  type LabeledInvoice,
  type RunnerResult,
} from '../../src/server/eval/run';

// These are synthetic unit-test decisions, not provider recordings or runtime stand-ins.
function mockDecision(status: Decision['status']): Decision {
  return {
    status,
    checks: [],
    flags: [],
    canApprove: status === 'ready' || status === 'approval_required',
    headline: 'Mock decision for evaluation unit test',
    nextStep: null,
    amountUsdMinor: 100,
    contractId: 'mock-contract',
    costCenter: 'diseno',
  };
}

function mockResult(invoiceId: string, status: Decision['status']): RunnerResult {
  return {
    ok: true,
    invoiceId,
    mode: 'replay',
    recordingsComplete: true,
    decision: mockDecision(status),
  };
}

const mockRegressionEvidence = {
  // Synthetic test input only; production counts must come from verified CI evidence.
  tests: 10,
  unsafeApprovals: 0,
  source: 'mock verified-test evidence',
};

describe('runEvaluation', () => {
  it('processes labels lexically and computes exact state, escalation, autonomy, and safety counts', async () => {
    const labels: LabeledInvoice[] = [
      { invoiceId: 'AL-6', expected: 'approval_required' },
      { invoiceId: 'AL-2', expected: 'stopped' },
      { invoiceId: 'AL-5', expected: 'ready' },
      { invoiceId: 'AL-1', expected: 'ready' },
      { invoiceId: 'AL-4', expected: 'review_required' },
      { invoiceId: 'AL-3', expected: 'approval_required' },
    ];
    const actual: Record<string, Decision['status']> = {
      'AL-1': 'ready',
      'AL-2': 'stopped',
      'AL-3': 'approval_required',
      'AL-4': 'review_required',
      'AL-5': 'review_required',
      'AL-6': 'ready',
    };
    const calls: string[] = [];
    const runner: EvaluationRunner = async (invoiceId) => {
      calls.push(invoiceId);
      return mockResult(invoiceId, actual[invoiceId]);
    };

    const result = await runEvaluation({ labels, runner, regression: mockRegressionEvidence });

    expect(calls).toEqual(['AL-1', 'AL-2', 'AL-3', 'AL-4', 'AL-5', 'AL-6']);
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('Expected available mock result');
    expect(result.labeled).toMatchObject({
      status: 'available',
      mode: 'replay',
      total: 6,
      correct: 4,
      falseEscalations: 1,
      autonomyPct: 33.33,
      unsafeApprovals: 1,
      safetyGate: 'failed',
    });
    expect(result.report.labeled).toEqual({
      total: 6,
      correct: 4,
      autonomyPct: 33.33,
      falseEscalations: 1,
      mode: 'replay',
    });
    expect(() => assertEvaluationSafe(result)).toThrow(/unsafe auto-approval/i);
  });

  it('blocks an empty labeled set rather than reporting zero metrics', async () => {
    const result = await runEvaluation({ labels: [], runner: async () => mockResult('unused', 'ready') });

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('Expected blocked result');
    expect(result.labeled).toEqual({ status: 'unavailable', reason: 'empty_labeled_set' });
  });

  it('blocks labeled metrics when no real runner is supplied', async () => {
    const result = await runEvaluation({ labels: [{ invoiceId: 'AL-1', expected: 'ready' }] });

    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('Expected blocked result');
    expect(result.labeled).toEqual({ status: 'unavailable', reason: 'runner_unavailable' });
  });

  it('blocks the whole set when a replay recording is missing', async () => {
    const calls: string[] = [];
    const runner: EvaluationRunner = async (invoiceId) => {
      calls.push(invoiceId);
      return { ok: false, invoiceId, reason: 'missing_recording' };
    };

    const result = await runEvaluation({
      labels: [
        { invoiceId: 'AL-2', expected: 'stopped' },
        { invoiceId: 'AL-1', expected: 'ready' },
      ],
      runner,
    });

    expect(calls).toEqual(['AL-1']);
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('Expected blocked result');
    expect(result.labeled).toEqual({ status: 'unavailable', reason: 'missing_recording', invoiceId: 'AL-1' });
  });

  it('blocks incomplete or mismatched runner output and thrown runner failures', async () => {
    const labels = [{ invoiceId: 'AL-1', expected: 'ready' }] as const;
    const incomplete = await runEvaluation({
      labels,
      runner: async () => ({ ok: false, invoiceId: 'AL-1', reason: 'incomplete_run' }),
    });
    const mismatched = await runEvaluation({
      labels,
      runner: async () => mockResult('AL-2', 'ready'),
    });
    const thrown = await runEvaluation({
      labels,
      runner: async () => {
        throw new Error('synthetic runner failure');
      },
    });

    expect(incomplete).toMatchObject({ status: 'blocked', labeled: { status: 'unavailable', reason: 'incomplete_set' } });
    expect(mismatched).toMatchObject({ status: 'blocked', labeled: { status: 'unavailable', reason: 'incomplete_set' } });
    expect(thrown).toMatchObject({ status: 'blocked', labeled: { status: 'unavailable', reason: 'runner_failed' } });
  });

  it('does not treat live or incomplete-recording results as labeled replay metrics', async () => {
    const liveMode = await runEvaluation({
      labels: [{ invoiceId: 'AL-1', expected: 'ready' }],
      runner: async (invoiceId) => ({
        ...mockResult(invoiceId, 'ready'),
        mode: 'live',
      }),
    });
    const incompleteRecording = await runEvaluation({
      labels: [{ invoiceId: 'AL-1', expected: 'ready' }],
      runner: async (invoiceId) => ({
        ...mockResult(invoiceId, 'ready'),
        recordingsComplete: false,
      }),
    });

    expect(liveMode).toMatchObject({ status: 'blocked', labeled: { status: 'unavailable', reason: 'not_replay' } });
    expect(incompleteRecording).toMatchObject({
      status: 'blocked',
      labeled: { status: 'unavailable', reason: 'missing_recording' },
    });
  });

  it('keeps regression evidence unavailable and omits live claims unless supplied', async () => {
    const result = await runEvaluation({
      labels: [{ invoiceId: 'AL-1', expected: 'ready' }],
      runner: async (invoiceId) => mockResult(invoiceId, 'ready'),
    });

    expect(result.status).toBe('blocked');
    expect(result.regression).toEqual({ status: 'unavailable', reason: 'evidence_not_supplied' });
    expect(result.live).toEqual({ status: 'unavailable', reason: 'sample_not_supplied' });
  });

  it('computes live metrics only from measured samples and keeps them separate from replay labels', async () => {
    const result = await runEvaluation({
      labels: [{ invoiceId: 'AL-1', expected: 'ready' }],
      runner: async (invoiceId) => mockResult(invoiceId, 'ready'),
      regression: mockRegressionEvidence,
      liveSample: [
        { latencyMs: 10, costUsd: '0.04', failed: false },
        { latencyMs: 30, costUsd: '0.03', failed: true },
        { latencyMs: 20, costUsd: '0.01', failed: false },
      ],
    });

    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('Expected available mock result');
    expect(result.labeled).toMatchObject({ status: 'available', mode: 'replay', total: 1, correct: 1 });
    expect(result.live).toEqual({
      status: 'available',
      mode: 'live',
      sample: 3,
      p50Ms: 20,
      costUsd: '0.08',
      failures: 1,
    });
    expect(result.report.live).toEqual({ sample: 3, p50Ms: 20, costUsd: '0.08', failures: 1 });
    expect(result.report.labeled.mode).toBe('replay');
  });
});
