import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionClaims } from '../../src/shared/domain/types';
import { ensureWorkspace } from '../../src/server/db/workspace';
import { openDb, type StoredInvoice } from '../../src/server/db/db';
import { toExpediente, toInvoiceRow } from '../../src/server/format';

const databases: ReturnType<typeof openDb>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});

function variableInvoice(): StoredInvoice {
  const claims: ExtractionClaims = {
    amountsFound: ['MXN 7000.00'],
    accountsFound: ['···· 7788'],
    taxIdsFound: ['COD010101AA2'],
    invoiceIdsFound: ['AL-038'],
    currenciesFound: ['MXN'],
    payeeName: 'Codaluz Digital S. de R.L.',
    payeeTaxId: 'COD010101AA2',
    payoutAccount: '···· 7788',
    invoiceId: 'AL-038',
    invoiceDate: '2026-10-16',
    dueDate: '2026-10-25',
    currency: 'MXN',
    amountRaw: 'MXN 7000.00',
    subtotalRaw: null,
    taxesRaw: null,
    quantity: null,
    rateRaw: null,
    description: 'Desarrollo backend por horas',
    documentTypeHint: 'factura',
    hasMultipleCurrenciesShown: false,
    evidenceQuotes: {},
    suspiciousPassages: [],
  };

  return {
    id: 'AL-038',
    status: 'review_required',
    sourceKind: 'text',
    sourceText: null,
    filePath: null,
    extraction: { ok: true, claims, sourceText: 'Factura AL-038', sourceKind: 'text' },
    jev: null,
    invoiceHash: null,
    vendorId: 'carlos-mendez',
    contractId: 'carlos-backend-variable',
    invoiceDate: '2026-10-16',
    dueDate: '2026-10-25',
    evaluatedToday: null,
    month: '2026-10',
    contractPeriod: '2026-10',
    costCenter: 'ingenieria',
    amountUsdMinor: 700_000,
    normalizedInvoiceId: 'al038',
    latestRecord: null,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
  };
}

describe('t-0044 QA review fixes', () => {
  it('shows a missing variable invoice rate as unavailable without a false tariff mismatch', () => {
    const db = openDb(':memory:');
    databases.push(db);
    ensureWorkspace(db, 'qa-variable-rate');

    const comparison = toExpediente(db, 'qa-variable-rate', variableInvoice()).comparison
      .find((row) => row.field === 'Monto facturado / monto contractual');

    expect(comparison?.invoice).toContain('Tarifa facturada: No disponible');
    expect(comparison).toMatchObject({ differs: false });
  });

  it('does not split a surrogate pair when truncating an invoice snippet', () => {
    const sourceText = `${'a'.repeat(119)}😀 more text`;
    const invoice = variableInvoice();
    if (!invoice.extraction?.ok) throw new Error('Expected a successful extraction.');
    const row = toInvoiceRow({
      ...invoice,
      extraction: { ...invoice.extraction, claims: { ...invoice.extraction.claims, description: sourceText } },
    });
    const hasUnpairedSurrogate = Array.from(row.concept).some(
      (character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character),
    );

    expect(hasUnpairedSurrogate).toBe(false);
  });

  it('does not separate a base character from its combining mark', () => {
    const sourceText = `${'a'.repeat(119)}e\u0301 more text`;
    const invoice = variableInvoice();
    if (!invoice.extraction?.ok) throw new Error('Expected a successful extraction.');
    const row = toInvoiceRow({
      ...invoice,
      extraction: { ...invoice.extraction, claims: { ...invoice.extraction.claims, description: sourceText } },
    });

    expect(row.concept).toBe(`${'a'.repeat(119)}…`);
  });
});
