import { useState } from 'react';
import type { Counters, InvoiceRow } from '../../../shared/api';
import { StatusChip } from '../../app/StatusChip';

interface BandejaProps {
  rows: InvoiceRow[];
  selectedId: string | null;
  counters: Counters;
  processing: boolean;
  rowRevisions: Record<string, number>;
  onSelect: (id: string) => void;
  onProcess: () => void;
  onReceive?: () => void;
  onDropFiles: (files: File[]) => void;
}

export function Bandeja({
  rows,
  selectedId,
  counters,
  processing,
  rowRevisions,
  onSelect,
  onProcess,
  onReceive,
  onDropFiles,
}: BandejaProps) {
  const [dropTarget, setDropTarget] = useState(false);
  const queued = rows.some((row) => row.status === 'queued');

  return (
    <section
      id="inbox"
      className={`panel panel-inbox${dropTarget ? ' drop-target' : ''}`}
      aria-labelledby="inbox-heading"
      onDragEnter={(event) => { event.preventDefault(); setDropTarget(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropTarget(false);
        onDropFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="panel-top">
        <div className="panel-toprow">
          <div>
            <p className="eyebrow">01 / Entrada y clasificación</p>
            <h2 id="inbox-heading" className="section-title">Bandeja de facturas</h2>
            <p className="section-description">
              {rows.length === 0 ? 'Recibe una factura ficticia para empezar.' : `${rows.length} ${rows.length === 1 ? 'factura' : 'facturas'} en la bandeja`}
            </p>
          </div>
          <button type="button" className="button button-primary process-button" onClick={onProcess} disabled={processing || !queued}>
            <span aria-hidden="true">↻</span> {processing ? 'Procesando…' : 'Procesar'}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty-list">
          <p className="eyebrow">Sin facturas</p>
          <p>Para empezar, recibe una factura y revisa su expediente.</p>
          {onReceive && (
            <button className="button button-primary empty-receive" type="button" onClick={onReceive}>
              Recibir una factura
            </button>
          )}
        </div>
      ) : (
        <>
      <div className="list-guide">
            <span>Factura / concepto</span><span>Selecciona una fila para abrir su expediente</span>
          </div>
          <div className="invoice-list" aria-label="Facturas">
            {rows.map((row, index) => (
              <button
                type="button"
                className={`invoice-row row-${row.status}`}
                key={row.id}
                aria-pressed={row.id === selectedId}
                onClick={() => onSelect(row.id)}
              >
                <span className="invoice-ordinal">{String(index + 1).padStart(2, '0')}</span>
                <span className="invoice-main">
                  <span className="invoice-id">{row.id}</span>
                  <span className="invoice-name">{row.payee}</span>
                  <span className="invoice-concept">{row.concept}</span>
                  <span className="invoice-reason">{row.reason}</span>
                </span>
                <span className="invoice-value">
                  <strong>{row.amount}</strong>
                  {row.amountUsd && <span>{row.amountUsd}</span>}
                </span>
                <span className="invoice-state">
                  <StatusChip
                    status={row.status}
                    animate={Boolean(rowRevisions[row.id])}
                    delay={index % 4 * 0.06}
                    revision={rowRevisions[row.id] ?? 0}
                  />
                  {row.due && <span className="invoice-due">Vence {row.due}</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="list-footer">
            <span>{rows.length} {rows.length === 1 ? 'factura' : 'facturas'} · {counters.queued} en cola</span>
            <span>Arrastra archivos aquí</span>
          </div>
        </>
      )}
    </section>
  );
}
