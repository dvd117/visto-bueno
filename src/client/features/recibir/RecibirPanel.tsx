import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from 'react';
import type { InvoiceRow, ProcessEvent, ProcessRequest } from '../../../shared/api';
import { invoiceTemplates } from '../../../shared/templates';
import './recibir.css';

export interface RecibirApi {
  createInvoiceText(text: string): Promise<InvoiceRow>;
  createInvoiceFile(file: File): Promise<InvoiceRow>;
  process(ids: ProcessRequest['ids'], mode: NonNullable<ProcessRequest['mode']>): AsyncIterable<ProcessEvent>;
}

interface RecibirPanelProps {
  open: boolean;
  onClose: () => void;
  api: RecibirApi;
}

const rateLimitMessage = 'Límite del demo alcanzado, intenta en un minuto';

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return typeof error.status === 'number' ? error.status : undefined;
  }

  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (getHttpStatus(error) === 429) return rateLimitMessage;
  if (error instanceof Error && error.message) return error.message;
  return 'No pude enviar la factura. Intenta de nuevo.';
}

function isSupportedFile(file: File): boolean {
  const extension = file.name.toLowerCase().split('.').pop();
  return file.type === 'application/pdf'
    || file.type.startsWith('image/')
    || extension === 'pdf'
    || ['png', 'jpg', 'jpeg', 'webp'].includes(extension ?? '');
}

export function RecibirPanel({ open, onClose, api }: RecibirPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  if (!open) return null;

  async function runProcess(ids: string[] | undefined, mode: 'replay' | 'live') {
    for await (const event of api.process(ids, mode)) {
      if (event.type === 'error') setError(event.message);
    }
  }

  async function submitText(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || busy) return;

    setBusy(true);
    setError(null);
    try {
      const invoice = await api.createInvoiceText(text);
      await runProcess([invoice.id], 'live');
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitFile(file: File) {
    if (busy) return;
    if (!isSupportedFile(file)) {
      setError('El archivo debe ser un PDF o una imagen.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const invoice = await api.createInvoiceFile(file);
      await runProcess([invoice.id], 'live');
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function processExamples() {
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      await runProcess(undefined, 'replay');
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void submitFile(file);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void submitFile(file);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
    );
    if (!focusable?.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="recibir-overlay">
      <section
        aria-labelledby="recibir-title"
        aria-modal="true"
        className="recibir-panel"
        onKeyDown={handleKeyDown}
        ref={panelRef}
        role="dialog"
      >
        <header className="recibir-header">
          <div>
            <p className="recibir-eyebrow">03 / ENTRADA Y CLASIFICACIÓN</p>
            <h2 id="recibir-title">Recibir facturas</h2>
          </div>
          <button autoFocus className="recibir-secondary" onClick={onClose} type="button">
            Cerrar panel
          </button>
        </header>

        <p className="recibir-warning">Demo con datos de prueba. No subas facturas reales.</p>

        {error && <p className="recibir-error" role="alert">{error}</p>}

        <section aria-labelledby="recibir-examples-title" className="recibir-section">
          <h3 id="recibir-examples-title">Facturas de ejemplo</h3>
          <p className="recibir-help">Procesa el set de ejemplo con respuestas grabadas.</p>
          <button className="recibir-secondary recibir-wide" disabled={busy} onClick={() => void processExamples()} type="button">
            Cargar facturas de ejemplo
          </button>
        </section>

        <section aria-labelledby="recibir-upload-title" className="recibir-section">
          <h3 id="recibir-upload-title">Subir un archivo</h3>
          <div
            aria-label="Zona para soltar facturas"
            className="recibir-dropzone"
            data-dragging={dragging}
            onDragLeave={() => setDragging(false)}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDrop={handleDrop}
            role="region"
          >
            <p>Suelta aquí un PDF o una imagen, o elige un archivo.</p>
            <label className="recibir-file-label" htmlFor="recibir-file">Seleccionar PDF o imagen</label>
            <input
              accept=".pdf,image/*"
              className="recibir-file-input"
              disabled={busy}
              id="recibir-file"
              onChange={handleFileChange}
              type="file"
            />
          </div>
        </section>

        <section aria-labelledby="recibir-templates-title" className="recibir-section">
          <h3 id="recibir-templates-title">Pruebas en vivo</h3>
          <div className="recibir-live-label">Modo en vivo</div>
          <p className="recibir-help">Elige una plantilla para editarla antes de enviarla.</p>
          <div className="recibir-template-list">
            {invoiceTemplates.map((template) => (
              <button
                className="recibir-template-button"
                key={template.id}
                onClick={() => setText(template.content)}
                type="button"
              >
                {template.label}
              </button>
            ))}
          </div>

          <form className="recibir-form" onSubmit={(event) => void submitText(event)}>
            <label htmlFor="recibir-text">Texto de la factura</label>
            <textarea
              id="recibir-text"
              onChange={(event) => setText(event.currentTarget.value)}
              value={text}
            />
            <button
              className="recibir-primary recibir-wide"
              disabled={busy || !text.trim()}
              type="submit"
            >
              {busy ? 'Enviando…' : 'Enviar y evaluar en vivo'}
            </button>
          </form>
        </section>
      </section>
    </div>
  );
}
