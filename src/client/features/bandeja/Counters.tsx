import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { useEffect } from 'react';
import type { Counters, RunStats } from '../../../shared/api';
import type { InvoiceStatus } from '../../../shared/domain/types';

export type CounterFilter = Extract<InvoiceStatus, 'ready' | 'approval_required' | 'review_required' | 'stopped'>;

interface MetricProps {
  label: string;
  glyph: string;
  tone: string;
  value: number;
  selected: boolean;
  onClick: () => void;
}

function Metric({ label, glyph, tone, value, selected, onClick }: MetricProps) {
  const reduceMotion = useReducedMotion();
  const count = useMotionValue(value);
  const displayed = useTransform(count, (current) => new Intl.NumberFormat('es-VE').format(Math.round(current)));

  useEffect(() => {
    if (reduceMotion) {
      count.set(value);
      return;
    }
    const controls = animate(count, value, { duration: 0.2, ease: [0.23, 1, 0.32, 1] });
    return () => controls.stop();
  }, [count, reduceMotion, value]);

  return (
    <button
      type="button"
      className={`metric metric-${tone} filter-trigger`}
      aria-pressed={selected}
      onClick={onClick}
    >
      <div className="metric-label"><span className="metric-glyph" aria-hidden="true">{glyph}</span>{label}</div>
      <motion.span className="metric-count">{displayed}</motion.span>
      {selected && <span className="metric-hint">Toca para quitar el filtro</span>}
    </button>
  );
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toLocaleString('es-VE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

interface CountersProps {
  counters: Counters;
  lastRun: RunStats | null;
  filter?: CounterFilter | null;
  onFilter?: (status: CounterFilter | null) => void;
}

export function Counters({ counters, lastRun, filter = null, onFilter = () => {} }: CountersProps) {
  const mode = lastRun?.mode === 'live' ? 'en vivo' : 'grabado';
  const elapsed = lastRun ? formatSeconds(lastRun.ms) : '—';
  const runCost = lastRun && /^\d+(?:\.\d+)?$/.test(lastRun.costUsd)
    ? `US$${lastRun.costUsd.replace('.', ',')}`
    : 'sin medición';
  const runSource = lastRun?.mode === 'live' ? 'en vivo' : 'respuestas grabadas';
  const runDescription = lastRun
    ? `${lastRun.invoices} ${lastRun.invoices === 1 ? 'factura' : 'facturas'} en ${elapsed} · ${runCost} · ${runSource}`
    : 'Sin ejecuciones todavía';

  return (
    <section className="overview" aria-label="Resumen de estados">
      <Metric label="Listas para pagar" glyph="✓" tone="ready" value={counters.ready} selected={filter === 'ready'} onClick={() => onFilter(filter === 'ready' ? null : 'ready')} />
      <Metric label="Requieren tu aprobación" glyph="▣" tone="approval" value={counters.approval_required} selected={filter === 'approval_required'} onClick={() => onFilter(filter === 'approval_required' ? null : 'approval_required')} />
      <Metric label="Requieren revisión" glyph="?" tone="review" value={counters.review_required} selected={filter === 'review_required'} onClick={() => onFilter(filter === 'review_required' ? null : 'review_required')} />
      <Metric label="Frenadas" glyph="×" tone="stopped" value={counters.stopped} selected={filter === 'stopped'} onClick={() => onFilter(filter === 'stopped' ? null : 'stopped')} />
      <div className="metric metric-run">
        <div className="run-heading"><span className="eyebrow">Última ejecución / {mode}</span><strong>{elapsed}</strong></div>
        <p className="run-description">{runDescription}</p>
      </div>
    </section>
  );
}
