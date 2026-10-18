import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EvaluationResult } from '../lib/api-types';
import type {
  ClientDirectory, CompanyRecord, DecisionAction, Expediente as ExpedienteData, FlagResolution, InvoiceRow,
  ProcessEvent, ProcessRequest, WorkspaceSummary,
} from '../../shared/api';
import type { InvoiceStatus } from '../../shared/domain/types';
import {
  ApiRequestError,
  beginClientContextSwitch,
  bitacoraApi,
  approveInvoice,
  createInvoice,
  datosApi,
  getClients,
  getCompany,
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
  switchClient,
} from '../lib/api';
import { Bandeja } from '../features/bandeja/Bandeja';
import { Counters } from '../features/bandeja/Counters';
import { ActionBar } from '../features/expediente/ActionBar';
import { Expediente } from '../features/expediente/Expediente';
import { Evaluacion } from '../features/evaluacion/Evaluacion';
import { FirstRunHint } from '../features/ayuda/FirstRunHint';
import { ClientSwitcher } from './ClientSwitcher';
import type { RecibirApi } from '../features/recibir/RecibirPanel';
import './app.css';

type AppSection = 'inbox' | 'reglas' | 'datos' | 'bitacora' | 'evaluacion';
type ActionableStatus = Extract<InvoiceStatus, 'ready' | 'approval_required' | 'review_required' | 'stopped'>;
interface ReceiveGeneration { reset: number; client: number }

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
  const [company, setCompany] = useState<CompanyRecord | null>(null);
  const [clientDirectory, setClientDirectory] = useState<ClientDirectory | null>(null);
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [heldReadyIds, setHeldReadyIds] = useState<Set<string>>(() => new Set());
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
  const [clientSwitching, setClientSwitching] = useState(false);
  const [activeSection, setActiveSection] = useState<AppSection>('inbox');
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [rowRevisions, setRowRevisions] = useState<Record<string, number>>({});
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);
  const resetOutcome = useRef<Promise<boolean> | null>(null);
  const resetGeneration = useRef(0);
  const clientContextGeneration = useRef(0);
  const receiptGenerations = useRef(new Map<string, ReceiveGeneration>());
  const clientSwitchInProgress = useRef(false);
  const selectedStatus = rows.find((row) => row.id === selectedId)?.status;
  const detailKey = JSON.stringify([selectedId, selectedStatus]);
  const detailError = detailFailure?.key === detailKey ? detailFailure.message : null;
  const selectedExpediente = expediente?.row.id === selectedId ? expediente : null;
  const detailLoading = Boolean(selectedId && !connectionError && !detailError && (
    !expediente || expediente.row.id !== selectedId || expediente.row.status !== selectedStatus
  ));

  const loadWorkspace = useCallback(async (showLoading: boolean) => {
    if (clientSwitchInProgress.current) return;
    const generation = clientContextGeneration.current;
    if (showLoading) setLoading(true);
    try {
      // Discover the active client before loading client-scoped data so the
      // API wrapper can pin every subsequent request to this tab's context.
      const directory = await getClients();
      if (generation !== clientContextGeneration.current) return;
      const [summary, invoices, profile] = await Promise.all([
        getWorkspace(), getInvoices(), getCompany().catch(() => null),
      ]);
      if (generation !== clientContextGeneration.current) return;
      setConnectionError(null);
      setWorkspace(summary);
      setCompany(profile);
      setClientDirectory(directory);
      setRows(invoices);
      setSelectedId((current) => current && invoices.some((row) => row.id === current)
        ? current
        : invoices[0]?.id ?? null);
    } catch (error) {
      if (generation !== clientContextGeneration.current) return;
      setWorkspace(null);
      setCompany(null);
      setClientDirectory(null);
      setRows([]);
      setSelectedId(null);
      setExpediente(null);
      setConnectionError(errorMessage(error));
    } finally {
      if (generation === clientContextGeneration.current) setLoading(false);
    }
  }, []);

  const handleClientSwitch = useCallback(async (clientId: string) => {
    if (clientSwitching || actionBusy || processing) return;
    clientSwitchInProgress.current = true;
    beginClientContextSwitch();
    const generation = ++clientContextGeneration.current;
    setClientSwitching(true);
    setLoading(true);
    setConnectionError(null);
    setWorkspace(null);
    setCompany(null);
    setClientDirectory(null);
    setRows([]);
    setHeldReadyIds(new Set());
    setSelectedId(null);
    setExpediente(null);
    setDetailFailure(null);
    setDetailRevision((current) => current + 1);
    setEvaluationResult(null);
    setEvaluationLoading(false);
    setEvaluationError(null);
    setRowRevisions({});
    setActiveSection('inbox');
    setFirstRunOpen(false);
    setReceiveOpen(false);
    setHelpOpen(false);
    setToast('');
    try {
      await switchClient(clientId);
      if (generation !== clientContextGeneration.current) return;
      clientSwitchInProgress.current = false;
      await loadWorkspace(true);
    } catch (error) {
      if (generation === clientContextGeneration.current) setConnectionError(errorMessage(error));
    } finally {
      if (generation === clientContextGeneration.current) {
        clientSwitchInProgress.current = false;
        setClientSwitching(false);
        setLoading(false);
      }
    }
  }, [actionBusy, clientSwitching, loadWorkspace, processing]);

  const openEvaluation = useCallback(() => {
    if (clientSwitching) return;
    setActiveSection('evaluacion');
    setEvaluationLoading(true);
    setEvaluationError(null);
    void getEvaluation()
      .then(setEvaluationResult)
      .catch((error: unknown) => setEvaluationError(errorMessage(error)))
      .finally(() => setEvaluationLoading(false));
  }, [clientSwitching]);

  const dismissFirstRun = useCallback(() => {
    setFirstRunOpen(false);
    try {
      window.localStorage.setItem(FIRST_RUN_DISMISSED_KEY, 'true');
    } catch {
      // Keep the in-memory dismissal even when browser storage is unavailable.
    }
  }, []);

  const openReceive = useCallback(() => {
    if (!clientSwitching) setReceiveOpen(true);
  }, [clientSwitching]);
  const openHelp = useCallback(() => {
    if (!clientSwitching) setHelpOpen(true);
  }, [clientSwitching]);
  const openData = useCallback(() => {
    if (clientSwitching) return;
    setActiveSection('datos');
    void loadWorkspace(false);
  }, [clientSwitching, loadWorkspace]);
  const openRules = useCallback(() => {
    if (!clientSwitching) setActiveSection('reglas');
  }, [clientSwitching]);

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

  const shouldDiscardReceive = useCallback(async (generation: ReceiveGeneration) => {
    while (true) {
      const outcome = resetOutcome.current;
      if (!outcome) break;
      if (await outcome) return true;
      if (resetOutcome.current === outcome) break;
    }
    return generation.reset !== resetGeneration.current || generation.client !== clientContextGeneration.current;
  }, []);

  const receiveInvalidationError = useCallback((generation: ReceiveGeneration) => new ApiRequestError(
    generation.client !== clientContextGeneration.current
      ? 'Cambiaste de cliente durante la carga; vuelve a enviarla si aún la necesitas.'
      : 'La demo se reinició durante la carga; vuelve a enviarla si aún la necesitas.',
    409,
  ), []);

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

  const selectActionState = useCallback((status: ActionableStatus) => {
    const firstInvoice = rows.find((row) => row.status === status);
    if (firstInvoice) selectInvoice(firstInvoice.id);
  }, [rows, selectInvoice]);

  const togglePaymentBatch = useCallback((invoiceId: string) => {
    setHeldReadyIds((current) => {
      const next = new Set(current);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else next.add(invoiceId);
      return next;
    });
  }, []);

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
      const generation = { reset: resetGeneration.current, client: clientContextGeneration.current };
      const row = await createInvoice({ text });
      if (await shouldDiscardReceive(generation)) {
        throw receiveInvalidationError(generation);
      }
      receiptGenerations.current.set(row.id, generation);
      setRows((current) => replaceRow(current, row));
      setSelectedId(row.id);
      setExpediente(null);
      setDetailFailure(null);
      return row;
    },
    async createInvoiceFile(file) {
      const generation = { reset: resetGeneration.current, client: clientContextGeneration.current };
      const row = await createInvoice(file);
      if (await shouldDiscardReceive(generation)) {
        throw receiveInvalidationError(generation);
      }
      receiptGenerations.current.set(row.id, generation);
      setRows((current) => replaceRow(current, row));
      setSelectedId(row.id);
      setExpediente(null);
      setDetailFailure(null);
      return row;
    },
    async *process(request: ProcessRequest) {
      if (processing || resetOutcome.current) throw new ApiRequestError('Ya hay una evaluación o reinicio en curso. Inténtalo al terminar.', 409);
      const requestIds = request.ids ?? [];
      const generations = requestIds
        .map((id) => receiptGenerations.current.get(id))
        .filter((generation): generation is ReceiveGeneration => generation !== undefined);
      const generation = generations[0] ?? { reset: resetGeneration.current, client: clientContextGeneration.current };
      const mixedGenerations = generations.some((item) => item.reset !== generation.reset || item.client !== generation.client);
      if (mixedGenerations || await shouldDiscardReceive(generation)) {
        for (const id of requestIds) receiptGenerations.current.delete(id);
        throw receiveInvalidationError(generation);
      }
      for (const id of requestIds) receiptGenerations.current.delete(id);
      setProcessing(true);
      try {
        yield* processInvoiceEvents(request, (event) => {
          if (generation.reset === resetGeneration.current && generation.client === clientContextGeneration.current) {
            handleProcessEvent(event);
          }
        });
      } finally {
        setProcessing(false);
        if (generation.reset === resetGeneration.current && generation.client === clientContextGeneration.current) {
          await loadWorkspace(false);
        }
      }
    },
  }), [handleProcessEvent, loadWorkspace, processing, receiveInvalidationError, shouldDiscardReceive]);

  const handleDropFiles = useCallback(async (files: File[]) => {
    if (files.length === 0 || actionBusy) return;
    const generation = { reset: resetGeneration.current, client: clientContextGeneration.current };
    setActionBusy(true);
    try {
      let firstId: string | null = null;
      for (const file of files) {
        const row = await createInvoice(file);
        if (await shouldDiscardReceive(generation)) return;
        firstId ??= row.id;
        setRows((current) => replaceRow(current, row));
      }
      if (await shouldDiscardReceive(generation)) return;
      if (firstId) setSelectedId(firstId);
      await loadWorkspace(false);
      showToast('Factura recibida. Pulsa Procesar para iniciar su revisión.');
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, loadWorkspace, shouldDiscardReceive, showToast]);

  const handleReset = useCallback(async () => {
    if (actionBusy || processing || clientSwitching || resetOutcome.current) return;
    let settleResetOutcome!: (succeeded: boolean) => void;
    const pendingReset = new Promise<boolean>((resolve) => { settleResetOutcome = resolve; });
    resetOutcome.current = pendingReset;
    setActionBusy(true);
    try {
      await resetWorkspace();
      // Only a successful server reset invalidates uploads started in the old workspace.
      resetGeneration.current += 1;
      settleResetOutcome(true);
      setActiveSection('inbox');
      setSelectedId(null);
      setHeldReadyIds(new Set());
      setExpediente(null);
      setDetailFailure(null);
      setDetailRevision((current) => current + 1);
      await loadWorkspace(true);
      showToast('Demo reiniciada.');
    } catch (error) {
      settleResetOutcome(false);
      showToast(errorMessage(error));
    } finally {
      resetOutcome.current = null;
      setActionBusy(false);
    }
  }, [actionBusy, clientSwitching, loadWorkspace, processing, showToast]);

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
      <div className={`frame${activeSection === 'inbox' && !loading && !connectionError ? ' frame-with-action-bar' : ''}`}>
        <div className="demo-banner" role="note">Modo demostración · No se realizan pagos reales</div>
        <header className="masthead">
          <div className="brandline">
            <a className="wordmark" href="#inbox" aria-label="Visto Bueno">visto.bueno</a>
            <span className="masthead-divider" aria-hidden="true" />
            <div className="company-line">
              {clientDirectory ? (
                <ClientSwitcher
                  clients={clientDirectory.clients}
                  activeId={clientDirectory.activeId}
                  activeCompanyName={company?.name ?? displayedWorkspace?.company.name ?? 'Cargando cliente…'}
                  disabled={clientSwitching || actionBusy || processing || loading}
                  onSwitch={handleClientSwitch}
                />
              ) : (
                <h1>{company?.name ?? displayedWorkspace?.company.name ?? 'Cargando cliente…'}</h1>
              )}
              <span className="fictional-tag">Datos ficticios</span>
            </div>
          </div>
          <nav className="navigation" aria-label="Secciones">
            <a href="#inbox" aria-current={activeSection === 'inbox' ? 'page' : undefined} onClick={(event) => {
              event.preventDefault(); if (clientSwitching) return; setActiveSection('inbox'); void loadWorkspace(false);
            }}>Bandeja</a>
            <a href="#reglas" aria-current={activeSection === 'reglas' ? 'page' : undefined} onClick={(event) => {
              event.preventDefault(); if (clientSwitching) return; setActiveSection('reglas');
            }}>Reglas</a>
            <a href="#datos" aria-current={activeSection === 'datos' ? 'page' : undefined} onClick={(event) => {
              event.preventDefault(); if (clientSwitching) return; setActiveSection('datos'); void loadWorkspace(false);
            }}>Preparar datos</a>
            <a href="#bitacora" aria-current={activeSection === 'bitacora' ? 'page' : undefined} onClick={(event) => {
              event.preventDefault(); if (clientSwitching) return; setActiveSection('bitacora'); void loadWorkspace(false);
            }}>Bitácora</a>
            <a href="#evaluacion" aria-current={activeSection === 'evaluacion' ? 'page' : undefined} onClick={(event) => {
              event.preventDefault(); if (clientSwitching) return; openEvaluation();
            }}>Evaluación</a>
          </nav>
          <div className="header-actions">
            <button className="button button-secondary" type="button" disabled={clientSwitching} onClick={openHelp}>
              Cómo decide
            </button>
            <button className="button button-primary" type="button" disabled={actionBusy || processing || clientSwitching} onClick={openReceive}>
              + Recibir factura
            </button>
            <button className="button button-secondary" type="button" disabled={actionBusy || processing || clientSwitching} onClick={() => void handleReset()}>
              Reiniciar demo
            </button>
          </div>
        </header>

        <FirstRunHint
          open={firstRunOpen && !clientSwitching}
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
                rows={rows}
                selectedStatus={selectedStatus ?? null}
                expediente={selectedExpediente}
                loading={detailLoading}
                error={detailError}
                busy={actionBusy || processing}
                includedInPaymentBatch={selectedExpediente?.row.status === 'ready' && !heldReadyIds.has(selectedExpediente.row.id)}
                onApprove={handleApprove}
                onReject={handleReject}
                onResolveFlag={handleResolveFlag}
                onReevaluate={handleReevaluate}
                onSelectStatus={selectActionState}
                onTogglePaymentBatch={togglePaymentBatch}
                onOpenData={openData}
              />
            </div>
          </main> : activeSection === 'reglas' ? <Suspense fallback={<main><p role="status">Cargando reglas…</p></main>}><Reglas api={reglasApi} /></Suspense>
            : activeSection === 'datos' ? <Suspense fallback={<main><p role="status">Cargando datos…</p></main>}><Datos api={datosApi} /></Suspense>
            : activeSection === 'evaluacion' ? <Evaluacion result={evaluationResult} loading={evaluationLoading} error={evaluationError} />
              : <main><Suspense fallback={<p role="status">Cargando bitácora…</p>}><Bitacora api={bitacoraApi} /></Suspense></main>
        ) : null}
        {!connectionError && !loading && activeSection === 'inbox' && displayedWorkspace && (
          <ActionBar invoices={rows} heldReadyIds={heldReadyIds} busy={actionBusy || processing} />
        )}
      </div>
      <Suspense fallback={null}>
        <RecibirPanel open={receiveOpen} onClose={() => setReceiveOpen(false)} api={receivingApi} />
        <ComoDecide open={helpOpen} onClose={() => setHelpOpen(false)} />
      </Suspense>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
