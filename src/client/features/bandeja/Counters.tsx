import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { useEffect } from 'react';
import type { Counters, RunStats } from '../../../shared/api';

interface MetricProps {
  label: string;
  glyph: string;
  tone: string;
  value: number;
}

function Metric({ label, glyph, tone, value }: MetricProps) {
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
    <div className={`metric metric-${tone}`}>
      <div className="metric-label"><span className="metric-glyph" aria-hidden="true">{glyph}</span>{label}</div>
      <motion.span className="metric-count">{displayed}</motion.span>
    </div>
  );
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toLocaleString('es-VE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

interface CountersProps {
  counters: Counters;
  lastRun: RunStats | null;
}

export function Counters({ counters, lastRun }: CountersProps) {
  const mode = lastRun?.mode === 'live' ? 'en vivo' : 'grabado';
  const elapsed = lastRun ? formatSeconds(lastRun.ms) : '—';
  const runDescription = lastRun
    ? `${lastRun.invoices} ${lastRun.invoices === 1 ? 'factura' : 'facturas'} en ${elapsed} · US$${lastRun.costUsd.replace('.', ',')} · ${mode}`
    : 'Sin ejecuciones todavía';

  return (
    <section className="overview" aria-label="Resumen de estados">
      <Metric label="Listas para pagar" glyph="✓" tone="ready" value={counters.ready} />
      <Metric label="Requieren tu aprobación" glyph="▣" tone="approval" value={counters.approval_required} />
      <Metric label="Requieren revisión" glyph="?" tone="review" value={counters.review_required} />
      <Metric label="Frenadas" glyph="×" tone="stopped" value={counters.stopped} />
      <div className="metric metric-run">
        <div className="run-heading"><span className="eyebrow">Última ejecución / {mode}</span><strong>{elapsed}</strong></div>
        <p className="run-description">{runDescription}</p>
      </div>
    </section>
  );
}
