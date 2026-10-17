import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../src/shared/api';
import { Bitacora } from '../../src/client/features/bitacora/Bitacora';

const entries: LogEntry[] = [
  {
    at: '2026-10-16T21:01:00.000Z',
    invoiceId: 'invoice-approved',
    status: 'approved',
    headline: 'Aprobada por María',
    seal: '2b91dc',
    by: 'María',
  },
  {
    at: '2026-10-16T21:00:00.000Z',
    invoiceId: 'invoice-ready',
    status: 'ready',
    headline: 'Decisión de Nube Andina',
    seal: '8f3a1c',
    by: null,
  },
];

const api = {
  getLog: vi.fn().mockResolvedValue(entries),
  exportPaymentsCsv: vi.fn().mockResolvedValue(''),
  exportLogCsv: vi.fn().mockResolvedValue(''),
  exportReportMd: vi.fn().mockResolvedValue(''),
};

describe('Bitacora', () => {
  it('renders chronological entries with their seals and Spanish status labels', async () => {
    render(<Bitacora api={api} />);

    expect(await screen.findByText('Decisión de Nube Andina')).toBeTruthy();
    expect(screen.getByText('Lista para pagar')).toBeTruthy();
    expect(screen.getByText('Sello #8f3a1c')).toBeTruthy();
    expect(screen.getByText('Aprobada por María')).toBeTruthy();
    expect(screen.getByText('Aprobada')).toBeTruthy();
    expect(screen.getByText('Sello #2b91dc')).toBeTruthy();
    const renderedEntries = screen.getAllByRole('listitem');
    expect(renderedEntries[0].textContent).toContain('invoice-ready');
    expect(renderedEntries[1].textContent).toContain('invoice-approved');
    expect(screen.getByRole('button', { name: 'Lote de pagos autorizados (CSV para Blinka)' })).toBeTruthy();
    expect(api.getLog).toHaveBeenCalledOnce();
  });
});
