import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecibirPanel, type RecibirApi } from '../../src/client/features/recibir/RecibirPanel';

// Synthetic test fixture only; calls stay inside the stub API below.
const invoice = {
  id: 'invoice-qa',
  payee: 'Andina Labs',
  concept: 'Prueba sintética',
  amount: 'USD 10,00',
  amountUsd: 'US$ 10,00',
  due: '2026-10-20',
  status: 'queued',
  reason: '',
  sourceKind: 'pdf',
} as const;

async function* noEvents() {}

function createApi(): RecibirApi {
  return {
    createInvoiceText: vi.fn(async () => ({ ...invoice, sourceKind: 'text' })),
    createInvoiceFile: vi.fn(async () => invoice),
    process: vi.fn(() => noEvents()),
  };
}

afterEach(() => cleanup());

describe('RecibirPanel file picker QA', () => {
  it('keeps one labelled keyboard-operable picker and announces the selected file', async () => {
    const api = createApi();
    const { container } = render(<RecibirPanel open onClose={vi.fn()} api={api} />);
    const picker = screen.getByLabelText('Seleccionar PDF o imagen') as HTMLInputElement;
    const label = screen.getByText('Seleccionar PDF o imagen') as HTMLLabelElement;

    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(picker.name).toBe('invoice-file');
    expect(picker.accept).toBe('.pdf,image/*');
    expect(label.htmlFor).toBe(picker.id);
    expect(label.tabIndex).toBe(-1);
    expect(picker.tabIndex).toBe(0);

    const activated = vi.fn();
    picker.addEventListener('click', activated);
    fireEvent.click(label);
    expect(activated).toHaveBeenCalledOnce();

    picker.focus();
    expect(document.activeElement).toBe(picker);

    const file = new File(['synthetic fixture'], 'andina-demo.pdf', { type: 'application/pdf' });
    fireEvent.change(picker, { target: { files: [file] } });
    expect(picker.value).toBe('');
    expect((await screen.findByRole('status')).textContent).toBe('Archivo seleccionado: andina-demo.pdf');
    expect(picker.getAttribute('aria-describedby')).toBe('recibir-file-status');

    await waitFor(() => expect(api.createInvoiceFile).toHaveBeenCalledWith(file));
    expect(api.process).toHaveBeenCalledWith(['invoice-qa'], 'live');
  });
});
