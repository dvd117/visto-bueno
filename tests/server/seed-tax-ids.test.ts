import { describe, expect, it } from 'vitest';
import { seed } from '../../src/server/seed/andina';

const rfcCharacterValues = new Map<string, number>([
  ...[...'0123456789'].map((character, value) => [character, value] as const),
  ...[...'ABCDEFGHIJKLMN'].map((character, index) => [character, index + 10] as const),
  ['&', 24] as const,
  ...[...'OPQRSTUVWXYZ'].map((character, index) => [character, index + 25] as const),
  [' ', 37] as const,
  ['Ñ', 38] as const,
]);

function expectedMexicanRfcCheckDigit(rfc: string): string | null {
  if (!/^[A-ZÑ&]{3}\d{6}[A-Z\d]{2}[\dA]$/u.test(rfc)) return null;

  const body = rfc.slice(0, -1).padStart(12, ' ');
  const sum = [...body].reduce((total, character, index) => (
    total + rfcCharacterValues.get(character)! * (13 - index)
  ), 0);
  const digit = 11 - (sum % 11);

  return digit === 11 ? '0' : digit === 10 ? 'A' : String(digit);
}

describe('Mexican RFC seed tax IDs', () => {
  it('has a valid SAT check digit for every RFC-formatted Mexican vendor tax ID', () => {
    const mexicanRfcVendors = seed().vendors.filter((vendor) => (
      vendor.country === 'MX' && expectedMexicanRfcCheckDigit(vendor.taxId) !== null
    ));

    expect(mexicanRfcVendors.length).toBeGreaterThan(0);
    for (const vendor of mexicanRfcVendors) {
      expect(vendor.taxId.at(-1), vendor.name).toBe(expectedMexicanRfcCheckDigit(vendor.taxId));
    }
  });
});
