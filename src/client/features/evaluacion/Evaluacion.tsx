import type { EvaluationResult } from '../../lib/api-types';
import './evaluacion.css';

interface EvaluacionProps {
  result: EvaluationResult | null;
  loading?: boolean;
  error?: string | null;
}

interface MetricRow {
  label: string;
  value: string;
}

type BlockedResult = Extract<EvaluationResult, { status: 'blocked' }>;
type UnavailableRegression = Extract<BlockedResult['regression'], { status: 'unavailable' }>;
type UnavailableLabeled = Extract<BlockedResult['labeled'], { status: 'unavailable' }>;

const REGRESSION_REASONS: Record<UnavailableRegression['reason'], string> = {
  evidence_not_supplied: 'No se aportó evidencia verificada de pruebas de seguridad.',
  invalid_evidence: 'La evidencia de pruebas de seguridad no es válida.',
};

const LABELED_REASONS: Record<UnavailableLabeled['reason'], string> = {
  empty_labeled_set: 'El conjunto de facturas etiquetadas está vacío.',
  invalid_labeled_set: 'El conjunto de facturas etiquetadas no es válido.',
  runner_unavailable: 'No hay un evaluador disponible para ejecutar el conjunto etiquetado.',
  missing_recording: 'Faltan respuestas grabadas completas para el conjunto etiquetado.',
  incomplete_set: 'La evaluación no cubrió el conjunto etiquetado completo.',
  runner_failed: 'Falló la evaluación de una factura del conjunto etiquetado.',
  not_replay: 'La evaluación etiquetada no se ejecutó con respuestas grabadas.',
  invalid_decision: 'Una respuesta no produjo un estado de decisión válido.',
};

function MetricTable({ caption, rows }: { caption: string; rows: readonly MetricRow[] }) {
  return (
    <table className="eval-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Indicador</th>
          <th scope="col">Resultado</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ label, value }) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td className="eval-metric-value">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} %`;
}

function PageHeader() {
  return (
    <header className="eval-header">
      <p className="eval-eyebrow">Informe de evidencia</p>
      <h1>Evaluación</h1>
      <p>Consulta por separado las pruebas de seguridad, las respuestas grabadas y las mediciones en vivo.</p>
    </header>
  );
}

export function Evaluacion({ result, loading = false, error }: EvaluacionProps) {
  if (loading) {
    return (
      <main className="eval-page" aria-busy="true">
        <PageHeader />
        <p className="eval-message" role="status">Estamos preparando la evaluación.</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="eval-page">
        <PageHeader />
        <p className="eval-message eval-message-error" role="alert">
          No pudimos cargar la evaluación. Inténtalo de nuevo.
        </p>
      </main>
    );
  }

  const regression = result?.regression.status === 'available' ? result.regression : null;
  const labeled = result?.labeled.status === 'available' ? result.labeled : null;
  const live = result?.live.status === 'available' ? result.live : null;
  const regressionMessage = result?.regression.status === 'unavailable'
    ? REGRESSION_REASONS[result.regression.reason]
    : 'Aún no hay evidencia de regresión para mostrar.';
  const labeledMessage = result?.labeled.status === 'unavailable'
    ? LABELED_REASONS[result.labeled.reason]
    : 'Aún no hay resultados del conjunto etiquetado para mostrar.';
  const regressionState = regression ? (regression.unsafeApprovals > 0 ? 'error' : 'clear') : 'unavailable';
  const labeledState = labeled ? (labeled.unsafeApprovals > 0 ? 'error' : 'clear') : 'unavailable';

  return (
    <main className="eval-page">
      <PageHeader />

      <div className="eval-claims">
        <section className="eval-panel" aria-labelledby="eval-regression-title" data-state={regressionState}>
          <h2 id="eval-regression-title">Seguridad de regresión</h2>
          {regression ? (
            <>
              <MetricTable
                caption="Evidencia de regresión"
                rows={[
                  { label: 'Pruebas de regresión', value: String(regression.tests) },
                  { label: 'Aprobaciones indebidas', value: String(regression.unsafeApprovals) },
                ]}
              />
              <p className="eval-source">Fuente: {regression.source}</p>
              <p className={regression.unsafeApprovals === 0 ? 'eval-safety-pass' : 'eval-safety-fail'}>
                {regression.unsafeApprovals} {regression.unsafeApprovals === 1 ? 'aprobación indebida' : 'aprobaciones indebidas'} en {regression.tests} pruebas.
              </p>
              {regression.unsafeApprovals > 0 && (
                <div className="eval-alert" role="alert" data-state="error">
                  Seguridad de regresión: se detectaron aprobaciones indebidas.
                </div>
              )}
            </>
          ) : <p className="eval-live-unavailable">{regressionMessage}</p>}
        </section>

        <section className="eval-panel" aria-labelledby="eval-labeled-title" data-state={labeledState}>
          <h2 id="eval-labeled-title">Conjunto etiquetado</h2>
          {labeled ? (
            <>
              <p className="eval-mode">Modo demostración · respuestas grabadas</p>
              <MetricTable
                caption="Resultados del conjunto etiquetado"
                rows={[
                  { label: 'Coincidencias exactas', value: `${labeled.correct} / ${labeled.total}` },
                  { label: 'Aprobaciones indebidas', value: String(labeled.unsafeApprovals) },
                  { label: 'Escalamientos falsos', value: String(labeled.falseEscalations) },
                  { label: 'Autonomía', value: formatPercent(labeled.autonomyPct) },
                ]}
              />
              {labeled.unsafeApprovals > 0 && (
                <div className="eval-alert" role="alert" data-state="error">
                  Conjunto etiquetado: se detectaron {labeled.unsafeApprovals} aprobaciones indebidas.
                </div>
              )}
            </>
          ) : <p className="eval-live-unavailable">{labeledMessage}</p>}
        </section>

        <section className="eval-panel eval-live" aria-labelledby="eval-live-title">
          <h2 id="eval-live-title">Muestra en vivo</h2>
          {live ? (
            <MetricTable
              caption="Mediciones en vivo"
              rows={[
                { label: 'Facturas medidas', value: String(live.sample) },
                { label: 'Latencia p50', value: `${new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 }).format(live.p50Ms)} ms` },
                { label: 'Costo medido (USD)', value: `US$${live.costUsd}` },
                { label: 'Fallos', value: String(live.failures) },
              ]}
            />
          ) : (
            <p className="eval-live-unavailable">Sin muestra en vivo</p>
          )}
        </section>
      </div>
    </main>
  );
}
