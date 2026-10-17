import type { Preset, Rules } from '../domain/types';

const RULE_FIELDS = [
  'version',
  'perPaymentLimitUsdMinor',
  'monthlyLimitUsdMinor',
  'approvalThresholdUsdMinor',
  'fuzzyDuplicateWindowDays',
  'preset',
] as const;

const PRESETS: readonly Preset[] = ['estricto', 'equilibrado', 'permisivo'];
const RULE_FIELD_SET = new Set<string>(RULE_FIELDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeNonnegativeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
}

/** Validates a complete editable rules snapshot and returns a detached copy. */
export function validateRulesConfig(input: unknown): Rules {
  if (!isRecord(input)) throw new TypeError('Rules configuration must be an object');

  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !RULE_FIELD_SET.has(key)) {
      throw new TypeError(`Unknown rules field: ${String(key)}`);
    }
  }

  for (const field of RULE_FIELDS) {
    if (!Object.hasOwn(input, field)) throw new TypeError(`Missing rules field: ${field}`);
  }

  assertSafeNonnegativeInteger(input.version, 'version');
  assertSafeNonnegativeInteger(input.perPaymentLimitUsdMinor, 'perPaymentLimitUsdMinor');
  assertSafeNonnegativeInteger(input.monthlyLimitUsdMinor, 'monthlyLimitUsdMinor');
  assertSafeNonnegativeInteger(input.approvalThresholdUsdMinor, 'approvalThresholdUsdMinor');
  assertSafeNonnegativeInteger(input.fuzzyDuplicateWindowDays, 'fuzzyDuplicateWindowDays');

  if (input.approvalThresholdUsdMinor >= input.perPaymentLimitUsdMinor) {
    throw new RangeError('approvalThresholdUsdMinor must be less than perPaymentLimitUsdMinor');
  }
  if (typeof input.preset !== 'string' || !PRESETS.includes(input.preset as Preset)) {
    throw new TypeError('preset must be estricto, equilibrado, or permisivo');
  }

  return {
    version: input.version,
    perPaymentLimitUsdMinor: input.perPaymentLimitUsdMinor,
    monthlyLimitUsdMinor: input.monthlyLimitUsdMinor,
    approvalThresholdUsdMinor: input.approvalThresholdUsdMinor,
    fuzzyDuplicateWindowDays: input.fuzzyDuplicateWindowDays,
    preset: input.preset as Preset,
  };
}
