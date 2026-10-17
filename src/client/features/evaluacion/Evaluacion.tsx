import type { EvaluationResult } from '../../../server/eval/run';
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

function blockingReasons(result: BlockedResult): string[] {
  const reasons: string[] = [];
  if (result.regression.status === 'unavailable') reasons.push(REGRESSION_REASONS[result.regression.reason]);
  if (result.labeled.status === 'unavailable') reasons.push(LABELED_REASONS[result.labeled.reason]);
  return reasons;
}

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

function UnavailableState({ result }: { result: BlockedResult | null }) {
  const reasons = result ? blockingReasons(result) : [];

  return (
    <section className="eval-unavailable" aria-labelledby="eval-unavailable-title">
      <h2 id="eval-unavailable-title">Evaluación no disponible</h2>
      {reasons.length > 0 ? (
        <ul>
          {reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      ) : (
        <p>Aún no hay un resultado de evaluación para mostrar.</p>
      )}
    </section>
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

  if (!result || result.status === 'blocked') {
    return (
      <main className="eval-page">
        <PageHeader />
        <UnavailableState result={result?.status === 'blocked' ? result : null} />
      </main>
    );
  }

  const unsafeRegression = result.regression.unsafeApprovals > 0;
  const unsafeLabeled = result.labeled.unsafeApprovals > 0;
  const hasUnsafeApprovals = unsafeRegression || unsafeLabeled;
  const unsafeMessages = [
    unsafeRegression && `${result.regression.unsafeApprovals} ${result.regression.unsafeApprovals === 1 ? 'aprobación indebida' : 'aprobaciones indebidas'} en las pruebas de seguridad.`,
    unsafeLabeled && `${result.labeled.unsafeApprovals} ${result.labeled.unsafeApprovals === 1 ? 'aprobación indebida' : 'aprobaciones indebidas'} en el conjunto etiquetado.`,
  ].filter((message): message is string => Boolean(message));
  const regressionRows = [
    { label: 'Pruebas de regresión', value: String(result.regression.tests) },
    { label: 'Aprobaciones indebidas', value: String(result.regression.unsafeApprovals) },
  ];
  const labeledRows = [
    { label: 'Coincidencias exactas', value: `${result.labeled.correct} / ${result.labeled.total}` },
    { label: 'Aprobaciones indebidas', value: String(result.labeled.unsafeApprovals) },
    { label: 'Escalamientos falsos', value: String(result.labeled.falseEscalations) },
    { label: 'Autonomía', value: formatPercent(result.labeled.autonomyPct) },
  ];

  return (
    <main className="eval-page" data-overall-safety={hasUnsafeApprovals ? 'failed' : 'passed'}>
      <PageHeader />

      {hasUnsafeApprovals && (
        <div className="eval-alert" role="alert" data-state="error">
          <h2>Hay aprobaciones indebidas</h2>
          <ul>{unsafeMessages.map((message) => <li key={message}>{message}</li>)}</ul>
        </div>
      )}

      <div className="eval-claims">
        <section className="eval-panel" aria-labelledby="eval-regression-title" data-state={unsafeRegression ? 'error' : 'clear'}>
          <h2 id="eval-regression-title">Seguridad de regresión</h2>
          <MetricTable caption="Evidencia de regresión" rows={regressionRows} />
          <p className="eval-source">Fuente: {result.regression.source}</p>
          {!hasUnsafeApprovals && (
            <p className="eval-safety-pass" data-overall-safety="passed">
              0 aprobaciones indebidas en {result.regression.tests} pruebas.
            </p>
          )}
        </section>

        <section className="eval-panel" aria-labelledby="eval-labeled-title" data-state={unsafeLabeled ? 'error' : 'clear'}>
          <h2 id="eval-labeled-title">Conjunto etiquetado</h2>
          <p className="eval-mode">Modo demostración · respuestas grabadas</p>
          <MetricTable caption="Resultados del conjunto etiquetado" rows={labeledRows} />
        </section>

        <section className="eval-panel eval-live" aria-labelledby="eval-live-title">
          <h2 id="eval-live-title">Muestra en vivo</h2>
          {result.live.status === 'available' ? (
            <MetricTable
              caption="Mediciones en vivo"
              rows={[
                { label: 'Latencia p50', value: `${new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 }).format(result.live.p50Ms)} ms` },
                { label: 'Costo medido (USD)', value: `US$${result.live.costUsd}` },
                { label: 'Fallos', value: String(result.live.failures) },
              ]}
            />
          ) : (
            <p className="eval-live-unavailable">Sin medición en vivo</p>
          )}
        </section>
      </div>
    </main>
  );
}
