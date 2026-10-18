import { useId } from 'react';
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
  subtitle?: string;
  large?: boolean;
  animate?: boolean;
  delay?: number;
  revision?: number;
  announce?: boolean;
  glyphOnly?: boolean;
}

export function StatusChip({ status, subtitle, large = false, animate = false, delay = 0, revision = 0, announce = true, glyphOnly = false }: StatusChipProps) {
  const reduceMotion = useReducedMotion();
  const subtitleId = useId();
  const { glyph, label, tone } = statusText[status];
  const className = `status-chip status-${tone}${large ? ' status-large' : ''}`;
  const content = (
    <>
      <span className="status-label">
        <span className="status-glyph" aria-hidden="true">{glyph}</span>
        {!glyphOnly && <span>{label}</span>}
      </span>
      {subtitle && <span className="status-subtitle" id={subtitleId}>{subtitle}</span>}
    </>
  );
  const statusAttributes = announce ? { role: 'status' as const, 'aria-label': label } : {};

  if (animate && !reduceMotion) {
    return (
      <motion.span
        key={`${status}-${revision}`}
        {...statusAttributes}
        aria-describedby={subtitle ? subtitleId : undefined}
        className={className}
        initial={{ opacity: 0, y: -2 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, delay, ease: [0.23, 1, 0.32, 1] }}
      >
        {content}
      </motion.span>
    );
  }

  return (
    <span {...statusAttributes} aria-describedby={subtitle ? subtitleId : undefined} className={className}>
      {content}
    </span>
  );
}
