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

  it('parses quoted commas and converts valid decimal money to integer minor units', () => {
    const vendorResult = parseTable('vendors', templateCsv('vendors'));
    expect(vendorResult.ok).toBe(true);
    if (!vendorResult.ok) return;
    expect(vendorResult.rows[0]?.name).toContain(',');

    const escapedQuoteCsv = templateCsv('vendors').replace('"Nube Andina, S.A.S."', '"Nube ""Andina"", S.A.S."');
    const escapedQuoteResult = parseTable('vendors', escapedQuoteCsv);
    expect(escapedQuoteResult.ok).toBe(true);
    if (!escapedQuoteResult.ok) return;
    expect(escapedQuoteResult.rows[0]?.name).toBe('Nube "Andina", S.A.S.');

    const contractCsv = templateCsv('contracts').replace(',850.00,,', ',10.00,,');
    const contractResult = parseTable('contracts', contractCsv);
    expect(contractResult.ok).toBe(true);
    if (!contractResult.ok) return;
    const amountMinor = contractResult.rows[0]?.amountMinor;
    expect(amountMinor).toBe(1_000);
    expect(Number.isInteger(amountMinor)).toBe(true);
  });

  it.each([
    ['contract amount', 'contracts', templateCsv('contracts').replace('850.00', '10.005'), 'amount'],
    ['contract amount with trailing zero', 'contracts', templateCsv('contracts').replace('850.00', '10.000'), 'amount'],
    ['contract rate', 'contracts', templateCsv('contracts').replace('fixed,USD,850.00,,,,monthly,', 'variable,USD,,10.005,hora,10,monthly,'), 'rate'],
    ['contract rate with trailing zero', 'contracts', templateCsv('contracts').replace('fixed,USD,850.00,,,,monthly,', 'variable,USD,,10.000,hora,10,monthly,'), 'rate'],
    ['budget amount', 'budgets', templateCsv('budgets').replace('850.00', '10.005'), 'approvedUsd'],
    ['budget amount with trailing zero', 'budgets', templateCsv('budgets').replace('850.00', '10.000'), 'approvedUsd'],
    ['scientific notation', 'budgets', templateCsv('budgets').replace('850.00', '1.005e2'), 'approvedUsd'],
    ['unsafe minor units', 'budgets', templateCsv('budgets').replace('850.00', '90071992547409.92'), 'approvedUsd'],
  ] as const)('rejects excessive precision or unsafe minor units in %s', (_name, table, csv, field) => {
    const result = parseTable(table, csv);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.row === 2 && error.field === field)).toBe(true);
  });

  it('continues to accept integer and two-decimal money plus four-decimal FX rates', () => {
    const integerBudget = parseTable('budgets', templateCsv('budgets').replace('850.00', '850'));
    expect(integerBudget.ok).toBe(true);
    if (!integerBudget.ok) return;
    expect(integerBudget.rows[0]?.approvedUsdMinor).toBe(85_000);

    const twoDecimalBudget = parseTable('budgets', templateCsv('budgets').replace('850.00', '850.25'));
    expect(twoDecimalBudget.ok).toBe(true);
    if (!twoDecimalBudget.ok) return;
    expect(twoDecimalBudget.rows[0]?.approvedUsdMinor).toBe(85_025);

    const fx = parseTable('fx', templateCsv('fx').replace(',1,', ',18.8656,'));
    expect(fx.ok).toBe(true);
    if (!fx.ok) return;
    expect(fx.rows[0]?.perUsd).toBe('18.8656');
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
