import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Datos, { type DatosApi, type DataRowMap, type DataTable, type DataTableValues } from '../../src/client/features/datos/Datos';
import type { CompanyPreview, CompanyRecord } from '../../src/shared/api';

const companyRecord: CompanyRecord = {
  name: 'Andina Labs Inc.', operatingCountries: ['US'], vendorCountries: ['CO'], currencies: ['USD'],
  limits: { perPaymentUsdMinor: 1_500_000, monthlyUsdMinor: 6_000_000, approvalThresholdUsdMinor: 300_000 },
};
const companyPreview: CompanyPreview = {
  counts: { ready: 0, approval_required: 0, review_required: 0, stopped: 0 },
  deltas: { ready: 0, approval_required: 0, review_required: 0, stopped: 0 },
  unsafeApprovals: 0, staleCount: 0,
};

const globalCss = readFileSync(`${process.cwd()}/src/client/app/app.css`, 'utf8');
const featureCss = readFileSync(`${process.cwd()}/src/client/features/datos/datos.css`, 'utf8');

const values: DataTableValues = {
  vendors: [{
    id: 'nube-andina', name: 'Nube Andina S.A.S.', taxId: '901.234.567-8', country: 'CO',
    payoutCurrency: 'USD', payoutAccount: 'Banco Ventaluz ···· 8890', status: 'allowed', version: 1,
  }],
  contracts: [{
    id: 'nube-hosting-monthly', vendorId: 'nube-andina',
    scope: 'Hosting administrado y respaldo de infraestructura', type: 'fixed', currency: 'USD',
    amountMinor: 85_000, billingFrequency: 'monthly', costCenter: 'operaciones',
    start: '2026-01-01', end: '2026-12-31', version: 1,
  }],
  budgets: [],
  treasury: { balanceUsdMinor: 480_000, fx: [{ currency: 'USD', perUsd: '1', date: '2026-10-15' }] },
};

beforeEach(() => {
  const style = document.createElement('style');
  style.dataset.qaDatosStyle = 'true';
  style.textContent = `${globalCss}\n@layer utilities { .text-white { color: #fff; } .bg-ink { background-color: #191919; } }\n${featureCss}`;
  document.head.append(style);
});

afterEach(() => {
  cleanup();
  document.querySelector('[data-qa-datos-style]')?.remove();
  document.body.style.removeProperty('color');
});

function makeApi(): DatosApi {
  return {
    getTable: vi.fn(async (table: DataTable) => values[table]) as DatosApi['getTable'],
    putRow: vi.fn(async (_table: DataTable, row: DataRowMap[DataTable]) => row) as DatosApi['putRow'],
    uploadCsv: vi.fn(async () => ({ ok: true as const })),
    templateUrl: (table) => `/api/data/templates/${table}.csv`,
    getCompany: vi.fn(async () => companyRecord) as DatosApi['getCompany'],
    saveCompany: vi.fn(async (next: CompanyRecord) => next) as DatosApi['saveCompany'],
    previewCompany: vi.fn(async () => companyPreview) as DatosApi['previewCompany'],
  };
}

function relativeLuminance(color: string) {
  const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map((value) => Number(value) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Color is not an RGB value: ${color}`);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Preparar datos — QA visual', () => {
  it('keeps the enabled company save button white against the global button cascade', async () => {
    render(<Datos api={makeApi()} />);
    fireEvent.change(await screen.findByLabelText('Nombre de la empresa'), { target: { value: 'Marea Norte SpA' } });

    const button = screen.getByRole('button', { name: 'Guardar perfil' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.classList.contains('datos-save-button')).toBe(true);
    expect(getComputedStyle(button).color).toBe('rgb(255, 255, 255)');
  });

  it('keeps the primary label readable against the real global button cascade', async () => {
    document.body.style.color = '#191919';
    const unrepairedButton = document.createElement('button');
    unrepairedButton.className = 'text-white bg-ink';
    unrepairedButton.style.backgroundColor = '#191919';
    document.body.append(unrepairedButton);
    const unrepairedStyle = getComputedStyle(unrepairedButton);
    expect(unrepairedStyle.color).toBe('rgb(25, 25, 25)');
    expect(unrepairedStyle.backgroundColor).toBe('rgb(25, 25, 25)');
    expect(contrastRatio(unrepairedStyle.color, unrepairedStyle.backgroundColor)).toBeCloseTo(1, 2);
    unrepairedButton.remove();

    render(<Datos api={makeApi()} />);
    const button = await screen.findByRole('button', { name: 'Guardar cambios de Nube Andina S.A.S.' });
    const style = getComputedStyle(button);

    expect(style.color).toBe('rgb(255, 255, 255)');
    expect(style.backgroundColor).toBe('rgb(25, 25, 25)');
    expect(contrastRatio(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(4.5);

  });

  it('gives vendor, contract, account, tax and money values enough field width to read', async () => {
    render(<Datos api={makeApi()} />);
    await screen.findByRole('table', { name: 'Contratos' });

    const fullValues = [
      ['Proveedor — Nube Andina S.A.S.', 'Nube Andina S.A.S.'],
      ['Identificador fiscal — Nube Andina S.A.S.', '901.234.567-8'],
      ['Cuenta de pago — Nube Andina S.A.S.', 'Banco Ventaluz ···· 8890'],
      ['Alcance — nube-hosting-monthly', 'Hosting administrado y respaldo de infraestructura'],
      ['Monto fijo — nube-hosting-monthly', '850.00'],
    ] as const;

    for (const [label, value] of fullValues) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      expect(field.value).toBe(value);
      expect(field.classList.contains('datos-control')).toBe(true);
      expect(field.style.minWidth).toMatch(/^\d+(?:\.\d+)?ch$/);
      expect(Number.parseFloat(field.style.minWidth)).toBeGreaterThanOrEqual(value.length);
    }

    const vendorScroller = screen.getByRole('table', { name: 'Proveedores' }).parentElement;
    const contractScroller = screen.getByRole('table', { name: 'Contratos' }).parentElement;
    expect(vendorScroller?.classList.contains('datos-table-scroll')).toBe(true);
    expect(contractScroller?.classList.contains('datos-table-scroll')).toBe(true);
  });

  it('shows a distinct disabled save style while a row save is pending', async () => {
    const api = makeApi();
    let finishSave: ((row: DataRowMap[DataTable]) => void) | undefined;
    api.putRow = vi.fn((_table: DataTable, row: DataRowMap[DataTable]) => new Promise((resolve) => {
      finishSave = resolve as (saved: DataRowMap[DataTable]) => void;
    })) as DatosApi['putRow'];
    render(<Datos api={api} />);

    const button = await screen.findByRole('button', { name: 'Guardar cambios de Nube Andina S.A.S.' });
    button.click();
    await waitFor(() => expect(button.disabled).toBe(true));
    const style = getComputedStyle(button);
    expect(style.backgroundColor).toBe('rgb(245, 245, 245)');
    expect(style.color).toBe('rgb(85, 85, 85)');
    expect(style.opacity).toBe('1');
    expect(button.textContent).toBe('Guardando…');

    finishSave?.(values.vendors[0]);
  });
});
