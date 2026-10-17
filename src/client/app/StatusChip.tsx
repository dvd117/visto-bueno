import { motion, useReducedMotion } from 'motion/react';
import type { InvoiceStatus } from '../../shared/domain/types';

const statusText: Record<InvoiceStatus, { glyph: string; label: string; tone: string }> = {
  ready: { glyph: '✓', label: 'Lista para pagar', tone: 'ready' },
  approval_required: { glyph: '▣', label: 'Requiere tu aprobación', tone: 'approval' },
  review_required: { glyph: '?', label: 'Requiere revisión', tone: 'review' },
  stopped: { glyph: '×', label: 'Frenada', tone: 'stopped' },
  queued: { glyph: '·', label: 'En cola', tone: 'quiet' },
  approved: { glyph: '✓', label: 'Aprobada', tone: 'ready' },
  rejected: { glyph: '×', label: 'Rechazada', tone: 'stopped' },
  stale: { glyph: '↻', label: 'Desactualizada', tone: 'quiet' },
};

interface StatusChipProps {
  status: InvoiceStatus;
  large?: boolean;
  animate?: boolean;
  delay?: number;
  revision?: number;
}

export function StatusChip({ status, large = false, animate = false, delay = 0, revision = 0 }: StatusChipProps) {
  const reduceMotion = useReducedMotion();
  const { glyph, label, tone } = statusText[status];
  const className = `status-chip status-${tone}${large ? ' status-large' : ''}`;

  if (animate && !reduceMotion) {
    return (
      <motion.span
        key={`${status}-${revision}`}
        role="status"
        aria-label={label}
        className={className}
        initial={{ opacity: 0, y: -2 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, delay, ease: [0.23, 1, 0.32, 1] }}
      >
        <span className="status-glyph" aria-hidden="true">{glyph}</span>
        <span>{label}</span>
      </motion.span>
    );
  }

  return (
    <span role="status" aria-label={label} className={className}>
      <span className="status-glyph" aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  );
}
