import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../../src/client/app/App';
import { getClients, getExpediente, templateUrl } from '../../src/client/lib/api';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});
const rules = {
  version: 1, perPaymentLimitUsdMinor: 85000, monthlyLimitUsdMinor: 500000,
  approvalThresholdUsdMinor: 50000, fuzzyDuplicateWindowDays: 30, preset: 'equilibrado',
};
const row = {
  id: 'andina-private', payee: 'ANDINA PRIVATE', concept: 'Servicio', amount: 'USD 100.00', amountUsd: 'USD 100.00',
  fxDate: null, due: null, status: 'ready', reason: 'Cumple', sourceKind: 'text', country: 'US', currency: 'USD',
  receivedAt: '2026-10-17T12:00:00.000Z',
};
const clients = [
  { id: 'client-andina', name: 'Andina Labs Inc.', invoiceCount: 1, readyCount: 1 },
  { id: 'client-marea', name: 'Marea Norte SpA', invoiceCount: 0, readyCount: 0 },
];
let finishSwitchReload: (() => Promise<void>) | null = null;

function setup(
  override: (path: string, init?: RequestInit) => Promise<Response> | undefined,
  context: { activeId: string } = { activeId: 'client-andina' },
) {
  sessionStorage.setItem('visto-bueno:client-id', 'client-andina');
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.href).pathname;
    const custom = override(path, init);
    if (custom) return custom;
    const name = clients.find((client) => client.id === context.activeId)!.name;
    if (path === '/api/clients/switch') {
      context.activeId = JSON.parse(String(init?.body)).clientId;
      return json({ activeId: context.activeId });
    }
    if (path === '/api/clients') return json({ activeId: context.activeId, clients });
    if (path === '/api/workspace') return json({
      company: { name, fictional: true }, rules,
      counters: { ready: context.activeId === 'client-andina' ? 1 : 0, approval_required: 0, review_required: 0,
        stopped: 0, approved: 0, rejected: 0, stale: 0, queued: 0 }, lastRun: null,
    });
    if (path === '/api/invoices') return json(context.activeId === 'client-andina' ? [row] : []);
    if (path === '/api/company') return json({
      name, operatingCountries: ['US'], vendorCountries: ['US'], currencies: ['USD'],
      limits: { perPaymentUsdMinor: 85000, monthlyUsdMinor: 500000, approvalThresholdUsdMinor: 50000 },
    });
    if (path.startsWith('/api/invoices/')) return json({ error: 'not_found', message: 'Missing' }, 404);
    if (path === '/api/log') return json([]);
    if (path === '/api/rules') return json(rules);
    if (path === '/api/data/vendors') return json([]);
    if (path === '/api/data/contracts' || path === '/api/data/budgets') return json([]);
    if (path === '/api/data/treasury') return json({ balanceUsdMinor: 0, fx: [{ currency: 'USD', perUsd: '1', date: '2026-10-17' }] });
    throw new Error(path);
  });
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem('visto-bueno:first-run-dismissed', 'true');
  const reloadPage = vi.fn();
  render(<App reloadPage={reloadPage} />);
  finishSwitchReload = async () => {
    await waitFor(() => expect(reloadPage).toHaveBeenCalled());
    cleanup();
    render(<App reloadPage={reloadPage} />);
    await screen.findByRole('button', { name: 'Marea Norte SpA' });
  };
  return fetchMock;
}

async function switchToMarea() {
  fireEvent.click(await screen.findByRole('button', { name: 'Andina Labs Inc.' }));
  fireEvent.click(screen.getByRole('option', { name: /Marea Norte SpA/ }));
  await finishSwitchReload?.();
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const kind of ['payments', 'reconciliation', 'audit'] as const) {
  it(`REVIEW: cancels delayed ${kind} export across client switch`, async () => {
    let release!: (response: Response) => void;
    const objectUrl = vi.fn(() => 'blob:review');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: objectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const fetchMock = setup((path) => path === `/api/export/${kind === 'audit' ? 'log' : kind}.csv`
      ? new Promise((resolve) => { release = resolve; })
      : undefined);

    await screen.findByRole('button', { name: 'Andina Labs Inc.' });
    if (kind === 'audit') {
      fireEvent.click(screen.getByRole('link', { name: 'Bitácora' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Bitácora de auditoría (CSV)' }));
    } else {
      fireEvent.click(await screen.findByRole('button', {
        name: kind === 'payments' ? 'Exportar lote de pago (1)' : 'Exportar conciliación (CSV)',
      }));
    }
    await waitFor(() => expect(release).toBeTypeOf('function'));
    const exportCall = fetchMock.mock.calls.find(([input]) =>
      new URL(String(input), window.location.href).pathname === `/api/export/${kind === 'audit' ? 'log' : kind}.csv`);
    expect(new Headers(exportCall?.[1]?.headers).get('X-Client-Id')).toBe('client-andina');
    expect(new URL(String(exportCall?.[0]), window.location.href).searchParams.get('client_id')).toBe('client-andina');
    await switchToMarea();
    await act(async () => {
      release(new Response('CLIENT,INVOICE\nANDINA,andina-private'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByRole('button', { name: 'Marea Norte SpA' })).toBeTruthy();
    expect(click).not.toHaveBeenCalled();
    expect(objectUrl).not.toHaveBeenCalled();
  });
}

it('REVIEW: cancels a delayed export after another tab broadcasts its client switch', async () => {
  const context = { activeId: 'client-andina' };
  let release!: (response: Response) => void;
  const objectUrl = vi.fn(() => 'blob:review');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: objectUrl });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  setup((path) => path === '/api/export/payments.csv'
    ? new Promise((resolve) => { release = resolve; })
    : undefined, context);

  await screen.findByRole('button', { name: 'Andina Labs Inc.' });
  fireEvent.click(await screen.findByRole('button', { name: 'Exportar lote de pago (1)' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  context.activeId = 'client-marea';
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'visto-bueno:client-context-switch', newValue: 'external-switch' }));
  });
  // The shared cookie changed in the other tab, but this tab remains on Andina.
  await screen.findByRole('button', { name: 'Andina Labs Inc.' });
  await act(async () => {
    release(new Response('CLIENT,INVOICE\nANDINA,andina-private'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(click).not.toHaveBeenCalled();
  expect(objectUrl).not.toHaveBeenCalled();
});

it('pins client-scoped fetches to the tab’s selected client', async () => {
  const fetchMock = setup(() => undefined);
  await screen.findByRole('button', { name: 'Andina Labs Inc.' });
  const clientRequests = fetchMock.mock.calls.filter(([input]) =>
    new URL(String(input), window.location.href).pathname !== '/api/clients');
  expect(clientRequests.length).toBeGreaterThan(0);
  for (const [, init] of clientRequests) {
    expect(new Headers(init?.headers).get('X-Client-Id')).toBe('client-andina');
  }
});

it('scopes file and template URLs to the active client', async () => {
  sessionStorage.setItem('visto-bueno:client-id', 'client-andina');
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(String(input), window.location.href).pathname;
    if (path === '/api/clients') return json({ activeId: 'client-andina', clients });
    if (path === '/api/invoices/file-invoice') return json({
      row: { ...row, id: 'file-invoice', sourceKind: 'pdf' }, record: null, comparison: [], sourceText: null,
      marks: [], fileUrl: '/api/files/file-invoice', history: [],
    });
    throw new Error(path);
  });
  vi.stubGlobal('fetch', fetchMock);

  await getClients();
  expect(templateUrl('vendors')).toBe('/api/data/vendors/template.csv?client_id=client-andina');
  const expediente = await getExpediente('file-invoice');
  expect(expediente.fileUrl).toBe('/api/files/file-invoice?client_id=client-andina');
  const fileRequest = fetchMock.mock.calls.find(([input]) =>
    new URL(String(input), window.location.href).pathname === '/api/invoices/file-invoice');
  expect(new Headers(fileRequest?.[1]?.headers).get('X-Client-Id')).toBe('client-andina');
});
