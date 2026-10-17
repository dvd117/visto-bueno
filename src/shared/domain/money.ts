import Decimal from 'decimal.js';
import type { Currency, FxRate, Money } from './types';

type Locale = 'es-CO' | 'es-VE' | 'es-MX' | 'en-US';
type ParseResult = { ok: true; normalized: string } | { ok: false; reason: 'ambiguous' | 'unparseable' };
type AmountResult = { ok: true; money: Money } | { ok: false; reason: 'ambiguous' | 'unparseable' };
type UsdResult = { ok: true; usdMinor: number } | { ok: false; reason: 'missing_rate' };

const separators: Record<Locale, { decimal: '.' | ','; group: '.' | ',' }> = {
  'es-CO': { decimal: ',', group: '.' },
  'es-VE': { decimal: ',', group: '.' },
  'es-MX': { decimal: '.', group: ',' },
  'en-US': { decimal: '.', group: ',' },
};

function validGroups(parts: string[]): boolean {
  return /^\d{1,3}$/.test(parts[0] ?? '') && parts.slice(1).every((part) => /^\d{3}$/.test(part));
}

function normalizeAmount(raw: string, locale?: Locale): ParseResult {
  const unsigned = raw;
  if (!/^\d+(?:[.,]\d+)*$/.test(unsigned)) return { ok: false, reason: 'unparseable' };

  const dotCount = (unsigned.match(/\./g) ?? []).length;
  const commaCount = (unsigned.match(/,/g) ?? []).length;
  const localeSeparators = locale ? separators[locale] : undefined;

  if (dotCount && commaCount) {
    const lastDot = unsigned.lastIndexOf('.');
    const lastComma = unsigned.lastIndexOf(',');
    const decimalSeparator = lastDot > lastComma ? '.' : ',';
    const groupSeparator = decimalSeparator === '.' ? ',' : '.';

    const decimalParts = unsigned.split(decimalSeparator);
    if (decimalParts.length !== 2) return { ok: false, reason: 'unparseable' };
    const [integerPart, fractionPart] = decimalParts;
    const groups = integerPart.split(groupSeparator);
    if (
      fractionPart.length > 2 ||
      !/^\d+$/.test(fractionPart) ||
      !/^\d+$/.test(groups.join('')) ||
      (groups.length > 1 && !validGroups(groups))
    ) {
      return { ok: false, reason: 'unparseable' };
    }
    return { ok: true, normalized: `${groups.join('')}.${fractionPart}` };
  }

  const separator = dotCount ? '.' : commaCount ? ',' : undefined;
  if (!separator) return { ok: true, normalized: unsigned };

  const parts = unsigned.split(separator);
  if (parts.length > 2) {
    if (!validGroups(parts)) return { ok: false, reason: 'unparseable' };
    return { ok: true, normalized: parts.join('') };
  }

  const [integerPart, fractionPart] = parts;
  if (fractionPart.length === 3) {
    if (!localeSeparators) return { ok: false, reason: 'ambiguous' };
    if (separator === localeSeparators.group) {
      if (!validGroups(parts)) return { ok: false, reason: 'unparseable' };
      return { ok: true, normalized: parts.join('') };
    }
    return { ok: false, reason: 'unparseable' };
  }

  if (fractionPart.length > 2) return { ok: false, reason: 'unparseable' };
  return { ok: true, normalized: `${integerPart}.${fractionPart}` };
}

export function parseAmount(raw: string, hint: { currency: Currency; locale?: Locale }): AmountResult {
  let amount = raw.trim();
  const currencyPrefix = /^(USD|COP|MXN)\s*/i.exec(amount);
  if (currencyPrefix) {
    if (currencyPrefix[1].toUpperCase() !== hint.currency) return { ok: false, reason: 'unparseable' };
    amount = amount.slice(currencyPrefix[0].length);
  } else if (amount.startsWith('$')) {
    amount = amount.slice(1).trimStart();
  }

  const normalized = normalizeAmount(amount, hint.locale);
  if (!normalized.ok) return normalized;

  const minor = new Decimal(normalized.normalized).times(100);
  const minorNumber = Number(minor.toFixed(0));
  if (!Number.isSafeInteger(minorNumber)) return { ok: false, reason: 'unparseable' };
  return { ok: true, money: { currency: hint.currency, minor: minorNumber } };
}

export function toUsdMinor(money: Money, fx: FxRate[]): UsdResult {
  if (!Number.isSafeInteger(money.minor)) return { ok: false, reason: 'missing_rate' };
  if (money.currency === 'USD') return { ok: true, usdMinor: money.minor };

  const rate = fx.find((entry) => entry.currency === money.currency);
  if (!rate) return { ok: false, reason: 'missing_rate' };

  try {
    const perUsd = new Decimal(rate.perUsd);
    if (!perUsd.isFinite() || !perUsd.isPositive()) return { ok: false, reason: 'missing_rate' };
    const usdMinor = new Decimal(money.minor.toString())
      .div(perUsd)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
    const usdMinorNumber = Number(usdMinor.toFixed(0));
    if (!Number.isSafeInteger(usdMinorNumber)) return { ok: false, reason: 'missing_rate' };
    return { ok: true, usdMinor: usdMinorNumber };
  } catch {
    return { ok: false, reason: 'missing_rate' };
  }
}

export function formatMoney(money: Money): string {
  const formatted = new Decimal(money.minor.toString()).div(100).toFixed(2, Decimal.ROUND_HALF_EVEN);
  const negative = formatted.startsWith('-');
  const unsigned = negative ? formatted.slice(1) : formatted;
  const [integerPart, fractionPart] = unsigned.split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${money.currency} ${negative ? '-' : ''}${grouped},${fractionPart}`;
}
