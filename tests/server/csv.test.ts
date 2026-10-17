import { describe, expect, it } from 'vitest';
import { parseTable, templateCsv, type CsvTable } from '../../src/server/csv';

const tables: CsvTable[] = ['vendors', 'contracts', 'budgets', 'fx'];

describe('CSV data tables', () => {
  it('returns one Spanish summary with 1-based row numbers for invalid rows', () => {
    const csv = [
      'id,name,taxId,country,payoutCurrency,payoutAccount,status,version',
      'vendor-1,Proveedor ficticio,NIT-001,XX,USD,Cuenta 001,allowed,1',
      'vendor-2,,NIT-002,CO,USD,Cuenta 002,unknown,0',
    ].join('\r\n');

    const result = parseTable('vendors', csv);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.row)).toContain(2);
    expect(result.errors.map((error) => error.row)).toContain(3);
    expect(result.summary).toMatch(/fila 2/i);
    expect(result.summary).toMatch(/fila 3/i);
  });

  it.each(tables)('round-trips the %s template through its row schema', (table) => {
    const csv = templateCsv(table);

    expect(csv).toContain('\r\n');
    const result = parseTable(table, csv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
  });

  it('parses quoted commas and converts decimal money to integer minor units with half-even rounding', () => {
    const vendorResult = parseTable('vendors', templateCsv('vendors'));
    expect(vendorResult.ok).toBe(true);
    if (!vendorResult.ok) return;
    expect(vendorResult.rows[0]?.name).toContain(',');

    const escapedQuoteCsv = templateCsv('vendors').replace('"Nube Andina, S.A.S."', '"Nube ""Andina"", S.A.S."');
    const escapedQuoteResult = parseTable('vendors', escapedQuoteCsv);
    expect(escapedQuoteResult.ok).toBe(true);
    if (!escapedQuoteResult.ok) return;
    expect(escapedQuoteResult.rows[0]?.name).toBe('Nube "Andina", S.A.S.');

    const contractCsv = templateCsv('contracts').replace(',850.00,,', ',10.005,,');
    const contractResult = parseTable('contracts', contractCsv);
    expect(contractResult.ok).toBe(true);
    if (!contractResult.ok) return;
    const amountMinor = contractResult.rows[0]?.amountMinor;
    expect(amountMinor).toBe(1_000);
    expect(Number.isInteger(amountMinor)).toBe(true);
  });

  it('reports an unterminated quoted field against its 1-based data row', () => {
    const csv = templateCsv('vendors').replace('"Nube Andina, S.A.S."', '"Nube Andina, S.A.S.');

    const result = parseTable('vendors', csv);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([{ row: 2, field: 'CSV', message: 'Hay un campo entre comillas sin cerrar.' }]);
    expect(result.summary).toMatch(/fila 2/i);
  });
});
