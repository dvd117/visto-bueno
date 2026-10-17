import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ExtractionClaims, SourceKind } from '../../src/shared/domain/types';
import { seed, seededPriorPayments } from '../../src/server/seed/andina';
import { normalize } from '../../src/shared/engine/normalize';
import { verifyClaims } from '../../src/shared/engine/verify';
import { evaluateRules, type LedgerView } from '../../src/shared/engine/rules';

interface Label {
  invoiceId: string;
  file: string;
  sourceKind: SourceKind;
  expected: string;
  reasonCheck: string;
}

const fixtureRoot = new URL('../../fixtures/invoices/', import.meta.url);
const labels = JSON.parse(readFileSync(new URL('labels.json', fixtureRoot), 'utf8')) as Label[];
const data = seed();

function literal(source: string, value: string): string {
  expect(source).toContain(value);
  return value;
}

function isoDate(source: string, value: string): string {
  const date = literal(source, value);
  const [, day, month, year] = date.match(/(\d{2})\/(\d{2})\/(\d{4})/) ?? [];
  expect(year, `date not found in source: ${date}`).toBeDefined();
  return `${year}-${month}-${day}`;
}

function claimsFromFixture(id: string, source: string): ExtractionClaims {
  const fields = {
    'AL-035': {
      payeeName: 'PIXEL PATIO S.A.S.', taxId: '900.000.101-3', account: 'Banco Altocauce ···· 1184',
      invoiceId: 'AL-035', date: '18/10/2026', due: '28/10/2026', amount: 'USD 4.000,00', currency: 'USD',
      description: 'auditoría de accesibilidad del prototipo',
    },
    'AL-037': {
      payeeName: 'ESTUDIO BRUMA S.A.S.', taxId: '989.876.543-5', account: 'Banco Ventaluz ···· 7712',
      invoiceId: 'AL-037', date: '15/10/2026', due: '20/10/2026', amount: 'COP 4.800.000,00', currency: 'COP',
      description: 'Diseño UX, octubre de 2026',
    },
    'AL-038': {
      payeeName: 'CODALUZ DIGITAL S. DE R.L.', taxId: 'COD010101AA2', account: 'Banco Brumavela ···· 2038',
      invoiceId: 'AL-038', date: '14/10/2026', due: '22/10/2026', amount: 'MXN 62.000,00', currency: 'MXN',
      rate: 'MXN 1.000,00', quantity: '62', description: 'Desarrollo backend, 62 horas de trabajo',
    },
    'AL-039': {
      payeeName: 'BORDE SUR SERVICIOS SpA', taxId: '77.231.046-3', account: 'Banco Niebla Azul ···· 9940',
      invoiceId: 'AL-039', date: '12/10/2026', due: '18/10/2026', amount: 'USD 9.900,00', currency: 'USD',
      description: 'Servicios de consultoría de infraestructura',
    },
    'AL-042': {
      payeeName: 'NUBE ANDINA TECNOLOGÍA S. DE R.L.', taxId: 'NAT010101AB6', account: 'Banco Ventaluz, cuenta de ahorros ···· 4412',
      invoiceId: 'AL-042', date: '15/10/2026', due: '25/10/2026', amount: 'USD 850,00', currency: 'USD',
      description: 'Hosting administrado, octubre de 2026',
    },
    'AL-045': {
      payeeName: 'LADERA AUSTRAL SpA', taxId: '99.876.543-9', account: 'Banco Alborvia ···· 5206',
      invoiceId: 'AL-045', date: '14/10/2026', due: '30/10/2026', amount: 'USD 640,00', currency: 'USD',
      description: 'Soporte de datos y conectividad, octubre de 2026',
    },
    'AL-049': {
      payeeName: 'LEX DELAWARE LLP', taxId: 'US-DE-004218', account: 'Banco Valleclaro ···· 4510',
      invoiceId: 'AL-043', date: '20/10/2026', due: '31/10/2026', amount: 'USD 1,200.00', currency: 'USD',
      description: 'Presentación extraordinaria de documentos corporativos',
    },
  }[id];
  if (!fields) throw new Error(`No hand-written claims for ${id}`);

  const payeeName = literal(source, fields.payeeName);
  const taxId = literal(source, fields.taxId);
  const account = literal(source, fields.account);
  const invoiceId = literal(source, fields.invoiceId);
  const amountRaw = literal(source, fields.amount);
  const currency = literal(source, fields.currency);
  const description = literal(source, fields.description);
  const rateRaw = id === 'AL-038' ? literal(source, 'MXN 1.000,00') : null;
  const quantity = id === 'AL-038' ? literal(source, '62') : null;

  return {
    amountsFound: [amountRaw], accountsFound: [account], taxIdsFound: [taxId], invoiceIdsFound: [invoiceId],
    currenciesFound: [currency], payeeName, payeeTaxId: taxId, payoutAccount: account, invoiceId,
    invoiceDate: isoDate(source, fields.date), dueDate: isoDate(source, fields.due), currency, amountRaw,
    subtotalRaw: null, taxesRaw: null, quantity, rateRaw, description, documentTypeHint: null,
    hasMultipleCurrenciesShown: false, evidenceQuotes: { amountRaw, payoutAccount: account, payeeTaxId: taxId, invoiceId },
    suspiciousPassages: [],
  };
}

function ledgerWithSeedAndAl043(): LedgerView {
  const rows = [
    ...seededPriorPayments.map((payment) => ({ ...payment, month: payment.period, normalizedInvoiceId: normalize(payment.id) })),
    {
      id: 'AL-043', vendorId: 'lex-delaware', contractId: 'lex-presentacion-once', month: '2026-10', period: 'once',
      costCenter: 'legal' as const, amountUsdMinor: 120_000, normalizedInvoiceId: 'al043',
    },
  ];
  return {
    committedUsdMinor: (month) => rows.filter((row) => row.month === month).reduce((sum, row) => sum + row.amountUsdMinor, 0),
    reservedUsdMinor: () => 0,
    committedByCostCenter: (costCenter, month) => rows.filter((row) => row.costCenter === costCenter && row.month === month)
      .reduce((sum, row) => sum + row.amountUsdMinor, 0),
    reservedByCostCenter: () => 0,
    hasInvoiceId: (vendorId, normalizedId) => rows.some((row) => row.vendorId === vendorId && row.normalizedInvoiceId === normalizedId),
    hasCommitmentForContractPeriod: (contractId, period) => rows.some((row) => row.contractId === contractId && row.period === period),
    recentByVendor: () => [],
  };
}

const selectedIds = ['AL-035', 'AL-037', 'AL-038', 'AL-039', 'AL-042', 'AL-045', 'AL-049'];

describe('labeled rules sanity', () => {
  it.each(selectedIds)('checks %s from its text fixture only', (invoiceId) => {
    const label = labels.find((item) => item.invoiceId === invoiceId)!;
    expect(label).toBeDefined();
    expect(label.reasonCheck.startsWith('R')).toBe(true);
    const sourcePath = label.file.replace(/\.pdf$/, '.txt');
    const source = readFileSync(new URL(sourcePath.replace('fixtures/invoices/', ''), fixtureRoot), 'utf8');
    const extraction = {
      ok: true as const, claims: claimsFromFixture(invoiceId, source), sourceText: source, sourceKind: label.sourceKind,
    };
    const verified = verifyClaims(extraction, data.vendors);
    const result = evaluateRules({
      vendor: verified.vendor, contracts: data.contracts, money: verified.money, claims: extraction.claims,
      treasury: data.treasury, budgets: data.budgets, rules: data.rules, ledger: ledgerWithSeedAndAl043(),
      today: '2026-10-16',
    });

    if (invoiceId === 'AL-037') {
      expect(result.checks.every((check) => check.passed)).toBe(true);
      return;
    }
    const deciding = result.checks.find((check) => check.id === label.reasonCheck);
    expect(deciding, `missing ${label.reasonCheck}`).toBeDefined();
    const expectedEffect = ['AL-038', 'AL-035'].includes(invoiceId) ? 'approval' : 'stop';
    expect(deciding).toMatchObject({ effect: expectedEffect, passed: expectedEffect === 'approval' });
  });
});
