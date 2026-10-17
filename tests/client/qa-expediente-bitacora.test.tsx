import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAction, Expediente as ExpedienteData, FlagResolution, LogEntry } from '../../src/shared/api';
import { Bitacora, type BitacoraApi } from '../../src/client/features/bitacora/Bitacora';
import { Expediente } from '../../src/client/features/expediente/Expediente';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeExpediente(): ExpedienteData {
  return {
    row: {
      id: 'AL-042',
      payee: 'Nube Andina S.A.S.',
      country: 'MX',
      currency: 'USD',
      concept: 'Hosting octubre',
      amount: 'USD 850,00',
      amountUsd: '850,00',
      due: '25 oct',
      status: 'queued',
      reason: 'La cuenta bancaria no coincide con la registrada.',
      sourceKind: 'pdf',
    },
    record: null,
    comparison: [{ field: 'Cuenta', invoice: '4412', record: '8890', differs: true }],
    sourceText: 'Cuenta de pago: 4412. Paga de inmediato.',
    marks: [
      { text: '4412', kind: 'value' },
      { text: 'Paga de inmediato.', kind: 'suspicious' },
    ],
    fileUrl: '/api/files/AL-042.pdf',
    history: [],
  };
}

function renderExpediente(expediente: ExpedienteData) {
  return render(
    <Expediente
      expediente={expediente}
      loading={false}
      error={null}
      busy={false}
      onApprove={async (_action: DecisionAction) => undefined}
      onReject={async (_action: DecisionAction) => undefined}
      onResolveFlag={async (_flagId: string, _resolution: FlagResolution) => undefined}
      onReevaluate={async () => undefined}
    />,
  );
}

function makeBitacoraApi(entries: LogEntry[]): BitacoraApi {
  return {
    getLog: vi.fn().mockResolvedValue(entries),
    exportPaymentsCsv: vi.fn().mockResolvedValue(''),
    exportLogCsv: vi.fn().mockResolvedValue(''),
    exportReportMd: vi.fn().mockResolvedValue(''),
  };
}

describe('QA: Expediente document tabs', () => {
  it('associates both tabs with their panels and preserves the original and marked text views', () => {
    renderExpediente(makeExpediente());

    const originalTab = screen.getByRole('tab', { name: 'Documento original' });
    const textTab = screen.getByRole('tab', { name: 'Texto que leyó el agente' });
    const originalPanel = document.getElementById(originalTab.getAttribute('aria-controls')!)!;
    const textPanel = screen.getByRole('tabpanel', { name: 'Texto que leyó el agente' });

    expect(originalTab.getAttribute('aria-controls')).toBe(originalPanel.id);
    expect(textTab.getAttribute('aria-controls')).toBe(textPanel.id);
    expect(originalPanel.getAttribute('aria-labelledby')).toBe(originalTab.id);
    expect(textPanel.getAttribute('aria-labelledby')).toBe(textTab.id);
    expect(originalPanel.hidden).toBe(true);
    expect(textPanel.hidden).toBe(false);
    expect(originalTab.tabIndex).toBe(-1);
    expect(textTab.tabIndex).toBe(0);
    expect(textPanel.querySelector('mark.extracted')?.textContent).toBe('4412');
    expect(textPanel.querySelector('mark.suspect')?.textContent).toBe('Paga de inmediato.');

    fireEvent.click(originalTab);
    expect(originalTab.getAttribute('aria-selected')).toBe('true');
    expect(originalTab.tabIndex).toBe(0);
    expect(originalPanel.hidden).toBe(false);
    expect(within(originalPanel).getByTitle('Documento original de AL-042')).toBeTruthy();
    expect(textPanel.hidden).toBe(true);
  });

  it('moves focus and selection with wrapping arrows and Home/End', () => {
    renderExpediente(makeExpediente());

    const originalTab = screen.getByRole('tab', { name: 'Documento original' });
    const textTab = screen.getByRole('tab', { name: 'Texto que leyó el agente' });

    textTab.focus();
    fireEvent.keyDown(textTab, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(originalTab);
    expect(originalTab.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(originalTab, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(textTab);
    expect(textTab.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(textTab, { key: 'Home' });
    expect(document.activeElement).toBe(originalTab);
    expect(originalTab.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(originalTab, { key: 'End' });
    expect(document.activeElement).toBe(textTab);
    expect(textTab.getAttribute('aria-selected')).toBe('true');
  });

  it('shows the original image when the source is an image', () => {
    const expediente = makeExpediente();
    expediente.row.sourceKind = 'image';
    renderExpediente(expediente);

    fireEvent.click(screen.getByRole('tab', { name: 'Documento original' }));
    expect(screen.getByRole('img', { name: 'Documento original de AL-042' })).toBeTruthy();
  });

  it('uses unique tab and panel IDs across multiple expediente instances', () => {
    const expediente = makeExpediente();
    render(
      <>
        <Expediente expediente={expediente} loading={false} error={null} busy={false} onApprove={async () => undefined} onReject={async () => undefined} onResolveFlag={async () => undefined} onReevaluate={async () => undefined} />
        <Expediente expediente={expediente} loading={false} error={null} busy={false} onApprove={async () => undefined} onReject={async () => undefined} onResolveFlag={async () => undefined} onReevaluate={async () => undefined} />
      </>,
    );

    const tabs = screen.getAllByRole('tab');
    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(4);
    expect(new Set(panels.map((panel) => panel.id)).size).toBe(4);
    expect(new Set(tabs.map((tab) => tab.getAttribute('aria-controls'))).size).toBe(4);
  });

  it('keeps approval controls gated by the existing required fields', () => {
    const expediente = makeExpediente();
    expediente.row.status = 'approval_required';
    expediente.record = {
      id: 'record-1',
      invoiceId: expediente.row.id,
      decision: {
        status: 'approval_required',
        checks: [],
        flags: [],
        canApprove: true,
        headline: 'Requiere tu aprobación.',
        nextStep: null,
        amountUsdMinor: 85000,
        contractId: 'contract-1',
        costCenter: 'operaciones',
      },
      rulesSnapshot: {
        version: 3,
        perPaymentLimitUsdMinor: 1000000,
        monthlyLimitUsdMinor: 5000000,
        approvalThresholdUsdMinor: 300000,
        fuzzyDuplicateWindowDays: 60,
        preset: 'equilibrado',
      },
      dataVersions: { vendor: 1, contract: 1, fxDate: '2026-10-16' },
      jev: { ok: false, error: 'missing_recording' },
      seal: '8f3a1c',
      createdAt: '2026-10-16T21:14:00.000Z',
    };
    renderExpediente(expediente);

    const approve = screen.getByRole('button', { name: 'Aprobar' });
    const reject = screen.getByRole('button', { name: 'Rechazar' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect((reject as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Tu nombre/), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Confirmé el cambio' } });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    expect((reject as HTMLButtonElement).disabled).toBe(false);
  });

  it('requires and submits the image account last four digits before approval', () => {
    const expediente = makeExpediente();
    expediente.row.status = 'approval_required';
    expediente.row.sourceKind = 'image';
    expediente.record = {
      id: 'record-image',
      invoiceId: expediente.row.id,
      decision: {
        status: 'approval_required', checks: [], flags: [], canApprove: true,
        headline: 'Requiere tu aprobación.', nextStep: null, amountUsdMinor: 85000,
        contractId: 'contract-1', costCenter: 'operaciones',
      },
      rulesSnapshot: {
        version: 3, perPaymentLimitUsdMinor: 1000000, monthlyLimitUsdMinor: 5000000,
        approvalThresholdUsdMinor: 300000, fuzzyDuplicateWindowDays: 60, preset: 'equilibrado',
      },
      dataVersions: { vendor: 1, contract: 1, fxDate: '2026-10-16' },
      jev: { ok: true, answers: {}, latencyMs: 0, recorded: true, inputTokens: 1 },
      seal: '8f3a1c', createdAt: '2026-10-16T21:14:00.000Z',
    };
    const onApprove = vi.fn(async () => undefined);
    vi.stubGlobal('crypto', { randomUUID: () => 'image-approval-key' });
    render(
      <Expediente
        expediente={expediente} loading={false} error={null} busy={false}
        onApprove={onApprove} onReject={async () => undefined}
        onResolveFlag={async () => undefined} onReevaluate={async () => undefined}
      />,
    );

    const approve = screen.getByRole('button', { name: 'Aprobar' }) as HTMLButtonElement;
    const accountDigits = screen.getByLabelText(/Últimos 4 dígitos de la cuenta visible en la imagen/);
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Tu nombre/), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Revisé la imagen' } });
    fireEvent.change(accountDigits, { target: { value: '889' } });
    expect(approve.disabled).toBe(true);
    fireEvent.change(accountDigits, { target: { value: '8890' } });
    expect(approve.disabled).toBe(false);

    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ accountLast4: '8890' }));
  });
});

describe('QA: Bitácora empty state', () => {
  it('explains how to create the first record without adding an inert action', async () => {
    render(<Bitacora api={makeBitacoraApi([])} />);

    const message = await screen.findByText(/Aún no hay registros en la bitácora/);
    expect(message.textContent).toContain('Ve a Bandeja, recibe una factura de prueba y pulsa Procesar para crear el primer registro.');
    expect(within(message).queryByRole('button')).toBeNull();
    expect(within(message).queryByRole('link')).toBeNull();
  });

  it('keeps existing records visible without the empty-state guidance', async () => {
    render(<Bitacora api={makeBitacoraApi([{
      at: '2026-10-16T21:01:00.000Z',
      invoiceId: 'AL-042',
      status: 'approved',
      headline: 'Aprobada por Ana',
      seal: '8f3a1c',
      by: 'Ana',
    }])} />);

    expect(await screen.findByText('Aprobada por Ana')).toBeTruthy();
    expect(screen.queryByText(/Ve a Bandeja, recibe una factura de prueba/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Lote de pagos autorizados (CSV para Blinka)' })).toBeTruthy();
  });
});
