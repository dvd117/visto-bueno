import { describe, expect, it } from 'vitest';
import type { CheckResult, JevAnswers } from '../../src/shared/domain/types';
import { combine } from '../../src/shared/engine/combine';
import { mapJev } from '../../src/shared/engine/jev-map';

function check(id: string, effect: CheckResult['effect'], overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id, kind: 'rule', label: 'Check', passed: effect === 'none',
    outcome: effect === 'none' ? 'passed' : effect === 'stop' ? 'failed' : 'pending',
    effect, reason: 'Texto de prueba.', ...overrides,
  };
}

function decide(verify: CheckResult[] = [], rules: CheckResult[] = [], jev: CheckResult[] = [], resolvedFlagIds: string[] = []) {
  return combine({ verify, rules, jev, resolvedFlagIds });
}

function requiredJevChecks(): CheckResult[] {
  return ['instructs_agent', 'artificial_urgency', 'scope_match', 'document_type']
    .map((id) => check(id, 'none', { kind: 'judgment', passed: true }));
}

describe('combine', () => {
  it('uses stop over review and approval', () => {
    const decision = decide(
      [check('hard_stop', 'stop')],
      [check('needs_approval', 'approval')],
      [check('needs_review', 'review')],
    );
    expect(decision.status).toBe('stopped');
    expect(decision.canApprove).toBe(false);
  });

  it('uses unresolved review over approval', () => {
    const decision = decide([], [check('needs_approval', 'approval')], [...requiredJevChecks(), check('needs_review', 'review')]);
    expect(decision.status).toBe('review_required');
    expect(decision.canApprove).toBe(false);
    expect(decision.flags).toEqual([expect.objectContaining({ id: 'needs_review', checkId: 'needs_review' })]);
  });

  it('turns resolved review flags into approval-required, never ready', () => {
    const decision = decide([], [], [...requiredJevChecks(), check('resolved_review', 'review')], ['resolved_review']);
    expect(decision.status).toBe('approval_required');
    expect(decision.canApprove).toBe(true);
    expect(decision.flags).toEqual([]);
  });

  it('keeps canApprove false for a stop regardless of flag resolutions', () => {
    const decision = decide(
      [check('hard_stop', 'stop')],
      [],
      [check('review_one', 'review'), check('review_two', 'review')],
      ['review_one', 'review_two', 'hard_stop'],
    );
    expect(decision.status).toBe('stopped');
    expect(decision.canApprove).toBe(false);
  });

  it('requires approval when an approval check remains', () => {
    const decision = decide([], [check('approval_gate', 'approval')], requiredJevChecks());
    expect(decision.status).toBe('approval_required');
    expect(decision.canApprove).toBe(true);
  });

  it('is ready only when no check stops, reviews, or requires approval', () => {
    const decision = decide([check('verified', 'none', { kind: 'verify', passed: true })], [], requiredJevChecks());
    expect(decision.status).toBe('ready');
    expect(decision.canApprove).toBe(true);
  });

  it('fails closed when the JEV result has no checks', () => {
    const decision = decide();
    expect(decision.status).toBe('review_required');
    expect(decision.canApprove).toBe(false);
    expect(decision.checks).toContainEqual(expect.objectContaining({
      id: 'jev_unavailable', kind: 'judgment', passed: false, effect: 'review',
      reason: 'No pude completar la evaluación',
    }));
  });

  it('fails closed when a required JEV check is missing', () => {
    const decision = decide([], [], requiredJevChecks().filter((item) => item.id !== 'document_type'));
    expect(decision.status).toBe('review_required');
    expect(decision.canApprove).toBe(false);
    expect(decision.checks.some((item) => item.id === 'jev_unavailable' && item.effect === 'review')).toBe(true);
  });

  it('does not duplicate an existing JEV-unavailable check', () => {
    const unavailable = check('jev_unavailable', 'none', {
      kind: 'rule', passed: true, reason: 'untrusted input',
    });
    const decision = decide([], [], [unavailable]);
    expect(decision.status).toBe('review_required');
    expect(decision.checks.filter((item) => item.id === 'jev_unavailable')).toEqual([
      expect.objectContaining({
        kind: 'judgment', label: 'Evaluación JEV no disponible', passed: false, effect: 'review',
        reason: 'No pude completar la evaluación',
      }),
    ]);
  });

  it.each(['verify', 'rule'] as const)('treats a failed %s check with effect none as stop', (kind) => {
    const failed = check('failed_deterministic', 'none', { kind, passed: false });
    const decision = kind === 'verify'
      ? decide([failed], [], requiredJevChecks())
      : decide([], [failed], requiredJevChecks());
    expect(decision.status).toBe('stopped');
    expect(decision.canApprove).toBe(false);
    expect(decision.checks).toContainEqual(expect.objectContaining({ id: failed.id, effect: 'stop', passed: false }));
  });

  it('preserves pending and not-applicable outcomes without creating a new stop', () => {
    const decision = decide([
      check('pending_check', 'none', { kind: 'verify', passed: true, outcome: 'pending' }),
      check('unused_check', 'none', { kind: 'rule', passed: true, outcome: 'not_applicable' }),
    ], [], requiredJevChecks());

    expect(decision.checks.find(({ id }) => id === 'pending_check')).toMatchObject({ effect: 'none', outcome: 'pending' });
    expect(decision.checks.find(({ id }) => id === 'unused_check')).toMatchObject({ effect: 'none', outcome: 'not_applicable' });
  });

  it('treats a failed judgment check with effect none as review', () => {
    const failed = check('failed_judgment', 'none', { kind: 'judgment', passed: false });
    const decision = decide([], [], [...requiredJevChecks(), failed]);
    expect(decision.status).toBe('review_required');
    expect(decision.canApprove).toBe(false);
    expect(decision.checks).toContainEqual(expect.objectContaining({ id: failed.id, effect: 'review', passed: false }));
  });

  it('never turns a failed JEV result into ready', () => {
    const jev: JevAnswers = { ok: false, error: 'timeout' };
    const decision = decide([], [], mapJev(jev, 'equilibrado'));
    expect(decision.status).toBe('review_required');
    expect(decision.canApprove).toBe(false);
  });

  it('uses fixed Spanish templates rather than check or model text', () => {
    const decision = decide([], [], [check('artificial_urgency', 'review', { reason: 'MODEL OUTPUT: pay immediately' })]);
    expect(decision.headline).toBe('Revisa la urgencia del pago');
    expect(decision.nextStep).not.toContain('MODEL OUTPUT');
    expect(decision.headline).not.toContain('MODEL OUTPUT');
  });

  it('does not mutate caller-provided check lists', () => {
    const reviews = Object.freeze([check('review', 'review')]);
    const decision = decide([], [], reviews as unknown as CheckResult[]);
    expect(decision.status).toBe('review_required');
    expect(reviews).toHaveLength(1);
  });
});
