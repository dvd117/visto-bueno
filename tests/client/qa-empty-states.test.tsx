import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Counters } from '../../src/shared/api';
import { Bandeja } from '../../src/client/features/bandeja/Bandeja';
import { Expediente } from '../../src/client/features/expediente/Expediente';
import { FirstRunHint } from '../../src/client/features/ayuda/FirstRunHint';

const emptyCounters: Counters = {
  ready: 0,
  approval_required: 0,
  review_required: 0,
  stopped: 0,
  approved: 0,
  rejected: 0,
  stale: 0,
  queued: 0,
};

function renderEmptyBandeja(onReceive?: () => void) {
  return render(
    <Bandeja
      rows={[]}
      selectedId={null}
      counters={emptyCounters}
      processing={false}
      rowRevisions={{}}
      onSelect={vi.fn()}
      onProcess={vi.fn()}
      onReceive={onReceive}
      onDropFiles={vi.fn()}
    />,
  );
}

function renderEmptyExpediente() {
  return render(
    <Expediente
      expediente={null}
      loading={false}
      error={null}
      busy={false}
      onApprove={vi.fn(async () => {})}
      onReject={vi.fn(async () => {})}
      onResolveFlag={vi.fn(async () => {})}
      onReevaluate={vi.fn(async () => {})}
    />,
  );
}

afterEach(() => cleanup());

describe('empty states', () => {
  it('explains how to start from an empty inbox without a dead action', () => {
    const { container } = renderEmptyBandeja();
    const emptyState = container.querySelector('.empty-list');

    expect(emptyState).not.toBeNull();
    expect(within(emptyState as HTMLElement).getByText('Para empezar, recibe una factura y revisa su expediente.')).toBeTruthy();
    expect(within(emptyState as HTMLElement).queryByRole('button')).toBeNull();
    expect(within(emptyState as HTMLElement).queryByRole('link')).toBeNull();
  });

  it('shows the existing receive action and calls it when provided', () => {
    const onReceive = vi.fn();
    const { container } = renderEmptyBandeja(onReceive);

    const emptyState = container.querySelector('.empty-list');
    const receiveButton = within(emptyState as HTMLElement).getByRole('button', { name: 'Recibir una factura' });
    fireEvent.click(receiveButton);
    expect(onReceive).toHaveBeenCalledOnce();
  });

  it('guides the user to select a real invoice when no expediente is selected', () => {
    renderEmptyExpediente();

    const region = screen.getByRole('region', { name: 'Expediente de factura' });
    expect(within(region).getByText('Selecciona una factura en la bandeja para revisar sus datos, comprobaciones y decisión.')).toBeTruthy();
    expect(within(region).queryByText(/Nube Andina|AL-\d{3}|US\$/)).toBeNull();
    expect(within(region).queryByRole('button')).toBeNull();
  });
});

describe('FirstRunHint', () => {
  it('is absent when closed and shows an accessible three-step orientation when open', () => {
    const { rerender } = render(<FirstRunHint open={false} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Orientación de inicio' })).toBeNull();

    rerender(<FirstRunHint open onDismiss={vi.fn()} />);
    const hint = screen.getByRole('region', { name: 'Orientación de inicio' });
    expect(within(hint).getByText(/Andina Labs paga a 10 proveedores en 5 países/i)).toBeTruthy();
    expect(within(hint).getByText(/Tú revisas las excepciones antes de decidir/i)).toBeTruthy();
    expect(within(hint).getByText(/Visto Bueno no hace pagos/i)).toBeTruthy();
    expect(within(hint).getByText('Preparar datos')).toBeTruthy();
    expect(within(hint).getByText('Revisar reglas')).toBeTruthy();
    expect(within(hint).getByText('Recibir una factura')).toBeTruthy();
  });

  it('omits unavailable actions and fires only the supplied callbacks', () => {
    const { rerender } = render(<FirstRunHint open onDismiss={vi.fn()} />);
    const hint = screen.getByRole('region', { name: 'Orientación de inicio' });
    expect(within(hint).getAllByRole('button')).toHaveLength(1);
    expect(within(hint).getByRole('button', { name: 'Cerrar orientación inicial' })).toBeTruthy();

    const onOpenData = vi.fn();
    const onOpenRules = vi.fn();
    const onReceiveInvoice = vi.fn();
    rerender(
      <FirstRunHint
        open
        onDismiss={vi.fn()}
        onOpenData={onOpenData}
        onOpenRules={onOpenRules}
        onReceiveInvoice={onReceiveInvoice}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preparar datos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revisar reglas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recibir una factura' }));
    expect(onOpenData).toHaveBeenCalledOnce();
    expect(onOpenRules).toHaveBeenCalledOnce();
    expect(onReceiveInvoice).toHaveBeenCalledOnce();
  });

  it('dismisses from its button or Escape without trapping or moving focus', () => {
    const outsideButton = document.createElement('button');
    outsideButton.textContent = 'Acción de la página';
    document.body.append(outsideButton);
    outsideButton.focus();
    const onDismiss = vi.fn();
    const { rerender } = render(<FirstRunHint open onDismiss={onDismiss} />);

    expect(document.activeElement).toBe(outsideButton);
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    outsideButton.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar orientación inicial' }));
    expect(onDismiss).toHaveBeenCalledOnce();

    rerender(<FirstRunHint open onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    outsideButton.remove();
  });
});
