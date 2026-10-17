import { useEffect, useId, useRef } from 'react';
import './como-decide.css';

interface GuideEntry {
  label: string;
  text: string;
}

interface GuideSection {
  title: string;
  list: 'ordered' | 'definitions' | 'bulleted';
  entries: readonly GuideEntry[];
}

const notice = 'Borrador para finanzas. Explica el comportamiento previsto. Confirma cada paso en la demo antes de confiar en él; esta guía no sustituye la factura ni los registros de tu empresa.';
const introduction = 'Visto Bueno organiza la revisión de una factura antes de preparar una decisión. No hace pagos.';

const sections: readonly GuideSection[] = [
  {
    title: 'El recorrido: seis pasos',
    list: 'ordered',
    entries: [
      { label: 'Extrae', text: 'Gemini propone el monto, la cuenta, el ID y otros datos. Son afirmaciones, no hechos.' },
      { label: 'Verifica', text: 'El código compara los datos críticos con la fuente y los registros. En PDF y texto, el monto, la cuenta, el ID fiscal y el ID de factura elegidos deben aparecer literalmente en el documento, normalizando espacios. Si falta un dato, pide una factura corregida y evalúa esa versión; un motivo no resuelve una falla de integridad. En una imagen no se puede hacer esta comprobación literal automáticamente: revisa los datos en la imagen. Una factura solo como imagen requiere aprobación humana.' },
      { label: 'Aplica reglas', text: 'El código comprueba proveedor, cuenta, contrato, moneda, importe, fechas, compromisos y límites. Estos controles deterministas son fijos.' },
      { label: 'Consulta señales', text: 'JEV puede señalar dudas sobre alcance, urgencia o posible duplicado. Una probabilidad expresa su juicio sobre esa pregunta; no es la probabilidad de que la factura sea correcta ni una autorización para pagar.' },
      { label: 'Combina', text: 'El código combina los controles y las alertas para decidir el estado. Ni el modelo ni un clic genérico pueden convertir un control fallido en una factura lista o aprobada.' },
      { label: 'Registra', text: 'El código guarda la decisión y su sello. Este registro no ejecuta un pago.' },
    ],
  },
  {
    title: 'Los cuatro estados',
    list: 'definitions',
    entries: [
      { label: 'Lista para pagar', text: 'Pasó todos los controles, no tiene alertas pendientes y está dentro del límite de pago automático. Se incluye en el lote autorizado; eso no significa que esté pagada.' },
      { label: 'Requiere tu aprobación', text: 'Pasó los controles y no tiene alertas, pero necesita autoridad humana, por ejemplo por el monto, una cantidad variable o una imagen. Puedes aprobar o rechazar; en ambos casos, indica un motivo.' },
      { label: 'Requiere revisión', text: 'Hay dudas o alertas por resolver. Aclara cada alerta que admita resolución con una opción y un motivo, o rechaza. Una falla de integridad de la fuente exige corregir la factura y evaluarla de nuevo; no basta con explicar la diferencia.' },
      { label: 'Frenada', text: 'Falló un control de seguridad o se activó un riesgo firme. No hay botón ni motivo que la autorice. Corrige la causa y vuelve a evaluar.' },
    ],
  },
  {
    title: 'Protege el dato bancario',
    list: 'bulleted',
    entries: [
      { label: 'Confirma el cambio', text: 'Si la factura muestra una cuenta distinta a la registrada, confirma el cambio con el proveedor por un canal seguro antes de actualizar sus datos.' },
      { label: 'Actualiza solo si es legítimo', text: 'Si el cambio es legítimo, actualiza la cuenta del proveedor en Preparar datos y vuelve a evaluar. Si la factura tiene la cuenta equivocada, solicita el documento corregido y evalúa esa versión.' },
    ],
  },
  {
    title: 'Reglas, señales y cambios',
    list: 'bulleted',
    entries: [
      { label: 'Sensibilidad', text: 'Estricto, Equilibrado y Permisivo cambian la sensibilidad de las señales de JEV. No relajan los controles de seguridad.' },
      { label: 'Desactualizada', text: 'Si cambian las reglas o los datos del proveedor o contrato, una decisión pendiente puede quedar desactualizada. No se puede aprobar hasta evaluarla otra vez; el registro anterior se conserva.' },
      { label: 'Identidad declarada', text: 'El nombre que escribes al aprobar o resolver una alerta no confirma quién eres ni equivale a una firma autenticada.' },
    ],
  },
  {
    title: 'Alcance del demo',
    list: 'bulleted',
    entries: [
      { label: 'Sin pagos', text: 'El lote es una exportación de compromisos autorizados para el siguiente sistema. No confirma un pago ni inicia una transferencia. Revisa el archivo y procesa los pagos en el sistema financiero correspondiente.' },
    ],
  },
];

function makeMarkdown(): string {
  const formattedSections = sections.map((section) => {
    const entries = section.entries.map(({ label, text }, index) => {
      const prefix = section.list === 'ordered' ? `${index + 1}.` : '-';
      return `${prefix} **${label}.** ${text}`;
    });
    return `## ${section.title}\n\n${entries.join('\n')}`;
  });

  return [
    '# Cómo decide el agente',
    `> ${notice}`,
    introduction,
    ...formattedSections,
  ].join('\n\n');
}

const markdown = makeMarkdown();

function getFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
}

function downloadMarkdown(): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'como-decide.md';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface ComoDecideProps {
  open: boolean;
  onClose: () => void;
}

export function ComoDecide({ open, onClose }: ComoDecideProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const keyboardActivationRef = useRef(false);

  useEffect(() => {
    const markKeyboardActivation = () => { keyboardActivationRef.current = true; };
    const markPointerActivation = () => { keyboardActivationRef.current = false; };
    document.addEventListener('keydown', markKeyboardActivation, true);
    document.addEventListener('pointerdown', markPointerActivation, true);
    return () => {
      document.removeEventListener('keydown', markKeyboardActivation, true);
      document.removeEventListener('pointerdown', markPointerActivation, true);
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusableElements(dialog);
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose]);

  const motion = keyboardActivationRef.current ? 'none' : 'slide';

  return (
    <div
      className="ayuda-overlay"
      data-open={open}
      data-motion={motion}
      aria-hidden={!open}
      inert={!open}
    >
      <section
        ref={dialogRef}
        className="ayuda-sheet"
        role="dialog"
        aria-modal={open}
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="ayuda-header">
          <div>
            <p className="ayuda-eyebrow">Guía de operación</p>
            <h2 id={titleId}>Cómo decide el agente</h2>
          </div>
          <button ref={closeRef} className="ayuda-button ayuda-close" type="button" onClick={onClose}>
            Cerrar panel
          </button>
        </header>

        <main className="ayuda-content">
          <p className="ayuda-notice">{notice}</p>
          <p className="ayuda-introduction">{introduction}</p>

          {sections.map((section) => (
            <section className="ayuda-section" key={section.title}>
              <h3>{section.title}</h3>
              {section.list === 'definitions' ? (
                <dl>
                  {section.entries.map(({ label, text }) => (
                    <div className="ayuda-definition" key={label}>
                      <dt>{label}</dt>
                      <dd>{text}</dd>
                    </div>
                  ))}
                </dl>
              ) : section.list === 'ordered' ? (
                <ol>
                  {section.entries.map(({ label, text }) => (
                    <li key={label}><strong>{label}.</strong> {text}</li>
                  ))}
                </ol>
              ) : (
                <ul>
                  {section.entries.map(({ label, text }) => (
                    <li key={label}><strong>{label}.</strong> {text}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}

          <button className="ayuda-button ayuda-download" type="button" onClick={downloadMarkdown}>
            Descargar guía en Markdown
          </button>
        </main>
      </section>
    </div>
  );
}
