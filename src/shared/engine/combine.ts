import type { CheckResult, Decision, Flag } from '../domain/types';
import { copyForDecision } from './copy';

interface CombineInput {
  verify: CheckResult[];
  rules: CheckResult[];
  jev: CheckResult[];
  resolvedFlagIds: string[];
}

const REQUIRED_JEV_CHECK_IDS = [
  'instructs_agent',
  'artificial_urgency',
  'scope_match',
  'document_type',
] as const;

function cloneCheck(check: CheckResult): CheckResult {
  return {
    ...check,
    ...(check.evidence ? { evidence: { ...check.evidence } } : {}),
  };
}

function normalizeCheck(check: CheckResult): CheckResult {
  const cloned = cloneCheck(check);
  if (cloned.id === 'jev_unavailable') return unavailableCheck();

  if (!cloned.passed && cloned.effect === 'none') {
    if (cloned.kind === 'verify' || cloned.kind === 'rule') cloned.effect = 'stop';
    if (cloned.kind === 'judgment') cloned.effect = 'review';
  }

  return cloned;
}

function unavailableCheck(): CheckResult {
  return {
    id: 'jev_unavailable',
    kind: 'judgment',
    label: 'Evaluación JEV no disponible',
    passed: false,
    effect: 'review',
    reason: 'No pude completar la evaluación',
  };
}

export function combine(input: CombineInput): Decision {
  const jevChecks = input.jev.map(normalizeCheck);
  const presentJevCheckIds = new Set(jevChecks
    .filter((check) => check.id !== 'jev_unavailable')
    .map((check) => check.id));
  if (REQUIRED_JEV_CHECK_IDS.some((id) => !presentJevCheckIds.has(id))
    && !jevChecks.some((check) => check.id === 'jev_unavailable')) {
    jevChecks.push(unavailableCheck());
  }

  const checks = [...input.verify, ...input.rules].map(normalizeCheck).concat(jevChecks);
  const resolved = new Set(input.resolvedFlagIds);
  const stop = checks.find((check) => check.effect === 'stop');
  const reviewChecks = checks.filter((check) => check.effect === 'review');
  const unresolvedReviews = reviewChecks.filter((check) => !resolved.has(check.id));
  const approval = checks.find((check) => check.effect === 'approval');
  const resolvedReview = reviewChecks.find((check) => resolved.has(check.id));

  let status: Decision['status'];
  let decidingCheckId: string | undefined;
  if (stop) {
    status = 'stopped';
    decidingCheckId = stop.id;
  } else if (unresolvedReviews.length > 0) {
    status = 'review_required';
    decidingCheckId = unresolvedReviews[0].id;
  } else if (approval || resolvedReview) {
    status = 'approval_required';
    decidingCheckId = approval?.id ?? resolvedReview?.id;
  } else {
    status = 'ready';
  }

  const flags: Flag[] = unresolvedReviews.map((check) => ({
    id: check.id,
    checkId: check.id,
    reason: check.reason,
  }));
  const copy = copyForDecision(status, decidingCheckId);

  return {
    status,
    checks,
    flags,
    canApprove: !stop && unresolvedReviews.length === 0,
    headline: copy.headline,
    nextStep: copy.nextStep,
    amountUsdMinor: null,
    contractId: null,
    costCenter: null,
  };
}
