// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../../src/client/app/App';

const counters = {
  ready: 0, approval_required: 0, review_required: 0, stopped: 0,
  approved: 0, rejected: 0, stale: 0, queued: 0,
};
const rules = {
  version: 1,
  perPaymentLimitUsdMinor: 1500000,
  monthlyLimitUsdMinor: 6000000,
  approvalThresholdUsdMinor: 300000,
  fuzzyDuplicateWindowDays: 60,
  preset: 'equilibrado',
} as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function installApi(evalStatus = 503, evalBody?: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.href).pathname;
    if (path === '/api/workspace') return json({
      company: { name: 'Andina Labs Inc.', fictional: true },
      rules,
      counters,
      lastRun: null,
    });
    if (path === '/api/invoices') return json([]);
    if (path === '/api/eval') return json(
      evalBody ?? { error: 'unavailable', message: 'La evaluación todavía no está disponible.' },
      evalStatus,
    );
    if (path === '/api/rules') return json(rules);
    if (path === '/api/rules/simulate') return json({
      counts: { ready: 0, approval_required: 0, review_required: 0, stopped: 0 },
      deltas: { ready: 0, approval_required: 0, review_required: 0, stopped: 0 },
      unsafeApprovals: 0,
    });
    if (path === '/api/data/vendors' || path === '/api/data/contracts' || path === '/api/data/budgets') return json([]);
    if (path === '/api/data/treasury') return json({
      balanceUsdMinor: 100_000,
      fx: [{ currency: 'USD', perUsd: '1', date: '2026-10-15' }],
    });
    if (path === '/api/log') return json([]);
    throw new Error(`Unexpected fetch: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  window.localStorage.clear();
  installApi();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App first-run and evaluation integration', () => {
  it('shows the unavailable evaluation for a 503 without inventing metrics', async () => {
    const fetchMock = installApi(503);
    render(<App />);
    await screen.findByRole('heading', { name: 'Andina Labs Inc.' });

    fireEvent.click(screen.getByRole('link', { name: 'Evaluación' }));

    expect(await screen.findByRole('heading', { name: 'Evaluación no disponible' })).toBeTruthy();
    expect(screen.getByText('Aún no hay un resultado de evaluación para mostrar.')).toBeTruthy();
    const page = screen.getByRole('main');
    expect(within(page).queryByRole('table')).toBeNull();
    expect(within(page).queryByText(/\b\d+\b|US\$|\bms\b/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/eval');
  });

  it('shows an error state for non-503 evaluation failures', async () => {
    installApi(500);
    render(<App />);
    await screen.findByRole('heading', { name: 'Andina Labs Inc.' });

    fireEvent.click(screen.getByRole('link', { name: 'Evaluación' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'No pudimos cargar la evaluación. Inténtalo de nuevo.');
  });

  it('renders validated evaluation metrics from the endpoint', async () => {
    installApi(200, {
      status: 'available',
      report: {
        regression: { tests: 38, unsafeApprovals: 0 },
        labeled: { total: 20, correct: 18, autonomyPct: 40.5, falseEscalations: 2, mode: 'replay' },
      },
      regression: { status: 'available', tests: 38, unsafeApprovals: 0, source: 'suite de regresión verificada', safetyGate: 'passed' },
      labeled: {
        status: 'available', mode: 'replay', total: 20, correct: 18, falseEscalations: 2,
        autonomyPct: 40.5, unsafeApprovals: 0, unsafeInvoiceIds: [], safetyGate: 'passed',
      },
      live: { status: 'unavailable', reason: 'sample_not_supplied' },
      safetyGate: 'passed',
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Andina Labs Inc.' });

    fireEvent.click(screen.getByRole('link', { name: 'Evaluación' }));

    expect(await screen.findByText('18 / 20')).toBeTruthy();
    expect(screen.getByText('0 aprobaciones indebidas en 38 pruebas.')).toBeTruthy();
  });

  it('shows the first-run hint once and persists dismissal', async () => {
    render(<App />);
    const hint = await screen.findByRole('region', { name: 'Orientación de inicio' });

    fireEvent.click(within(hint).getByRole('button', { name: 'Cerrar orientación inicial' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Orientación de inicio' })).toBeNull());
    expect(window.localStorage.getItem('visto-bueno:first-run-dismissed')).toBe('true');

    cleanup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Andina Labs Inc.' });
    expect(screen.queryByRole('region', { name: 'Orientación de inicio' })).toBeNull();
  });

  it('still renders and dismisses the hint when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied'); });
    render(<App />);

    const hint = await screen.findByRole('region', { name: 'Orientación de inicio' });
    fireEvent.click(within(hint).getByRole('button', { name: 'Cerrar orientación inicial' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Orientación de inicio' })).toBeNull());
  });

  it('connects first-run actions and the empty Bandeja action to existing app views', async () => {
    render(<App />);
    const hint = await screen.findByRole('region', { name: 'Orientación de inicio' });

    fireEvent.click(within(hint).getByRole('button', { name: 'Preparar datos' }));
    expect(await screen.findByRole('heading', { name: 'Preparar datos' })).toBeTruthy();

    fireEvent.click(within(hint).getByRole('button', { name: 'Revisar reglas' }));
    expect(await screen.findByRole('heading', { name: 'Reglas de pago' })).toBeTruthy();

    fireEvent.click(within(hint).getByRole('button', { name: 'Recibir una factura' }));
    expect(await screen.findByRole('dialog', { name: 'Recibir facturas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar panel' }));

    fireEvent.click(screen.getByRole('link', { name: 'Bandeja' }));
    const emptyInbox = document.querySelector('.empty-list') as HTMLElement;
    fireEvent.click(within(emptyInbox).getByRole('button', { name: 'Recibir una factura' }));
    expect(await screen.findByRole('dialog', { name: 'Recibir facturas' })).toBeTruthy();
  });
});
