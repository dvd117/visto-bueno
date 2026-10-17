// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InvoiceRow } from '../../src/shared/api';
import { ActionBar } from '../../src/client/features/expediente/ActionBar';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function row(id: string, status: InvoiceRow['status']): InvoiceRow {
  return {
    id, payee: `Proveedor ${id}`, concept: 'Factura de prueba', amount: 'USD 10,00', amountUsd: 'USD 10,00',
    due: null, status, reason: 'Prueba.', sourceKind: 'text', country: 'CO', currency: 'USD',
  };
}

describe('payment action bar', () => {
  it('counts selected ready and approved invoices, then exports that safe subset', async () => {
    const fetchMock = vi.fn(async () => new Response('header\nrow', { status: 200 }));
    const createObjectURL = vi.fn(() => 'blob:export');
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    render(
      <ActionBar
        invoices={[
          row('AL-READY-IN', 'ready'), row('AL-READY-HELD', 'ready'), row('AL-APPROVED', 'approved'),
          row('AL-REVIEW', 'review_required'), row('AL-STOPPED', 'stopped'),
        ]}
        heldReadyIds={new Set(['AL-READY-HELD'])}
        busy={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Exportar lote de pago (2)' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/export/payments.csv?batch=1&ready=AL-READY-IN'));
    expect(click).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Exportar conciliación (CSV)' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/export/reconciliation.csv?batch=1&ready=AL-READY-IN'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('disables both exports when no ready or approved invoice is eligible', () => {
    render(<ActionBar invoices={[row('AL-REVIEW', 'review_required'), row('AL-STOPPED', 'stopped')]} heldReadyIds={new Set()} busy={false} />);

    expect((screen.getByRole('button', { name: 'Exportar lote de pago (0)' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Exportar conciliación (CSV)' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
