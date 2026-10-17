// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Counters, Expediente, InvoiceRow } from '../../src/shared/api';
import App from '../../src/client/app/App';

const counters: Counters = {
  ready: 0, approval_required: 0, review_required: 0, stopped: 0,
  approved: 0, rejected: 0, stale: 0, queued: 1,
};
const rules = {
  version: 1,
  perPaymentLimitUsdMinor: 1_500_000,
  monthlyLimitUsdMinor: 6_000_000,
  approvalThresholdUsdMinor: 300_000,
  fuzzyDuplicateWindowDays: 60,
  preset: 'equilibrado',
} as const;

const queuedRow: InvoiceRow = {
  id: 'AL-030', payee: 'Proveedor por identificar', concept: 'Factura recibida',
  amount: '—', amountUsd: null, due: null, status: 'queued', reason: 'Pendiente de evaluación',
  sourceKind: 'text', country: null, currency: null,
};
const readyRow: InvoiceRow = {
  ...queuedRow, payee: 'Pixel Patio S.A.S.', concept: 'Diseño y mantenimiento',
  amount: 'USD 780,00', amountUsd: 'USD 780,00', due: '2026-10-25', status: 'ready',
  reason: 'Evaluación completada.', country: 'CO', currency: 'USD',
};
const otherRow: InvoiceRow = {
  ...queuedRow, id: 'AL-031', payee: 'Otro proveedor', concept: 'Compra de insumos',
};
const expediente: Expediente = {
  row: queuedRow, record: null, comparison: [], sourceText: 'Factura recibida', marks: [], fileUrl: null, history: [],
};
const refreshedExpediente: Expediente = {
  ...expediente, row: readyRow,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App load flow', () => {
  it('clears an uploaded selection before loading the reset workspace', async () => {
    const uploadedRow: InvoiceRow = { ...queuedRow, id: 'CUSTOM-UPLOADED-001', payee: 'Factura subida' };
    const seededRow: InvoiceRow = { ...readyRow, id: 'AL-001', payee: 'Proveedor semilla' };
    const uploadedExpediente: Expediente = { ...expediente, row: uploadedRow };
    const seededExpediente: Expediente = { ...refreshedExpediente, row: seededRow };
    let invoiceReads = 0;
    let resetRequested = false;
    let staleDetailReadsAfterReset = 0;
    let resolveResetInvoices!: (response: Response) => void;
    const resetInvoices = new Promise<Response>((resolve) => { resolveResetInvoices = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path === '/api/workspace') return json({
        company: { name: 'Andina Labs Inc.', fictional: true }, rules, counters, lastRun: null,
      });
      if (path === '/api/invoices') {
        invoiceReads += 1;
        return invoiceReads === 1 ? json([uploadedRow]) : resetInvoices;
      }
      if (path === '/api/workspace/reset' && init?.method === 'POST') {
        resetRequested = true;
        return json({ ok: true });
      }
      if (path === `/api/invoices/${uploadedRow.id}`) {
        if (resetRequested) {
          staleDetailReadsAfterReset += 1;
          return json({ error: 'not_found', message: 'No encontré esta factura.' }, 404);
        }
        return json(uploadedExpediente);
      }
      if (path === `/api/invoices/${seededRow.id}`) return json(seededExpediente);
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Factura subida' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar demo' }));

    expect(await screen.findByText('Conectando con el servidor…')).toBeTruthy();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    const staleReads = staleDetailReadsAfterReset;
    resolveResetInvoices(json([seededRow]));
    expect(await screen.findByRole('heading', { name: 'Proveedor semilla' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /AL-001/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('No encontré esta factura.')).toBeNull();
    expect(staleReads).toBe(0);
  });

  it('discards a Recibir upload response that arrives after reset', async () => {
    const uploadedRow: InvoiceRow = { ...queuedRow, id: 'CUSTOM-UPLOADED-002', payee: 'Factura tardía' };
    const seededRow: InvoiceRow = { ...readyRow, id: 'AL-001', payee: 'Proveedor semilla' };
    const seededExpediente: Expediente = { ...refreshedExpediente, row: seededRow };
    let resolveUpload!: (response: Response) => void;
    const uploadResponse = new Promise<Response>((resolve) => { resolveUpload = resolve; });
    let resolveProcess!: (response: Response) => void;
    const processResponse = new Promise<Response>((resolve) => { resolveProcess = resolve; });
    let uploadStarted = false;
    let processRequests = 0;
    let staleDetailReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path === '/api/workspace') return json({
        company: { name: 'Andina Labs Inc.', fictional: true }, rules, counters, lastRun: null,
      });
      if (path === '/api/invoices' && init?.method === 'POST') {
        uploadStarted = true;
        return uploadResponse;
      }
      if (path === '/api/invoices') return json([seededRow]);
      if (path === '/api/workspace/reset' && init?.method === 'POST') return json({ ok: true });
      if (path === `/api/invoices/${seededRow.id}`) return json(seededExpediente);
      if (path === `/api/invoices/${uploadedRow.id}`) {
        staleDetailReads += 1;
        return json({ error: 'not_found', message: 'No encontré esta factura.' }, 404);
      }
      if (path === '/api/process') {
        processRequests += 1;
        return processResponse;
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Proveedor semilla' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '+ Recibir factura' }));
    expect(await screen.findByRole('dialog', { name: 'Recibir facturas' })).toBeTruthy();
    const file = new File(['fake pdf'], 'late-invoice.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Seleccionar PDF o imagen'), { target: { files: [file] } });
    await waitFor(() => expect(uploadStarted).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar demo' }));
    expect(await screen.findByText('Demo reiniciada.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /AL-001/ }).getAttribute('aria-pressed')).toBe('true');

    try {
      await act(async () => {
        resolveUpload(json(uploadedRow));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });

      expect(screen.queryByRole('button', { name: /CUSTOM-UPLOADED-002/ })).toBeNull();
      expect(screen.getByRole('button', { name: /AL-001/ }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.queryByText('No encontré esta factura.')).toBeNull();
      expect(staleDetailReads).toBe(0);
      expect(processRequests).toBe(0);
    } finally {
      resolveProcess(new Response('data: {"type":"done","stats":{"invoices":1,"ms":1,"costUsd":"0.00","mode":"replay"}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }));
    }
  });

  it('keeps the last expediente visible while a streamed result is being refetched', async () => {
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    let detailRequests = 0;
    let processing = false;
    const processEvents = [
      { type: 'decided', row: readyRow, counters: { ...counters, queued: 0, ready: 1 } },
      { type: 'done', stats: { invoices: 1, ms: 12, costUsd: '0.00', mode: 'replay' } },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of processEvents) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path === '/api/workspace') return json({
        company: { name: 'Andina Labs Inc.', fictional: true }, rules, counters, lastRun: null,
      });
      if (path === '/api/invoices') return json([queuedRow]);
      if (path === '/api/invoices/AL-030') {
        detailRequests += 1;
        return processing ? refreshResponse : json(expediente);
      }
      if (path === '/api/process') {
        processing = true;
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Proveedor por identificar' }, {}, { timeout: 5_000 })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Procesar' }));
    await waitFor(() => expect(detailRequests).toBeGreaterThan(1));
    expect(screen.getByRole('button', { name: /Pixel Patio S\.A\.S\./ })).toBeTruthy();
    expect(screen.queryByText('Abriendo expediente…')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Proveedor por identificar' })).toBeTruthy();

    resolveRefresh(json(refreshedExpediente));
    expect(await screen.findByRole('heading', { name: 'Pixel Patio S.A.S.' })).toBeTruthy();
  });

  it('does not render the old expediente after loadWorkspace selects a different invoice', async () => {
    let invoiceReads = 0;
    let resolveOtherDetail!: (response: Response) => void;
    const otherDetailResponse = new Promise<Response>((resolve) => { resolveOtherDetail = resolve; });
    let otherDetailRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path === '/api/workspace') return json({
        company: { name: 'Andina Labs Inc.', fictional: true }, rules, counters, lastRun: null,
      });
      if (path === '/api/invoices') {
        invoiceReads += 1;
        return json(invoiceReads === 1 ? [queuedRow] : [otherRow]);
      }
      if (path === '/api/invoices/AL-030') return json(expediente);
      if (path === '/api/invoices/AL-031') {
        otherDetailRequests += 1;
        return otherDetailResponse;
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Proveedor por identificar' })).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Bandeja' }));
    await waitFor(() => expect(otherDetailRequests).toBeGreaterThan(0));

    expect(screen.queryByRole('heading', { name: 'Proveedor por identificar' })).toBeNull();
    expect(screen.getByText('Abriendo expediente…')).toBeTruthy();

    resolveOtherDetail(json({ ...expediente, row: otherRow }));
    expect(await screen.findByRole('heading', { name: 'Otro proveedor' })).toBeTruthy();
  });

  it('shows the refetch error while keeping the same expediente visible', async () => {
    let detailRequests = 0;
    let processing = false;
    const processEvents = [
      { type: 'decided', row: readyRow, counters: { ...counters, queued: 0, ready: 1 } },
      { type: 'done', stats: { invoices: 1, ms: 12, costUsd: '0.00', mode: 'replay' } },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of processEvents) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path === '/api/workspace') return json({
        company: { name: 'Andina Labs Inc.', fictional: true }, rules, counters, lastRun: null,
      });
      if (path === '/api/invoices') return json([queuedRow]);
      if (path === '/api/invoices/AL-030') {
        detailRequests += 1;
        if (processing) throw new TypeError('Network request failed');
        return json(expediente);
      }
      if (path === '/api/process') {
        processing = true;
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Proveedor por identificar' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Procesar' }));
    await waitFor(() => expect(detailRequests).toBeGreaterThan(1));

    expect(await screen.findByText('No pude conectar con el servidor')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Proveedor por identificar' })).toBeTruthy();
  });
});
