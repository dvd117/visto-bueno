import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvaluationResult } from '../../src/server/eval/run';
import { Evaluacion } from '../../src/client/features/evaluacion/Evaluacion';

afterEach(cleanup);

function makeAvailableResult(): EvaluationResult {
  return {
    status: 'available',
    report: {
      regression: { tests: 38, unsafeApprovals: 0 },
      labeled: {
        total: 20,
        correct: 18,
        autonomyPct: 40.5,
        falseEscalations: 2,
        mode: 'replay',
      },
    },
    regression: {
      status: 'available',
      tests: 38,
      unsafeApprovals: 0,
      source: 'suite de regresión verificada',
      safetyGate: 'passed',
    },
    labeled: {
      status: 'available',
      mode: 'replay',
      total: 20,
      correct: 18,
      falseEscalations: 2,
      autonomyPct: 40.5,
      unsafeApprovals: 0,
      unsafeInvoiceIds: [],
      safetyGate: 'passed',
    },
    live: { status: 'unavailable', reason: 'sample_not_supplied' },
    safetyGate: 'passed',
  };
}

function makeBlockedResult(): EvaluationResult {
  return {
    status: 'blocked',
    regression: { status: 'unavailable', reason: 'evidence_not_supplied' },
    labeled: { status: 'unavailable', reason: 'missing_recording', invoiceId: 'AL-047' },
    live: { status: 'unavailable', reason: 'sample_not_supplied' },
  };
}

describe('Evaluacion', () => {
  it('keeps the three evidence claims separate when results are blocked', () => {
    render(<Evaluacion result={makeBlockedResult()} />);

    expect(screen.getByRole('heading', { name: 'Seguridad de regresión' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Conjunto etiquetado' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Muestra en vivo' })).toBeTruthy();
    expect(screen.getByText('No se aportó evidencia verificada de pruebas de seguridad.')).toBeTruthy();
    expect(screen.getByText('Faltan respuestas grabadas completas para el conjunto etiquetado.')).toBeTruthy();
    expect(screen.getByText('Sin muestra en vivo')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/aprobaciones indebidas en \d+ pruebas/i)).toBeNull();
  });

  it('shows three separate unavailable claims when no result exists', () => {
    render(<Evaluacion result={null} />);

    expect(screen.getByRole('heading', { name: 'Seguridad de regresión' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Conjunto etiquetado' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Muestra en vivo' })).toBeTruthy();
    expect(screen.getByText('Aún no hay evidencia de regresión para mostrar.')).toBeTruthy();
    expect(screen.getByText('Aún no hay resultados del conjunto etiquetado para mostrar.')).toBeTruthy();
    expect(screen.getByText('Sin muestra en vivo')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders verified regression and labeled replay metrics', () => {
    render(<Evaluacion result={makeAvailableResult()} />);

    expect(screen.getByText('38')).toBeTruthy();
    expect(screen.getByText('18 / 20')).toBeTruthy();
    expect(screen.getByText('2', { selector: '.eval-metric-value' })).toBeTruthy();
    expect(screen.getByText('40,50 %')).toBeTruthy();
    expect(screen.getByText('Modo demostración · respuestas grabadas')).toBeTruthy();
    expect(screen.getByText('0 aprobaciones indebidas en 38 pruebas.')).toBeTruthy();
  });

  it('shows a prominent error when any unsafe approvals were measured', () => {
    const result = makeAvailableResult();
    if (result.status !== 'available') throw new Error('Expected available fixture');
    result.regression = { ...result.regression, unsafeApprovals: 1, safetyGate: 'failed' };
    result.safetyGate = 'failed';

    render(<Evaluacion result={result} />);

    expect(screen.getByRole('alert').textContent).toContain('Seguridad de regresión');
    expect(screen.getByRole('alert').getAttribute('data-state')).toBe('error');
    expect(document.querySelector('[aria-labelledby="eval-regression-title"]')?.getAttribute('data-state')).toBe('error');
  });

  it('treats an unsafe labeled replay result as an error too', () => {
    const result = makeAvailableResult();
    if (result.status !== 'available') throw new Error('Expected available fixture');
    result.labeled = { ...result.labeled, unsafeApprovals: 2, safetyGate: 'failed' };
    result.safetyGate = 'failed';

    render(<Evaluacion result={result} />);

    expect(screen.getByRole('alert').textContent).toContain('Conjunto etiquetado: se detectaron 2 aprobaciones indebidas.');
    expect(document.querySelector('[aria-labelledby="eval-labeled-title"]')?.getAttribute('data-state')).toBe('error');
  });

  it('labels live measurements unavailable without inventing zero values', () => {
    render(<Evaluacion result={makeAvailableResult()} />);
    const live = screen.getByRole('region', { name: 'Muestra en vivo' });

    expect(within(live).getByText('Sin muestra en vivo')).toBeTruthy();
    expect(live.textContent).not.toMatch(/\b0\b|ms|US\$/);
    expect(within(live).queryByRole('table')).toBeNull();
  });

  it('renders a supplied live sample separately from replay metrics', () => {
    const result = makeAvailableResult();
    if (result.status !== 'available') throw new Error('Expected available fixture');
    result.live = {
      status: 'available',
      mode: 'live',
      sample: 3,
      p50Ms: 923,
      costUsd: '0.0034',
      failures: 1,
    };

    render(<Evaluacion result={result} />);
    const live = screen.getByRole('region', { name: 'Muestra en vivo' });

    expect(within(live).getByText('923 ms')).toBeTruthy();
    expect(within(live).getByText('US$0.0034')).toBeTruthy();
    expect(within(live).getByText('3')).toBeTruthy();
    expect(within(live).getByText('1')).toBeTruthy();
    expect(screen.getByText('Modo demostración · respuestas grabadas')).toBeTruthy();
  });

  it('uses section headings and accessible table captions', () => {
    render(<Evaluacion result={makeAvailableResult()} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Evaluación' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Seguridad de regresión' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Conjunto etiquetado' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Evidencia de regresión' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Resultados del conjunto etiquetado' })).toBeTruthy();
  });

  it('shows a Spanish loading message', () => {
    render(<Evaluacion result={null} loading />);

    expect(screen.getByRole('status').textContent).toContain('Estamos preparando la evaluación.');
  });

  it('shows a Spanish error message', () => {
    render(<Evaluacion result={null} error="NetworkError" />);

    expect(screen.getByRole('alert').textContent).toContain('No pudimos cargar la evaluación. Inténtalo de nuevo.');
  });
});
