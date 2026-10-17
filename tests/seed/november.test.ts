import { describe, expect, it } from 'vitest';
import { seed } from '../../src/server/seed/andina';
import { parseAmount } from '../../src/shared/domain/money';
import { evaluateRules, type LedgerView } from '../../src/shared/engine/rules';
import { invoiceTemplates } from '../../src/shared/templates';
import type { ExtractionClaims } from '../../src/shared/domain/types';

const ledger: LedgerView = {
  committedUsdMinor: () => 0,
  reservedUsdMinor: () => 0,
  committedByCostCenter: () => 0,
  reservedByCostCenter: () => 0,
  hasInvoiceId: () => false,
  hasCommitmentForContractPeriod: () => false,
  recentByVendor: () => [],
};

describe('legitimate COP November template', () => {
  it('matches exactly one Valentina contract and passes all deterministic checks', () => {
    const template = invoiceTemplates.find(({ id }) => id === 'legitimate-cop');
    expect(template).toBeDefined();

    const invoiceDate = template!.content.match(/^Fecha de emisión: (.+)$/m)?.[1] ?? null;
    expect(invoiceDate).toBe('2026-11-01');
    const amountRaw = template!.content.match(/^Monto total: (.+)$/m)?.[1] ?? null;
    expect(amountRaw).toBe('COP 4.800.000,00');
    const parsedAmount = parseAmount(amountRaw ?? '', { currency: 'COP' });
    expect(parsedAmount).toEqual({ ok: true, money: { currency: 'COP', minor: 480_000_000 } });
    if (!parsedAmount.ok) throw new Error(`Could not parse the template amount: ${parsedAmount.reason}`);

    const data = seed();
    const vendor = data.vendors.find(({ id }) => id === 'valentina-ruiz') ?? null;
    const claims: ExtractionClaims = {
      amountsFound: [amountRaw ?? ''], accountsFound: ['Banco Ventaluz ···· 7712'],
      taxIdsFound: ['989.876.543-5'], invoiceIdsFound: ['CR-VR-2026-11-01'], currenciesFound: ['COP'],
      payeeName: 'Estudio Bruma S.A.S.', payeeTaxId: '989.876.543-5', payoutAccount: 'Banco Ventaluz ···· 7712',
      invoiceId: 'CR-VR-2026-11-01', invoiceDate, dueDate: '2026-11-20', currency: 'COP',
      amountRaw, subtotalRaw: null, taxesRaw: null, quantity: null, rateRaw: null,
      description: 'Diseño UX, noviembre de 2026', documentTypeHint: 'Cuenta de cobro',
      hasMultipleCurrenciesShown: false, evidenceQuotes: {}, suspiciousPassages: [],
    };
    const result = evaluateRules({
      vendor, contracts: data.contracts, money: parsedAmount.money, claims, treasury: data.treasury, budgets: data.budgets,
      rules: data.rules, ledger, today: '2026-10-16',
    });

    expect(result.checks.find(({ id }) => id === 'R3')).toMatchObject({ passed: true, effect: 'none' });
    expect(result.checks.find(({ id }) => id === 'R9')).toMatchObject({ passed: true, effect: 'none' });
    expect(result.checks).toHaveLength(16);
    expect(result.checks.every(({ passed }) => passed)).toBe(true);
    expect(result.contract).toMatchObject({
      vendorId: 'valentina-ruiz', type: 'fixed', currency: 'COP', amountMinor: 480_000_000,
      billingFrequency: 'monthly', costCenter: 'diseno', start: '2026-11-01', end: '2026-11-30',
    });
    expect(data.budgets).toContainEqual({ costCenter: 'diseno', month: '2026-11', approvedUsdMinor: 600_000 });
  });
});
