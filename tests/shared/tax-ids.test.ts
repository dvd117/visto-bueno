import { describe, expect, it } from 'vitest';
import { taxIdChecksumValid } from '../../src/shared/domain/tax-ids';

// Test-only synthetic IDs; checksums do not establish that a tax ID is registered or real.
const examples = [
  ['VE', 'J-00000000-0'],
  ['PE', '20-00000000-1'],
  ['AR', '30-00000000-7'],
] as const;

describe('country tax ID checksums', () => {
  it.each(examples)('accepts the synthetic %s checksum vector', (country, taxId) => {
    expect(taxIdChecksumValid(country, taxId)).toBe(true);
  });

  it.each([
    ['VE', 'J-00000000-1'],
    ['PE', '20-00000000-0'],
    ['AR', '30-00000000-6'],
  ] as const)('rejects an incorrect %s check digit', (country, taxId) => {
    expect(taxIdChecksumValid(country, taxId)).toBe(false);
  });

  it('accepts common display separators and RIF case but rejects unrelated letters', () => {
    expect(taxIdChecksumValid('VE', 'j-00000000-0')).toBe(true);
    expect(taxIdChecksumValid('PE', '20-00000000-1')).toBe(true);
    expect(taxIdChecksumValid('AR', '30-00000000-7')).toBe(true);
    expect(taxIdChecksumValid('PE', '20x00000001')).toBe(false);
  });

  it('does not apply X2 checks to other countries', () => {
    expect(taxIdChecksumValid('CO', '900.000.001-1')).toBeNull();
  });
});
