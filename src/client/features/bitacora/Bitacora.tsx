import { useEffect, useState } from 'react';
import type { LogEntry } from '../../../shared/api';
import type { InvoiceStatus } from '../../../shared/domain/types';
import type { BitacoraApi } from '../../lib/api-types';
import { getExportGeneration, isExportGenerationCurrent } from '../../lib/api';
export type { BitacoraApi } from '../../lib/api-types';

interface BitacoraProps {
  api: BitacoraApi;
}

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  queued: 'En espera',
  ready: 'Lista para pagar',
  approval_required: 'Requiere tu aprobación',
  review_required: 'Requiere revisión',
  stopped: 'Frenada',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  stale: 'Desactualizada',
};

const STATUS_GLYPHS: Record<InvoiceStatus, string> = {
  queued: '…',
  ready: '✓',
  approval_required: '▣',
  review_required: '?',
  stopped: '×',
  approved: '✓',
  rejected: '×',
  stale: '↻',
};

const STATUS_CLASSES: Record<InvoiceStatus, string> = {
  queued: 'text-soft',
  ready: 'text-ready',
  approval_required: 'text-approval',
  review_required: 'text-review',
  stopped: 'text-stopped',
  approved: 'text-ready',
  rejected: 'text-stopped',
  stale: 'text-soft',
};

const EXPORTS = [
  { key: 'exportPaymentsCsv', label: 'Lote de pagos autorizados (CSV para Blinka)', filename: 'lote-de-pagos.csv', type: 'text/csv;charset=utf-8' },
  { key: 'exportLogCsv', label: 'Bitácora de auditoría (CSV)', filename: 'bitacora.csv', type: 'text/csv;charset=utf-8' },
  { key: 'exportReportMd', label: 'Informe (Markdown)', filename: 'informe-visto-bueno.md', type: 'text/markdown;charset=utf-8' },
] as const;

type ExportKey = (typeof EXPORTS)[number]['key'];

function orderedEntries(entries: LogEntry[]): LogEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, timestamp: Date.parse(entry.at) }))
    .sort((left, right) => {
      if (Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp) && left.timestamp !== right.timestamp) {
        return left.timestamp - right.timestamp;
      }
      return left.entry.at.localeCompare(right.entry.at) || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('es-VE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function downloadText(filename: string, contentType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Bitacora({ api }: BitacoraProps) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportKey | null>(null);

  useEffect(() => {
    let active = true;
    void api.getLog()
      .then((result) => {
        if (active) setEntries(orderedEntries(result));
      })
      .catch(() => {
        if (active) setError('No pude cargar la bitácora. Inténtalo de nuevo.');
      });
    return () => { active = false; };
  }, [api]);

  async function exportFile(key: ExportKey, filename: string, contentType: string): Promise<void> {
    const generation = getExportGeneration();
    setError(null);
    setExporting(key);
    try {
      const content = await api[key]();
      if (!isExportGenerationCurrent(generation)) return;
      downloadText(filename, contentType, content);
    } catch {
      setError('No pude descargar el archivo. Inténtalo de nuevo.');
    } finally {
      setExporting(null);
    }
  }

  return (
    <section aria-labelledby="bitacora-title" className="space-y-5">
      <header>
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-soft">Registro de decisiones</p>
        <h2 id="bitacora-title" className="text-[21px] font-extrabold tracking-tight text-ink">Bitácora</h2>
      </header>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Exportaciones">
        {EXPORTS.map(({ key, label, filename, type }) => (
          <button
            key={key}
            type="button"
            className="border border-ink px-3 py-2 text-left text-ink hover:bg-wash focus-visible:outline-[3px] focus-visible:outline-offset-[3px] focus-visible:outline-focus disabled:opacity-50"
            disabled={exporting !== null}
            onClick={() => { void exportFile(key, filename, type); }}
          >
            {exporting === key ? 'Preparando archivo…' : label}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="text-stopped">{error}</p>}
      {entries === null && !error && <p role="status" className="text-soft">Cargando bitácora…</p>}
      {entries?.length === 0 && (
        <p className="border-t-[3px] border-line-bold py-4 text-soft">
          Aún no hay registros en la bitácora.{' '}
          Ve a Bandeja, recibe una factura de prueba y pulsa Procesar para crear el primer registro.
        </p>
      )}
      {entries && entries.length > 0 && (
        <ol className="border-t-[3px] border-line-bold">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${entry.invoiceId}-${entry.seal}-${index}`} className="border-b border-line py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em] ${STATUS_CLASSES[entry.status]}`}>
                  <span aria-hidden="true" className="inline-flex h-[17px] w-[17px] items-center justify-center border border-current">
                    {STATUS_GLYPHS[entry.status]}
                  </span>
                  {STATUS_LABELS[entry.status]}
                </p>
                <time className="text-[11px] text-soft" dateTime={entry.at}>{formatTimestamp(entry.at)}</time>
              </div>
              <h3 className="mt-1 text-[14px] font-bold text-ink">{entry.headline}</h3>
              <p className="mt-1 text-[11px] text-faint">Factura {entry.invoiceId}{entry.by ? ` · Responsable: ${entry.by}` : ''}</p>
              <p className="mt-3 border-t border-line-bold pt-2 text-[10px] text-soft">{`Sello #${entry.seal}`}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
