import { describe, expect, it, vi } from 'vitest';
import type { Contract, CostCenter, ExtractionClaims, Rules, Vendor } from '../../src/shared/domain/types';
import type { LedgerView, RuleContext } from '../../src/shared/engine/rules';
import { evaluateRules } from '../../src/shared/engine/rules';

const vendor: Vendor = {
  id: 'vendor-1', name: 'Nube Andina S.A.S.', taxId: '901.234.567-8', country: 'CO',
  payoutCurrency: 'USD', payoutAccount: 'Banco Altocauce ···· 8890', status: 'allowed', version: 1,
};

const contract: Contract = {
  id: 'contract-1', vendorId: vendor.id, scope: 'Hosting', type: 'fixed', currency: 'USD', amountMinor: 10_000,
  billingFrequency: 'monthly', costCenter: 'operaciones', start: '2026-01-01', end: '2026-12-31', version: 1,
};

function claims(overrides: Partial<ExtractionClaims> = {}): ExtractionClaims {
  return {
    amountsFound: ['USD 100.00'], accountsFound: ['Banco Altocauce ···· 8890'], taxIdsFound: ['901.234.567-8'],
    invoiceIdsFound: ['INV-001'], currenciesFound: ['USD'], payeeName: 'Nube Andina S.A.S.',
    payeeTaxId: '901.234.567-8', payoutAccount: 'Banco Altocauce ···· 8890', invoiceId: 'INV-001',
    invoiceDate: '2026-10-16', dueDate: '2026-10-20', currency: 'USD', amountRaw: 'USD 100.00',
    subtotalRaw: null, taxesRaw: null, quantity: null, rateRaw: null, description: 'Hosting',
    documentTypeHint: 'factura', hasMultipleCurrenciesShown: false, evidenceQuotes: {}, suspiciousPassages: [],
    ...overrides,
  };
}

function fakeLedger(overrides: Partial<LedgerView> = {}): LedgerView {
  return {
    committedUsdMinor: () => 0,
    reservedUsdMinor: () => 0,
    committedByCostCenter: () => 0,
    reservedByCostCenter: () => 0,
    hasInvoiceId: () => false,
    hasCommitmentForContractPeriod: () => false,
    recentByVendor: () => [],
    ...overrides,
  };
}

const defaultRules: Rules = {
  version: 1, perPaymentLimitUsdMinor: 200_000, monthlyLimitUsdMinor: 1_000_000,
  approvalThresholdUsdMinor: 100_000, fuzzyDuplicateWindowDays: 60, preset: 'equilibrado',
};

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    vendor, contracts: [contract], money: { currency: 'USD', minor: 10_000 }, claims: claims(),
    treasury: { balanceUsdMinor: 1_000_000, fx: [{ currency: 'USD', perUsd: '1', date: '2026-10-15' }] },
    budgets: [{ costCenter: 'operaciones', month: '2026-10', approvedUsdMinor: 1_000_000 }],
    rules: defaultRules, ledger: fakeLedger(), today: '2026-10-16', ...overrides,
  };
}

function evaluate(overrides: Partial<RuleContext> = {}) {
  return evaluateRules(context(overrides));
}

function getCheck(result: ReturnType<typeof evaluateRules>, id: string) {
  const check = result.checks.find((item) => item.id === id);
  expect(check, `missing check ${id}`).toBeDefined();
  return check!;
}

function expectPass(result: ReturnType<typeof evaluateRules>, id: string, effect: 'none' | 'approval' = 'none') {
  expect(getCheck(result, id)).toMatchObject({ passed: true, effect });
}

function expectFail(result: ReturnType<typeof evaluateRules>, id: string, effect: 'stop' | 'review') {
  expect(getCheck(result, id)).toMatchObject({ passed: false, effect });
}

const accountMaskCases = ['X', 'XX', 'x', 'xx', '*', '****', '·', '····', '•', '••••', '#', '?', '█']
  .flatMap((marker) => [
    { marker, digits: '8890', allowed: true },
    { marker, digits: '18890', allowed: false },
    { marker, digits: '11112228890', allowed: false },
  ]);

const unicodeAccountCases = [
  { script: 'Arabic-Indic', fourDigits: '٨٨٩٠', fullDigits: '١٢٣٤٨٨٩٠' },
  { script: 'Devanagari', fourDigits: '८८९०', fullDigits: '१२३४८८९०' },
  { script: 'fullwidth', fourDigits: '８８９０', fullDigits: '１２３４８８９０' },
].flatMap((digits) => ['х', 'Х', 'χ', 'Χ', 'ｘ', 'Ｘ', '×', '∗', '⁎', '＊', '●', '∙', '・']
  .map((marker) => ({ ...digits, marker })));

const unsafeAccountTextCases = [
  ['U+200B zero-width space', 'Banco Andino\u200B'],
  ['U+200D zero-width joiner', 'Ban\u200Dco Andino'],
  ['U+FEFF zero-width no-break space', 'Ban\uFEFFco Andino'],
  ['U+202E right-to-left override', 'Ban\u202Eco Andino'],
  ['U+0000 null control', 'Banco\u0000 Andino'],
  ['Cyrillic a', 'Bаnco Andino'],
  ['Cyrillic o', 'Bancо Andino'],
  ['Greek alpha', 'Bαnco Andino'],
  ['U+0338 combining long solidus overlay', 'Banco\u0338 Andino'],
] as const;

const multiAccountCandidates = [
  'Banco Altocauce 11112228890 y Banco Altocauce 99990008890',
  'Cuenta de ahorros Banco Altocauce 11112228890 y cuenta corriente Banco Altocauce 99990008890',
];

describe('evaluateRules', () => {
  it('returns all hard rules in stable R1–R16 order, all passing for a valid invoice', () => {
    const result = evaluate();
    expect(result.checks.map((check) => check.id)).toEqual(Array.from({ length: 16 }, (_, i) => `R${i + 1}`));
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result.checks.every((check) => check.effect === 'none')).toBe(true);
    expect(result.contract).toEqual(contract);
    expect(result.amountUsdMinor).toBe(10_000);
  });

  it('R1 passes an allowed vendor and stops for a missing or blocked payee', () => {
    expectPass(evaluate(), 'R1');
    expectFail(evaluate({ vendor: null }), 'R1', 'stop');
    expectFail(evaluate({ vendor: { ...vendor, status: 'blocked' } }), 'R1', 'stop');
  });

  it('R2 passes a matching bank account and stops with masked mismatch evidence', () => {
    expectPass(evaluate(), 'R2');
    expectPass(evaluate({ claims: claims({ payoutAccount: 'Banco Altocauce 1234568890' }) }), 'R2');
    const unidentifiable = evaluate({
      vendor: { ...vendor, payoutAccount: '···· 8890' },
      claims: claims({ payoutAccount: '···· 8890' }),
    });
    expectFail(unidentifiable, 'R2', 'stop');
    expect(getCheck(unidentifiable, 'R2').evidence).toEqual({ invoice: '···· —', record: '···· —' });
    expectFail(evaluate({ claims: claims({ payoutAccount: '8890' }) }), 'R2', 'stop');
    expectFail(evaluate({ claims: claims({ payoutAccount: 'Banco Ventaluz ···· 8890' }) }), 'R2', 'stop');
    const result = evaluate({ claims: claims({ payoutAccount: 'Banco Ventaluz ···· 4412' }) });
    expectFail(result, 'R2', 'stop');
    expect(getCheck(result, 'R2')).toMatchObject({
      evidence: { invoice: '···· 4412', record: '···· 8890' },
      reason: 'Verifica el cambio con el proveedor por un canal seguro, actualiza su cuenta en Preparar datos y re-evalúa',
    });
    const ambiguous = evaluate({ claims: claims({ payoutAccount: 'Banco Ventaluz 99991234567 - 8890' }) });
    expectFail(ambiguous, 'R2', 'stop');
    expect(getCheck(ambiguous, 'R2').evidence).toEqual({ invoice: '···· —', record: '···· 8890' });
    expectFail(evaluate({ claims: claims({ payoutAccount: null }) }), 'R2', 'stop');
  });

  it('marks image account and amount agreement as unverifiable and approval-gated', () => {
    const result = evaluate({ sourceKind: 'image' });

    expect(getCheck(result, 'R2')).toMatchObject({
      passed: false, effect: 'approval', reason: 'No verificable en imagen.',
    });
    expect(getCheck(result, 'R5')).toMatchObject({
      passed: false, effect: 'approval', reason: 'No verificable en imagen.',
    });
  });

  it('R2 fails closed when a standalone X is ambiguous before a full account number', () => {
    const result = evaluate({ claims: claims({ payoutAccount: 'Banco Altocauce X 11112228890' }) });
    expectFail(result, 'R2', 'stop');
    expect(getCheck(result, 'R2').evidence).toEqual({ invoice: '···· —', record: '···· 8890' });
  });

  it('R2 fails closed when a Cyrillic x mask precedes a full account number', () => {
    const confusableVendor = { ...vendor, payoutAccount: 'Banco Andino х ···· 8890' };
    const result = evaluate({
      vendor: confusableVendor,
      claims: claims({ payoutAccount: 'Banco Andino х 1234568890' }),
    });

    expectFail(result, 'R2', 'stop');
  });

  it.each(unsafeAccountTextCases)('R2 fails closed for %s even when the bank text matches', (_name, bankText) => {
    const registered = `${bankText} ···· 8890`;
    const result = evaluate({
      vendor: { ...vendor, payoutAccount: registered },
      claims: claims({ payoutAccount: `${bankText} 1234568890` }),
    });
    expectFail(result, 'R2', 'stop');
  });

  it.each(['Banco Ñandú', 'Crédito Valleclaro'])('R2 matches accented Latin bank name %s', (bankName) => {
    const result = evaluate({
      vendor: { ...vendor, payoutAccount: `${bankName} ···· 8890` },
      claims: claims({ payoutAccount: `${bankName} 1234568890` }),
    });
    expectPass(result, 'R2');
  });

  it.each(unicodeAccountCases)(
    'R2 normalizes $script digits with mask $marker (four digits match; full account stops)',
    ({ marker, fourDigits, fullDigits }) => {
      expectPass(evaluate({ claims: claims({ payoutAccount: `Banco Andino ${marker} ${fourDigits}` }) }), 'R2');
      expectFail(evaluate({ claims: claims({ payoutAccount: `Banco Andino ${marker} ${fullDigits}` }) }), 'R2', 'stop');
    },
  );

  it.each([
    'Banco Altocauce XX 11112228890',
    'Banco Altocauce XXXX 11112228890',
  ])('R2 fails closed for an X mask before five or more visible digits: %s', (payoutAccount) => {
    expectFail(evaluate({ claims: claims({ payoutAccount }) }), 'R2', 'stop');
  });

  it.each(accountMaskCases)('R2 allows only up to four visible digits after mask $marker ($digits)', ({ marker, digits, allowed }) => {
    const result = evaluate({ claims: claims({ payoutAccount: `Banco Altocauce ${marker} ${digits}` }) });
    expect(getCheck(result, 'R2').passed).toBe(allowed);
    if (allowed) expectPass(result, 'R2');
    else expectFail(result, 'R2', 'stop');
  });

  it.each(multiAccountCandidates)('R2 fails closed when a candidate contains multiple full accounts: %s', (payoutAccount) => {
    expectFail(evaluate({ claims: claims({ payoutAccount }) }), 'R2', 'stop');
  });

  it('R3 stops when there is no active contract or multiple overlapping contracts', () => {
    expectPass(evaluate(), 'R3');
    const none = evaluate({ contracts: [] });
    expectFail(none, 'R3', 'stop');
    expect(none.contract).toBeNull();
    expect(getCheck(none, 'R3').reason).toBe('Sin acuerdo vigente, no hay pago automático');

    const overlaps = evaluate({ contracts: [contract, { ...contract, id: 'contract-2' }] });
    expectFail(overlaps, 'R3', 'stop');
    expect(overlaps.contract).toBeNull();
  });

  it('R4 passes matching currency and stops on a contract currency mismatch', () => {
    expectPass(evaluate(), 'R4');
    expectFail(evaluate({
      claims: claims({ currency: 'COP' }), money: { currency: 'COP', minor: 10_000 },
    }), 'R4', 'stop');
  });

  it('R5 passes an exact fixed amount and stops on any difference', () => {
    expectPass(evaluate(), 'R5');
    expectFail(evaluate({ money: { currency: 'USD', minor: 10_001 } }), 'R5', 'stop');
  });

  it('R6 approves valid variable work and stops when units exceed the maximum', () => {
    const variable: Contract = {
      ...contract, type: 'variable', amountMinor: undefined, rateMinor: 1_000, unit: 'hora', maxUnitsPerPeriod: 5,
    };
    const variableClaims = claims({ amountRaw: 'USD 20.00', rateRaw: 'USD 10.00', quantity: '2' });
    const valid = evaluate({ contracts: [variable], claims: variableClaims, money: { currency: 'USD', minor: 2_000 } });
    expectPass(valid, 'R6', 'approval');

    const over = evaluate({
      contracts: [variable], claims: claims({ ...variableClaims, amountRaw: 'USD 60.00', quantity: '6' }),
      money: { currency: 'USD', minor: 6_000 },
    });
    expectFail(over, 'R6', 'stop');
  });

  it('R6 stops when invoice rate or rate-times-quantity does not match', () => {
    const variable: Contract = {
      ...contract, type: 'variable', amountMinor: undefined, rateMinor: 1_000, unit: 'hora', maxUnitsPerPeriod: 5,
    };
    expectFail(evaluate({
      contracts: [variable], claims: claims({ amountRaw: 'USD 20.00', rateRaw: 'USD 11.00', quantity: '2' }),
      money: { currency: 'USD', minor: 2_000 },
    }), 'R6', 'stop');
    expectFail(evaluate({
      contracts: [variable], claims: claims({ amountRaw: 'USD 21.00', rateRaw: 'USD 10.00', quantity: '2' }),
      money: { currency: 'USD', minor: 2_100 },
    }), 'R6', 'stop');
  });

  it('R7 passes without a committed contract-period payment and stops on a second monthly invoice', () => {
    expectPass(evaluate(), 'R7');
    const hasCommitmentForContractPeriod = vi.fn((contractId: string, period: string) => contractId === contract.id && period === '2026-10');
    const result = evaluate({ ledger: fakeLedger({ hasCommitmentForContractPeriod }) });
    expectFail(result, 'R7', 'stop');
    expect(hasCommitmentForContractPeriod).toHaveBeenCalledWith('contract-1', '2026-10');
    expect(getCheck(result, 'R7').reason).toBe('Este contrato ya registra un cobro en octubre');
  });

  it('R7 uses annual and one-time periods', () => {
    const annual = { ...contract, billingFrequency: 'annual' as const };
    const once = { ...contract, billingFrequency: 'one_time' as const };
    const annualCheck = vi.fn((_contractId: string, period: string) => period === '2026');
    const oneTimeCheck = vi.fn((_contractId: string, period: string) => period === 'once');
    expectFail(evaluate({ contracts: [annual], ledger: fakeLedger({ hasCommitmentForContractPeriod: annualCheck }) }), 'R7', 'stop');
    expectFail(evaluate({ contracts: [once], ledger: fakeLedger({ hasCommitmentForContractPeriod: oneTimeCheck }) }), 'R7', 'stop');
    expect(annualCheck).toHaveBeenCalledWith(contract.id, '2026');
    expect(oneTimeCheck).toHaveBeenCalledWith(contract.id, 'once');
  });

  it('R8 normalizes invoice ids before exact-duplicate lookup', () => {
    expectPass(evaluate(), 'R8');
    const hasInvoiceId = vi.fn((vendorId: string, normalizedId: string) => vendorId === vendor.id && normalizedId === 'al043');
    const result = evaluate({ claims: claims({ invoiceId: 'al 043' }), ledger: fakeLedger({ hasInvoiceId }) });
    expectFail(result, 'R8', 'stop');
    expect(hasInvoiceId).toHaveBeenCalledWith('vendor-1', 'al043');
  });

  it('R9 passes an in-period date and stops when the chosen contract does not cover it', () => {
    expectPass(evaluate(), 'R9');
    const result = evaluate({
      contracts: [{ ...contract, start: '2026-10-17' }],
      claims: claims({ invoiceDate: '2026-10-16' }),
    });
    expectFail(result, 'R9', 'stop');
  });

  it('R10 passes a valid due date on or after today and reviews a past or invalid date', () => {
    expectPass(evaluate(), 'R10');
    expectPass(evaluate({ claims: claims({ dueDate: '2026-10-16' }) }), 'R10');
    expectFail(evaluate({ claims: claims({ dueDate: '2026-10-15' }) }), 'R10', 'review');
    expectFail(evaluate({ claims: claims({ dueDate: 'not-a-date' }) }), 'R10', 'review');
  });

  it('R11 allows an amount exactly at the per-payment limit and stops one cent over', () => {
    const atLimitRules = { ...defaultRules, perPaymentLimitUsdMinor: 10_000 };
    expectPass(evaluate({ rules: atLimitRules }), 'R11');
    expectFail(evaluate({
      rules: atLimitRules, money: { currency: 'USD', minor: 10_001 },
    }), 'R11', 'stop');
  });

  it('R12 counts committed and reserved amounts against the monthly limit', () => {
    expectPass(evaluate(), 'R12');
    const result = evaluate({
      rules: { ...defaultRules, monthlyLimitUsdMinor: 19_999 },
      ledger: fakeLedger({ reservedUsdMinor: (month) => month === '2026-10' ? 10_000 : 0 }),
    });
    expectFail(result, 'R12', 'stop');
  });

  it('R13 subtracts both committed and reserved cost-center amounts from the budget', () => {
    expectPass(evaluate(), 'R13');
    const committedByCostCenter = vi.fn((_cc: CostCenter, month: string) => month === '2026-10' ? 2_000 : 0);
    const reservedByCostCenter = vi.fn((_cc: CostCenter, month: string) => month === '2026-10' ? 3_001 : 0);
    const result = evaluate({
      budgets: [{ costCenter: 'operaciones', month: '2026-10', approvedUsdMinor: 15_000 }],
      ledger: fakeLedger({ committedByCostCenter, reservedByCostCenter }),
    });
    expectFail(result, 'R13', 'stop');
    expect(committedByCostCenter).toHaveBeenCalledWith('operaciones', '2026-10');
    expect(reservedByCostCenter).toHaveBeenCalledWith('operaciones', '2026-10');
  });

  it('R14 subtracts committed and reserved amounts from the available treasury balance', () => {
    expectPass(evaluate(), 'R14');
    const result = evaluate({
      treasury: { balanceUsdMinor: 19_999, fx: [{ currency: 'USD', perUsd: '1', date: '2026-10-15' }] },
      ledger: fakeLedger({ committedUsdMinor: () => 4_000, reservedUsdMinor: () => 6_000 }),
    });
    expectFail(result, 'R14', 'stop');
  });

  it('R15 passes below the approval threshold and requires approval above it', () => {
    expectPass(evaluate(), 'R15');
    const result = evaluate({
      rules: { ...defaultRules, approvalThresholdUsdMinor: 9_999 },
    });
    expectPass(result, 'R15', 'approval');
  });

  it('R16 passes with a matching FX rate and stops when the currency rate is missing', () => {
    expectPass(evaluate(), 'R16');
    expectFail(evaluate({
      contracts: [{ ...contract, currency: 'COP' }],
      claims: claims({ currency: 'COP' }), money: { currency: 'COP', minor: 10_000 },
      treasury: { balanceUsdMinor: 1_000_000, fx: [] },
    }), 'R16', 'stop');
  });

  it('keeps a lookalike name with unknown tax id and account out of the allow list', () => {
    const result = evaluate({
      vendor: null,
      contracts: [],
      claims: claims({ payeeName: 'Nube Andlna SAS', payeeTaxId: 'unknown', payoutAccount: 'Unknown Bank ···· 0000' }),
    });
    expectFail(result, 'R1', 'stop');
  });

  it('does not use wall-clock time when evaluating due dates', () => {
    expectPass(evaluate({ today: '2026-10-16', claims: claims({ dueDate: '2026-10-16' }) }), 'R10');
    expectFail(evaluate({ today: '2026-10-17', claims: claims({ dueDate: '2026-10-16' }) }), 'R10', 'review');
  });
});
