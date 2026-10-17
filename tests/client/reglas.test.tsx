import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimulationResult } from '../../src/shared/api';
import type { Rules, Vendor } from '../../src/shared/domain/types';
import { Reglas, type ReglasApi } from '../../src/client/features/reglas/Reglas';

const initialRules: Rules = {
  version: 1,
  perPaymentLimitUsdMinor: 1_500_000,
  monthlyLimitUsdMinor: 6_000_000,
  approvalThresholdUsdMinor: 300_000,
  fuzzyDuplicateWindowDays: 60,
  preset: 'equilibrado',
};

const safeSimulation: SimulationResult = {
  counts: { ready: 7, approval_required: 4, review_required: 3, stopped: 6 },
  deltas: { ready: -2, approval_required: 1, review_required: 1, stopped: 0 },
  unsafeApprovals: 0,
};

const initialVendors: Vendor[] = [
  {
    id: 'nube-andina',
    name: 'Nube Andina Tecnología S. de R.L.',
    taxId: 'NAT010101AB6',
    country: 'MX',
    payoutCurrency: 'USD',
    payoutAccount: 'Banco Ventaluz ···· 1234 5678 8890',
    status: 'allowed',
    version: 7,
  },
  {
    id: 'pixel-patio',
    name: 'Pixel Patio S.A.S.',
    taxId: '900.000.101-3',
    country: 'CO',
    payoutCurrency: 'COP',
    payoutAccount: 'Banco Altocauce ···· 1184',
    status: 'blocked',
    version: 3,
  },
];

const reglasCss = readFileSync(resolve(process.cwd(), 'src/client/features/reglas/reglas.css'), 'utf8');

function createApi(overrides: Partial<ReglasApi> = {}): ReglasApi {
  return {
    getRules: vi.fn(async () => initialRules),
    saveRules: vi.fn(async (rules: Rules) => ({ ...rules, version: 2 })),
    simulate: vi.fn(async (_rules: Rules) => safeSimulation),
    getVendors: vi.fn(async () => initialVendors),
    saveVendor: vi.fn(async (vendor: Vendor) => vendor),
    ...overrides,
  };
}

function renderReglas(api = createApi()) {
  render(<Reglas api={api} />);
  return api;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForLoadedControls() {
  await screen.findByLabelText('Límite por pago (USD)');
}

afterEach(() => {
  cleanup();
});

describe('Reglas', () => {
  it('renders every vendor with masked payout accounts and text status', async () => {
    renderReglas();

    expect(await screen.findByRole('heading', { name: 'Beneficiarios permitidos' })).toBeTruthy();
    expect(screen.getByText('Nube Andina Tecnología S. de R.L.')).toBeTruthy();
    expect(screen.getByText('Pixel Patio S.A.S.')).toBeTruthy();
    expect(screen.getByText('México')).toBeTruthy();
    expect(screen.getByText('NAT010101AB6')).toBeTruthy();
    expect(screen.getByText('USD')).toBeTruthy();
    expect(screen.getByText('•••• 8890')).toBeTruthy();
    expect(screen.getByText('•••• 1184')).toBeTruthy();
    expect(screen.queryByText('Banco Ventaluz ···· 1234 5678 8890')).toBeNull();
    expect(screen.getByText('Permitido', { exact: true })).toBeTruthy();
    expect(screen.getByText('Bloqueado', { exact: true })).toBeTruthy();
    expect(screen.getByText('✓')).toBeTruthy();
    expect(screen.getByText('×')).toBeTruthy();
  });

  it('saves the full vendor row with its current version and adopts the response', async () => {
    const savedVendor = { ...initialVendors[0], status: 'blocked' as const, version: 8 };
    const api = renderReglas(createApi({ saveVendor: vi.fn(async () => savedVendor) }));

    fireEvent.click(await screen.findByRole('button', { name: `Bloquear a ${initialVendors[0].name}` }));

    await waitFor(() => expect(api.saveVendor).toHaveBeenCalledWith({
      ...initialVendors[0],
      status: 'blocked',
    }));
    const vendorRow = screen.getByText(initialVendors[0].name).closest('li');
    expect(vendorRow).toBeTruthy();
    expect(within(vendorRow as HTMLElement).getByText('Bloqueado', { exact: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Permitir a ${initialVendors[0].name}` })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('status').map((item) => item.textContent).join(' '))
      .toContain('Este cambio desactualiza'));
  });

  it('disables the vendor control while saving and keeps the old state on failure', async () => {
    const save = deferred<Vendor>();
    const api = renderReglas(createApi({ saveVendor: vi.fn(() => save.promise) }));
    const toggle = await screen.findByRole('button', { name: `Bloquear a ${initialVendors[0].name}` });

    fireEvent.click(toggle);

    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    await act(async () => save.reject(new Error('No pude completar la solicitud.')));

    expect((await screen.findByRole('alert')).textContent).toContain('El estado anterior se conserva.');
    expect(screen.getByText('Permitido', { exact: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Bloquear a ${initialVendors[0].name}` })).toBeTruthy();
  });

  it('loads editable rules, presets, help, and locked safety checks without toggles', async () => {
    renderReglas();
    await waitForLoadedControls();

    expect(screen.getByLabelText('Límite mensual (USD)')).toBeTruthy();
    expect(screen.getByLabelText('Umbral de aprobación humana (USD)')).toBeTruthy();
    expect(screen.getByLabelText('Ventana de duplicado aproximado (días)')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Estricto/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Equilibrado/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Permisivo/ })).toBeTruthy();
    expect(screen.getByText('Ver criterios avanzados')).toBeTruthy();

    expect(screen.getAllByText('Fijo por seguridad')).toHaveLength(3);
    expect(screen.queryByText('Lista de proveedores permitidos')).toBeNull();
    expect(screen.getByText('R1 no se puede desactivar: solo se evalúan facturas de proveedores que tú marques como Permitido.')).toBeTruthy();
    expect(screen.getByText('La cuenta bancaria de la factura debe coincidir')).toBeTruthy();
    expect(screen.getByText('Integridad del documento de origen')).toBeTruthy();
    expect(screen.getByText('Contrato vigente')).toBeTruthy();
    expect(screen.getAllByText(/¿Qué es esto\?/).length).toBeGreaterThanOrEqual(7);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'Guardar cambios' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps vendor status and field labels at the design metadata scale', () => {
    const statusRule = reglasCss.match(/\.reglas-vendor-status\s*\{([^}]+)\}/u)?.[1] ?? '';
    const fieldLabelRule = reglasCss.match(/\.reglas-vendor-facts dt\s*\{([^}]+)\}/u)?.[1] ?? '';

    expect(statusRule).toMatch(/font-size:\s*10px/u);
    expect(fieldLabelRule).toMatch(/font-size:\s*10px/u);
  });

  it('blocks saving when the approval threshold is equal to the payment limit', async () => {
    const api = renderReglas();
    await waitForLoadedControls();

    fireEvent.change(screen.getByLabelText('Umbral de aprobación humana (USD)'), {
      target: { value: '15.000,00' },
    });

    expect(await screen.findByText('Debe ser menor que el límite por pago.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Guardar cambios' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.saveRules).not.toHaveBeenCalled();
  });

  it('saves exact integer cents and adopts the server version', async () => {
    const api = renderReglas();
    await waitForLoadedControls();

    fireEvent.change(screen.getByLabelText('Límite por pago (USD)'), {
      target: { value: '15.000,25' },
    });
    await waitFor(() => expect(api.simulate).toHaveBeenCalledWith(expect.objectContaining({
      perPaymentLimitUsdMinor: 1_500_025,
    })));

    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => expect(api.saveRules).toHaveBeenCalledWith(expect.objectContaining({
      perPaymentLimitUsdMinor: 1_500_025,
      version: 1,
    })));
    expect(await screen.findByText('Reglas v2 guardadas.')).toBeTruthy();
  });

  it('keeps valid zero monthly budget and duplicate window editable', async () => {
    const zeroRules: Rules = {
      ...initialRules,
      monthlyLimitUsdMinor: 0,
      fuzzyDuplicateWindowDays: 0,
    };
    const api = renderReglas(createApi({ getRules: vi.fn(async () => zeroRules) }));
    await waitForLoadedControls();

    fireEvent.change(screen.getByLabelText('Umbral de aprobación humana (USD)'), {
      target: { value: '500,00' },
    });

    await waitFor(() => expect(api.simulate).toHaveBeenCalledWith(expect.objectContaining({
      monthlyLimitUsdMinor: 0,
      fuzzyDuplicateWindowDays: 0,
      approvalThresholdUsdMinor: 50_000,
    })));
    expect(screen.queryByText(/El límite mensual debe ser mayor/)).toBeNull();
    expect(screen.queryByText(/La ventana debe ser de al menos un día/)).toBeNull();
  });

  it('rejects fractional precision beyond cents without calling the simulator or save API', async () => {
    const api = renderReglas();
    await waitForLoadedControls();

    fireEvent.change(screen.getByLabelText('Límite por pago (USD)'), {
      target: { value: '1,234' },
    });

    expect(await screen.findByText('Usa hasta dos cifras después de la coma.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Guardar cambios' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.simulate).not.toHaveBeenCalled();
    expect(api.saveRules).not.toHaveBeenCalled();
  });

  it('shows impact counts, deltas, and zero unsafe approvals only after a successful response', async () => {
    const simulation = deferred<SimulationResult>();
    const api = renderReglas(createApi({ simulate: vi.fn(() => simulation.promise) }));
    await waitForLoadedControls();

    fireEvent.change(screen.getByLabelText('Umbral de aprobación humana (USD)'), {
      target: { value: '500,00' },
    });

    expect(screen.getByText('Calculando el impacto de estos ajustes…')).toBeTruthy();
    expect(screen.queryByText(/aprobaciones indebidas/)).toBeNull();
    simulation.resolve(safeSimulation);

    await waitFor(() => {
      const impact = screen.getByRole('status').textContent ?? '';
      expect(impact).toContain('7 listas (−2)');
      expect(impact).toContain('4 requieren tu aprobación (+1)');
      expect(impact).toContain('3 requieren revisión (+1)');
      expect(impact).toContain('6 frenadas (0)');
      expect(impact).toContain('0 aprobaciones indebidas');
    });
  });

  it('does not let a late simulation response overwrite the latest edit', async () => {
    const first = deferred<SimulationResult>();
    const second = deferred<SimulationResult>();
    const simulate = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const api = renderReglas(createApi({ simulate }));
    await waitForLoadedControls();

    fireEvent.change(screen.getByLabelText('Umbral de aprobación humana (USD)'), {
      target: { value: '1.000,00' },
    });
    fireEvent.change(screen.getByLabelText('Umbral de aprobación humana (USD)'), {
      target: { value: '2.000,00' },
    });

    second.resolve({ ...safeSimulation, counts: { ...safeSimulation.counts, ready: 9 } });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('9 listas ('));
    first.resolve({ ...safeSimulation, counts: { ...safeSimulation.counts, ready: 2 } });
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toContain('2 listas ('));
    expect(screen.getByRole('status').textContent).toContain('9 listas (');
  });

  it('does not publish a pending preview after saving a new baseline', async () => {
    const preview = deferred<SimulationResult>();
    const api = renderReglas(createApi({ simulate: vi.fn(() => preview.promise) }));
    await waitForLoadedControls();

    fireEvent.change(screen.getByLabelText('Umbral de aprobación humana (USD)'), {
      target: { value: '500,00' },
    });
    expect(api.simulate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Reglas v2 guardadas.')).toBeTruthy();

    await act(async () => {
      preview.resolve(safeSimulation);
    });

    expect(screen.queryByText(/7 listas/)).toBeNull();
    expect(screen.queryByText(/0 aprobaciones indebidas/)).toBeNull();
    expect(screen.getByText('Edita un ajuste para calcular su impacto.')).toBeTruthy();
  });

  it('shows simulator failure honestly and never invents counts', async () => {
    const api = renderReglas(createApi({ simulate: vi.fn(async () => Promise.reject(new Error('offline'))) }));
    await waitForLoadedControls();

    fireEvent.change(screen.getByLabelText('Umbral de aprobación humana (USD)'), {
      target: { value: '500,00' },
    });

    expect((await screen.findByRole('alert')).textContent).toContain('No pude calcular el impacto. Tus ajustes siguen sin guardar.');
    expect(screen.queryByText(/aprobaciones indebidas/)).toBeNull();
    expect(screen.queryByText(/7 listas/)).toBeNull();
  });

  it('does not claim zero unsafe approvals when the simulator returns a nonzero value', async () => {
    const api = renderReglas(createApi({
      simulate: vi.fn(async () => ({ ...safeSimulation, unsafeApprovals: 2 }) as unknown as SimulationResult),
    }));
    await waitForLoadedControls();

    fireEvent.change(screen.getByLabelText('Umbral de aprobación humana (USD)'), {
      target: { value: '500,00' },
    });

    expect((await screen.findByRole('alert')).textContent).toContain('El simulador detectó 2 aprobaciones indebidas. No guardes estos ajustes.');
    expect(screen.queryByText(/0 aprobaciones indebidas/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Guardar cambios' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.saveRules).not.toHaveBeenCalled();
  });

  it('surfaces save errors without claiming the rules were updated', async () => {
    const api = renderReglas(createApi({ saveRules: vi.fn(async () => Promise.reject(new Error('offline'))) }));
    await waitForLoadedControls();

    fireEvent.change(screen.getByLabelText('Umbral de aprobación humana (USD)'), {
      target: { value: '500,00' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    expect((await screen.findByRole('alert')).textContent).toContain('No pude guardar los cambios. Tus reglas siguen sin actualizarse.');
    expect(screen.queryByText('Reglas v2 guardadas.')).toBeNull();
  });
});
