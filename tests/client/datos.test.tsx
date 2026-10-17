import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Datos, { type DatosApi, type DataRowMap, type DataTable, type DataTableValues } from '../../src/client/features/datos/Datos';

const data: DataTableValues = {
  vendors: [{
    id: 'nube-andina', name: 'Nube Andina S.A.S.', taxId: '901.234.567-8', country: 'CO',
    payoutCurrency: 'USD', payoutAccount: 'Bancolombia ···· 8890', status: 'allowed', version: 1,
  }],
  contracts: [],
  budgets: [{ costCenter: 'ingenieria', month: '2026-10', approvedUsdMinor: 85_000 }],
  treasury: { balanceUsdMinor: 480_000, fx: [{ currency: 'USD', perUsd: '1', date: '2026-10-15' }] },
};

afterEach(cleanup);

function makeApi(uploadCsv = vi.fn(async () => ({ ok: true as const }))): DatosApi {
  return {
    getTable: vi.fn(async (table: DataTable) => data[table]) as DatosApi['getTable'],
    putRow: vi.fn(async (_table: DataTable, row: DataRowMap[DataTable]) => row) as DatosApi['putRow'],
    uploadCsv: uploadCsv as DatosApi['uploadCsv'],
    templateUrl: (table) => `/api/data/templates/${table}.csv`,
  };
}

describe('Preparar datos', () => {
  it('saves an inline vendor account edit through putRow', async () => {
    const api = makeApi();
    render(<Datos api={api} />);

    await screen.findByRole('table', { name: 'Proveedores' });
    expect(screen.getByRole('table', { name: 'Contratos' })).toBeDefined();
    expect(screen.getByRole('table', { name: 'Presupuestos' })).toBeDefined();
    expect(screen.getByRole('table', { name: 'Saldo y tipos de cambio' })).toBeDefined();

    const account = await screen.findByLabelText('Cuenta de pago — Nube Andina S.A.S.');
    fireEvent.change(account, { target: { value: 'Bancolombia ···· 4412' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios de Nube Andina S.A.S.' }));

    await waitFor(() => expect(api.putRow).toHaveBeenCalledWith('vendors', expect.objectContaining({
      id: 'nube-andina', payoutAccount: 'Bancolombia ···· 4412', version: 1,
    })));
  });

  it('rejects inline amounts with more than two decimal places instead of rounding', async () => {
    const api = makeApi();
    render(<Datos api={api} />);

    const amount = await screen.findByLabelText('Presupuesto aprobado (USD) — ingenieria · 2026-10');
    fireEvent.change(amount, { target: { value: '850.001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios de ingenieria · 2026-10' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(api.putRow).not.toHaveBeenCalled();
  });

  it('converts exact inline decimal amounts to safe integer minor units', async () => {
    const api = makeApi();
    render(<Datos api={api} />);

    const amount = await screen.findByLabelText('Presupuesto aprobado (USD) — ingenieria · 2026-10');
    fireEvent.change(amount, { target: { value: '850.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios de ingenieria · 2026-10' }));

    await waitFor(() => expect(api.putRow).toHaveBeenCalledWith('budgets', expect.objectContaining({
      costCenter: 'ingenieria', month: '2026-10', approvedUsdMinor: 85_050,
    })));
  });

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
  });
});
