import { describe, expect, it } from 'vitest';
import type { Rules } from '../../src/shared/domain/types';
import { validateRulesConfig } from '../../src/shared/engine/rules-config';

const validRules: Rules = {
  version: 1,
  perPaymentLimitUsdMinor: 1_500_000,
  monthlyLimitUsdMinor: 6_000_000,
  approvalThresholdUsdMinor: 300_000,
  fuzzyDuplicateWindowDays: 60,
  preset: 'equilibrado',
};

describe('validateRulesConfig', () => {
  it('returns an independent copy of a valid rules snapshot', () => {
    const parsed = validateRulesConfig(validRules);

    expect(parsed).toEqual(validRules);
    expect(parsed).not.toBe(validRules);
  });

  it('accepts a zero fuzzy window and zero monthly limit', () => {
    expect(validateRulesConfig({
      ...validRules,
      monthlyLimitUsdMinor: 0,
      fuzzyDuplicateWindowDays: 0,
    })).toMatchObject({ monthlyLimitUsdMinor: 0, fuzzyDuplicateWindowDays: 0 });
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s USD-minor limit', (_label, value) => {
    expect(() => validateRulesConfig({ ...validRules, perPaymentLimitUsdMinor: value }))
      .toThrow(/perPaymentLimitUsdMinor/);
  });

  it('rejects an approval threshold equal to or above the per-payment limit', () => {
    expect(() => validateRulesConfig({
      ...validRules,
      perPaymentLimitUsdMinor: 500,
      approvalThresholdUsdMinor: 500,
    })).toThrow(/approvalThresholdUsdMinor/);
    expect(() => validateRulesConfig({
      ...validRules,
      perPaymentLimitUsdMinor: 500,
      approvalThresholdUsdMinor: 501,
    })).toThrow(/approvalThresholdUsdMinor/);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid fuzzy window %s', (value) => {
    expect(() => validateRulesConfig({ ...validRules, fuzzyDuplicateWindowDays: value }))
      .toThrow(/fuzzyDuplicateWindowDays/);
  });

  it('rejects invalid presets and unknown safety-rule overrides', () => {
    expect(() => validateRulesConfig({ ...validRules, preset: 'disable-checks' }))
      .toThrow(/preset/);
    expect(() => validateRulesConfig({ ...validRules, requireAllowlist: false }))
      .toThrow(/Unknown rules field: requireAllowlist/);
    expect(() => validateRulesConfig({ ...validRules, requireContract: false }))
      .toThrow(/Unknown rules field: requireContract/);
  });

  it('rejects non-object and incomplete configurations', () => {
    expect(() => validateRulesConfig(null)).toThrow(/object/);
    expect(() => validateRulesConfig({ ...validRules, preset: undefined })).toThrow(/preset/);
  });
});
