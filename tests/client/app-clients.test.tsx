import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/client/app/App';
import { ClientSwitcher } from '../../src/client/app/ClientSwitcher';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('App client switcher', () => {
  it('keeps the menu within 390px and 1440px viewports', () => {
    const clients = [
      { id: 'client-a', name: 'Andina Labs Inc.', invoiceCount: 20, readyCount: 7 },
      { id: 'client-b', name: 'Marea Norte SpA', invoiceCount: 0, readyCount: 0 },
    ];
    const originalWidth = window.innerWidth;
    const viewportCases = [
      { width: 390, triggerLeft: 200, expectedLeft: '18px' },
      { width: 1440, triggerLeft: 220, expectedLeft: '220px' },
    ];

    for (const viewport of viewportCases) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport.width });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
        x: viewport.triggerLeft, y: 40, width: 180, height: 44,
        top: 40, right: viewport.triggerLeft + 180, bottom: 84, left: viewport.triggerLeft,
        toJSON: () => ({}),
      }));
      render(<ClientSwitcher
        clients={clients}
        activeId="client-a"
        activeCompanyName="Andina Labs Inc."
        onSwitch={() => {}}
      />);

      fireEvent.click(screen.getByRole('button', { name: 'Andina Labs Inc.' }));
      const menu = document.querySelector<HTMLElement>('.client-switcher-menu')!;
      expect(menu.style.left).toBe(viewport.expectedLeft);
      expect(menu.style.width).toBe('360px');
      cleanup();
      vi.restoreAllMocks();
    }

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  });

  it('uses the active C1 company profile in the header and atomically switches workspaces', async () => {
    let activeId = 'client-andina';
    let switchBody: { clientId?: string } | null = null;
    const invoice = {
      id: 'AL-CLIENT-001', payee: 'Proveedor Andina', concept: 'Servicio mensual', amount: 'USD 100.00', amountUsd: 'USD 100.00',
      fxDate: null, due: '31 oct 2026', status: 'ready', reason: 'Cumple las reglas', sourceKind: 'text', country: 'US', currency: 'USD',
    };
    const workspace = {
      company: { name: 'Legacy summary value', fictional: true },
      rules: {
        version: 1, perPaymentLimitUsdMinor: 85000, monthlyLimitUsdMinor: 500000,
        approvalThresholdUsdMinor: 300000, fuzzyDuplicateWindowDays: 30, preset: 'equilibrado',
      },
      counters: { ready: 1, approval_required: 0, review_required: 0, stopped: 0, approved: 0, rejected: 0, stale: 0, queued: 0 },
      lastRun: null,
    };
    const profile = (name: string) => ({
      name, operatingCountries: ['US'], vendorCountries: ['CO', 'MX', 'VE', 'CL', 'US'], currencies: ['USD', 'COP', 'MXN'],
      limits: { perPaymentUsdMinor: 85000, monthlyUsdMinor: 500000, approvalThresholdUsdMinor: 300000 },
    });
    const clients = [
      { id: 'client-andina', name: 'Andina Labs Inc.', invoiceCount: 0, readyCount: 0 },
      { id: 'client-marea', name: 'Marea Norte SpA', invoiceCount: 0, readyCount: 0 },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path === '/api/workspace') return json(workspace);
      if (path === '/api/invoices') return json(activeId === 'client-andina' ? [invoice] : []);
      if (path === `/api/invoices/${invoice.id}`) return json({ error: 'not_found', message: 'No encontré esta factura.' }, 404);
      if (path === '/api/company') return json(profile(activeId === 'client-andina' ? 'Andina Labs Inc.' : 'Marea Norte SpA'));
      if (path === '/api/clients') return json({ activeId, clients: clients.map((client) => ({ ...client })) });
      if (path === '/api/clients/switch' && init?.method === 'POST') {
        switchBody = JSON.parse(String(init.body)) as { clientId?: string };
        activeId = switchBody.clientId ?? activeId;
        return json({ activeId });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByText('Proveedor Andina')).toBeTruthy();
    const switcher = await screen.findByRole('button', { name: 'Andina Labs Inc.' });
    expect(switcher.getAttribute('aria-haspopup')).toBe('listbox');
    fireEvent.click(switcher);
    const marea = await screen.findByRole('option', { name: /Marea Norte SpA/ });
    fireEvent.click(marea);

    expect(await screen.findByRole('button', { name: 'Marea Norte SpA' })).toBeTruthy();
    expect(switchBody).toEqual({ clientId: 'client-marea' });
    expect(screen.queryByText('Proveedor Andina')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input), window.location.href).pathname === '/api/company')).toBe(true);
  });
});
