import { describe, expect, it } from 'vitest';
import type { CheckResult, Decision } from '../../src/shared/domain/types';
import { subtitleForDecision } from '../../src/shared/engine/copy';

function check(id: string, effect: CheckResult['effect']): CheckResult {
  return { id, kind: id.startsWith('R') ? 'rule' : 'verify', label: id, passed: false, effect, reason: 'Reason' };
}

function decision(
  status: Decision['status'],
  checks: CheckResult[],
  flagIds: string[] = [],
): Pick<Decision, 'status' | 'checks' | 'flags'> {
  return {
    status,
    checks,
    flags: flagIds.map((id) => ({ id, checkId: id, reason: 'Reason' })),
  };
}

describe('subtitleForDecision', () => {
  it.each([
    'extraction_failed', 'source_amountRaw', 'source_payoutAccount', 'source_payeeTaxId', 'source_invoiceId',
    'multiple_tax_ids', 'multiple_totals', 'multiple_currencies', 'sum_mismatch', 'missing_amount',
    'missing_payee', 'ambiguous_amount', 'R10',
  ])('labels %s as a data doubt', (id) => {
    expect(subtitleForDecision(decision('review_required', [check(id, 'review')], [id])))
      .toBe('Duda en los datos');
  });

  it.each([
    ['jev_unavailable', 'Evaluación incompleta'],
    ['instructs_agent', 'Instrucción en la factura'],
    ['artificial_urgency', 'Urgencia por confirmar'],
    ['scope_match', 'Alcance por confirmar'],
    ['fuzzy_duplicate', 'Posible duplicado'],
    ['document_type', 'Tipo de documento'],
  ])('labels review reason %s accurately', (id, subtitle) => {
    expect(subtitleForDecision(decision('review_required', [check(id, 'review')], [id]))).toBe(subtitle);
  });

  it.each([
    ['image_confirmation', 'No verificable en imagen'],
    ['R6', 'Monto variable'],
    ['R15', 'Excede el límite automático'],
  ])('labels approval reason %s accurately', (id, subtitle) => {
    expect(subtitleForDecision(decision('approval_required', [check(id, 'approval')]))).toBe(subtitle);
  });

  it('uses the first approval check in engine order and never labels image approval as the limit', () => {
    expect(subtitleForDecision(decision('approval_required', [
      check('image_confirmation', 'approval'), check('R15', 'approval'),
    ]))).toBe('No verificable en imagen');
    expect(subtitleForDecision(decision('approval_required', [check('R15', 'approval')]))).toBe('Excede el límite automático');
  });

  it('uses the first unresolved review check in engine order when reasons overlap', () => {
    expect(subtitleForDecision(decision('review_required', [
      check('missing_amount', 'review'), check('artificial_urgency', 'review'),
    ], ['artificial_urgency', 'missing_amount']))).toBe('Duda en los datos');
  });

  it('explains approval after a resolved review without reusing its unresolved subtitle', () => {
    expect(subtitleForDecision(decision('approval_required', [check('fuzzy_duplicate', 'review')]))).toBe('Aprobación tras revisión');
  });

  it('returns no subtitle for unknown reasons and statuses without a mapped reason', () => {
    expect(subtitleForDecision(decision('review_required', [check('unknown', 'review')], ['unknown']))).toBeUndefined();
    expect(subtitleForDecision(decision('stopped', [check('image_confirmation', 'approval')]))).toBeUndefined();
    expect(subtitleForDecision(decision('ready', []))).toBeUndefined();
  });
});
