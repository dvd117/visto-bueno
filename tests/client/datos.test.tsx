import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Datos, { type DatosApi, type DataRowMap, type DataTable, type DataTableValues } from '../../src/client/features/datos/Datos';
import { datosApi } from '../../src/client/lib/api';

// JSDOM rendering can exceed Vitest's 5s default when the full suite is parallel.
const parallelTimeoutMs = 15_000;

const data: DataTableValues = {
  vendors: [{
    id: 'nube-andina', name: 'Nube Andina S.A.S.', taxId: '901.234.567-8', country: 'CO',
    payoutCurrency: 'USD', payoutAccount: 'Banco Ventaluz ···· 8890', status: 'allowed', version: 1,
  }],
  contracts: [],
  budgets: [{ costCenter: 'ingenieria', month: '2026-10', approvedUsdMinor: 85_000 }],
  treasury: { balanceUsdMinor: 480_000, fx: [{ currency: 'USD', perUsd: '1', date: '2026-10-15' }] },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeApi(
  uploadCsv = vi.fn(async () => ({ ok: true as const })),
  values: DataTableValues = data,
): DatosApi {
  return {
    getTable: vi.fn(async (table: DataTable) => values[table]) as DatosApi['getTable'],
    putRow: vi.fn(async (_table: DataTable, row: DataRowMap[DataTable]) => row) as DatosApi['putRow'],
    uploadCsv: uploadCsv as DatosApi['uploadCsv'],
    templateUrl: (table) => `/api/data/templates/${table}.csv`,
  };
}

describe('Preparar datos', () => {
  it('accepts a Chilean vendor from the API and offers Chile in the country selector', async () => {
    const vendor = { ...data.vendors[0]!, country: 'CL' as const };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([vendor]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(datosApi.getTable('vendors')).resolves.toEqual([vendor]);

    const api = makeApi();
    render(<Datos api={api} />);
    const country = await screen.findByLabelText('País — Nube Andina S.A.S.') as HTMLSelectElement;
    expect(Array.from(country.options, (option) => option.value)).toContain('CL');
  });

  it('saves an inline vendor account edit through putRow', async () => {
    const api = makeApi();
    render(<Datos api={api} />);

    await screen.findByRole('table', { name: 'Proveedores' });
    expect(screen.getByRole('table', { name: 'Contratos' })).toBeDefined();
    expect(screen.getByRole('table', { name: 'Presupuestos' })).toBeDefined();
    expect(screen.getByRole('table', { name: 'Saldo y tipos de cambio' })).toBeDefined();

    const account = await screen.findByLabelText('Cuenta de pago — Nube Andina S.A.S.');
    fireEvent.change(account, { target: { value: 'Banco Ventaluz ···· 4412' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios de Nube Andina S.A.S.' }));

    await waitFor(() => expect(api.putRow).toHaveBeenCalledWith('vendors', expect.objectContaining({
      id: 'nube-andina', payoutAccount: 'Banco Ventaluz ···· 4412', version: 1,
    })));
  }, parallelTimeoutMs);

  it('offers all seven currencies and accepts Peru and Argentina', async () => {
    const api = makeApi();
    render(<Datos api={api} />);

    const currency = await screen.findByLabelText('Moneda de pago — Nube Andina S.A.S.') as HTMLSelectElement;
    expect(Array.from(currency.options, (option) => option.value)).toEqual(['USD', 'COP', 'MXN', 'CLP', 'PEN', 'ARS', 'VES']);
    const country = screen.getByLabelText('País — Nube Andina S.A.S.') as HTMLSelectElement;
    expect(Array.from(country.options, (option) => option.value)).toContain('PE');
    expect(Array.from(country.options, (option) => option.value)).toContain('AR');
  }, parallelTimeoutMs);

  it('edits a CLP contract using whole-peso minor units', async () => {
    const contract = {
      id: 'contrato-clp', vendorId: 'nube-andina', scope: 'Servicio ficticio', type: 'fixed' as const,
      currency: 'CLP' as const, amountMinor: 950, billingFrequency: 'monthly' as const,
      costCenter: 'ingenieria' as const, start: '2026-10-01', end: '2026-12-31', version: 1,
    };
    const api = makeApi(undefined, { ...data, contracts: [contract] });
    render(<Datos api={api} />);

    const amount = await screen.findByLabelText('Monto fijo — contrato-clp') as HTMLInputElement;
    expect(amount.value).toBe('950');
    fireEvent.change(amount, { target: { value: '1250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios de contrato-clp' }));

    await waitFor(() => expect(api.putRow).toHaveBeenCalledWith('contracts', expect.objectContaining({
      id: 'contrato-clp', currency: 'CLP', amountMinor: 1250,
    })));
  }, parallelTimeoutMs);

  it('edits a seeded CLP FX rate and preserves its date', async () => {
    const values: DataTableValues = {
      ...data,
      treasury: { ...data.treasury, fx: [...data.treasury.fx, { currency: 'CLP', perUsd: '950', date: '2026-10-15' }] },
    };
    const api = makeApi(undefined, values);
    render(<Datos api={api} />);

    const rate = await screen.findByLabelText('Valor — CLP · 2026-10-15');
    fireEvent.change(rate, { target: { value: '975' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios de CLP · 2026-10-15' }));

    await waitFor(() => expect(api.putRow).toHaveBeenCalledWith('treasury', expect.objectContaining({
      fx: expect.arrayContaining([{ currency: 'CLP', perUsd: '975', date: '2026-10-15' }]),
    })));
  }, parallelTimeoutMs);

  it('rejects inline amounts with more than two decimal places instead of rounding', async () => {
    const api = makeApi();
    render(<Datos api={api} />);

    const amount = await screen.findByLabelText('Presupuesto aprobado (USD) — ingenieria · 2026-10');
    fireEvent.change(amount, { target: { value: '850.001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios de ingenieria · 2026-10' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(api.putRow).not.toHaveBeenCalled();
  }, parallelTimeoutMs);

  it('converts exact inline decimal amounts to safe integer minor units', async () => {
    const api = makeApi();
    render(<Datos api={api} />);

    const amount = await screen.findByLabelText('Presupuesto aprobado (USD) — ingenieria · 2026-10');
    fireEvent.change(amount, { target: { value: '850.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios de ingenieria · 2026-10' }));

    await waitFor(() => expect(api.putRow).toHaveBeenCalledWith('budgets', expect.objectContaining({
      costCenter: 'ingenieria', month: '2026-10', approvedUsdMinor: 85_050,
    })));
  }, parallelTimeoutMs);

  it('shows the single error summary returned after a CSV upload', async () => {
    const uploadCsv = vi.fn(async () => ({
      ok: false as const,
      error: { error: 'invalid_csv', message: 'El CSV tiene errores en las filas 2 y 4.' },
    }));
    const api = makeApi(uploadCsv);
    render(<Datos api={api} />);

    const file = new File(['csv'], 'proveedores.csv', { type: 'text/csv' });
    fireEvent.change(await screen.findByLabelText('Subir CSV de proveedores'), { target: { files: [file] } });

    await waitFor(() => expect(uploadCsv).toHaveBeenCalledWith('vendors', file));
    expect((await screen.findByRole('alert')).textContent).toContain('El CSV tiene errores en las filas 2 y 4.');
  }, parallelTimeoutMs);
});
