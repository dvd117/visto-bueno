import { useEffect, useId } from 'react';
import './first-run-hint.css';

interface FirstRunHintProps {
  open: boolean;
  onDismiss: () => void;
  onOpenData?: () => void;
  onOpenRules?: () => void;
  onReceiveInvoice?: () => void;
}

export function FirstRunHint({
  open,
  onDismiss,
  onOpenData,
  onOpenRules,
  onReceiveInvoice,
}: FirstRunHintProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onDismiss();
    };

    document.addEventListener('keydown', dismissOnEscape);
    return () => document.removeEventListener('keydown', dismissOnEscape);
  }, [open, onDismiss]);

  if (!open) return null;

  const steps = [
    { label: 'Preparar datos', onActivate: onOpenData },
    { label: 'Revisar reglas', onActivate: onOpenRules },
    { label: 'Recibir una factura', onActivate: onReceiveInvoice },
  ];

  return (
    <section
      className="first-run-hint"
      role="region"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className="first-run-content">
        <p className="first-run-eyebrow">Primeros pasos</p>
        <h2 id={titleId}>Orientación de inicio</h2>
        <p id={descriptionId} className="first-run-description">
          <span>Andina Labs paga a 10 proveedores en 5 países. Tú revisas las excepciones antes de decidir; Visto Bueno no hace pagos.</span>{' '}
          <span>Solo deja una factura lista para pagar si cumple tus reglas; si no, te pregunta.</span>
        </p>
        <ol className="first-run-steps">
          {steps.map(({ label, onActivate }) => (
            <li key={label}>
              {onActivate ? (
                <button className="first-run-action" type="button" onClick={onActivate}>{label}</button>
              ) : label}
            </li>
          ))}
        </ol>
      </div>
      <button
        className="first-run-close"
        type="button"
        aria-label="Cerrar orientación inicial"
        onClick={onDismiss}
      >
        Cerrar
      </button>
    </section>
  );
}
