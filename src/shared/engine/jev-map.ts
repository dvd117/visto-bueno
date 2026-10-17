import type { CheckOutcome, CheckResult, JevAnswer, JevAnswers, Preset } from '../domain/types';

export const PRESETS = Object.freeze({
  estricto: Object.freeze({ action: 0.6, reviewFrom: 0.25 }),
  equilibrado: Object.freeze({ action: 0.7, reviewFrom: 0.35 }),
  permisivo: Object.freeze({ action: 0.85, reviewFrom: 0.5 }),
}) satisfies Record<Preset, { action: number; reviewFrom: number }>;

const PAYABLE_DOCUMENT_TYPES = new Set(['factura', 'cuenta de cobro']);
const REVIEW_ONLY_DOCUMENT_TYPES = new Set(['cotización', 'recibo']);
const COST_CENTERS = new Set(['ingenieria', 'diseno', 'operaciones', 'legal', 'otro']);

type NoulAnswer = Extract<JevAnswer, { type: 'noul' }>;
type ChoiceAnswer = Extract<JevAnswer, { type: 'choice' }>;
type ScoreAnswer = Extract<JevAnswer, { type: 'score' }>;

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isProbabilityRecord(value: unknown): value is Record<string, number> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(isProbability);
}

function isNoulAnswer(value: JevAnswer | undefined): value is NoulAnswer {
  return value?.type === 'noul' && isProbability(value.noul);
}

function isChoiceAnswer(value: JevAnswer | undefined): value is ChoiceAnswer {
  return value?.type === 'choice' && typeof value.choice === 'string'
    && isProbability(value.confidence) && isProbabilityRecord(value.probabilities)
    && Object.keys(value.probabilities).length > 0
    && typeof value.probabilities[value.choice] === 'number';
}

function isScopeAnswer(value: JevAnswer | undefined): value is ScoreAnswer {
  return value?.type === 'score' && Number.isFinite(value.score) && value.score >= 0 && value.score <= 2
    && isProbability(value.confidence) && isProbabilityRecord(value.probabilities)
    && ['0', '1', '2'].every((key) => typeof value.probabilities[key] === 'number');
}

function topScopeIndex(answer: ScoreAnswer): number | null {
  const entries = Object.entries(answer.probabilities)
    .filter(([key]) => key === '0' || key === '1' || key === '2')
    .sort(([leftKey], [rightKey]) => Number(rightKey) - Number(leftKey));
  entries.sort((left, right) => right[1] - left[1]);
  if (entries.length !== 3 || entries[0][1] === entries[1][1]) return null;
  return Number(entries[0][0]);
}

function result(
  id: string,
  label: string,
  effect: CheckResult['effect'],
  reason: string,
  probability?: number,
  outcome: CheckOutcome = effect === 'none' ? 'passed' : effect === 'stop' ? 'failed' : 'pending',
): CheckResult {
  return {
    id,
    kind: 'judgment',
    label,
    passed: outcome === 'passed' || outcome === 'not_applicable',
    outcome,
    effect,
    reason,
    ...(probability === undefined ? {} : { probability }),
  };
}

function unavailable(): CheckResult {
  return result('jev_unavailable', 'Evaluación JEV no disponible', 'review', 'No pude completar la evaluación', undefined, 'pending');
}

function scopeNotApplicable(): CheckResult {
  return result(
    'scope_match', 'Coincidencia con el alcance', 'none',
    'No aplica: no hay un acuerdo único vigente para evaluar el alcance.', undefined, 'not_applicable',
  );
}

function mapNoul(id: 'instructs_agent' | 'artificial_urgency' | 'fuzzy_duplicate', value: number, preset: Preset): CheckResult {
  const reviewFrom = PRESETS[preset].reviewFrom;
  const action = PRESETS[preset].action;
  let effect: CheckResult['effect'] = 'none';
  let reason: string;

  if (id === 'instructs_agent') {
    effect = value >= action ? 'stop' : value >= reviewFrom ? 'review' : 'none';
    reason = effect === 'stop'
      ? 'La factura intenta instruir al sistema o saltarse un control.'
      : effect === 'review'
        ? 'Revisa una instrucción dirigida al sistema automatizado.'
        : 'No se detectó una instrucción para omitir controles.';
  } else if (value >= reviewFrom) {
    effect = 'review';
    reason = id === 'artificial_urgency'
      ? 'Revisa la urgencia de pago indicada.'
      : 'Compara esta factura con el cobro similar.';
  } else {
    reason = id === 'artificial_urgency'
      ? 'No se detectó urgencia artificial.'
      : 'No se detectó un posible cobro duplicado.';
  }

  const label = id === 'instructs_agent'
    ? 'Instrucciones al sistema'
    : id === 'artificial_urgency' ? 'Urgencia artificial' : 'Posible duplicado';
  return result(id, label, effect, reason, value);
}

function mapScope(answer: ScoreAnswer): CheckResult {
  const top = topScopeIndex(answer);
  let effect: CheckResult['effect'];
  let reason: string;

  if (answer.confidence < 0.6 || top === null || top === 1) {
    effect = 'review';
    reason = 'Confirma que el trabajo corresponde al alcance acordado.';
  } else if (top === 2) {
    effect = 'stop';
    reason = 'El trabajo no coincide con el alcance acordado.';
  } else {
    effect = 'none';
    reason = 'El trabajo coincide con el alcance acordado.';
  }

  return result('scope_match', 'Coincidencia con el alcance', effect, reason, answer.confidence);
}

function mapDocumentType(answer: ChoiceAnswer): CheckResult {
  let effect: CheckResult['effect'] = 'review';
  let reason = 'Confirma el tipo de documento antes de continuar.';

  if (answer.confidence >= 0.6 && PAYABLE_DOCUMENT_TYPES.has(answer.choice)) {
    effect = 'none';
    reason = 'El documento es un tipo de comprobante pagable.';
  } else if (answer.confidence >= 0.8 && REVIEW_ONLY_DOCUMENT_TYPES.has(answer.choice)) {
    effect = 'stop';
    reason = 'El documento parece ser un recibo o una cotización.';
  }

  return result('document_type', 'Tipo de documento', effect, reason, answer.confidence);
}

export function mapJev(answers: JevAnswers, preset: Preset, asked?: { fuzzy?: boolean; scope?: boolean }): CheckResult[] {
  if (!answers.ok) return [unavailable()];

  const values = answers.answers;
  const scopeAsked = asked?.scope !== false;
  const fuzzyDuplicate = values.fuzzy_duplicate;
  const costCenter = values.cost_center;
  if (!isNoulAnswer(values.instructs_agent)
    || !isNoulAnswer(values.artificial_urgency)
    || (scopeAsked && !isScopeAnswer(values.scope_match))
    || !isChoiceAnswer(values.document_type)
    || (asked?.fuzzy === true && fuzzyDuplicate === undefined)
    || (fuzzyDuplicate !== undefined && !isNoulAnswer(fuzzyDuplicate))
    || (costCenter !== undefined && (!isChoiceAnswer(costCenter) || !COST_CENTERS.has(costCenter.choice)))) {
    return [unavailable()];
  }

  const checks = [
    mapNoul('instructs_agent', values.instructs_agent.noul, preset),
    mapNoul('artificial_urgency', values.artificial_urgency.noul, preset),
    scopeAsked ? mapScope(values.scope_match as ScoreAnswer) : scopeNotApplicable(),
  ];

  if (fuzzyDuplicate !== undefined) {
    checks.push(mapNoul('fuzzy_duplicate', fuzzyDuplicate.noul, preset));
  }
  checks.push(mapDocumentType(values.document_type));
  return checks;
}
