import type { VendorCountry } from './types';

const RIF_TYPE_VALUES: Record<string, number> = { V: 1, E: 2, J: 3, P: 4, G: 5 };
const CHECK_DIGIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
const CUIT_PREFIXES = new Set(['20', '23', '24', '27', '30', '33', '34']);
// SUNAT references for Peruvian RUC formats and prefix usage:
// https://centrovirtual.sunat.gob.pe/tramites/inscribete-ruc
// https://www.sunat.gob.pe/orientacion/pvs/registro/manual/mu-0441-pvs-T-Registro_RM_170_2023_TR.pdf
const PE_RUC_PREFIXES = new Set(['10', '15', '17', '20']);

function nationalTaxIdDigits(value: string): string | null {
  const match = /^(\d{2})[-\s]?(\d{8})[-\s]?(\d)$/u.exec(value.trim());
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

/** Returns null when X2 does not define a checksum for this country. This is not registry or identity verification. */
export function taxIdChecksumValid(country: VendorCountry, value: string): boolean | null {
  if (country === 'VE') {
    const match = /^([VEJPG])-?(\d{8})-?(\d)$/u.exec(value.trim().toUpperCase());
    if (!match) return false;

    const typeValue = RIF_TYPE_VALUES[match[1]!];
    const body = [String(typeValue), ...match[2]!];
    const weights = [4, 3, 2, 7, 6, 5, 4, 3, 2];
    const sum = body.reduce((total, digit, index) => total + Number(digit) * weights[index]!, 0);
    const remainder = sum % 11;
    const expected = remainder < 2 ? 0 : 11 - remainder;
    return expected === Number(match[3]);
  }

  if (country === 'PE') {
    const digits = nationalTaxIdDigits(value);
    if (!digits || !/^\d{11}$/u.test(digits) || !PE_RUC_PREFIXES.has(digits.slice(0, 2))) return false;
    const sum = [...digits.slice(0, 10)].reduce(
      (total, digit, index) => total + Number(digit) * CHECK_DIGIT_WEIGHTS[index]!, 0,
    );
    const rawDigit = 11 - (sum % 11);
    const expected = rawDigit === 11 ? 1 : rawDigit === 10 ? 0 : rawDigit;
    return expected === Number(digits[10]);
  }

  if (country === 'AR') {
    const digits = nationalTaxIdDigits(value);
    if (!digits || !/^\d{11}$/u.test(digits) || !CUIT_PREFIXES.has(digits.slice(0, 2))) return false;
    const sum = [...digits.slice(0, 10)].reduce(
      (total, digit, index) => total + Number(digit) * CHECK_DIGIT_WEIGHTS[index]!, 0,
    );
    const rawDigit = 11 - (sum % 11);
    const expected = rawDigit === 11 ? 0 : rawDigit === 10 ? 9 : rawDigit;
    return expected === Number(digits[10]);
  }

  return null;
}
