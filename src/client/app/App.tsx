import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EvaluationResult } from '../lib/api-types';
import type { DecisionAction, Expediente as ExpedienteData, FlagResolution, InvoiceRow, ProcessEvent, ProcessRequest, WorkspaceSummary } from '../../shared/api';
import {
  ApiRequestError,
  bitacoraApi,
  approveInvoice,
  createInvoice,
  datosApi,
  getExpediente,
  getEvaluation,
  getInvoices,
  getWorkspace,
  processInvoiceEvents,
  processInvoices,
  reglasApi,
  reevaluateInvoice,
  rejectInvoice,
  resetWorkspace,
  resolveFlag,
} from '../lib/api';
import { Bandeja } from '../features/bandeja/Bandeja';
import { Counters } from '../features/bandeja/Counters';
import { Expediente } from '../features/expediente/Expediente';
import { Evaluacion } from '../features/evaluacion/Evaluacion';
import { FirstRunHint } from '../features/ayuda/FirstRunHint';
import type { RecibirApi } from '../features/recibir/RecibirPanel';
import './app.css';

type AppSection = 'inbox' | 'reglas' | 'datos' | 'bitacora' | 'evaluacion';

const FIRST_RUN_DISMISSED_KEY = 'visto-bueno:first-run-dismissed';

function shouldShowFirstRunHint(): boolean {
  try {
    return window.localStorage.getItem(FIRST_RUN_DISMISSED_KEY) !== 'true';
  } catch {
    return true;
  }
}

const Bitacora = lazy(async () => ({ default: (await import('../features/bitacora/Bitacora')).Bitacora }));
const Datos = lazy(() => import('../features/datos/Datos'));
const RecibirPanel = lazy(async () => ({ default: (await import('../features/recibir/RecibirPanel')).RecibirPanel }));
const ComoDecide = lazy(async () => ({ default: (await import('../features/ayuda/ComoDecide')).ComoDecide }));
const Reglas = lazy(async () => ({ default: (await import('../features/reglas/Reglas')).Reglas }));

function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return 'No pude conectar con el servidor';
  if (error instanceof ApiRequestError) return error.message;
  return 'No pude completar la solicitud.';
}

function replaceRow(rows: InvoiceRow[], nextRow: InvoiceRow): InvoiceRow[] {
  const index = rows.findIndex((row) => row.id === nextRow.id);
  if (index < 0) return [nextRow, ...rows];
  return rows.map((row) => row.id === nextRow.id ? nextRow : row);
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expediente, setExpediente] = useState<ExpedienteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [detailFailure, setDetailFailure] = useState<{ key: string; message: string } | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [evaluationResult, setEvaluationResult] = useState<EvaluationResult | null>(null);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [firstRunOpen, setFirstRunOpen] = useState(shouldShowFirstRunHint);
  const [processing, setProcessing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [activeSection, setActiveSection] = useState<AppSection>('inbox');
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [rowRevisions, setRowRevisions] = useState<Record<string, number>>({});
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);
  const selectedStatus = rows.find((row) => row.id === selectedId)?.status;
  const detailKey = JSON.stringify([selectedId, selectedStatus]);
  const detailError = detailFailure?.key === detailKey ? detailFailure.message : null;
  const selectedExpediente = expediente?.row.id === selectedId ? expediente : null;
  const detailLoading = Boolean(selectedId && !connectionError && !detailError && (
    !expediente || expediente.row.id !== selectedId || expediente.row.status !== selectedStatus
  ));

  const loadWorkspace = useCallback(async (showLoading: boolean) => {
    if (showLoading) setLoading(true);
    try {
      const [summary, invoices] = await Promise.all([getWorkspace(), getInvoices()]);
      setConnectionError(null);
      setWorkspace(summary);
      setRows(invoices);
      setSelectedId((current) => current && invoices.some((row) => row.id === current)
        ? current
        : invoices[0]?.id ?? null);
    } catch (error) {
      setWorkspace(null);
      setRows([]);
      setSelectedId(null);
      setExpediente(null);
      setConnectionError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const openEvaluation = useCallback(() => {
    setActiveSection('evaluacion');
    setEvaluationLoading(true);
    setEvaluationError(null);
    void getEvaluation()
      .then(setEvaluationResult)
      .catch((error: unknown) => setEvaluationError(errorMessage(error)))
      .finally(() => setEvaluationLoading(false));
  }, []);

  const dismissFirstRun = useCallback(() => {
    setFirstRunOpen(false);
    try {
      window.localStorage.setItem(FIRST_RUN_DISMISSED_KEY, 'true');
    } catch {
      // Keep the in-memory dismissal even when browser storage is unavailable.
    }
  }, []);

  const openReceive = useCallback(() => setReceiveOpen(true), []);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const openData = useCallback(() => {
    setActiveSection('datos');
    void loadWorkspace(false);
  }, [loadWorkspace]);
  const openRules = useCallback(() => setActiveSection('reglas'), []);

  useEffect(() => {
    void loadWorkspace(false);
  }, [loadWorkspace]);

  useEffect(() => {
    let active = true;
    if (!selectedId || connectionError) return () => { active = false; };
    getExpediente(selectedId)
      .then((data) => { if (active) setExpediente(data); })
      .catch((error: unknown) => {
        if (active) setDetailFailure({ key: detailKey, message: errorMessage(error) });
      });
    return () => { active = false; };
  }, [selectedId, selectedStatus, connectionError, detailKey, detailRevision]);

  useEffect(() => () => {
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3200);
  }, []);

  const handleProcessEvent = useCallback((event: ProcessEvent) => {
    if (event.type === 'decided') {
      setRows((current) => replaceRow(current, event.row));
      setWorkspace((current) => current ? { ...current, counters: event.counters } : current);
      setRowRevisions((current) => ({ ...current, [event.row.id]: (current[event.row.id] ?? 0) + 1 }));
    } else if (event.type === 'error') {
      showToast(event.message);
    } else {
      setWorkspace((current) => current ? { ...current, lastRun: event.stats } : current);
    }
  }, [showToast]);

  const selectInvoice = useCallback((id: string) => {
    if (id === selectedId) return;
    setSelectedId(id);
    setExpediente(null);
    setDetailFailure(null);
  }, [selectedId]);

  const handleProcess = useCallback(async () => {
    if (processing) return;
    setProcessing(true);
    try {
      await processInvoices({ mode: 'replay' }, handleProcessEvent);
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setProcessing(false);
    }
  }, [processing, handleProcessEvent, showToast]);

  const receivingApi = useMemo<RecibirApi>(() => ({
    async createInvoiceText(text) {
      const row = await createInvoice({ text });
      setRows((current) => replaceRow(current, row));
      setSelectedId(row.id);
      setExpediente(null);
      setDetailFailure(null);
      return row;
    },
    async createInvoiceFile(file) {
      const row = await createInvoice(file);
      setRows((current) => replaceRow(current, row));
      setSelectedId(row.id);
      setExpediente(null);
      setDetailFailure(null);
      return row;
    },
    async *process(request: ProcessRequest) {
      if (processing) throw new ApiRequestError('Ya hay una evaluación en curso. Inténtalo al terminar.', 409);
      setProcessing(true);
      try {
        yield* processInvoiceEvents(request, handleProcessEvent);
      } finally {
        setProcessing(false);
        await loadWorkspace(false);
      }
    },
  }), [handleProcessEvent, loadWorkspace, processing]);

  const handleDropFiles = useCallback(async (files: File[]) => {
    if (files.length === 0 || actionBusy) return;
    setActionBusy(true);
    try {
      let firstId: string | null = null;
      for (const file of files) {
        const row = await createInvoice(file);
        firstId ??= row.id;
        setRows((current) => replaceRow(current, row));
      }
      if (firstId) setSelectedId(firstId);
      await loadWorkspace(false);
      showToast('Factura recibida. Pulsa Procesar para iniciar su revisión.');
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, loadWorkspace, showToast]);

  const handleReset = useCallback(async () => {
    if (actionBusy || processing) return;
    setActionBusy(true);
    try {
      await resetWorkspace();
      setActiveSection('inbox');
      setExpediente(null);
      setDetailFailure(null);
      setDetailRevision((current) => current + 1);
      await loadWorkspace(true);
      showToast('Demo reiniciada.');
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, loadWorkspace, processing, showToast]);

  const withSelectedAction = useCallback(async (
    action: (id: string) => Promise<ExpedienteData>,
    success: string,
  ) => {
    if (!selectedId || actionBusy) return;
    setActionBusy(true);
    try {
      const updated = await action(selectedId);
      setExpediente(updated);
      setRows((current) => replaceRow(current, updated.row));
      await loadWorkspace(false);
      showToast(success);
    } catch (error) {
      const payload = error instanceof ApiRequestError ? error.payload : null;
      if (payload && 'expediente' in payload) {
        setExpediente(payload.expediente);
        setRows((current) => replaceRow(current, payload.expediente.row));
      }
      showToast(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, loadWorkspace, selectedId, showToast]);

  const handleApprove = useCallback((action: DecisionAction) => withSelectedAction(
    (id) => approveInvoice(id, action), 'Aprobación registrada.',
  ), [withSelectedAction]);
  const handleReject = useCallback((action: DecisionAction) => withSelectedAction(
    (id) => rejectInvoice(id, action), 'Rechazo registrado.',
  ), [withSelectedAction]);
  const handleResolveFlag = useCallback((flagId: string, resolution: FlagResolution) => withSelectedAction(
    (id) => resolveFlag(id, flagId, resolution), 'Alerta resuelta.',
  ), [withSelectedAction]);
  const handleReevaluate = useCallback(() => withSelectedAction(
    (id) => reevaluateInvoice(id), 'Factura re-evaluada.',
  ), [withSelectedAction]);

  const displayedWorkspace = workspace;

  return (
    <>
      <div className="frame">
        <div className="demo-banner" role="note">Modo demostración · No se realizan pagos reales</div>
        <header className="masthead">
          <div className="brandline">
            <a className="wordmark" href="#inbox" aria-label="Visto Bueno">visto.bueno</a>
            <span className="masthead-divider" aria-hidden="true" />
            <div className="company-line">
              <h1>{displayedWorkspace?.company.name ?? 'Andina Labs Inc.'}</h1>
              <span className="fictional-tag">Datos ficticios</span>
            </div>
          </div>
          <nav className="navigation" aria-label="Secciones">
            <a href="#inbox" aria-current={activeSection === 'inbox' ? 'page' : undefined} onClick={(event) => {
              event.preventDefault(); setActiveSection('inbox'); void loadWorkspace(false);
            }}>Bandeja</a>
            <a href="#reglas" aria-current={activeSection === 'reglas' ? 'page' : undefined} onClick={(event) => {
              event.preventDefault(); setActiveSection('reglas');
            }}>Reglas</a>
            <a href="#datos" aria-current={activeSection === 'datos' ? 'page' : undefined} onClick={(event) => {
              event.preventDefault(); setActiveSection('datos'); void loadWorkspace(false);
            }}>Preparar datos</a>
            <a href="#bitacora" aria-current={activeSection === 'bitacora' ? 'page' : undefined} onClick={(event) => {
              event.preventDefault(); setActiveSection('bitacora'); void loadWorkspace(false);
            }}>Bitácora</a>
            <a href="#evaluacion" aria-current={activeSection === 'evaluacion' ? 'page' : undefined} onClick={(event) => {
              event.preventDefault(); openEvaluation();
            }}>Evaluación</a>
          </nav>
          <div className="header-actions">
            <button className="button button-secondary" type="button" onClick={openHelp}>
              Cómo decide
            </button>
            <button className="button button-primary" type="button" disabled={actionBusy || processing} onClick={openReceive}>
              + Recibir factura
            </button>
            <button className="button button-secondary" type="button" disabled={actionBusy || processing} onClick={() => void handleReset()}>
              Reiniciar demo
            </button>
          </div>
        </header>

        <FirstRunHint
          open={firstRunOpen}
          onDismiss={dismissFirstRun}
          onOpenData={openData}
          onOpenRules={openRules}
          onReceiveInvoice={openReceive}
        />

        {connectionError ? (
          <main><section className="offline-state" role="alert">
            <p className="eyebrow">Bandeja no disponible</p>
            <h2>No pude conectar con el servidor</h2>
            <p>Las facturas y sus decisiones no están disponibles. No se muestran datos de ejemplo.</p>
            <button className="button button-primary" type="button" onClick={() => void loadWorkspace(true)}>Intentar de nuevo</button>
          </section></main>
        ) : loading ? (
          <main><p className="page-loading" role="status">Conectando con el servidor…</p></main>
        ) : displayedWorkspace ? (
          activeSection === 'inbox' ? <main>
            <Counters counters={displayedWorkspace.counters} lastRun={displayedWorkspace.lastRun} />
            <div className="workspace">
              <Bandeja
                rows={rows}
                selectedId={selectedId}
                counters={displayedWorkspace.counters}
                processing={processing || actionBusy}
                rowRevisions={rowRevisions}
                onSelect={selectInvoice}
                onProcess={() => void handleProcess()}
                onReceive={openReceive}
                onDropFiles={(files) => void handleDropFiles(files)}
              />
              <Expediente
                key={`${selectedId ?? 'empty'}:${selectedExpediente?.row.status ?? ''}:${selectedExpediente?.record?.id ?? ''}`}
                expediente={selectedExpediente}
                loading={detailLoading}
                error={detailError}
                busy={actionBusy || processing}
                onApprove={handleApprove}
                onReject={handleReject}
                onResolveFlag={handleResolveFlag}
                onReevaluate={handleReevaluate}
              />
            </div>
          </main> : activeSection === 'reglas' ? <Suspense fallback={<main><p role="status">Cargando reglas…</p></main>}><Reglas api={reglasApi} /></Suspense>
            : activeSection === 'datos' ? <Suspense fallback={<main><p role="status">Cargando datos…</p></main>}><Datos api={datosApi} /></Suspense>
            : activeSection === 'evaluacion' ? <Evaluacion result={evaluationResult} loading={evaluationLoading} error={evaluationError} />
              : <main><Suspense fallback={<p role="status">Cargando bitácora…</p>}><Bitacora api={bitacoraApi} /></Suspense></main>
        ) : null}
      </div>
      <Suspense fallback={null}>
        <RecibirPanel open={receiveOpen} onClose={() => setReceiveOpen(false)} api={receivingApi} />
        <ComoDecide open={helpOpen} onClose={() => setHelpOpen(false)} />
      </Suspense>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
