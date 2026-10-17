// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.href).pathname;
    if (path === '/api/workspace') return json({
      company: { name: 'Andina Labs Inc.', fictional: true },
      rules,
      counters,
      lastRun: null,
    });
    if (path === '/api/rules') return json(rules);
    if (path === '/api/rules/simulate') return json({
      counts: { ready: 0, approval_required: 0, review_required: 0, stopped: 0 },
      deltas: { ready: 0, approval_required: 0, review_required: 0, stopped: 0 },
      unsafeApprovals: 0,
    });
    if (path === '/api/invoices') return json([]);
    if (path === '/api/data/vendors' || path === '/api/data/contracts' || path === '/api/data/budgets') return json([]);
    if (path === '/api/data/treasury') return json({
      balanceUsdMinor: 100_000,
      fx: [{ currency: 'USD', perUsd: '1', date: '2026-10-15' }],
    });
    if (path === '/api/log') return json([]);
    throw new Error(`Unexpected fetch: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T11 app integration', () => {
  it('mounts the merged help and receiving panels and connects data and log views', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Andina Labs Inc.' });

    fireEvent.click(screen.getByRole('button', { name: 'Cómo decide' }));
    expect(await screen.findByRole('dialog', { name: 'Cómo decide el agente' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar panel' }));

    fireEvent.click(screen.getAllByRole('button', { name: '+ Recibir factura' })[0]!);
    expect(await screen.findByRole('dialog', { name: 'Recibir facturas' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar panel' }));

    fireEvent.click(screen.getByRole('link', { name: 'Preparar datos' }));
    expect(await screen.findByRole('heading', { name: 'Preparar datos' })).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Bitácora' }));
    expect(await screen.findByRole('heading', { name: 'Bitácora' })).toBeTruthy();
  });

  it('mounts the Reglas section using its rules adapter', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Andina Labs Inc.' });

    fireEvent.click(screen.getByRole('link', { name: 'Reglas' }));

    expect(await screen.findByRole('heading', { name: 'Reglas de pago' })).toBeTruthy();
    expect(await screen.findByText('Versión vigente: 1')).toBeTruthy();
  });
});
