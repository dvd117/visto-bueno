export const CURRENCY_DEFINITIONS = {
  USD: { exponent: 2, locale: 'en-US' },
  COP: { exponent: 2, locale: 'es-CO' },
  MXN: { exponent: 2, locale: 'es-MX' },
  CLP: { exponent: 0, locale: 'es-CL' },
  PEN: { exponent: 2, locale: 'es-PE' },
  ARS: { exponent: 2, locale: 'es-AR' },
  VES: { exponent: 2, locale: 'es-VE' },
} as const;

export type Currency = keyof typeof CURRENCY_DEFINITIONS;
export type CurrencyLocale = (typeof CURRENCY_DEFINITIONS)[Currency]['locale'];
export const CURRENCIES = Object.keys(CURRENCY_DEFINITIONS) as [Currency, ...Currency[]];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && Object.hasOwn(CURRENCY_DEFINITIONS, value);
}
