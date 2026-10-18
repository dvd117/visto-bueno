import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAction, Expediente as ExpedienteData, FlagResolution, LogEntry } from '../../src/shared/api';
import type { CheckResult, ExtractionClaims, JevAnswer, JevAnswers } from '../../src/shared/domain/types';
import { Bitacora, type BitacoraApi } from '../../src/client/features/bitacora/Bitacora';
import { Expediente } from '../../src/client/features/expediente/Expediente';
import { mapJev } from '../../src/shared/engine/jev-map';
import { verifyClaims } from '../../src/shared/engine/verify';

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
      rows={[expediente.row]}
      selectedStatus={expediente.row.status}
      expediente={expediente}
      loading={false}
      error={null}
      busy={false}
      includedInPaymentBatch
      onApprove={async (_action: DecisionAction) => undefined}
      onReject={async (_action: DecisionAction) => undefined}
      onResolveFlag={async (_flagId: string, _resolution: FlagResolution) => undefined}
      onReevaluate={async () => undefined}
      onSelectStatus={() => undefined}
      onTogglePaymentBatch={() => undefined}
      onOpenData={() => undefined}
    />,
  );
}

function makeExpedienteWithChecks(invoiceId: string, checks: CheckResult[]): ExpedienteData {
  const expediente = makeExpediente();
  expediente.row.id = invoiceId;
  expediente.row.status = 'review_required';
  expediente.record = {
    id: `record-${invoiceId}`,
    invoiceId,
    decision: {
      status: 'review_required', checks, flags: [], canApprove: false,
      headline: 'Requiere tu aprobación.', nextStep: null,
      amountUsdMinor: null, contractId: null, costCenter: null,
    },
    rulesSnapshot: {
      version: 1, perPaymentLimitUsdMinor: 1_000_000, monthlyLimitUsdMinor: 5_000_000,
      approvalThresholdUsdMinor: 300_000, fuzzyDuplicateWindowDays: 60, preset: 'equilibrado',
    },
    dataVersions: { fxDate: '2026-10-16' }, jev: { ok: false, error: 'timeout' },
    seal: '8f3a1c', createdAt: '2026-10-16T21:14:00.000Z',
  };
  return expediente;
}

const noul = (n: number): JevAnswer => ({ type: 'noul', noul: n });
const score = (top: number, confidence: number): JevAnswer => ({
  type: 'score', score: top, confidence,
  probabilities: { '0': top === 0 ? 0.9 : 0.05, '1': top === 1 ? 0.9 : 0.05, '2': top === 2 ? 0.9 : 0.05 },
});
const choice = (value: string, confidence: number): JevAnswer => ({
  type: 'choice', choice: value, confidence, probabilities: { [value]: confidence },
});

function firedReviewChecks() {
  const answers: Extract<JevAnswers, { ok: true }> = {
    ok: true,
    answers: {
      instructs_agent: noul(0.5), artificial_urgency: noul(0.5),
      scope_match: score(1, 0.9), fuzzy_duplicate: noul(0.5),
      document_type: choice('otro', 0.99),
    },
    latencyMs: 1, recorded: true, inputTokens: 20,
  };
  return mapJev(answers, 'equilibrado', { fuzzy: true });
}

function ambiguousAmountCheck(): CheckResult {
  const claims: ExtractionClaims = {
    amountsFound: ['USD 1?00'], accountsFound: [], taxIdsFound: [], invoiceIdsFound: [], currenciesFound: ['USD'],
    payeeName: null, payeeTaxId: null, payoutAccount: null, invoiceId: null,
    invoiceDate: null, dueDate: null, currency: 'USD', amountRaw: 'USD 1?00',
    subtotalRaw: null, taxesRaw: null, quantity: null, rateRaw: null, description: 'Hosting',
    documentTypeHint: 'factura', hasMultipleCurrenciesShown: false, evidenceQuotes: {}, suspiciousPassages: [],
  };
  return verifyClaims({ ok: true, claims, sourceText: 'Total USD 1?00', sourceKind: 'text' }, [])
    .checks.find(({ id }) => id === 'ambiguous_amount')!;
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
  it('renders the 15 fired risk signals as accessible alerts, never as pending checks', () => {
    const fired = firedReviewChecks();
    const ambiguousAmount = ambiguousAmountCheck();
    const pairs = [
      ['AL-042', 'instructs_agent'], ['AL-044', 'instructs_agent'],
      ['AL-045', 'instructs_agent'], ['AL-046', 'instructs_agent'],
      ['AL-039', 'artificial_urgency'], ['AL-042', 'artificial_urgency'],
      ['AL-044', 'artificial_urgency'], ['AL-045', 'artificial_urgency'],
      ['AL-045', 'fuzzy_duplicate'], ['AL-046', 'fuzzy_duplicate'],
      ['AL-049', 'fuzzy_duplicate'], ['AL-044', 'document_type'],
      ['AL-037', 'scope_match'], ['AL-049', 'scope_match'],
      ['AL-047', 'ambiguous_amount'],
    ] as const;

    expect(pairs).toHaveLength(15);
    for (const invoiceId of new Set(pairs.map(([id]) => id))) {
      const checks = pairs.filter(([id]) => id === invoiceId).map(([, checkId]) => (
        checkId === 'ambiguous_amount'
          ? ambiguousAmount
          : fired.find(({ id }) => id === checkId)!
      ));
      expect(checks.every(({ effect }) => effect === 'review')).toBe(true);
      renderExpediente(makeExpedienteWithChecks(invoiceId, checks));

      for (const check of checks) {
        const title = screen.getByText(`${check.label} · Alerta`);
        const row = title.closest('li');
        const glyph = row?.querySelector('.trail-glyph');
        expect(glyph?.textContent).toBe('!');
        expect(glyph?.getAttribute('aria-label')).toBe('Alerta');
        expect(row?.textContent).not.toContain('Pendiente');
      }
      cleanup();
    }
  });

  it('renders pending and not-applicable trail outcomes with distinct glyphs and labels', () => {
    const expediente = makeExpediente();
    expediente.row.status = 'review_required';
    expediente.record = {
      id: 'record-trail',
      invoiceId: expediente.row.id,
      decision: {
        status: 'review_required',
        checks: [
          {
            id: 'R2', kind: 'rule', label: 'Cuenta bancaria registrada', passed: true,
            outcome: 'pending', effect: 'none', reason: 'La cuenta de la factura coincide con la cuenta registrada.',
          },
          {
            id: 'image_confirmation', kind: 'verify', label: 'Confirmación visual', passed: false,
            outcome: 'pending', effect: 'approval', reason: 'Confirma los datos contra la imagen.',
          },
          {
            id: 'jev_unavailable', kind: 'judgment', label: 'Evaluación JEV no disponible', passed: false,
            outcome: 'pending', effect: 'review', reason: 'No pude completar la evaluación.',
          },
          {
            id: 'scope_match', kind: 'judgment', label: 'Coincidencia con el alcance', passed: true,
            outcome: 'not_applicable', effect: 'none', reason: 'No hay un acuerdo único vigente.',
          },
        ],
        flags: [], canApprove: false, headline: 'Requiere tu aprobación.', nextStep: null,
        amountUsdMinor: null, contractId: null, costCenter: null,
      },
      rulesSnapshot: {
        version: 1, perPaymentLimitUsdMinor: 1_000_000, monthlyLimitUsdMinor: 5_000_000,
        approvalThresholdUsdMinor: 300_000, fuzzyDuplicateWindowDays: 60, preset: 'equilibrado',
      },
      dataVersions: { fxDate: '2026-10-16' }, jev: { ok: false, error: 'timeout' },
      seal: '8f3a1c', createdAt: '2026-10-16T21:14:00.000Z',
    };

    renderExpediente(expediente);

    expect(screen.getByText('Cuenta bancaria registrada · Pendiente')).toBeTruthy();
    expect(screen.getByText('No se pudo verificar una sola cuenta bancaria contra un registro.')).toBeTruthy();
    expect(screen.queryByText('La cuenta de la factura coincide con la cuenta registrada.')).toBeNull();
    expect(screen.getByText('Confirmación visual · Pendiente')).toBeTruthy();
    expect(screen.getByText('Evaluación JEV no disponible · Pendiente')).toBeTruthy();
    expect(screen.getByText('Coincidencia con el alcance · No aplica')).toBeTruthy();
    expect(screen.getAllByText('?', { selector: '.trail-glyph' })).toHaveLength(3);
    expect(screen.getByText('—', { selector: '.trail-glyph' })).toBeTruthy();
  });

  it('shows the original amount, USD equivalent, and applied FX date in R15', () => {
    const reason = 'El monto supera el umbral y requiere aprobación humana. Importe original: CLP 3.800.000 · Equivalente USD: USD 4.000,00 · Tasa ilustrativa aplicada (tabla interna): 2026-10-15.';
    const expediente = makeExpedienteWithChecks('REVIEW-CLP-THRESHOLD', [{
      id: 'R15', kind: 'rule', label: 'Umbral de aprobación humana', passed: true,
      outcome: 'passed', effect: 'approval', reason,
    }]);
    expediente.row.status = 'approval_required';
    expediente.row.currency = 'CLP';
    expediente.row.amount = 'CLP 3.800.000';
    expediente.row.amountUsd = 'USD 4.000,00';
    expediente.row.fxDate = '2026-10-15';
    if (!expediente.record) throw new Error('Expected an R15 decision record.');
    expediente.record.decision.status = 'approval_required';
    expediente.record.decision.amountUsdMinor = 400_000;

    renderExpediente(expediente);

    expect(screen.getByText(reason)).toBeTruthy();
  });

  it('associates both tabs with their panels and preserves the original and marked text views', () => {
    renderExpediente(makeExpediente());

    const originalTab = screen.getByRole('tab', { name: 'Documento original' });
    const textTab = screen.getByRole('tab', { name: 'Texto que leyó el agente' });
    const originalPanel = document.getElementById(originalTab.getAttribute('aria-controls')!)!;
    const textPanel = document.getElementById(textTab.getAttribute('aria-controls')!)!;

    expect(originalTab.getAttribute('aria-controls')).toBe(originalPanel.id);
    expect(textTab.getAttribute('aria-controls')).toBe(textPanel.id);
    expect(originalPanel.getAttribute('aria-labelledby')).toBe(originalTab.id);
    expect(textPanel.getAttribute('aria-labelledby')).toBe(textTab.id);
    expect(originalPanel.hidden).toBe(false);
    expect(textPanel.hidden).toBe(true);
    expect(originalTab.tabIndex).toBe(0);
    expect(textTab.tabIndex).toBe(-1);

    fireEvent.click(textTab);
    expect(textPanel.hidden).toBe(false);
    expect(originalPanel.hidden).toBe(true);
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
        <Expediente rows={[expediente.row]} selectedStatus={expediente.row.status} includedInPaymentBatch onSelectStatus={() => undefined} onTogglePaymentBatch={() => undefined} onOpenData={() => undefined} expediente={expediente} loading={false} error={null} busy={false} onApprove={async () => undefined} onReject={async () => undefined} onResolveFlag={async () => undefined} onReevaluate={async () => undefined} />
        <Expediente rows={[expediente.row]} selectedStatus={expediente.row.status} includedInPaymentBatch onSelectStatus={() => undefined} onTogglePaymentBatch={() => undefined} onOpenData={() => undefined} expediente={expediente} loading={false} error={null} busy={false} onApprove={async () => undefined} onReject={async () => undefined} onResolveFlag={async () => undefined} onReevaluate={async () => undefined} />
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

  it('keeps stopped invoices rejectable or correctable, never approvable', () => {
    const expediente = makeExpediente();
    expediente.row.status = 'stopped';
    const onReject = vi.fn(async () => undefined);
    const onOpenData = vi.fn();
    vi.stubGlobal('crypto', { randomUUID: () => 'stopped-rejection-key' });
    render(
      <Expediente
        rows={[expediente.row]} selectedStatus="stopped" expediente={expediente}
        loading={false} error={null} busy={false} includedInPaymentBatch={false}
        onApprove={async () => undefined} onReject={onReject}
        onResolveFlag={async () => undefined} onReevaluate={async () => undefined}
        onSelectStatus={() => undefined} onTogglePaymentBatch={() => undefined} onOpenData={onOpenData}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Rechazar' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Tu nombre/), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Motivo de rechazo'), { target: { value: 'La cuenta no coincide' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preparar datos' }));
    expect(onOpenData).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar' }));
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ approver: 'Ana', reason: 'La cuenta no coincide' }));
  });

  it('routes correction-only review flags away from an API action that must fail', () => {
    const expediente = makeExpedienteWithChecks('AL-042', []);
    expediente.record!.decision.flags = [{
      id: 'flag-account', checkId: 'source_payoutAccount', reason: 'No se pudo confirmar la cuenta en el documento.',
    }];
    renderExpediente(expediente);

    expect(screen.queryByLabelText('Decisión sobre esta alerta')).toBeNull();
    expect(screen.getByText('Corrige este dato en Preparar datos y vuelve a evaluar; esta alerta no se resuelve manualmente.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preparar datos' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-evaluar esta factura' })).toBeTruthy();
  });

  it('shows include or hold only for a ready invoice', () => {
    const expediente = makeExpediente();
    expediente.row.status = 'ready';
    const onTogglePaymentBatch = vi.fn();
    render(
      <Expediente
        rows={[expediente.row]} selectedStatus="ready" expediente={expediente}
        loading={false} error={null} busy={false} includedInPaymentBatch
        onApprove={async () => undefined} onReject={async () => undefined}
        onResolveFlag={async () => undefined} onReevaluate={async () => undefined}
        onSelectStatus={() => undefined} onTogglePaymentBatch={onTogglePaymentBatch} onOpenData={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retirar del lote' }));
    expect(onTogglePaymentBatch).toHaveBeenCalledWith('AL-042');
    expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
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
        rows={[expediente.row]}
        selectedStatus={expediente.row.status}
        expediente={expediente} loading={false} error={null} busy={false}
        includedInPaymentBatch={false}
        onApprove={onApprove} onReject={async () => undefined}
        onResolveFlag={async () => undefined} onReevaluate={async () => undefined}
        onSelectStatus={() => undefined} onTogglePaymentBatch={() => undefined} onOpenData={() => undefined}
      />,
    );

    const approve = screen.getByRole('button', { name: 'Aprobar' }) as HTMLButtonElement;
    const reject = screen.getByRole('button', { name: 'Rechazar' }) as HTMLButtonElement;
    const accountDigits = screen.getByLabelText(/Últimos 4 dígitos de la cuenta visible en la imagen/);
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Tu nombre/), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Revisé la imagen' } });
    expect(reject.disabled).toBe(true);
    fireEvent.change(accountDigits, { target: { value: '889' } });
    expect(approve.disabled).toBe(true);
    fireEvent.change(accountDigits, { target: { value: '8890' } });
    expect(approve.disabled).toBe(false);
    expect(reject.disabled).toBe(false);

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
