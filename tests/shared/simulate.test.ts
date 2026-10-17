import { describe, expect, it } from 'vitest';
import type {
  Budget, Contract, ExtractionClaims, ExtractionResult, JevAnswers, Rules, Treasury, Vendor,
} from '../../src/shared/domain/types';
import { simulateImpact, type SimulationInput, type SimulationInvoice } from '../../src/shared/engine/simulate';

const vendor: Vendor = {
  id: 'vendor-1', name: 'Andina Labs proveedor ficticio', taxId: '900.000.001-1', country: 'CO',
  payoutCurrency: 'USD', payoutAccount: 'Banco Andino ···· 8890', status: 'allowed', version: 1,
};

const contract: Contract = {
  id: 'contract-1', vendorId: vendor.id, scope: 'Alojamiento de prueba', type: 'fixed', currency: 'USD',
  amountMinor: 1_234, billingFrequency: 'monthly', costCenter: 'operaciones',
  start: '2026-01-01', end: '2026-12-31', version: 1,
};

const rules: Rules = {
  version: 1, perPaymentLimitUsdMinor: 1_500_000, monthlyLimitUsdMinor: 6_000_000,
  approvalThresholdUsdMinor: 300_000, fuzzyDuplicateWindowDays: 60, preset: 'equilibrado',
};

const budgets: Budget[] = [{ costCenter: 'operaciones', month: '2026-10', approvedUsdMinor: 1_000_000 }];
const treasury: Treasury = {
  balanceUsdMinor: 1_000_000,
  fx: [{ currency: 'USD', perUsd: '1', date: '2026-10-15' }],
};

function claims(overrides: Partial<ExtractionClaims> = {}): ExtractionClaims {
  const amountRaw = overrides.amountRaw === undefined ? 'USD 12.34' : overrides.amountRaw;
  const invoiceId = overrides.invoiceId === undefined ? 'AL-001' : overrides.invoiceId;
  return {
    amountsFound: amountRaw ? [amountRaw] : [], accountsFound: [vendor.payoutAccount],
    taxIdsFound: [vendor.taxId], invoiceIdsFound: invoiceId ? [invoiceId] : [], currenciesFound: ['USD'],
    payeeName: vendor.name, payeeTaxId: vendor.taxId, payoutAccount: vendor.payoutAccount, invoiceId,
    invoiceDate: '2026-10-16', dueDate: '2026-10-20', currency: 'USD', amountRaw,
    subtotalRaw: null, taxesRaw: null, quantity: null, rateRaw: null, description: 'Servicio ficticio',
    documentTypeHint: 'factura', hasMultipleCurrenciesShown: false, evidenceQuotes: {}, suspiciousPassages: [],
    ...overrides,
  };
}

function extraction(options: { amountRaw?: string | null; invoiceId?: string | null; sourceText?: string; sourceKind?: 'pdf' | 'image' | 'text' } = {}): ExtractionResult {
  const invoiceClaims = claims({
    ...(options.amountRaw === undefined ? {} : { amountRaw: options.amountRaw }),
    ...(options.invoiceId === undefined ? {} : { invoiceId: options.invoiceId }),
  });
  return {
    ok: true,
    claims: invoiceClaims,
    sourceText: options.sourceText ?? [vendor.taxId, vendor.payoutAccount, invoiceClaims.invoiceId, invoiceClaims.amountRaw]
      .filter(Boolean).join(' '),
    sourceKind: options.sourceKind ?? 'text',
  };
}

const validJev: Extract<JevAnswers, { ok: true }> = {
  ok: true,
  answers: {
    instructs_agent: { type: 'noul', noul: 0 },
    artificial_urgency: { type: 'noul', noul: 0 },
    scope_match: { type: 'score', score: 0, confidence: 0.9, probabilities: { '0': 0.9, '1': 0.05, '2': 0.05 } },
    document_type: { type: 'choice', choice: 'factura', confidence: 0.9, probabilities: { factura: 0.9 } },
  },
  latencyMs: 1, recorded: true, inputTokens: 10,
};

function invoice(id: string, options: Parameters<typeof extraction>[0] = {}): SimulationInvoice {
  return { id, extraction: extraction(options), jev: validJev };
}

function input(invoices = [invoice('invoice-1')], overrides: Partial<SimulationInput> = {}): SimulationInput {
  return {
    invoices,
    vendors: [vendor],
    contracts: [contract],
    budgets,
    treasury,
    rules,
    today: '2026-10-16',
    ...overrides,
  };
}

describe('simulateImpact', () => {
  it('moves a $850 invoice to approval when the threshold is lowered to $500', () => {
    const snapshot = input([invoice('invoice-1', { amountRaw: 'USD 850.00' })], {
      contracts: [{ ...contract, amountMinor: 85_000 }],
    });
    const candidate = { ...rules, approvalThresholdUsdMinor: 50_000 };

    const result = simulateImpact(snapshot, candidate);

    expect(result.counts).toEqual({ ready: 0, approval_required: 1, review_required: 0, stopped: 0 });
    expect(result.deltas).toEqual({ ready: -1, approval_required: 1, review_required: 0, stopped: 0 });
    expect(result.unsafeApprovals).toBe(0);
  });

  it('never turns a failed hard rule into ready under the permissive preset', () => {
    const snapshot = input([invoice('invoice-1')], {
      vendors: [{ ...vendor, status: 'blocked' }],
    });

    const result = simulateImpact(snapshot, { ...rules, preset: 'permisivo' });

    expect(result.counts).toMatchObject({ ready: 0, stopped: 1 });
    expect(result.unsafeApprovals).toBe(0);
  });

  it('does not produce ready for missing, incomplete, or malformed JEV answers', () => {
    const missing = { ...invoice('missing-jev', { invoiceId: 'AL-001' }), jev: null };
    const incomplete = {
      ...invoice('incomplete-jev', { invoiceId: 'AL-002' }),
      jev: { ...validJev, answers: { instructs_agent: validJev.answers.instructs_agent } },
    };
    const malformed = {
      ...invoice('malformed-jev', { invoiceId: 'AL-003' }),
      jev: {
        ...validJev,
        answers: {
          ...validJev.answers,
          instructs_agent: { type: 'noul' as const, noul: Number.NaN },
        },
      },
    };

    const snapshot = input([missing, incomplete, malformed]);
    const result = simulateImpact(snapshot, snapshot.rules);

    expect(result.counts).toMatchObject({ ready: 0, review_required: 3 });
  });

  it('does not produce ready for ambiguous or source-unconfirmed amounts', () => {
    const ambiguous = invoice('ambiguous', { amountRaw: 'USD 2.500', invoiceId: 'AL-001' });
    const unconfirmed = invoice('unconfirmed', {
      invoiceId: 'AL-002',
      sourceText: `${vendor.taxId} ${vendor.payoutAccount} AL-002 Total USD 99.99`,
    });

    const snapshot = input([ambiguous, unconfirmed]);
    const result = simulateImpact(snapshot, snapshot.rules);

    expect(result.counts).toMatchObject({ ready: 0, review_required: 2 });
  });

  it('counts seeded committed and reserved cents, then evaluates current invoices once', () => {
    const snapshot = input([invoice('current-invoice')], {
      rules: { ...rules, monthlyLimitUsdMinor: 1_000 },
      priorCommitments: [
        { invoiceId: 'prior-ready', state: 'committed', amountUsdMinor: 600, month: '2026-10', costCenter: 'legal' },
        { invoiceId: 'prior-pending', state: 'reserved', amountUsdMinor: 400, month: '2026-10', costCenter: 'legal' },
      ],
    });
    const currentContract = { ...contract, costCenter: 'legal' as const };
    const result = simulateImpact({ ...snapshot, contracts: [currentContract] }, rules);

    expect(result.counts).toMatchObject({ ready: 0, stopped: 1 });
  });

  it('does not treat a current reserved invoice as an R7 committed payment', () => {
    const second = invoice('b-pending', { invoiceId: 'AL-002' });
    const snapshot = input([
      invoice('a-pending', { invoiceId: 'AL-001' }),
      {
        ...second,
        jev: {
          ...validJev,
          answers: { ...validJev.answers, fuzzy_duplicate: { type: 'noul', noul: 0 } },
        },
      },
    ], {
      rules: { ...rules, approvalThresholdUsdMinor: 1_000, monthlyLimitUsdMinor: 3_000 },
    });

    const result = simulateImpact(snapshot, snapshot.rules);

    expect(result.counts).toMatchObject({ approval_required: 2, stopped: 0 });
  });

  it('excludes a current invoice from seeded commitments before re-evaluating it', () => {
    const snapshot = input([invoice('same-row')], {
      rules: { ...rules, perPaymentLimitUsdMinor: 1_234, monthlyLimitUsdMinor: 1_234, approvalThresholdUsdMinor: 1_000 },
      priorCommitments: [{
        invoiceId: 'same-row', state: 'committed', amountUsdMinor: 1_234, month: '2026-10', costCenter: 'operaciones',
        vendorId: vendor.id, invoiceNumber: 'AL-001', contractId: contract.id, contractPeriod: '2026-10',
      }],
    });

    const result = simulateImpact(snapshot, snapshot.rules);

    expect(result.counts).toMatchObject({ approval_required: 1, stopped: 0 });
  });

  it('uses deterministic invoice-id order regardless of input array order', () => {
    const invoices = [
      invoice('a-large', { amountRaw: 'USD 6.00', invoiceId: 'AL-100' }),
      invoice('b-small', { amountRaw: 'USD 5.00', invoiceId: 'AL-101' }),
      invoice('c-small', { amountRaw: 'USD 5.00', invoiceId: 'AL-102' }),
    ];
    const vendors = invoices.map((_, index) => ({ ...vendor, id: `vendor-${index}`, taxId: `900.000.00${index}-1` }));
    const contracts = invoices.map((row, index) => ({
      ...contract, id: `contract-${index}`, vendorId: `vendor-${index}`, amountMinor: index === 0 ? 600 : 500,
      billingFrequency: 'one_time' as const,
    }));
    const sourceInputs = invoices.map((row, index) => {
      const selectedVendor = vendors[index];
      const extractionValue = row.extraction as Extract<ExtractionResult, { ok: true }>;
      const selectedClaims = { ...extractionValue.claims, payeeTaxId: selectedVendor.taxId, taxIdsFound: [selectedVendor.taxId] };
      return { ...row, extraction: { ...extractionValue, claims: selectedClaims, sourceText: `${selectedVendor.taxId} ${selectedVendor.payoutAccount} ${selectedClaims.invoiceId} ${selectedClaims.amountRaw}` } };
    });
    const snapshot = input(sourceInputs, {
      vendors,
      contracts,
      rules: { ...rules, perPaymentLimitUsdMinor: 5_000, monthlyLimitUsdMinor: 1_000, approvalThresholdUsdMinor: 4_000 },
      budgets: [{ costCenter: 'operaciones', month: '2026-10', approvedUsdMinor: 100_000 }],
    });

    const sorted = simulateImpact(snapshot, snapshot.rules);
    const reversed = simulateImpact({ ...snapshot, invoices: [...sourceInputs].reverse() }, snapshot.rules);

    expect(sorted).toEqual(reversed);
    expect(sorted.counts).toMatchObject({ ready: 1, stopped: 2 });
  });

  it('compares exact integer cents at the per-payment boundary', () => {
    const snapshot = input([invoice('invoice-1')], {
      rules: { ...rules, perPaymentLimitUsdMinor: 1_234, monthlyLimitUsdMinor: 10_000, approvalThresholdUsdMinor: 1_000 },
    });
    const oneCentLower = { ...snapshot.rules, perPaymentLimitUsdMinor: 1_233, approvalThresholdUsdMinor: 1_000 };

    expect(simulateImpact(snapshot, snapshot.rules).counts).toMatchObject({ stopped: 0 });
    expect(simulateImpact(snapshot, oneCentLower).counts).toMatchObject({ stopped: 1 });
  });

  it('does not mutate the supplied invoices, records, snapshots, or rules', () => {
    const snapshot = input([invoice('invoice-1')]);
    const before = structuredClone(snapshot);
    const candidate = { ...rules, approvalThresholdUsdMinor: 200_000 };
    const candidateBefore = structuredClone(candidate);

    simulateImpact(snapshot, candidate);

    expect(snapshot).toEqual(before);
    expect(candidate).toEqual(candidateBefore);
  });

  it('uses the pinned demo date when today is omitted', () => {
    const pending = invoice('expired-invoice');
    const extracted = pending.extraction as Extract<ExtractionResult, { ok: true }>;
    const snapshot = input([{
      ...pending,
      extraction: { ...extracted, claims: { ...extracted.claims, dueDate: '2026-10-15' } },
    }], { today: undefined });

    const result = simulateImpact(snapshot, snapshot.rules);

    expect(result.counts).toMatchObject({ review_required: 1, ready: 0 });
  });

  it('rejects invalid candidate rules rather than simulating them', () => {
    expect(() => simulateImpact(input(), { ...rules, requireAccountMatch: false }))
      .toThrow(/Unknown rules field/);
  });
});
