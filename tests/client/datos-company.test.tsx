import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Datos from '../../src/client/features/datos/Datos';
import type { DatosApi } from '../../src/client/lib/api-types';
import type { CompanyPreview, CompanyRecord } from '../../src/shared/api';

const saved: CompanyRecord = {
  name: 'Andina Labs Inc.',
  operatingCountries: ['US'],
  vendorCountries: ['CO', 'MX', 'VE', 'CL', 'US'],
  currencies: ['USD', 'COP', 'MXN'],
  limits: { perPaymentUsdMinor: 1_500_000, monthlyUsdMinor: 6_000_000, approvalThresholdUsdMinor: 300_000 },
};

const preview: CompanyPreview = {
  counts: { ready: 6, approval_required: 2, review_required: 2, stopped: 4 },
  deltas: { ready: -1, approval_required: 1, review_required: 0, stopped: 0 },
  unsafeApprovals: 0,
  staleCount: 3,
};

function fakeApi(overrides: Partial<DatosApi> = {}): DatosApi {
  return {
    getTable: vi.fn(async (table: string) => (table === 'treasury' ? { balanceUsdMinor: 0, fx: [] } : [])),
    putRow: vi.fn(async (_table: string, row: unknown) => row),
    uploadCsv: vi.fn(async () => ({ ok: true as const })),
    templateUrl: () => '#',
    getCompany: vi.fn(async () => saved),
    saveCompany: vi.fn(async (next: CompanyRecord) => next),
    previewCompany: vi.fn(async () => preview),
    ...overrides,
  } as unknown as DatosApi;
}

function setValue(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Datos company profile editor', () => {
  it('loads the saved profile and limits', async () => {
    render(<Datos api={fakeApi()} />);

    expect((await screen.findByLabelText('Nombre de la empresa') as HTMLInputElement).value).toBe('Andina Labs Inc.');
    expect((screen.getByLabelText('Límite por pago (USD)') as HTMLInputElement).value).toBe('15000.00');
    expect((screen.getByLabelText('Umbral de aprobación humana (USD)') as HTMLInputElement).value).toBe('3000.00');
    expect((screen.getByRole('button', { name: 'Guardar perfil' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the impact of a limit change and keeps save disabled until it is previewed', async () => {
    const api = fakeApi();
    render(<Datos api={api} />);
    await screen.findByLabelText('Nombre de la empresa');

    setValue('Umbral de aprobación humana (USD)', '900.00');

    expect(await screen.findByText(/Facturas pendientes que quedan desactualizadas: 3/)).toBeTruthy();
    expect(api.previewCompany).toHaveBeenCalledWith(expect.objectContaining({
      limits: expect.objectContaining({ approvalThresholdUsdMinor: 90_000 }),
    }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Guardar perfil' }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: 'Guardar perfil' }));

    await waitFor(() => expect(api.saveCompany).toHaveBeenCalledWith(expect.objectContaining({
      limits: expect.objectContaining({ approvalThresholdUsdMinor: 90_000 }),
    })));
  });

  it('refuses an approval threshold at or above the payment limit without previewing', async () => {
    const api = fakeApi();
    render(<Datos api={api} />);
    await screen.findByLabelText('Nombre de la empresa');

    setValue('Umbral de aprobación humana (USD)', '20000.00');

    expect(await screen.findByText('Debe ser menor que el límite por pago.')).toBeTruthy();
    expect(api.previewCompany).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Guardar perfil' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves a profile-only edit without an impact preview', async () => {
    const api = fakeApi();
    render(<Datos api={api} />);
    await screen.findByLabelText('Nombre de la empresa');

    setValue('Nombre de la empresa', 'Marea Norte SpA');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar perfil' }));

    await waitFor(() => expect(api.saveCompany).toHaveBeenCalledWith(expect.objectContaining({ name: 'Marea Norte SpA' })));
    expect(api.previewCompany).not.toHaveBeenCalled();
  });
});
