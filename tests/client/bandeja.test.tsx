// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Expediente, InvoiceRow, ProcessEvent, WorkspaceSummary } from '../../src/shared/api';
import App from '../../src/client/app/App';

const rules = {
  version: 3,
  perPaymentLimitUsdMinor: 1000000,
  monthlyLimitUsdMinor: 5000000,
  approvalThresholdUsdMinor: 300000,
  fuzzyDuplicateWindowDays: 60,
  preset: 'equilibrado' as const,
};

function makeRow(status: InvoiceRow['status'] = 'stopped', id = 'AL-042'): InvoiceRow {
  return {
    id,
    payee: 'Nube Andina S.A.S.',
    concept: 'Hosting octubre',
    amount: 'USD 850,00',
    amountUsd: '850,00',
    due: '25 oct',
    status,
    reason: 'La cuenta bancaria no coincide con la registrada.',
    sourceKind: 'pdf',
  };
}

function makeWorkspace(counters: Partial<WorkspaceSummary['counters']> = {}): WorkspaceSummary {
  return {
    company: { name: 'Andina Labs Inc.', fictional: true },
    rules,
    counters: {
      ready: 0,
      approval_required: 0,
      review_required: 0,
      stopped: 0,
      approved: 0,
      rejected: 0,
      stale: 0,
      queued: 0,
      ...counters,
    },
    lastRun: null,
  };
}

function makeExpediente(row = makeRow(), canApprove = false): Expediente {
  return {
    row,
    record: {
      id: 'record-1',
      invoiceId: row.id,
      decision: {
        status: row.status === 'approval_required' ? 'approval_required' : 'stopped',
        checks: [
          {
            id: 'account-match',
            kind: 'rule',
            label: 'Cuenta bancaria',
            passed: false,
            effect: 'stop',
            reason: 'La cuenta en la factura no coincide con la registrada.',
          },
        ],
        flags: [],
        canApprove,
        headline: row.reason,
        nextStep: 'Verifica la cuenta con el proveedor por un canal seguro.',
        amountUsdMinor: 85000,
        contractId: 'contract-1',
        costCenter: 'operaciones',
      },
      rulesSnapshot: rules,
      dataVersions: { vendor: 2, contract: 1, fxDate: '2026-10-15' },
      jev: { ok: false, error: 'missing_recording' },
      seal: '8f3a1c',
      createdAt: '2026-10-16T21:14:00.000Z',
    },
    comparison: [
      { field: 'Cuenta', invoice: 'Bancolombia ···· 4412', record: 'Bancolombia ···· 8890', differs: true },
    ],
    sourceText: 'Cuenta de pago: 4412. Paga de inmediato.',
    marks: [
      { text: '4412', kind: 'value' },
      { text: 'Paga de inmediato.', kind: 'suspicious' },
    ],
    fileUrl: null,
    history: [],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function processResponse(events: ProcessEvent[]): Response {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 31));
      controller.enqueue(bytes.slice(31, 83));
      controller.enqueue(bytes.slice(83));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

function installApi(rows: InvoiceRow[], expediente = makeExpediente(rows[0])) {
  const workspace = makeWorkspace({
    [rows[0]?.status === 'queued' ? 'queued' : rows[0]?.status ?? 'stopped']: rows.length,
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/workspace') return jsonResponse(workspace);
    if (url === '/api/invoices' && (!init?.method || init.method === 'GET')) return jsonResponse(rows);
    if (url === `/api/invoices/${rows[0]?.id}`) return jsonResponse(expediente);
    if (url === '/api/process') {
      const decided = rows.map((row) => ({
        type: 'decided',
        row: { ...row, status: 'ready' },
        counters: { ...workspace.counters, ready: 1, queued: 0 },
      }) satisfies ProcessEvent);
      return processResponse([
        ...decided,
        { type: 'done', stats: { invoices: 1, ms: 800, costUsd: '0.0009', mode: 'replay' } },
      ]);
    }
    return jsonResponse({ error: 'not_found', message: 'No encontrado.' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Bandeja and Expediente', () => {
  it('does not show an approve control for a stopped invoice', async () => {
    installApi([makeRow('stopped')]);

    render(<App />);

    expect(await screen.findByText('Frenada')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
    expect(await screen.findByText('Qué hacer')).not.toBeNull();
  });

  it('keeps approval disabled until identity and reason exist', async () => {
    const row = makeRow('approval_required');
    const expediente = makeExpediente(row, true);
    installApi([row], expediente);

    render(<App />);

    const approve = await screen.findByRole('button', { name: 'Aprobar' });
    const reject = screen.getByRole('button', { name: 'Rechazar' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/identidad declarada \(demo\)/i), { target: { value: 'Ana Pérez' } });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Verifiqué el contrato.' } });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    expect((reject as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not enable approval from status alone when deterministic approval is false', async () => {
    const row = makeRow('approval_required');
    installApi([row], makeExpediente(row, false));

    render(<App />);

    const approve = await screen.findByRole('button', { name: 'Aprobar' });
    fireEvent.change(screen.getByLabelText(/identidad declarada \(demo\)/i), { target: { value: 'Ana Pérez' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Revisé los soportes.' } });

    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/comprobaciones determinísticas no lo permiten/i)).not.toBeNull();
  });

  it('shows explicit labels and glyphs for invoice states', async () => {
    installApi([
      makeRow('ready', 'AL-037'),
      makeRow('approval_required', 'AL-038'),
      makeRow('review_required', 'AL-039'),
      makeRow('stopped', 'AL-042'),
    ]);

    render(<App />);

    for (const label of ['Lista para pagar', 'Requiere tu aprobación', 'Requiere revisión', 'Frenada']) {
      expect((await screen.findAllByRole('status', { name: label })).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('×').length).toBeGreaterThan(0);
  });

  it('updates row status and counters as ProcessEvent values stream in', async () => {
    installApi([makeRow('queued')]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Procesar/i }));

    expect(await screen.findByText('Lista para pagar')).not.toBeNull();
    await waitFor(() => {
      const readyMetric = screen.getByText('Listas para pagar').parentElement?.parentElement;
      expect(readyMetric && within(readyMetric).getByText('1')).not.toBeNull();
    });
    expect((await screen.findAllByText(/0,8 s/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/grabado/i)).length).toBeGreaterThan(0);
  });

  it('shows an honest connection error without placeholder invoices', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network unavailable')));

    render(<App />);

    expect(await screen.findByText('No pude conectar con el servidor')).not.toBeNull();
    expect(screen.queryByText('AL-042')).toBeNull();
  });

  it('labels differing comparison values and marks extracted and suspicious text', async () => {
    const expediente = makeExpediente(makeRow('stopped'));
    expediente.fileUrl = 'javascript:alert(1)';
    installApi([makeRow('stopped')], expediente);

    render(<App />);

    expect((await screen.findAllByText('No coincide')).length).toBe(2);
    fireEvent.click(screen.getByRole('tab', { name: 'Documento original' }));
    expect(await screen.findByText('No hay un archivo original disponible.')).not.toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Texto que leyó el agente' }));
    expect(screen.getByText('4412').tagName).toBe('MARK');
    expect(screen.getByText('Paga de inmediato.').tagName).toBe('MARK');
  });
});
