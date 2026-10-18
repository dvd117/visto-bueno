import { useState } from 'react';
import type { InvoiceRow } from '../../../shared/api';
import { exportPaymentBatchCsv, getExportGeneration, isExportGenerationCurrent } from '../../lib/api';

interface ActionBarProps {
  invoices: InvoiceRow[];
  heldReadyIds: ReadonlySet<string>;
  busy: boolean;
}

type ExportKind = 'payments' | 'reconciliation';

function downloadText(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ActionBar({ invoices, heldReadyIds, busy }: ActionBarProps) {
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readyIds = invoices
    .filter((invoice) => invoice.status === 'ready' && !heldReadyIds.has(invoice.id))
    .map((invoice) => invoice.id);
  const approvedCount = invoices.filter((invoice) => invoice.status === 'approved').length;
  const batchCount = readyIds.length + approvedCount;

  async function exportCsv(kind: ExportKind, filename: string): Promise<void> {
    const generation = getExportGeneration();
    setError(null);
    setExporting(kind);
    try {
      const content = await exportPaymentBatchCsv(kind, readyIds);
      if (!isExportGenerationCurrent(generation)) return;
      downloadText(filename, content);
    } catch {
      setError('No pude descargar el archivo. Inténtalo de nuevo.');
    } finally {
      setExporting(null);
    }
  }

  return (
    <aside className="action-bar" role="region" aria-label="Lote de pago">
      <div className="action-bar-summary">
        <strong>Lote elegible · {batchCount} {batchCount === 1 ? 'factura' : 'facturas'}</strong>
        <span>Solo Lista para pagar y facturas ya aprobadas. {approvedCount} aprobadas.</span>
        <span>Las excepciones se resuelven una por una. Ninguna se aprueba en lote.</span>
        {error && <span className="action-bar-error" role="alert">{error}</span>}
      </div>
      <div className="action-bar-actions">
        <button
          className="button button-primary"
          type="button"
          disabled={busy || exporting !== null || batchCount === 0}
          onClick={() => { void exportCsv('payments', 'lote-de-pago.csv'); }}
        >
          {exporting === 'payments' ? 'Preparando archivo…' : `Exportar lote de pago (${batchCount})`}
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy || exporting !== null || batchCount === 0}
          onClick={() => { void exportCsv('reconciliation', 'conciliacion-lote.csv'); }}
        >
          {exporting === 'reconciliation' ? 'Preparando archivo…' : 'Exportar conciliación (CSV)'}
        </button>
      </div>
    </aside>
  );
}
