import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SimulationResult } from '../../../shared/api';
import type { Preset, Rules } from '../../../shared/domain/types';
import './reglas.css';

export interface ReglasApi {
  getRules(): Promise<Rules>;
  saveRules(rules: Rules): Promise<Rules>;
  simulate(rules: Rules): Promise<SimulationResult>;
}

interface ReglasProps {
  api: ReglasApi;
}

type FormValues = {
  perPaymentLimitUsd: string;
  monthlyLimitUsd: string;
  approvalThresholdUsd: string;
  fuzzyDuplicateWindowDays: string;
  preset: Preset;
};

type FormErrors = Partial<Record<keyof Omit<FormValues, 'preset'>, string>>;
type RuleState = 'loading' | 'idle' | 'simulating' | 'ready' | 'error';
type SimulationView = {
  counts: SimulationResult['counts'];
  deltas: SimulationResult['deltas'];
  unsafeApprovals: number;
};

const presetOptions: Array<{ value: Preset; label: string; description: string }> = [
  { value: 'estricto', label: 'Estricto', description: 'Revisa más señales dudosas.' },
  { value: 'equilibrado', label: 'Equilibrado', description: 'Sensibilidad intermedia.' },
  { value: 'permisivo', label: 'Permisivo', description: 'Reduce las alertas de juicio.' },
];

const presetCriteria: Array<{ preset: Preset; stop: string; review: string }> = [
  { preset: 'estricto', stop: '0,60', review: '0,25' },
  { preset: 'equilibrado', stop: '0,70', review: '0,35' },
  { preset: 'permisivo', stop: '0,85', review: '0,50' },
];

const statusRows: Array<{
  key: keyof SimulationResult['counts'];
  label: string;
  tone: string;
}> = [
  { key: 'ready', label: 'listas', tone: 'ready' },
  { key: 'approval_required', label: 'requieren tu aprobación', tone: 'approval' },
  { key: 'review_required', label: 'requieren revisión', tone: 'review' },
  { key: 'stopped', label: 'frenadas', tone: 'stopped' },
];

function formatUsdMinor(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) return '';
  const whole = String(BigInt(minor) / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cents = String(BigInt(minor) % 100n).padStart(2, '0');
  return `${whole},${cents}`;
}

function parseUsdMinor(value: string): { value: number | null; error: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { value: null, error: 'Ingresa un monto en dólares.' };
  const decimalPart = trimmed.split(',')[1];
  if (decimalPart !== undefined && decimalPart.length > 2) {
    return { value: null, error: 'Usa hasta dos cifras después de la coma.' };
  }

  const match = /^(\d+|\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    return { value: null, error: 'Escribe un monto válido, por ejemplo 1.234,56.' };
  }

  const whole = match[1].replaceAll('.', '');
  if (whole.length > 14) {
    return { value: null, error: 'El monto supera la precisión segura disponible.' };
  }
  const cents = (match[2] ?? '').padEnd(2, '0') || '0';
  const minor = BigInt(whole) * 100n + BigInt(cents);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { value: null, error: 'El monto supera la precisión segura disponible.' };
  }
  return { value: Number(minor), error: null };
}

function valuesFromRules(rules: Rules): FormValues {
  return {
    perPaymentLimitUsd: formatUsdMinor(rules.perPaymentLimitUsdMinor),
    monthlyLimitUsd: formatUsdMinor(rules.monthlyLimitUsdMinor),
    approvalThresholdUsd: formatUsdMinor(rules.approvalThresholdUsdMinor),
    fuzzyDuplicateWindowDays: String(rules.fuzzyDuplicateWindowDays),
    preset: rules.preset,
  };
}

function rulesChanged(next: Rules, current: Rules): boolean {
  return next.perPaymentLimitUsdMinor !== current.perPaymentLimitUsdMinor
    || next.monthlyLimitUsdMinor !== current.monthlyLimitUsdMinor
    || next.approvalThresholdUsdMinor !== current.approvalThresholdUsdMinor
    || next.fuzzyDuplicateWindowDays !== current.fuzzyDuplicateWindowDays
    || next.preset !== current.preset;
}

function validateForm(values: FormValues, version: number): { rules: Rules | null; errors: FormErrors } {
  const errors: FormErrors = {};
  const perPayment = parseUsdMinor(values.perPaymentLimitUsd);
  const monthly = parseUsdMinor(values.monthlyLimitUsd);
  const threshold = parseUsdMinor(values.approvalThresholdUsd);

  if (perPayment.error) errors.perPaymentLimitUsd = perPayment.error;
  else if (perPayment.value === 0) errors.perPaymentLimitUsd = 'El límite por pago debe ser mayor que US$0,00.';

  if (monthly.error) errors.monthlyLimitUsd = monthly.error;

  if (threshold.error) errors.approvalThresholdUsd = threshold.error;

  const windowValue = values.fuzzyDuplicateWindowDays.trim();
  let windowDays: number | null = null;
  if (!/^\d+$/.test(windowValue) || !Number.isSafeInteger(Number(windowValue))) {
    errors.fuzzyDuplicateWindowDays = 'Escribe una cantidad entera de días igual o mayor que cero.';
  } else {
    windowDays = Number(windowValue);
  }

  if (perPayment.value !== null && threshold.value !== null && threshold.value >= perPayment.value) {
    errors.approvalThresholdUsd = 'Debe ser menor que el límite por pago.';
  }

  if (
    Object.keys(errors).length > 0
    || perPayment.value === null
    || monthly.value === null
    || threshold.value === null
    || windowDays === null
  ) {
    return { rules: null, errors };
  }

  return {
    rules: {
      version,
      perPaymentLimitUsdMinor: perPayment.value,
      monthlyLimitUsdMinor: monthly.value,
      approvalThresholdUsdMinor: threshold.value,
      fuzzyDuplicateWindowDays: windowDays,
      preset: values.preset,
    },
    errors,
  };
}

function readSimulationResult(value: unknown): SimulationView | null {
  if (typeof value !== 'object' || value === null) return null;
  const result = value as Record<string, unknown>;
  const counts = result.counts;
  const deltas = result.deltas;
  const states: Array<keyof SimulationResult['counts']> = [
    'ready', 'approval_required', 'review_required', 'stopped',
  ];
  if (typeof counts !== 'object' || counts === null || typeof deltas !== 'object' || deltas === null) return null;

  const countValues = counts as Record<string, unknown>;
  const deltaValues = deltas as Record<string, unknown>;
  if (!states.every((key) => Number.isSafeInteger(countValues[key]) && Number(countValues[key]) >= 0)) return null;
  if (!states.every((key) => Number.isSafeInteger(deltaValues[key]))) return null;
  if (!Number.isSafeInteger(result.unsafeApprovals) || Number(result.unsafeApprovals) < 0) return null;

  return {
    counts: countValues as SimulationResult['counts'],
    deltas: deltaValues as SimulationResult['deltas'],
    unsafeApprovals: Number(result.unsafeApprovals),
  };
}

function deltaLabel(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return '0';
}

export function Reglas({ api }: ReglasProps) {
  const [serverRules, setServerRules] = useState<Rules | null>(null);
  const [form, setForm] = useState<FormValues | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [simulation, setSimulation] = useState<SimulationView | null>(null);
  const [simulationState, setSimulationState] = useState<RuleState>('loading');
  const simulationRequest = useRef(0);

  useEffect(() => {
    let active = true;
    api.getRules()
      .then((rules) => {
        if (!active) return;
        setServerRules(rules);
        setForm(valuesFromRules(rules));
        setSimulationState('idle');
      })
      .catch(() => {
        if (!active) return;
        setLoadError('No pude cargar las reglas. Intenta de nuevo.');
        setSimulationState('error');
      });

    return () => {
      active = false;
      simulationRequest.current += 1;
    };
  }, [api]);

  const validation = form && serverRules ? validateForm(form, serverRules.version) : null;
  const hasUnsafeSimulation = simulation !== null && simulation.unsafeApprovals !== 0;
  const hasUnsavedChanges = Boolean(validation?.rules && serverRules && rulesChanged(validation.rules, serverRules));
  const canSave = hasUnsavedChanges && !saving && !hasUnsafeSimulation;

  function updateForm(nextForm: FormValues) {
    setForm(nextForm);
    setSaveError(null);
    setSaveMessage(null);

    const requestId = ++simulationRequest.current;
    setSimulation(null);
    if (!serverRules) return;

    const nextRules = validateForm(nextForm, serverRules.version).rules;
    if (!nextRules) {
      setSimulationState('idle');
      return;
    }

    setSimulationState('simulating');
    void api.simulate(nextRules)
      .then((response) => {
        if (requestId !== simulationRequest.current) return;
        const result = readSimulationResult(response);
        if (!result) {
          setSimulationState('error');
          return;
        }
        setSimulation(result);
        setSimulationState('ready');
      })
      .catch(() => {
        if (requestId !== simulationRequest.current) return;
        setSimulationState('error');
      });
  }

  async function saveRules(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validation?.rules || !hasUnsavedChanges || saving || hasUnsafeSimulation) return;

    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const updated = await api.saveRules(validation.rules);
      simulationRequest.current += 1;
      setSimulation(null);
      setSimulationState('idle');
      setServerRules(updated);
      setForm(valuesFromRules(updated));
      setSaveMessage(`Reglas v${updated.version} guardadas.`);
    } catch {
      setSaveError('No pude guardar los cambios. Tus reglas siguen sin actualizarse.');
    } finally {
      setSaving(false);
    }
  }

  const fieldErrors = validation?.errors ?? {};

  return (
    <>
      <section
        aria-busy={!form && !loadError}
        aria-labelledby="reglas-title"
        className="reglas-screen"
        id="reglas"
      >
        <header className="reglas-heading">
          <p className="reglas-eyebrow">04 / REGLAS Y UMBRALES</p>
          <h2 id="reglas-title">Reglas de pago</h2>
          <p>Define los límites y la sensibilidad de revisión. Los controles fijos protegen cada pago.</p>
        </header>

        {loadError && <p className="reglas-error" role="alert">{loadError}</p>}
        {!form && !loadError && <p className="reglas-status" role="status">Cargando reglas…</p>}

        {form && serverRules && (
          <form className="reglas-layout" onSubmit={(event) => void saveRules(event)} noValidate>
            <div className="reglas-edit-column">
              <section aria-labelledby="reglas-limits-title" className="reglas-panel">
                <div className="reglas-section-heading">
                  <h3 id="reglas-limits-title">Límites de pago</h3>
                  <span>Versión vigente: {serverRules.version}</span>
                </div>

                <div className="reglas-field-grid">
                  <div className="reglas-field">
                    <label htmlFor="reglas-payment-limit">Límite por pago (USD)</label>
                    <div className="reglas-input-wrap">
                      <span aria-hidden="true">US$</span>
                      <input
                        aria-describedby={fieldErrors.perPaymentLimitUsd ? 'reglas-payment-help reglas-payment-error' : 'reglas-payment-help'}
                        aria-invalid={Boolean(fieldErrors.perPaymentLimitUsd)}
                        autoComplete="off"
                        disabled={saving}
                        id="reglas-payment-limit"
                        inputMode="decimal"
                        onChange={(event) => updateForm({ ...form, perPaymentLimitUsd: event.currentTarget.value })}
                        type="text"
                        value={form.perPaymentLimitUsd}
                      />
                    </div>
                    <p className="reglas-help" id="reglas-payment-help">¿Qué es esto? Monto máximo en USD para una factura individual.</p>
                    {fieldErrors.perPaymentLimitUsd && <p className="reglas-error" id="reglas-payment-error" role="alert">{fieldErrors.perPaymentLimitUsd}</p>}
                  </div>

                  <div className="reglas-field">
                    <label htmlFor="reglas-monthly-limit">Límite mensual (USD)</label>
                    <div className="reglas-input-wrap">
                      <span aria-hidden="true">US$</span>
                      <input
                        aria-describedby={fieldErrors.monthlyLimitUsd ? 'reglas-monthly-help reglas-monthly-error' : 'reglas-monthly-help'}
                        aria-invalid={Boolean(fieldErrors.monthlyLimitUsd)}
                        autoComplete="off"
                        disabled={saving}
                        id="reglas-monthly-limit"
                        inputMode="decimal"
                        onChange={(event) => updateForm({ ...form, monthlyLimitUsd: event.currentTarget.value })}
                        type="text"
                        value={form.monthlyLimitUsd}
                      />
                    </div>
                    <p className="reglas-help" id="reglas-monthly-help">¿Qué es esto? Tope mensual para pagos comprometidos, incluidas las aprobaciones pendientes.</p>
                    {fieldErrors.monthlyLimitUsd && <p className="reglas-error" id="reglas-monthly-error" role="alert">{fieldErrors.monthlyLimitUsd}</p>}
                  </div>

                  <div className="reglas-field">
                    <label htmlFor="reglas-approval-threshold">Umbral de aprobación humana (USD)</label>
                    <div className="reglas-input-wrap">
                      <span aria-hidden="true">US$</span>
                      <input
                        aria-describedby={fieldErrors.approvalThresholdUsd ? 'reglas-threshold-help reglas-threshold-error' : 'reglas-threshold-help'}
                        aria-invalid={Boolean(fieldErrors.approvalThresholdUsd)}
                        autoComplete="off"
                        disabled={saving}
                        id="reglas-approval-threshold"
                        inputMode="decimal"
                        onChange={(event) => updateForm({ ...form, approvalThresholdUsd: event.currentTarget.value })}
                        type="text"
                        value={form.approvalThresholdUsd}
                      />
                    </div>
                    <p className="reglas-help" id="reglas-threshold-help">¿Qué es esto? Por encima de este monto, alguien debe aprobar. Puede ser US$0,00.</p>
                    {fieldErrors.approvalThresholdUsd && <p className="reglas-error" id="reglas-threshold-error" role="alert">{fieldErrors.approvalThresholdUsd}</p>}
                  </div>

                  <div className="reglas-field">
                    <label htmlFor="reglas-duplicate-window">Ventana de duplicado aproximado (días)</label>
                    <input
                      aria-describedby={fieldErrors.fuzzyDuplicateWindowDays ? 'reglas-window-help reglas-window-error' : 'reglas-window-help'}
                      aria-invalid={Boolean(fieldErrors.fuzzyDuplicateWindowDays)}
                      autoComplete="off"
                      disabled={saving}
                      id="reglas-duplicate-window"
                      inputMode="numeric"
                      onChange={(event) => updateForm({ ...form, fuzzyDuplicateWindowDays: event.currentTarget.value })}
                      type="text"
                      value={form.fuzzyDuplicateWindowDays}
                    />
                    <p className="reglas-help" id="reglas-window-help">¿Qué es esto? Días hacia atrás para buscar cobros similares del mismo proveedor.</p>
                    {fieldErrors.fuzzyDuplicateWindowDays && <p className="reglas-error" id="reglas-window-error" role="alert">{fieldErrors.fuzzyDuplicateWindowDays}</p>}
                  </div>
                </div>
              </section>

              <section aria-labelledby="reglas-sensitivity-title" className="reglas-panel">
                <div className="reglas-section-heading">
                  <h3 id="reglas-sensitivity-title">Sensibilidad del agente</h3>
                  <span>Solo señales de juicio</span>
                </div>
                <fieldset aria-describedby="reglas-preset-help" className="reglas-presets">
                  <legend>Elige un preset</legend>
                  {presetOptions.map((option) => (
                    <label className="reglas-preset-option" key={option.value}>
                      <input
                        aria-describedby="reglas-preset-help"
                        checked={form.preset === option.value}
                        disabled={saving}
                        name="reglas-preset"
                        onChange={() => updateForm({ ...form, preset: option.value })}
                        type="radio"
                        value={option.value}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <p className="reglas-help" id="reglas-preset-help">¿Qué es esto? Ajusta la sensibilidad de las señales de juicio; nunca relaja un control fijo.</p>

                <p className="reglas-help" id="reglas-advanced-help">¿Qué es esto? La vista avanzada explica los umbrales de cada preset.</p>
                <details className="reglas-advanced">
                  <summary aria-describedby="reglas-advanced-help">Ver criterios avanzados</summary>
                  <p>La primera cifra detiene señales de instrucción; la segunda marca señales para revisión. No cambia los controles determinísticos.</p>
                  <div className="reglas-criteria" role="table" aria-label="Criterios de sensibilidad">
                    <div className="reglas-criteria-row reglas-criteria-head" role="row">
                      <span role="columnheader">Preset</span>
                      <span role="columnheader">Frena desde</span>
                      <span role="columnheader">Revisa desde</span>
                    </div>
                    {presetCriteria.map((criterion) => (
                      <div className="reglas-criteria-row" key={criterion.preset} role="row">
                        <span role="cell">{presetOptions.find(({ value }) => value === criterion.preset)?.label}{form.preset === criterion.preset ? ' · Activo' : ''}</span>
                        <span role="cell">{criterion.stop}</span>
                        <span role="cell">{criterion.review}</span>
                      </div>
                    ))}
                  </div>
                </details>
              </section>
            </div>

            <aside aria-labelledby="reglas-fixed-title" className="reglas-panel reglas-fixed-panel">
              <h3 id="reglas-fixed-title">Controles que no puedes cambiar</h3>
              <p className="reglas-fixed-intro">Estos límites están siempre activos y no tienen interruptores.</p>
              <ul className="reglas-fixed-list">
                <li>
                  <div><strong>Lista de proveedores permitidos</strong><span>Solo los proveedores registrados pueden recibir pagos.</span></div>
                  <small>Fijo por seguridad</small>
                </li>
                <li>
                  <div><strong>La cuenta bancaria de la factura debe coincidir</strong><span>Un cambio de cuenta requiere corregir los datos y volver a evaluar.</span></div>
                  <small>Fijo por seguridad</small>
                </li>
                <li>
                  <div><strong>Integridad del documento de origen</strong><span>Los datos críticos deben estar presentes en la factura.</span></div>
                  <small>Fijo por seguridad</small>
                </li>
                <li>
                  <div><strong>Contrato vigente</strong><span>Cada pago necesita un contrato aplicable.</span></div>
                  <small>Fijo por seguridad</small>
                </li>
              </ul>
            </aside>

            <section aria-labelledby="reglas-impact-title" className="reglas-impact">
              <div className="reglas-impact-heading">
                <h3 id="reglas-impact-title">Impacto en la bandeja</h3>
                <p>Se calcula con los datos y las respuestas guardadas. No genera llamadas al agente.</p>
              </div>
              {simulationState === 'simulating' && (
                <p className="reglas-status" role="status">Calculando el impacto de estos ajustes…</p>
              )}
              {simulationState === 'idle' && (
                <p className="reglas-status" role="status">
                  {validation?.rules ? 'Edita un ajuste para calcular su impacto.' : 'Corrige los campos para calcular el impacto.'}
                </p>
              )}
              {simulationState === 'error' && (
                <p className="reglas-error" role="alert">No pude calcular el impacto. Tus ajustes siguen sin guardar.</p>
              )}
              {simulationState === 'ready' && simulation?.unsafeApprovals === 0 && (
                <p className="reglas-impact-result" role="status" aria-live="polite">
                  <span>Con estos ajustes en tu bandeja:</span>{' '}
                  {statusRows.map(({ key, label, tone }, index) => (
                    <span className={`reglas-impact-count reglas-impact-count--${tone}`} key={key}>
                      {simulation.counts[key]} {label} ({deltaLabel(simulation.deltas[key])}){index < statusRows.length - 1 ? ' · ' : ''}
                    </span>
                  ))}
                  <span className="reglas-impact-safe"> · 0 aprobaciones indebidas</span>
                </p>
              )}
              {simulationState === 'ready' && simulation !== null && simulation.unsafeApprovals > 0 && (
                <p className="reglas-error" role="alert">
                  El simulador detectó {simulation.unsafeApprovals} aprobaciones indebidas. No guardes estos ajustes.
                </p>
              )}
            </section>

            <footer className="reglas-actions">
              <div>
                <button aria-describedby="reglas-save-help" className="reglas-primary" disabled={!canSave} type="submit">
                  {saving ? 'Guardando…' : 'Guardar cambios'}
                </button>
                <p className="reglas-help" id="reglas-save-help">¿Qué es esto? Guarda los límites y el preset. El servidor confirma la versión aplicada.</p>
              </div>
              <div className="reglas-save-feedback" aria-live="polite">
                {saveMessage && <p className="reglas-saved" role="status">{saveMessage}</p>}
                {saveError && <p className="reglas-error" role="alert">{saveError}</p>}
              </div>
            </footer>
          </form>
        )}
      </section>
    </>
  );
}
