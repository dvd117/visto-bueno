import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { DecisionAction, Expediente as ExpedienteData, FlagResolution, InvoiceRow, WorkspaceSummary } from '../../shared/api';
import {
  ApiRequestError,
  approveInvoice,
  createInvoice,
  getExpediente,
  getInvoices,
  getWorkspace,
  processInvoices,
  reevaluateInvoice,
  rejectInvoice,
  resetWorkspace,
  resolveFlag,
} from '../lib/api';
import { Bandeja } from '../features/bandeja/Bandeja';
import { Counters } from '../features/bandeja/Counters';
import { Expediente } from '../features/expediente/Expediente';
import './app.css';

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
  const [processing, setProcessing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [rowRevisions, setRowRevisions] = useState<Record<string, number>>({});
  const [toast, setToast] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const selectedStatus = rows.find((row) => row.id === selectedId)?.status;
  const detailKey = JSON.stringify([selectedId, selectedStatus]);
  const detailError = detailFailure?.key === detailKey ? detailFailure.message : null;
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
      await processInvoices({ mode: 'replay' }, (event) => {
        if (event.type === 'decided') {
          setRows((current) => replaceRow(current, event.row));
          setWorkspace((current) => current ? { ...current, counters: event.counters } : current);
          setRowRevisions((current) => ({ ...current, [event.row.id]: (current[event.row.id] ?? 0) + 1 }));
        } else if (event.type === 'error') {
          showToast(event.message);
        } else {
          setWorkspace((current) => current ? { ...current, lastRun: event.stats } : current);
        }
      });
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setProcessing(false);
    }
  }, [processing, showToast]);

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

  const handleFileSelection = (event: ChangeEvent<HTMLInputElement>) => {
    void handleDropFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  };

  const handleReset = useCallback(async () => {
    if (actionBusy || processing) return;
    setActionBusy(true);
    try {
      await resetWorkspace();
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
      <main className="frame">
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
            <a href="#inbox" aria-current="page">Bandeja</a>
            <a href="#reglas">Reglas</a>
            <a href="#datos">Preparar datos</a>
            <a href="#bitacora">Bitácora</a>
          </nav>
          <div className="header-actions">
            <input
              ref={fileInput}
              className="visually-hidden"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              multiple
              aria-label="Seleccionar facturas ficticias"
              onChange={handleFileSelection}
            />
            <button className="button button-primary" type="button" disabled={actionBusy} onClick={() => fileInput.current?.click()}>
              + Recibir factura
            </button>
            <button className="button button-secondary" type="button" disabled={actionBusy || processing} onClick={() => void handleReset()}>
              Reiniciar demo
            </button>
          </div>
        </header>

        {connectionError ? (
          <section className="offline-state" role="alert">
            <p className="eyebrow">Bandeja no disponible</p>
            <h2>No pude conectar con el servidor</h2>
            <p>Las facturas y sus decisiones no están disponibles. No se muestran datos de ejemplo.</p>
            <button className="button button-primary" type="button" onClick={() => void loadWorkspace(true)}>Intentar de nuevo</button>
          </section>
        ) : loading ? (
          <p className="page-loading" role="status">Conectando con el servidor…</p>
        ) : displayedWorkspace ? (
          <>
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
                onReceive={() => fileInput.current?.click()}
                onDropFiles={(files) => void handleDropFiles(files)}
              />
              <Expediente
                key={`${selectedId ?? 'empty'}:${expediente?.row.status ?? ''}:${expediente?.record?.id ?? ''}`}
                expediente={expediente}
                loading={detailLoading}
                error={detailError}
                busy={actionBusy || processing}
                onApprove={handleApprove}
                onReject={handleReject}
                onResolveFlag={handleResolveFlag}
                onReevaluate={handleReevaluate}
              />
            </div>
          </>
        ) : null}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
