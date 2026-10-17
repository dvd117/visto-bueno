import { describe, expect, it } from 'vitest';
import type { JevAnswer, JevAnswers, JevQuestionId, Preset } from '../../src/shared/domain/types';
import { buildJevQuestions } from '../../src/shared/engine/jev-questions';
import { mapJev, PRESETS } from '../../src/shared/engine/jev-map';

const noul = (n: number): JevAnswer => ({ type: 'noul', noul: n });
const choice = (value: string, confidence: number): JevAnswer => ({
  type: 'choice', choice: value, confidence, probabilities: { [value]: confidence },
});
const score = (top: number, confidence: number): JevAnswer => ({
  type: 'score', score: top, confidence,
  probabilities: { '0': top === 0 ? 0.9 : 0.05, '1': top === 1 ? 0.9 : 0.05, '2': top === 2 ? 0.9 : 0.05 },
});

function validJev(overrides: Partial<Record<JevQuestionId, JevAnswer>> = {}): Extract<JevAnswers, { ok: true }> {
  return {
    ok: true,
    answers: {
      instructs_agent: noul(0),
      artificial_urgency: noul(0),
      scope_match: score(0, 0.9),
      document_type: choice('factura', 0.9),
      ...overrides,
    },
    latencyMs: 1,
    recorded: true,
    inputTokens: 20,
  };
}

function checkFor(id: string, answers: JevAnswers, preset: Preset = 'equilibrado') {
  const check = mapJev(answers, preset).find((item) => item.id === id);
  expect(check, `expected check ${id}`).toBeDefined();
  return check!;
}

describe('JEV questions', () => {
  it('includes conditional fuzzy and cost-center questions only when requested', () => {
    const base = buildJevQuestions({ needFuzzy: false, needCostCenter: false });
    expect(base).not.toHaveProperty('fuzzy_duplicate');
    expect(base).not.toHaveProperty('cost_center');
    expect(base).toHaveProperty('instructs_agent');
    expect(base).toHaveProperty('artificial_urgency');
    expect(base).toHaveProperty('scope_match');
    expect(base).toHaveProperty('document_type');

    const conditional = buildJevQuestions({ needFuzzy: true, needCostCenter: true });
    expect(conditional).toHaveProperty('fuzzy_duplicate');
    expect(conditional).toHaveProperty('cost_center');
  });

  it('uses the specified scope and document criteria', () => {
    const questions = buildJevQuestions({ needFuzzy: false, needCostCenter: false });
    expect(questions.scope_match).toMatchObject({
      type: 'score',
      criteria: ['Coincide con lo acordado', 'Parcialmente', 'No coincide'],
    });
    expect(Object.keys((questions.document_type as { criteria: Record<string, unknown> }).criteria))
      .toEqual(['factura', 'cuenta de cobro', 'recibo', 'cotización', 'otro']);
  });
});

describe('JEV presets and mapping', () => {
  it('pins each preset threshold', () => {
    expect(PRESETS).toEqual({
      estricto: { action: 0.6, reviewFrom: 0.25 },
      equilibrado: { action: 0.7, reviewFrom: 0.35 },
      permisivo: { action: 0.85, reviewFrom: 0.5 },
    });
    expect(Object.isFrozen(PRESETS)).toBe(true);
    expect(Object.isFrozen(PRESETS.estricto)).toBe(true);
  });

  it.each([
    ['estricto', 0.6, 0.25],
    ['equilibrado', 0.7, 0.35],
    ['permisivo', 0.85, 0.5],
  ] as const)('applies both sides of instructs_agent thresholds for %s', (preset, action, reviewFrom) => {
    const effect = (value: number) => checkFor('instructs_agent', validJev({ instructs_agent: noul(value) }), preset).effect;
    expect(effect(reviewFrom - 0.01)).toBe('none');
    expect(effect(reviewFrom)).toBe('review');
    expect(effect(action - 0.01)).toBe('review');
    expect(effect(action)).toBe('stop');
  });

  it.each([
    ['estricto', 0.25],
    ['equilibrado', 0.35],
    ['permisivo', 0.5],
  ] as const)('maps urgency and fuzzy-duplicate thresholds for %s', (preset, reviewFrom) => {
    expect(checkFor('artificial_urgency', validJev({ artificial_urgency: noul(reviewFrom - 0.01) }), preset).effect).toBe('none');
    expect(checkFor('artificial_urgency', validJev({ artificial_urgency: noul(reviewFrom) }), preset).effect).toBe('review');
    expect(checkFor('fuzzy_duplicate', validJev({ fuzzy_duplicate: noul(reviewFrom - 0.01) }), preset).effect).toBe('none');
    expect(checkFor('fuzzy_duplicate', validJev({ fuzzy_duplicate: noul(reviewFrom) }), preset).effect).toBe('review');
  });

  it('stops high-confidence scope mismatches and reviews partial or uncertain matches', () => {
    const result = (top: number, confidence: number) => checkFor('scope_match', validJev({ scope_match: score(top, confidence) }));
    expect(result(2, 0.59).effect).toBe('review');
    expect(result(2, 0.6).effect).toBe('stop');
    expect(result(1, 0.99).effect).toBe('review');
    expect(result(0, 0.59).effect).toBe('review');
    expect(result(0, 0.6).effect).toBe('none');
  });

  it('marks scope not applicable and ignores the answer when no unique contract is active', () => {
    const { scope_match: _scope, ...answers } = validJev({ scope_match: score(2, 0.99) }).answers;
    const checks = mapJev({ ...validJev(), answers }, 'equilibrado', { scope: false });
    expect(checks).toContainEqual(expect.objectContaining({
      id: 'scope_match', passed: true, outcome: 'not_applicable', effect: 'none',
    }));
    expect(checks.find((check) => check.id === 'jev_unavailable')).toBeUndefined();
  });

  it('reviews an ambiguous top score instead of selecting a confident category', () => {
    const answer: JevAnswer = {
      type: 'score', score: 1, confidence: 0.9, probabilities: { '0': 0.5, '1': 0.5, '2': 0 },
    };
    expect(checkFor('scope_match', validJev({ scope_match: answer })).effect).toBe('review');
  });

  it.each(['factura', 'cuenta de cobro'])('accepts payable document type %s at sufficient confidence', (documentType) => {
    expect(checkFor('document_type', validJev({ document_type: choice(documentType, 0.6) })).effect).toBe('none');
  });

  it.each(['factura', 'cuenta de cobro'])('reviews low-confidence payable type %s', (documentType) => {
    expect(checkFor('document_type', validJev({ document_type: choice(documentType, 0.59) })).effect).toBe('review');
  });

  it.each(['cotización', 'recibo'])('applies both confidence cutoffs to %s', (documentType) => {
    const effect = (confidence: number) => checkFor('document_type', validJev({ document_type: choice(documentType, confidence) })).effect;
    expect(effect(0.59)).toBe('review');
    expect(effect(0.6)).toBe('review');
    expect(effect(0.79)).toBe('review');
    expect(effect(0.8)).toBe('stop');
  });

  it('reviews other and unknown document types', () => {
    expect(checkFor('document_type', validJev({ document_type: choice('otro', 0.99) })).effect).toBe('review');
    expect(checkFor('document_type', validJev({ document_type: choice('factura proforma', 0.99) })).effect).toBe('review');
  });

  it('treats cost-center suggestions as non-authorizing', () => {
    const checks = mapJev(validJev({ cost_center: choice('legal', 0.99) }), 'equilibrado');
    expect(checks.some((item) => item.id === 'cost_center')).toBe(false);
    expect(checks.every((item) => item.effect !== 'approval')).toBe(true);
  });

  it('fails closed when a fuzzy answer was requested but is missing or invalid', () => {
    const requested = { fuzzy: true };
    expect(mapJev(validJev(), 'equilibrado', requested)).toEqual([
      expect.objectContaining({ id: 'jev_unavailable', effect: 'review' }),
    ]);
    expect(mapJev(validJev({ fuzzy_duplicate: choice('sí', 0.9) }), 'equilibrado', requested)).toEqual([
      expect.objectContaining({ id: 'jev_unavailable', effect: 'review' }),
    ]);
  });

  it('turns JEV failure into one fixed review check', () => {
    const checks = mapJev({ ok: false, error: 'timeout' }, 'equilibrado');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'jev_unavailable', kind: 'judgment', passed: false, effect: 'review',
      reason: 'No pude completar la evaluación',
    });
  });

  it('fails closed when a required answer is missing or malformed', () => {
    const { document_type: _missing, ...answers } = validJev().answers;
    expect(mapJev({ ...validJev(), answers }, 'equilibrado')).toEqual([
      expect.objectContaining({ id: 'jev_unavailable', effect: 'review' }),
    ]);

    const malformed = validJev();
    (malformed.answers as Record<string, unknown>).instructs_agent = { type: 'choice', choice: 'sí' };
    expect(mapJev(malformed, 'equilibrado')).toEqual([
      expect.objectContaining({ id: 'jev_unavailable', effect: 'review' }),
    ]);
  });

  it('fails closed when a required choice answer has no probability scores', () => {
    const answer: JevAnswer = {
      type: 'choice', choice: 'factura', confidence: 0.99, probabilities: {},
    };
    expect(mapJev(validJev({ document_type: answer }), 'equilibrado')).toEqual([
      expect.objectContaining({ id: 'jev_unavailable', effect: 'review' }),
    ]);
  });
});
