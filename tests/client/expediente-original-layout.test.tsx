import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Expediente as ExpedienteData, InvoiceRow } from '../../src/shared/api';
import { Expediente } from '../../src/client/features/expediente/Expediente';

afterEach(cleanup);

function makeExpediente(sourceKind: InvoiceRow['sourceKind'], id = 'AL-042'): ExpedienteData {
  const row: InvoiceRow = {
    id, payee: 'Nube Andina S. de R.L.', concept: 'Hosting octubre',
    country: 'MX', currency: 'USD', amount: 'USD 850,00', amountUsd: 'USD 850,00',
    due: '25 oct', status: 'stopped', reason: 'La cuenta bancaria no coincide.', sourceKind,
  };
  return {
    row, record: null,
    comparison: [{ field: 'Cuenta bancaria', invoice: '···· 4412', record: '···· 8890', differs: true }],
    sourceText: 'Cuenta bancaria ···· 4412', marks: [],
    fileUrl: sourceKind === 'pdf' || sourceKind === 'image' ? `/api/files/${id}` : null,
    history: [],
  };
}

function expedienteView(expediente: ExpedienteData) {
  return (
    <Expediente
      rows={[expediente.row]} selectedStatus={expediente.row.status}
      expediente={expediente} loading={false} error={null} busy={false}
      includedInPaymentBatch={false}
      onApprove={async () => undefined} onReject={async () => undefined}
      onResolveFlag={async () => undefined} onReevaluate={async () => undefined}
      onSelectStatus={() => undefined} onTogglePaymentBatch={() => undefined} onOpenData={() => undefined}
    />
  );
}

function renderExpediente(expediente: ExpedienteData) {
  return render(expedienteView(expediente));
}

describe('Expediente original document layout', () => {
  it('shows the original PDF beside the comparison without a tab click', () => {
    renderExpediente(makeExpediente('pdf'));

    const originalTab = screen.getByRole('tab', { name: 'Documento original' });
    const originalPanel = document.getElementById(originalTab.getAttribute('aria-controls')!);
    const evidenceGrid = document.querySelector('.record-evidence-grid');

    expect(originalTab.getAttribute('aria-selected')).toBe('true');
    expect(originalPanel?.hasAttribute('hidden')).toBe(false);
    expect(originalPanel?.querySelector('iframe')?.getAttribute('src')).toBe('/api/files/AL-042');
    expect(screen.getByRole('link', { name: 'Abrir PDF original' }).getAttribute('href')).toBe('/api/files/AL-042');
    expect(screen.getByRole('table', { name: 'Comparación con tus registros' })).toBeTruthy();
    expect(evidenceGrid?.children).toHaveLength(2);
  });

  it('preserves switching between the original image and extracted text', () => {
    renderExpediente(makeExpediente('image'));

    const originalTab = screen.getByRole('tab', { name: 'Documento original' });
    const textTab = screen.getByRole('tab', { name: 'Texto que leyó el agente' });
    const originalPanel = document.getElementById(originalTab.getAttribute('aria-controls')!);
    const textPanel = document.getElementById(textTab.getAttribute('aria-controls')!);

    fireEvent.click(originalTab);
    expect(originalTab.getAttribute('aria-selected')).toBe('true');
    expect(originalPanel?.querySelector('img')?.getAttribute('src')).toBe('/api/files/AL-042');
    fireEvent.click(textTab);
    expect(textTab.getAttribute('aria-selected')).toBe('true');
    expect(textPanel?.textContent).toContain('Cuenta bancaria ···· 4412');
    expect(originalPanel?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(originalTab);
    expect(originalTab.getAttribute('aria-selected')).toBe('true');
    expect(originalPanel?.hasAttribute('hidden')).toBe(false);
  });

  it('keeps the extracted text selected when no original file exists', () => {
    renderExpediente(makeExpediente('text'));

    expect(screen.getByRole('tab', { name: 'Texto que leyó el agente' }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.document-text')?.textContent).toContain('Cuenta bancaria ···· 4412');
  });

  it('returns to the original when a different invoice is selected', () => {
    const first = makeExpediente('pdf');
    const { rerender } = renderExpediente(first);
    fireEvent.click(screen.getByRole('tab', { name: 'Texto que leyó el agente' }));

    rerender(expedienteView(makeExpediente('image', 'AL-036')));

    const originalTab = screen.getByRole('tab', { name: 'Documento original' });
    expect(originalTab.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.original-image')?.getAttribute('src')).toBe('/api/files/AL-036');
  });
});
