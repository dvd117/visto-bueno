import { describe, expect, it } from 'vitest';
import type { ExtractionClaims, ExtractionResult, Vendor } from '../../src/shared/domain/types';
import { normalize, normalizeAccount } from '../../src/shared/engine/normalize';
import { verifyClaims } from '../../src/shared/engine/verify';

const vendor: Vendor = {
  id: 'vendor-1', name: 'Nube Andina S.A.S.', taxId: '901.234.567-8', country: 'CO',
  payoutCurrency: 'USD', payoutAccount: 'Bancolombia ···· 8890', status: 'allowed', version: 1,
};

function claims(overrides: Partial<ExtractionClaims> = {}): ExtractionClaims {
  return {
    amountsFound: ['USD 100.00'], accountsFound: ['Bancolombia ···· 8890'], taxIdsFound: ['901.234.567-8'],
    invoiceIdsFound: ['INV-001'], currenciesFound: ['USD'], payeeName: 'Nube Andina S.A.S.',
    payeeTaxId: '901.234.567-8', payoutAccount: 'Bancolombia ···· 8890', invoiceId: 'INV-001',
    invoiceDate: '2026-10-16', dueDate: '2026-10-20', currency: 'USD', amountRaw: 'USD 100.00',
    subtotalRaw: null, taxesRaw: null, quantity: null, rateRaw: null, description: 'Hosting',
    documentTypeHint: 'factura', hasMultipleCurrenciesShown: false,
    evidenceQuotes: {}, suspiciousPassages: [], ...overrides,
  };
}

function extraction(overrides: Partial<Extract<ExtractionResult, { ok: true }>> = {}): Extract<ExtractionResult, { ok: true }> {
  return {
    ok: true,
    claims: claims(),
    sourceText: 'NIT 901.234.567-8\nCuenta Bancolombia ···· 8890\nFactura INV-001\nTotal USD 100.00',
    sourceKind: 'text',
    ...overrides,
  };
}

function getCheck(result: ReturnType<typeof verifyClaims>, id: string) {
  const check = result.checks.find((item) => item.id === id);
  expect(check, `missing check ${id}`).toBeDefined();
  return check!;
}

describe('verifyClaims', () => {
  it('normalizes Unicode compatibility forms, punctuation, and spaces for identifiers', () => {
    expect(normalize('ＡＬ– 043')).toBe('al043');
    expect(normalizeAccount('Bancolombia 1234568890')).toBe(normalizeAccount('Bancolombia ···· 8890'));
  });

  it('verifies literal source claims and matches a vendor by tax id', () => {
    const result = verifyClaims(extraction(), [vendor]);
    expect(result.vendor).toEqual(vendor);
    expect(result.money).toEqual({ currency: 'USD', minor: 10_000 });
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result.checks.every((check) => check.effect === 'none')).toBe(true);
  });

  it('checks chosen critical claims against whitespace-normalized source text', () => {
    const result = verifyClaims(extraction({
      sourceText: 'NIT 901.234.567-8\nCuenta Bancolombia\n···· 8890\nFactura INV-001\nTotal USD\n100.00',
    }), [vendor]);
    expect(result.checks.filter((check) => check.id.startsWith('source_')).every((check) => check.passed)).toBe(true);
  });

  it.each([
    ['amountRaw', 'source_amountRaw'],
    ['payoutAccount', 'source_payoutAccount'],
    ['payeeTaxId', 'source_payeeTaxId'],
    ['invoiceId', 'source_invoiceId'],
  ] as const)('reviews a chosen %s that is absent from the source', (field, id) => {
    const sourceText = 'NIT 901.234.567-8 Cuenta Bancolombia ···· 8890 Factura INV-001 Total USD 100.00';
    const chosen = field === 'amountRaw' ? 'USD 999.00'
      : field === 'payoutAccount' ? 'Bancolombia ···· 1111'
        : field === 'payeeTaxId' ? '999.999.999-9' : 'INV-999';
    const result = verifyClaims(extraction({
      claims: claims({ [field]: chosen }), sourceText,
    }), [vendor]);
    expect(getCheck(result, id)).toMatchObject({ passed: false, effect: 'review' });
  });

  it('reviews a missing or unconfirmed total', () => {
    const missing = verifyClaims(extraction({ claims: claims({ amountRaw: null, amountsFound: [] }) }), [vendor]);
    expect(getCheck(missing, 'missing_amount')).toMatchObject({ passed: false, effect: 'review' });

    const unconfirmed = verifyClaims(extraction({
      claims: claims({ amountRaw: 'USD 999.00' }),
      sourceText: 'NIT 901.234.567-8 Cuenta Bancolombia ···· 8890 Factura INV-001 Total USD 100.00',
    }), [vendor]);
    expect(getCheck(unconfirmed, 'source_amountRaw')).toMatchObject({ passed: false, effect: 'review' });
  });

  it('reviews non-invoice text without crashing or inventing a payee or amount', () => {
    const result = verifyClaims(extraction({
      claims: claims({
        amountsFound: [], accountsFound: [], taxIdsFound: [], invoiceIdsFound: [], currenciesFound: [],
        payeeName: null, payeeTaxId: null, payoutAccount: null, invoiceId: null, currency: null, amountRaw: null,
        documentTypeHint: null,
      }),
      sourceText: 'hola, ¿me pagan?',
    }), [vendor]);
    expect(getCheck(result, 'missing_amount')).toMatchObject({ passed: false, effect: 'review' });
    expect(getCheck(result, 'missing_payee')).toMatchObject({ passed: false, effect: 'review' });
    expect(result.vendor).toBeNull();
    expect(result.money).toBeNull();
  });

  it('reviews an account claim absent from the source', () => {
    const result = verifyClaims(extraction({
      claims: claims({ payoutAccount: 'Bancolombia ···· 4412' }),
    }), [vendor]);
    expect(getCheck(result, 'source_payoutAccount')).toMatchObject({ passed: false, effect: 'review' });
  });

  it('stops when the invoice contains two distinct normalized accounts', () => {
    const sameAccount = verifyClaims(extraction({
      claims: claims({ accountsFound: ['Bancolombia ···· 8890', 'Bancolombia 1234568890'] }),
    }), [vendor]);
    expect(getCheck(sameAccount, 'two_accounts')).toMatchObject({ passed: true, effect: 'none' });

    const result = verifyClaims(extraction({
      claims: claims({ accountsFound: ['Bancolombia ···· 8890', 'Bancolombia ···· 4412'] }),
    }), [vendor]);
    expect(getCheck(result, 'two_accounts')).toMatchObject({ passed: false, effect: 'stop' });
  });

  it('reviews multiple tax ids, totals, or currencies', () => {
    const result = verifyClaims(extraction({
      claims: claims({
        taxIdsFound: ['901.234.567-8', '900.000.000-1'],
        amountsFound: ['USD 100.00', 'USD 200.00'],
        currenciesFound: ['USD', 'COP'],
      }),
    }), [vendor]);
    expect(getCheck(result, 'multiple_tax_ids')).toMatchObject({ passed: false, effect: 'review' });
    expect(getCheck(result, 'multiple_totals')).toMatchObject({ passed: false, effect: 'review' });
    expect(getCheck(result, 'multiple_currencies')).toMatchObject({ passed: false, effect: 'review' });
  });

  it('does not collapse distinct total candidates that differ only in ambiguous separators', () => {
    const result = verifyClaims(extraction({
      claims: claims({ amountsFound: ['USD 1,234', 'USD 12.34'], amountRaw: 'USD 12.34' }),
      sourceText: 'NIT 901.234.567-8 Cuenta Bancolombia ···· 8890 Factura INV-001 Total USD 1,234 or USD 12.34',
    }), [vendor]);
    expect(getCheck(result, 'multiple_totals')).toMatchObject({ passed: false, effect: 'review' });
  });

  it('reviews mismatched subtotal plus taxes', () => {
    const result = verifyClaims(extraction({
      claims: claims({ subtotalRaw: 'USD 80.00', taxesRaw: 'USD 10.00' }),
    }), [vendor]);
    expect(getCheck(result, 'sum_mismatch')).toMatchObject({ passed: false, effect: 'review' });
  });

  it('reviews a missing payee', () => {
    const result = verifyClaims(extraction({
      claims: claims({ payeeName: null, payeeTaxId: null, payoutAccount: null, taxIdsFound: [], accountsFound: [] }),
    }), [vendor]);
    expect(getCheck(result, 'missing_payee')).toMatchObject({ passed: false, effect: 'review' });
  });

  it('rejects ambiguous amounts without inferring a locale', () => {
    const result = verifyClaims(extraction({
      claims: claims({ amountRaw: 'USD 2.500', amountsFound: ['USD 2.500'] }),
      sourceText: 'NIT 901.234.567-8 Cuenta Bancolombia ···· 8890 Factura INV-001 Total USD 2.500',
    }), [vendor]);
    expect(getCheck(result, 'ambiguous_amount')).toMatchObject({ passed: false, effect: 'review' });
    expect(result.money).toBeNull();
  });

  it('uses a recognized claims currency, otherwise the matched vendor payout currency', () => {
    const fromClaims = verifyClaims(extraction({ claims: claims({ currency: 'COP', amountRaw: 'COP 4.800.000,00' }) }), [vendor]);
    expect(fromClaims.money).toEqual({ currency: 'COP', minor: 480_000_000 });

    const fromVendor = verifyClaims(extraction({ claims: claims({ currency: 'not-a-currency' }) }), [vendor]);
    expect(fromVendor.money).toEqual({ currency: 'USD', minor: 10_000 });

    const unknown = verifyClaims(extraction({
      claims: claims({ payeeTaxId: 'unknown', payoutAccount: 'Unknown Bank ···· 0000', currency: null }),
    }), [vendor]);
    expect(getCheck(unknown, 'ambiguous_amount')).toMatchObject({ passed: false, effect: 'review' });
    expect(unknown.money).toBeNull();
  });

  it('adds an approval check for image-only sources', () => {
    const result = verifyClaims(extraction({ sourceKind: 'image' }), [vendor]);
    expect(getCheck(result, 'image_confirmation')).toMatchObject({ passed: true, effect: 'approval' });
    expect(result.checks.some((check) => check.id.startsWith('source_'))).toBe(false);
  });

  it('reviews a JEV extraction failure with its specific safe reason', () => {
    const failed: ExtractionResult = { ok: false, error: 'rate_limited', sourceKind: 'text' };
    const result = verifyClaims(failed, [vendor]);
    expect(result.vendor).toBeNull();
    expect(result.money).toBeNull();
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'extraction_failed', passed: false, effect: 'review',
      reason: 'No pude leer la factura (límite del servicio)',
    }));
  });

  it('matches by account only when no tax id matches, never by a lookalike name', () => {
    const byAccount = verifyClaims(extraction({
      claims: claims({ payeeTaxId: 'unknown', payoutAccount: 'Bancolombia 1234568890' }),
    }), [vendor]);
    expect(byAccount.vendor).toEqual(vendor);

    const lookalike = verifyClaims(extraction({
      claims: claims({ payeeName: 'Nube Andlna SAS', payeeTaxId: 'unknown', payoutAccount: 'Unknown Bank ···· 0000' }),
    }), [vendor]);
    expect(lookalike.vendor).toBeNull();
  });
});
