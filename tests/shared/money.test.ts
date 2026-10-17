import { describe, expect, it } from 'vitest';
import type { Currency, FxRate } from '../../src/shared/domain/types';
import { formatMoney, parseAmount, toUsdMinor } from '../../src/shared/domain/money';

describe('parseAmount', () => {
  it('parses Colombian pesos with es-419 punctuation', () => {
    expect(parseAmount('COP 4.800.000,00', { currency: 'COP' })).toEqual({
      ok: true,
      money: { currency: 'COP', minor: 480000000 },
    });
  });

  it('parses mixed locale formats without a locale hint', () => {
    expect(parseAmount('USD 1,200.00', { currency: 'USD' })).toEqual({
      ok: true,
      money: { currency: 'USD', minor: 120000 },
    });
    expect(parseAmount('USD 850,00', { currency: 'USD' })).toEqual({
      ok: true,
      money: { currency: 'USD', minor: 85000 },
    });
    expect(parseAmount('MXN 62.000,00', { currency: 'MXN' })).toEqual({
      ok: true,
      money: { currency: 'MXN', minor: 6200000 },
    });
  });

  it('rejects a lone separator with three trailing digits as ambiguous without a locale hint', () => {
    expect(parseAmount('USD 2.500', { currency: 'USD' })).toEqual({ ok: false, reason: 'ambiguous' });
    expect(parseAmount('USD 2,500', { currency: 'USD' })).toEqual({ ok: false, reason: 'ambiguous' });
    expect(parseAmount('USD 850,004', { currency: 'USD' })).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('uses the locale hint to resolve a lone separator as a thousands mark', () => {
    const cases: Array<{ raw: string; currency: Currency; locale: 'es-CO' | 'es-VE' | 'es-MX' | 'en-US' }> = [
      { raw: 'USD 2.500', currency: 'USD', locale: 'es-CO' },
      { raw: 'USD 2.500', currency: 'USD', locale: 'es-VE' },
      { raw: 'USD 2,500', currency: 'USD', locale: 'es-MX' },
      { raw: 'USD 2,500', currency: 'USD', locale: 'en-US' },
    ];

    for (const entry of cases) {
      expect(parseAmount(entry.raw, { currency: entry.currency, locale: entry.locale })).toEqual({
        ok: true,
        money: { currency: 'USD', minor: 250000 },
      });
    }
  });

  it('rejects decimal fractions with more than two digits', () => {
    for (const raw of [
      'USD 1.2345',
      'USD 12,3456',
      'USD 1.234,567',
      'USD 1,234.567',
    ]) {
      expect(parseAmount(raw, { currency: 'USD' })).toEqual({ ok: false, reason: 'unparseable' });
    }
  });

  it('rejects three decimal digits when a locale hint identifies the separator as decimal', () => {
    expect(parseAmount('USD 2.500', { currency: 'USD', locale: 'en-US' })).toEqual({
      ok: false,
      reason: 'unparseable',
    });
    expect(parseAmount('USD 2.500', { currency: 'USD', locale: 'es-MX' })).toEqual({
      ok: false,
      reason: 'unparseable',
    });
    expect(parseAmount('USD 2,500', { currency: 'USD', locale: 'es-CO' })).toEqual({
      ok: false,
      reason: 'unparseable',
    });
  });

  it('uses self-describing separators even when the locale hint disagrees', () => {
    expect(parseAmount('USD 850.004,00', { currency: 'USD' })).toEqual({
      ok: true,
      money: { currency: 'USD', minor: 85000400 },
    });
    expect(parseAmount('MXN 62.000,00', { currency: 'MXN', locale: 'es-MX' })).toEqual({
      ok: true,
      money: { currency: 'MXN', minor: 6200000 },
    });
    expect(parseAmount('COP 4.800.000', { currency: 'COP', locale: 'en-US' })).toEqual({
      ok: true,
      money: { currency: 'COP', minor: 480000000 },
    });
    expect(parseAmount('USD 1,200.00', { currency: 'USD', locale: 'es-CO' })).toEqual({
      ok: true,
      money: { currency: 'USD', minor: 120000 },
    });
  });

  it('rejects negative amounts', () => {
    expect(parseAmount('USD -850,00', { currency: 'USD' })).toEqual({ ok: false, reason: 'unparseable' });
    expect(parseAmount('-850,00', { currency: 'USD' })).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('parses decimal cents and a currency symbol', () => {
    expect(parseAmount('USD 2.500,00', { currency: 'USD' })).toEqual({
      ok: true,
      money: { currency: 'USD', minor: 250000 },
    });
    expect(parseAmount('$ 310', { currency: 'USD' })).toEqual({
      ok: true,
      money: { currency: 'USD', minor: 31000 },
    });
  });

  it('returns unparseable for text without an amount', () => {
    expect(parseAmount('abc', { currency: 'USD' })).toEqual({ ok: false, reason: 'unparseable' });
  });
});

describe('toUsdMinor', () => {
  const fx: FxRate[] = [
    { currency: 'COP', perUsd: '4171.30', date: '2026-10-15' },
    { currency: 'MXN', perUsd: '18.8656', date: '2026-10-15' },
  ];

  it('converts COP and MXN to USD minor units', () => {
    expect(toUsdMinor({ currency: 'COP', minor: 480000000 }, fx)).toEqual({ ok: true, usdMinor: 115072 });
    expect(toUsdMinor({ currency: 'MXN', minor: 6200000 }, fx)).toEqual({ ok: true, usdMinor: 328640 });
  });

  it('returns missing_rate when the currency has no FX entry', () => {
    expect(toUsdMinor({ currency: 'COP', minor: 100 }, [])).toEqual({ ok: false, reason: 'missing_rate' });
  });

  it('rounds exact half cents to the nearest even cent', () => {
    const constructedFx: FxRate[] = [{ currency: 'COP', perUsd: '2', date: '2026-10-15' }];
    expect(toUsdMinor({ currency: 'COP', minor: 1 }, constructedFx)).toEqual({ ok: true, usdMinor: 0 });
    expect(toUsdMinor({ currency: 'COP', minor: 3 }, constructedFx)).toEqual({ ok: true, usdMinor: 2 });
  });
});

describe('formatMoney', () => {
  it('formats money with es-419 grouping and decimal marks', () => {
    expect(formatMoney({ currency: 'COP', minor: 480000000 })).toBe('COP 4.800.000,00');
    expect(formatMoney({ currency: 'USD', minor: 85000 })).toBe('USD 850,00');
  });
});
