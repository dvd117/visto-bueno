import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { DecisionAction, Expediente as ExpedienteData, FlagResolution } from '../../../shared/api';
import type { CheckResult, Flag } from '../../../shared/domain/types';
import { StatusChip } from '../../app/StatusChip';

interface ExpedienteProps {
  expediente: ExpedienteData | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onApprove: (action: DecisionAction) => Promise<void>;
  onReject: (action: DecisionAction) => Promise<void>;
  onResolveFlag: (flagId: string, resolution: FlagResolution) => Promise<void>;
  onReevaluate: () => Promise<void>;
}

type DocumentMode = 'original' | 'text';

function formatProbability(value: number): string {
  return value.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function CheckSource({ check }: { check: CheckResult }) {
  if (check.kind !== 'judgment' || check.probability === undefined) {
    return <span className="trail-source">Regla</span>;
  }
  const probability = Math.max(0, Math.min(1, check.probability));
  const percent = Math.round(probability * 100);
  return (
    <span className="trail-source judgment-source">
      <span>Juicio · JEV {formatProbability(probability)}</span>
      <span className="probability-track" role="progressbar" aria-label="Confianza del juicio" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

function Comparison({ data }: { data: ExpedienteData }) {
  const differenceCount = data.comparison.filter((item) => item.differs && item.invoice !== null && item.record !== null).length;
  const missingRecordCount = data.comparison.filter((item) => item.record === null).length;
  const missingInvoiceCount = data.comparison.filter((item) => item.invoice === null).length;
  return (
    <>
      <div className="section-heading">
        <h3 id="comparison-heading">Comparación con tus registros</h3>
        <span className="section-note">
          {differenceCount} {differenceCount === 1 ? 'diferencia' : 'diferencias'}
          {missingRecordCount > 0 && ` · ${missingRecordCount} sin registro`}
          {missingInvoiceCount > 0 && ` · ${missingInvoiceCount} sin dato en factura`}
          {' · '}{data.comparison.length} {data.comparison.length === 1 ? 'campo' : 'campos'}
        </span>
      </div>
      {data.comparison.length === 0 ? <p className="quiet-note">Todavía no hay una comparación registrada.</p> : (
      <div className="comparison" role="table" aria-labelledby="comparison-heading">
        <div className="compare-head" role="row">
          <div role="columnheader">Dato</div>
          <div role="columnheader">En la factura</div>
          <div role="columnheader">En tus registros</div>
        </div>
        {data.comparison.map((item) => (
          <div className={`compare-row${item.differs && item.invoice !== null && item.record !== null ? ' different' : ''}`} role="row" key={item.field}>
            <div className="compare-key" role="rowheader">{item.field}</div>
            <div className="compared-value" role="cell">
              {item.invoice ?? 'Sin dato'}
              {item.differs && item.invoice !== null && item.record !== null && <span className="difference-tag">No coincide</span>}
            </div>
            <div className="compared-value" role="cell">
              {item.record ?? 'Sin registro'}
              {item.differs && item.invoice !== null && item.record !== null && <span className="difference-tag">No coincide</span>}
            </div>
          </div>
        ))}
      </div>
      )}
    </>
  );
}

function renderMarkedText(text: string, marks: ExpedienteData['marks']) {
  const usableMarks = marks.filter((mark) => mark.text.length > 0);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  while (cursor < text.length) {
    let match: { index: number; text: string; kind: 'value' | 'suspicious' } | undefined;
    for (const mark of usableMarks) {
      const index = text.indexOf(mark.text, cursor);
      if (index < 0) continue;
      if (!match || index < match.index || (index === match.index && mark.text.length > match.text.length)) {
        match = { index, text: mark.text, kind: mark.kind };
      }
    }
    if (!match) {
      nodes.push(text.slice(cursor));
      break;
    }
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    nodes.push(
      <mark key={key++} className={match.kind === 'value' ? 'extracted' : 'suspect'}>
        {match.text}
      </mark>,
    );
    cursor = match.index + match.text.length;
  }
  return nodes;
}

function DecisionTrail({ checks }: { checks: CheckResult[] }) {
  if (checks.length === 0) return <p className="quiet-note">No hay comprobaciones registradas.</p>;
  return (
    <ul className="trail-list">
      {checks.map((check) => {
        const alert = check.effect === 'review';
        const passed = check.passed && !alert;
        const glyph = alert ? '!' : passed ? '✓' : '×';
        const stateLabel = alert ? 'Alerta' : passed ? 'Cumple' : 'No cumple';
        return (
          <li className={`trail-row${alert ? ' trail-alert' : passed ? ' trail-pass' : ' trail-fail'}`} key={check.id}>
            <span className="trail-glyph" aria-label={stateLabel}>{glyph}</span>
            <span className="trail-check">
              <strong>{check.label}</strong>
              <span>{check.reason}</span>
            </span>
            <CheckSource check={check} />
          </li>
        );
      })}
    </ul>
  );
}

function FlagActions({
  flag,
  approver,
  busy,
  onResolve,
}: {
  flag: Flag;
  approver: string;
  busy: boolean;
  onResolve: (choice: string, reason: string) => void;
}) {
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  if (flag.resolution) {
    return <p className="resolved-flag"><span aria-hidden="true">✓</span> Resuelta por {flag.resolution.by} · {flag.resolution.reason}</p>;
  }
  return (
    <div className="flag-action">
      <label>
        Decisión sobre esta alerta
        <select value={choice} onChange={(event) => setChoice(event.target.value)}>
          <option value="">Selecciona una opción</option>
          <option value="not_applicable">La alerta no aplica</option>
          <option value="confirmed">La alerta sí aplica</option>
        </select>
      </label>
      <label>
        Motivo
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
      </label>
      <button
        className="button button-secondary"
        type="button"
        disabled={busy || !approver.trim() || !choice || !reason.trim()}
        onClick={() => onResolve(choice, reason.trim())}
      >
        Guardar resolución
      </button>
    </div>
  );
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('es-VE', { dateStyle: 'medium', timeStyle: 'short' });
}

function safeFileUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/files/')) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function Expediente({
  expediente,
  loading,
  error,
  busy,
  onApprove,
  onReject,
  onResolveFlag,
  onReevaluate,
}: ExpedienteProps) {
  const [documentMode, setDocumentMode] = useState<DocumentMode>('text');
  const [approver, setApprover] = useState('');
  const [reason, setReason] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const documentTabsId = useId();
  const originalTabRef = useRef<HTMLButtonElement>(null);
  const textTabRef = useRef<HTMLButtonElement>(null);
  const originalTabId = `${documentTabsId}-original-tab`;
  const textTabId = `${documentTabsId}-text-tab`;
  const originalPanelId = `${documentTabsId}-original-panel`;
  const textPanelId = `${documentTabsId}-text-panel`;

  function handleDocumentTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: DocumentMode) {
    let next: DocumentMode | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      next = current === 'original' ? 'text' : 'original';
    } else if (event.key === 'Home') {
      next = 'original';
    } else if (event.key === 'End') {
      next = 'text';
    }
    if (!next) return;

    event.preventDefault();
    setDocumentMode(next);
    (next === 'original' ? originalTabRef : textTabRef).current?.focus();
  }

  if (loading) return <section className="panel expediente"><p className="record-loading">Abriendo expediente…</p></section>;
  if (error) return <section className="panel expediente"><p className="record-error">{error}</p></section>;
  if (!expediente) {
    return (
      <section id="expediente" className="panel expediente" aria-labelledby="record-empty-title">
        <article className="record">
          <div className="record-meta">
            <span className="eyebrow">02 / Expediente · Decisión trazable</span>
          </div>
          <div className="record-lede">
            <div>
              <h2 id="record-empty-title" className="record-vendor">Expediente de factura</h2>
              <p className="record-reason">
                Selecciona una factura en la bandeja para revisar sus datos, comprobaciones y decisión.
              </p>
            </div>
          </div>
        </article>
      </section>
    );
  }

  const { row, record } = expediente;
  const decision = record?.decision;
  const canApprove = row.status === 'approval_required' && decision?.canApprove === true;
  const canSubmitDecision = Boolean(approver.trim() && reason.trim()) && !busy;
  const fileUrl = safeFileUrl(expediente.fileUrl);

  const decisionAction = (): DecisionAction => ({
    approver: approver.trim(),
    reason: reason.trim(),
    idempotencyKey: crypto.randomUUID(),
  });

  return (
    <section id="expediente" className="panel expediente" aria-labelledby="record-title">
      <article className="record">
        <div className="record-meta">
          <span className="eyebrow">02 / Expediente · Decisión trazable</span>
          <span className="record-id">{row.id}{record && ` · ${dateLabel(record.createdAt)}`}</span>
        </div>
        <div className="record-lede">
          <div>
            <h2 id="record-title" className="record-vendor">{row.payee}</h2>
            <p className="record-reason">{decision?.headline ?? row.reason}</p>
          </div>
          <StatusChip status={row.status} large />
        </div>

        {row.status === 'stopped' && (
          <aside className="action-box" aria-label="Qué hacer">
            <div>
              <p className="action-label">Qué hacer</p>
              <p className="action-copy">{decision?.nextStep ?? row.reason}</p>
            </div>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void onReevaluate()}>
              Re-evaluar esta factura
            </button>
          </aside>
        )}
        {row.status === 'stale' && (
          <aside className="stale-note" role="note">
            <strong>Desactualizada</strong>
            <span>Cambiaron las reglas o los datos. Re-evalúa antes de decidir.</span>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void onReevaluate()}>
              Re-evaluar esta factura
            </button>
          </aside>
        )}

        <section className="record-section" aria-labelledby="comparison-heading">
          <Comparison data={expediente} />
        </section>

        <section className="record-section" aria-labelledby="trail-heading">
          <div className="section-heading"><h3 id="trail-heading">Trazabilidad de la decisión</h3></div>
          {decision ? <DecisionTrail checks={decision.checks} /> : <p className="quiet-note">Procesa esta factura para iniciar las comprobaciones.</p>}
          {record && !record.jev.ok && <p className="connection-note">JEV no conectado · no se aprobará automáticamente.</p>}
        </section>

        <section className="record-section document-section" aria-labelledby="document-heading">
          <div className="section-heading"><h3 id="document-heading">Documento</h3></div>
          <div className="document-switch" role="tablist" aria-label="Vista del documento">
            <button
              ref={originalTabRef}
              id={originalTabId}
              type="button"
              role="tab"
              aria-controls={originalPanelId}
              aria-selected={documentMode === 'original'}
              tabIndex={documentMode === 'original' ? 0 : -1}
              onClick={() => setDocumentMode('original')}
              onKeyDown={(event) => handleDocumentTabKeyDown(event, 'original')}
            >
              Documento original
            </button>
            <button
              ref={textTabRef}
              id={textTabId}
              type="button"
              role="tab"
              aria-controls={textPanelId}
              aria-selected={documentMode === 'text'}
              tabIndex={documentMode === 'text' ? 0 : -1}
              onClick={() => setDocumentMode('text')}
              onKeyDown={(event) => handleDocumentTabKeyDown(event, 'text')}
            >
              Texto que leyó el agente
            </button>
          </div>
          <div
            id={originalPanelId}
            role="tabpanel"
            aria-labelledby={originalTabId}
            className="document-surface"
            hidden={documentMode !== 'original'}
            tabIndex={0}
          >
            {documentMode === 'original' ? (
              fileUrl ? (
                row.sourceKind === 'image'
                  ? <img className="original-image" src={fileUrl} alt={`Documento original de ${row.id}`} />
                  : row.sourceKind === 'pdf'
                    ? <iframe className="original-document" src={fileUrl} title={`Documento original de ${row.id}`} />
                    : <p className="quiet-note">No hay un archivo original disponible.</p>
              ) : <p className="quiet-note">No hay un archivo original disponible.</p>
            ) : null}
          </div>
          <div
            id={textPanelId}
            role="tabpanel"
            aria-labelledby={textTabId}
            className="document-surface"
            hidden={documentMode !== 'text'}
            tabIndex={0}
          >
            {documentMode === 'text' ? (
              expediente.sourceText ? (
                <pre className="document-text">{renderMarkedText(expediente.sourceText, expediente.marks)}</pre>
              ) : <p className="quiet-note">No hay texto extraído para mostrar.</p>
            ) : null}
          </div>
        </section>

        {row.status === 'review_required' && (
          <section className="record-section flags-section" aria-labelledby="flags-heading">
            <div className="section-heading"><h3 id="flags-heading">Resuelve cada alerta</h3></div>
            {decision?.flags.length ? decision.flags.map((flag) => (
              <div className="flag-card" key={flag.id}>
                <p className="flag-reason">{flag.reason}</p>
                <FlagActions
                  flag={flag}
                  approver={approver}
                  busy={busy}
                  onResolve={(choice, flagReason) => void onResolveFlag(flag.id, {
                    choice,
                    reason: flagReason,
                    approver: approver.trim(),
                  })}
                />
              </div>
            )) : <p className="quiet-note">El servidor no indicó alertas pendientes.</p>}
            <label className="field-label approver-field">
              Tu nombre <span>(identidad declarada (demo))</span>
              <input value={approver} onChange={(event) => setApprover(event.target.value)} autoComplete="off" />
            </label>
            <label className="field-label">
              Motivo de rechazo
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
            </label>
            <button className="button button-secondary" type="button" disabled={!canSubmitDecision} onClick={() => void onReject(decisionAction())}>
              Rechazar
            </button>
          </section>
        )}

        {row.status === 'approval_required' && (
          <section className="record-section action-section" aria-labelledby="actions-heading">
            <div className="section-heading"><h3 id="actions-heading">Tu decisión</h3></div>
            <label className="field-label">
              Tu nombre <span>(identidad declarada (demo))</span>
              <input value={approver} onChange={(event) => setApprover(event.target.value)} autoComplete="off" />
            </label>
            <label className="field-label">
              Motivo
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
            </label>
            {!decision?.canApprove && <p className="safety-note">Aprobar no está disponible: las comprobaciones determinísticas no lo permiten.</p>}
            <div className="action-buttons">
              <button
                className="button button-primary"
                type="button"
                disabled={!canApprove || !canSubmitDecision}
                onClick={() => void onApprove(decisionAction())}
              >Aprobar</button>
              <button className="button button-secondary" type="button" disabled={!canSubmitDecision} onClick={() => void onReject(decisionAction())}>
                Rechazar
              </button>
            </div>
          </section>
        )}

        <footer className="decision-seal">
          {record ? (
            <>
              <p>Sello #{record.seal} · Reglas v{record.rulesSnapshot.version} · {dateLabel(record.createdAt)}</p>
              <button className="text-button" type="button" aria-expanded={showHistory} onClick={() => setShowHistory((show) => !show)}>
                {showHistory ? 'Ocultar registro completo' : 'Ver registro completo'}
              </button>
              {showHistory && (
                <ol className="record-history">
                  {[...expediente.history, record].map((entry) => (
                    <li key={entry.id}>
                      <span>{entry.decision.status.replaceAll('_', ' ')}</span>
                      <span>Sello #{entry.seal} · {dateLabel(entry.createdAt)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : <p>Sin sello: todavía no hay una decisión registrada.</p>}
        </footer>
      </article>
    </section>
  );
}
