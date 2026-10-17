import { afterEach, describe, expect, it } from 'vitest';
import type { CheckResult, DecisionRecord, ExtractionClaims } from '../../src/shared/domain/types';
import { ensureWorkspace } from '../../src/server/db/workspace';
import { openDb, type StoredInvoice } from '../../src/server/db/db';
import { toExpediente, toInvoiceRow } from '../../src/server/format';

const databases: ReturnType<typeof openDb>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});

function makeInvoice(overrides: Partial<StoredInvoice> = {}): StoredInvoice {
  const claims: ExtractionClaims = {
    amountsFound: ['USD 780.00'],
    accountsFound: ['Bancolombia ···· 4412'],
    taxIdsFound: ['NAT010101AB6'],
    invoiceIdsFound: ['AL-030'],
    currenciesFound: ['USD'],
    payeeName: 'NUBE ANDINA TECNOLOGÍA S. DE R.L.',
    payeeTaxId: 'NAT010101AB6',
    payoutAccount: 'Banco Ventaluz ···· 4412',
    invoiceId: 'AL-030',
    invoiceDate: '2026-10-16',
    dueDate: '2026-10-25',
    currency: 'USD',
    amountRaw: 'USD 780.00',
    subtotalRaw: null,
    taxesRaw: null,
    quantity: null,
    rateRaw: null,
    description: 'Hosting administrado y respaldo de infraestructura',
    documentTypeHint: 'factura',
    hasMultipleCurrenciesShown: false,
    evidenceQuotes: {},
    suspiciousPassages: [],
  };
  return {
    id: 'AL-030',
    status: 'review_required',
    sourceKind: 'text',
    sourceText: null,
    filePath: null,
    extraction: { ok: true, claims, sourceText: 'Factura AL-030', sourceKind: 'text' },
    jev: null,
    invoiceHash: null,
    vendorId: 'nube-andina',
    contractId: 'nube-hosting-monthly',
    invoiceDate: '2026-10-16',
    dueDate: '2026-10-25',
    evaluatedToday: null,
    month: '2026-10',
    contractPeriod: '2026-10',
    costCenter: 'operaciones',
    amountUsdMinor: 78_000,
    normalizedInvoiceId: 'al030',
    latestRecord: null,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('integrated QA formatter fixes', () => {
  it('adds the decision subtitle to the row only while its decision status is current', () => {
    const decisionRecord: DecisionRecord = {
      id: 'record-1',
      invoiceId: 'AL-030',
      decision: {
        status: 'approval_required',
        checks: [{
          id: 'R15', kind: 'rule', label: 'Umbral de aprobación humana', passed: true, effect: 'approval',
          reason: 'El monto supera el umbral y requiere aprobación humana.',
        } satisfies CheckResult],
        flags: [],
        canApprove: true,
        headline: 'Requiere tu aprobación',
        nextStep: 'Aprueba o rechaza esta factura con un motivo.',
        amountUsdMinor: 78_000,
        contractId: 'nube-hosting-monthly',
        costCenter: 'operaciones',
      },
      rulesSnapshot: {
        version: 3,
        perPaymentLimitUsdMinor: 1_000_000,
        monthlyLimitUsdMinor: 5_000_000,
        approvalThresholdUsdMinor: 30_000,
        fuzzyDuplicateWindowDays: 60,
        preset: 'equilibrado',
      },
      dataVersions: { fxDate: '2026-10-16' },
      jev: { ok: false, error: 'missing_recording' },
      seal: '8f3a1c',
      createdAt: '2026-10-16T00:00:00.000Z',
    };

    const current = toInvoiceRow(makeInvoice({ status: 'approval_required', latestRecord: decisionRecord }));
    const approved = toInvoiceRow(makeInvoice({ status: 'approved', latestRecord: decisionRecord }));

    expect(current.subtitle).toBe('Excede el límite automático');
    expect(approved.subtitle).toBeUndefined();
  });

  it('truncates a long queued snippet at a word boundary and marks the truncation', () => {
    const sourceText = 'Factura para Andina Labs, servicios de infraestructura y soporte técnico durante octubre de 2026. '.repeat(3);
    const row = toInvoiceRow(makeInvoice({ status: 'queued', extraction: null, sourceText }));

    const rawCut = sourceText.slice(0, 120);
    expect(row.concept).toBe(`${rawCut.slice(0, rawCut.lastIndexOf(' '))}…`);
    expect(row.concept.length).toBeLessThanOrEqual(121);
  });

  it('does not add an ellipsis when a queued snippet is not truncated', () => {
    const row = toInvoiceRow(makeInvoice({ status: 'queued', extraction: null, sourceText: 'Factura para Andina Labs.' }));

    expect(row.concept).toBe('Factura para Andina Labs.');
  });

  it('adds the matched vendor country and invoice currency to Bandeja rows', () => {
    const db = openDb(':memory:');
    databases.push(db);
    ensureWorkspace(db, 'qa-regional-row');

    const row = toExpediente(db, 'qa-regional-row', makeInvoice()).row;

    expect(row).toMatchObject({ country: 'MX', currency: 'USD' });
  });

  it('builds the comparison from invoice, vendor, contract, and budget records', () => {
    const db = openDb(':memory:');
    databases.push(db);
    ensureWorkspace(db, 'qa-comparison');

    const expediente = toExpediente(db, 'qa-comparison', makeInvoice());
    const rows = new Map(expediente.comparison.map((row) => [row.field, row]));

    expect([...rows.keys()]).toEqual([
      'Beneficiario',
      'Identificador fiscal',
      'Cuenta bancaria (últimos 4)',
      'Monto facturado / monto contractual',
      'Alcance del contrato',
      'Fecha de factura vs. período del contrato',
      'Presupuesto restante',
    ]);
    expect(rows.get('Beneficiario')).toMatchObject({ invoice: 'NUBE ANDINA TECNOLOGÍA S. DE R.L.', record: 'Nube Andina Tecnología S. de R.L.', differs: false });
    expect(rows.get('Identificador fiscal')).toMatchObject({ invoice: 'NAT010101AB6', record: 'NAT010101AB6', differs: false });
    expect(rows.get('Cuenta bancaria (últimos 4)')).toMatchObject({ invoice: '···· 4412', record: '···· 8890', differs: true });
    expect(rows.get('Monto facturado / monto contractual')).toMatchObject({ invoice: 'USD 780,00', record: 'USD 850,00', differs: true });
    expect(rows.get('Fecha de factura vs. período del contrato')).toMatchObject({ invoice: '2026-10-16', record: '2026-01-01 a 2026-12-31', differs: false });
    expect(rows.get('Presupuesto restante')?.record).toMatch(/^USD [\d.]+,\d{2} disponible antes de esta factura$/);
    expect(expediente.record).toBeNull();
  });

  it('marks missing registered counterparts unavailable instead of matching them', () => {
    const db = openDb(':memory:');
    databases.push(db);
    ensureWorkspace(db, 'qa-no-counterpart');

    const expediente = toExpediente(db, 'qa-no-counterpart', makeInvoice({ vendorId: null, contractId: null }));
    const beneficiary = expediente.comparison.find((row) => row.field === 'Beneficiario');
    const budget = expediente.comparison.find((row) => row.field === 'Presupuesto restante');

    expect(beneficiary).toMatchObject({ invoice: 'NUBE ANDINA TECNOLOGÍA S. DE R.L.', record: null, differs: true });
    expect(budget).toMatchObject({ record: null, differs: true });
  });
});
