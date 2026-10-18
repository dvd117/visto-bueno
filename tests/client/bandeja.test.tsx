// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Expediente, InvoiceRow, ProcessEvent, WorkspaceSummary } from '../../src/shared/api';
import { Counters } from '../../src/client/features/bandeja/Counters';
import { Bandeja } from '../../src/client/features/bandeja/Bandeja';
import { Expediente as ExpedientePanel } from '../../src/client/features/expediente/Expediente';
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
    country: 'MX',
    currency: 'MXN',
    concept: 'Hosting octubre',
    amount: 'USD 850,00',
    amountUsd: '850,00',
    due: '25 oct',
    status,
    reason: 'La cuenta bancaria no coincide con la registrada.',
    sourceKind: 'pdf',
    receivedAt: '2026-10-17T12:00:00.000Z',
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
      { field: 'Cuenta', invoice: 'Banco Ventaluz ···· 4412', record: 'Banco Ventaluz ···· 8890', differs: true },
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
  const counts = rows.reduce<Partial<WorkspaceSummary['counters']>>((result, row) => {
    result[row.status] = (result[row.status] ?? 0) + 1;
    return result;
  }, {});
  const workspace = makeWorkspace(counts);
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
  it('opens invoice groups by default except for ready', () => {
    const rows = [
      makeRow('ready', 'AL-043'),
      makeRow('approval_required', 'AL-035'),
      makeRow('review_required', 'AL-044'),
      makeRow('stopped', 'AL-042'),
      makeRow('stale', 'AL-045'),
      makeRow('approved', 'AL-046'),
      makeRow('rejected', 'AL-047'),
      { ...makeRow('queued', 'AL-050'), receivedAt: '2026-10-18T12:00:00.000Z' },
    ];

    render(
      <Bandeja
        rows={rows}
        selectedId={null}
        counters={makeWorkspace({ queued: 1 }).counters}
        processing={false}
        rowRevisions={{}}
        onSelect={vi.fn()}
        onProcess={vi.fn()}
        onDropFiles={vi.fn()}
      />,
    );

    const groups = Array.from(document.querySelectorAll<HTMLDetailsElement>('.state-group'));
    expect(groups.map((group) => group.dataset.state)).toEqual([
      'stopped', 'review_required', 'approval_required', 'stale', 'ready', 'approved', 'rejected',
    ]);
    expect(groups.filter((group) => !group.open).map((group) => group.dataset.state)).toEqual(['ready']);
    expect(screen.getByRole('heading', { name: 'Antes de procesar' })).not.toBeNull();
    expect(document.querySelector('.arrival-section .invoice-id')?.textContent).toBe('AL-050');
    expect(screen.getAllByText('PDF').length).toBeGreaterThan(0);
  });

  it('marks a three-row expansion button to hide on desktop only', () => {
    const rows = [
      makeRow('stopped', 'AL-042'),
      makeRow('stopped', 'AL-043'),
      makeRow('stopped', 'AL-044'),
    ];

    render(
      <Bandeja
        rows={rows}
        selectedId={null}
        counters={makeWorkspace({ stopped: 3 }).counters}
        processing={false}
        rowRevisions={{}}
        onSelect={vi.fn()}
        onProcess={vi.fn()}
        onDropFiles={vi.fn()}
      />,
    );

    const moreButton = document.querySelector('.state-group[data-state="stopped"] .more-rows');
    expect(moreButton?.getAttribute('data-hide-on-desktop')).toBe('true');
  });

  it('sorts rows inside each state group by receipt time, newest first', () => {
    const older = { ...makeRow('stopped', 'AL-042'), receivedAt: '2026-10-16T21:14:00.000Z' };
    const newer = { ...makeRow('stopped', 'AL-049'), receivedAt: '2026-10-17T09:30:00.000Z' };
    const oldest = { ...makeRow('stopped', 'AL-040'), receivedAt: '2026-10-16T08:00:00.000Z' };

    render(
      <Bandeja
        rows={[older, newer, oldest]}
        selectedId={null}
        counters={makeWorkspace({ stopped: 3 }).counters}
        processing={false}
        rowRevisions={{}}
        onSelect={vi.fn()}
        onProcess={vi.fn()}
        onDropFiles={vi.fn()}
      />,
    );

    const stoppedGroup = document.querySelector('.state-group[data-state="stopped"]');
    const ids = within(stoppedGroup as HTMLElement).getAllByRole('button', { name: /AL-/ })
      .map((row) => row.querySelector('.invoice-id')?.textContent);
    expect(ids).toEqual(['AL-049', 'AL-042', 'AL-040']);
    fireEvent.click(within(stoppedGroup as HTMLElement).getByRole('button', { name: 'Ver las 3 facturas' }));
    expect(within(stoppedGroup as HTMLElement).getByRole('button', { name: 'Mostrar menos' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('preserves receivedAt through the shared API schema for newest-first inbox ordering', async () => {
    const older = { ...makeRow('stopped', 'AL-049'), receivedAt: '2026-10-16T21:14:00.000Z' };
    const newer = { ...makeRow('stopped', 'AL-040'), receivedAt: '2026-10-17T09:30:00.000Z' };
    installApi([older, newer]);

    render(<App />);

    await screen.findByRole('button', { name: /AL-040/ });
    const stoppedGroup = document.querySelector('.state-group[data-state="stopped"]');
    const ids = within(stoppedGroup as HTMLElement).getAllByRole('button', { name: /AL-/ })
      .map((row) => row.querySelector('.invoice-id')?.textContent);
    expect(ids).toEqual(['AL-040', 'AL-049']);
  });

  it('uses counter buttons to filter invoice groups and clears the filter on a second click', async () => {
    const rows = [
      makeRow('stopped', 'AL-042'),
      makeRow('review_required', 'AL-044'),
      makeRow('approval_required', 'AL-035'),
      makeRow('ready', 'AL-043'),
    ];
    installApi(rows);

    render(<App />);

    const readyCounter = await screen.findByRole('button', { name: /^Listas para pagar/ });
    fireEvent.click(readyCounter);
    expect(document.querySelectorAll('.state-group')).toHaveLength(1);
    expect(document.querySelector('.state-group[data-state="ready"] .invoice-id')?.textContent).toBe('AL-043');

    fireEvent.click(readyCounter);
    expect(document.querySelectorAll('.state-group')).toHaveLength(4);
    expect(document.querySelector('.state-group[data-state="stopped"] .invoice-id')?.textContent).toBe('AL-042');
    expect(document.querySelector<HTMLDetailsElement>('.state-group[data-state="ready"]')?.open).toBe(false);
  });

  it('formats ISO due dates in Latin American Spanish', () => {
    const row = { ...makeRow('ready'), due: '2026-10-15' };

    render(
      <Bandeja
        rows={[row]}
        selectedId={row.id}
        counters={makeWorkspace().counters}
        processing={false}
        rowRevisions={{}}
        onSelect={vi.fn()}
        onProcess={vi.fn()}
        onReceive={vi.fn()}
        onDropFiles={vi.fn()}
      />,
    );

    expect(screen.getByText('Vence 15 oct 2026')).not.toBeNull();
  });

  it('explains an unmeasured replay cost without a dash placeholder', () => {
    render(
      <Counters
        counters={makeWorkspace().counters}
        lastRun={{ invoices: 20, ms: 1000, costUsd: '—', mode: 'replay' }}
      />,
    );

    expect(screen.getByText('20 facturas en 1,0 s · sin medición · respuestas grabadas')).not.toBeNull();
    expect(screen.queryByText(/US\$—/)).toBeNull();
  });

  it('keeps the required declared identity phrase without nested parentheses', async () => {
    const row = makeRow('approval_required');
    installApi([row], makeExpediente(row, true));

    render(<App />);

    expect(await screen.findByText('identidad declarada (demo)')).not.toBeNull();
    expect(screen.getByLabelText(/identidad declarada \(demo\)/i)).not.toBeNull();
  });

  it('shows the decision subtitle in both the row and expediente status', async () => {
    const row = { ...makeRow('review_required'), subtitle: 'Duda en los datos' };
    const expediente = makeExpediente(row);
    if (!expediente.record) throw new Error('Expected a decision record.');
    expediente.record.decision = {
      ...expediente.record.decision,
      status: 'review_required',
      checks: [{
        id: 'missing_amount',
        kind: 'verify',
        label: 'Monto presente',
        passed: false,
        effect: 'review',
        reason: 'La factura no contiene un monto verificable.',
      }],
      flags: [{ id: 'missing_amount', checkId: 'missing_amount', reason: 'La factura no contiene un monto verificable.' }],
    };
    installApi([row], expediente);

    render(<App />);

    await waitFor(() => expect(screen.getAllByText('Duda en los datos')).toHaveLength(2));
    const statuses = screen.getAllByRole('status', { name: 'Requiere revisión' });
    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      const descriptionId = status.getAttribute('aria-describedby');
      expect(descriptionId).toBeTruthy();
      expect(document.getElementById(descriptionId!)?.textContent).toBe('Duda en los datos');
    }
  });

  it('shows an original CLP amount beside USD and the applied rate date', async () => {
    const row: InvoiceRow = {
      ...makeRow(), currency: 'CLP', amount: 'CLP 950', amountUsd: 'USD 1,00', fxDate: '2026-10-15',
    };
    installApi([row], makeExpediente(row));

    render(<App />);

    expect(await screen.findByText('CLP 950')).not.toBeNull();
    expect(screen.getByText('USD 1,00')).not.toBeNull();
    expect(screen.getByText('Tasa ilustrativa · 2026-10-15')).not.toBeNull();
  });

  it('does not show an approve control for a stopped invoice', async () => {
    installApi([makeRow('stopped')]);

    render(<App />);

    const expediente = await screen.findByRole('region', { name: 'Nube Andina S.A.S.' });
    await within(expediente).findByRole('complementary', { name: 'Qué hacer' });
    expect(await within(expediente).findByRole('status', { name: 'Frenada' })).not.toBeNull();
    expect(within(expediente).queryByRole('button', { name: 'Aprobar' })).toBeNull();
    expect(screen.getByText('MX · MXN')).not.toBeNull();
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

    await waitFor(() => {
      const readyRow = document.querySelector('.state-group[data-state="ready"] .invoice-row');
      expect(readyRow?.querySelector('.invoice-id')?.textContent).toBe('AL-042');
      expect(readyRow?.querySelector('[aria-label="Lista para pagar"]')).not.toBeNull();
    });
    await waitFor(() => {
      const readyMetric = screen.getByRole('button', { name: /^Listas para pagar/ });
      expect(within(readyMetric).getByText('1')).not.toBeNull();
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

  it('shows the new invoice default tab on the first render after switching invoices', () => {
    const rows = [makeRow('stopped', 'AL-042'), makeRow('stopped', 'AL-043')];
    const expedientes = rows.map((row) => {
      const expediente = makeExpediente(row);
      expediente.fileUrl = `/api/files/${row.id}`;
      return expediente;
    });

    function InvoiceSwitchHarness() {
      const [index, setIndex] = useState(0);
      const [tabOnSwitch, setTabOnSwitch] = useState('');
      const previousInvoiceId = useRef<string | null>(null);

      useLayoutEffect(() => {
        if (previousInvoiceId.current !== null && previousInvoiceId.current !== rows[index].id) {
          setTabOnSwitch(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? '');
        }
        previousInvoiceId.current = rows[index].id;
      }, [index]);

      return (
        <>
          <button type="button" onClick={() => setIndex(1)}>Switch invoice</button>
          <ExpedientePanel
            rows={rows}
            selectedStatus={rows[index].status}
            expediente={expedientes[index]}
            loading={false}
            error={null}
            busy={false}
            includedInPaymentBatch={false}
            onApprove={async () => undefined}
            onReject={async () => undefined}
            onResolveFlag={async () => undefined}
            onReevaluate={async () => undefined}
            onSelectStatus={() => undefined}
            onTogglePaymentBatch={() => undefined}
            onOpenData={() => undefined}
          />
          <output data-testid="tab-on-invoice-switch">{tabOnSwitch}</output>
        </>
      );
    }

    render(<InvoiceSwitchHarness />);
    fireEvent.click(screen.getByRole('tab', { name: 'Texto que leyó el agente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch invoice' }));

    expect(screen.getByTestId('tab-on-invoice-switch').textContent).toBe('Documento original');
  });
});
