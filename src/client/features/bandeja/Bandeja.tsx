import { useState } from 'react';
import type { Counters, InvoiceRow } from '../../../shared/api';
import type { InvoiceStatus, SourceKind } from '../../../shared/domain/types';
import { StatusChip } from '../../app/StatusChip';
import { formatDueDate } from '../../lib/format-due-date';
import type { CounterFilter } from './Counters';

interface BandejaProps {
  rows: InvoiceRow[];
  selectedId: string | null;
  counters: Counters;
  processing: boolean;
  rowRevisions: Record<string, number>;
  filter?: CounterFilter | null;
  onSelect: (id: string) => void;
  onProcess: () => void;
  onReceive?: () => void;
  onDropFiles: (files: File[]) => void;
}

type GroupStatus = Exclude<InvoiceStatus, 'queued'>;

interface StateGroup {
  status: GroupStatus;
  plural: string;
  openByDefault: boolean;
}

const stateGroups: StateGroup[] = [
  { status: 'stopped', plural: 'Frenadas', openByDefault: true },
  { status: 'review_required', plural: 'Requieren revisión', openByDefault: true },
  { status: 'approval_required', plural: 'Requieren tu aprobación', openByDefault: true },
  { status: 'stale', plural: 'Desactualizadas', openByDefault: true },
  { status: 'ready', plural: 'Listas para pagar', openByDefault: false },
  { status: 'approved', plural: 'Aprobadas', openByDefault: true },
  { status: 'rejected', plural: 'Rechazadas', openByDefault: true },
];

const sourceLabels: Record<SourceKind, string> = {
  pdf: 'PDF',
  image: 'Imagen',
  text: 'Texto',
};

function newestReceivedFirst(left: InvoiceRow, right: InvoiceRow): number {
  const difference = Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
  return Number.isFinite(difference) && difference !== 0
    ? difference
    : right.id.localeCompare(left.id);
}

export function Bandeja({
  rows,
  selectedId,
  counters,
  processing,
  rowRevisions,
  filter = null,
  onSelect,
  onProcess,
  onReceive,
  onDropFiles,
}: BandejaProps) {
  const [dropTarget, setDropTarget] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const queuedRows = rows.filter((row) => row.status === 'queued').sort(newestReceivedFirst);
  const groupedRows = new Map<GroupStatus, InvoiceRow[]>(stateGroups.map(({ status }) => [status, []]));
  for (const row of rows) {
    if (row.status !== 'queued') groupedRows.get(row.status)?.push(row);
  }
  for (const groupRows of groupedRows.values()) groupRows.sort(newestReceivedFirst);

  const queued = queuedRows.length > 0;
  const visibleCount = filter
    ? groupedRows.get(filter)?.length ?? 0
    : rows.length;

  function toggleExpanded(status: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  function renderInvoiceRow(row: InvoiceRow, index: number) {
    return (
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
          <span className="invoice-source">{sourceLabels[row.sourceKind]}</span>
          <span className="invoice-reason">{row.reason}</span>
        </span>
        <span className="invoice-region" aria-label="País del proveedor · moneda de la factura">
          {row.country ?? '—'} · {row.currency ?? '—'}
        </span>
        <span className="invoice-value">
          <strong>{row.amount}</strong>
          {row.amountUsd && <span>{row.amountUsd}</span>}
          {row.fxDate && <span className="invoice-fx-date">Tasa ilustrativa · {row.fxDate}</span>}
        </span>
        <span className="invoice-state">
          <StatusChip
            status={row.status}
            subtitle={row.subtitle}
            animate={Boolean(rowRevisions[row.id])}
            delay={index % 4 * 0.06}
            revision={rowRevisions[row.id] ?? 0}
          />
          {row.due && <span className="invoice-due">Vence {formatDueDate(row.due)}</span>}
        </span>
      </button>
    );
  }

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
            <span>Factura / concepto</span><span>País · moneda · selecciona una fila para abrir el expediente</span>
          </div>
          {filter === null && queuedRows.length > 0 && (
            <section className="arrival-section" aria-labelledby="arrival-heading">
              <p className="eyebrow">Recibir factura</p>
              <h3 id="arrival-heading" className="arrival-heading">Antes de procesar</h3>
              <p className="section-description">Las facturas recién recibidas aparecen aquí antes de evaluarse.</p>
              <div className="group-rows" data-expanded={expandedGroups.has('queued')}>
                {queuedRows.map(renderInvoiceRow)}
              </div>
              {queuedRows.length > 2 && (
                <button
                  type="button"
                  className="more-rows"
                  data-hide-on-desktop={queuedRows.length === 3}
                  aria-expanded={expandedGroups.has('queued')}
                  onClick={() => toggleExpanded('queued')}
                >
                  {expandedGroups.has('queued') ? 'Mostrar menos' : `Ver las ${queuedRows.length} facturas`}
                </button>
              )}
            </section>
          )}
          {stateGroups.some(({ status }) => (groupedRows.get(status)?.length ?? 0) > 0) && (
            <p className="eyebrow list-stage-heading">Después de procesar</p>
          )}
          <div className="state-groups" aria-label="Facturas por estado">
            {stateGroups.map((group) => {
              const groupRows = groupedRows.get(group.status) ?? [];
              if (groupRows.length === 0 || (filter !== null && filter !== group.status)) return null;
              const isExpanded = expandedGroups.has(group.status);
              return (
                <details
                  className={`state-group state-group-${group.status}`}
                  data-state={group.status}
                  key={group.status}
                  open={filter ? filter === group.status : group.openByDefault}
                >
                  <summary>
                    <span className="group-title">
                      <StatusChip status={group.status} announce={false} />
                      <span>{group.plural}</span>
                    </span>
                    <span className="group-count">{groupRows.length}</span>
                  </summary>
                  <div className="group-rows" data-expanded={isExpanded}>
                    {groupRows.map(renderInvoiceRow)}
                  </div>
                  {groupRows.length > 2 && (
                    <button
                      type="button"
                      className="more-rows"
                      data-hide-on-desktop={groupRows.length === 3}
                      aria-expanded={isExpanded}
                      onClick={() => toggleExpanded(group.status)}
                    >
                      {isExpanded ? 'Mostrar menos' : `Ver las ${groupRows.length} facturas`}
                    </button>
                  )}
                </details>
              );
            })}
          </div>
          {visibleCount === 0 && <p className="empty-filter" role="status">No hay facturas en este estado.</p>}
          <div className="list-footer">
            <span>{filter ? `${visibleCount} ${visibleCount === 1 ? 'factura filtrada' : 'facturas filtradas'}` : `${rows.length} ${rows.length === 1 ? 'factura' : 'facturas'} · ${counters.queued} en cola`}</span>
            <span>Arrastra archivos aquí</span>
          </div>
        </>
      )}
    </section>
  );
}
