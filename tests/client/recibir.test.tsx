import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecibirPanel, type RecibirApi } from '../../src/client/features/recibir/RecibirPanel';
import type { ProcessRequest } from '../../src/shared/api';
import { invoiceTemplates } from '../../src/shared/templates';

const invoice = {
  id: 'invoice-1',
  payee: 'Estudio Bruma S.A.S.',
  country: 'CO',
  currency: 'COP',
  concept: 'Diseño UX, octubre',
  amount: 'COP 4.800.000,00',
  amountUsd: 'US$ 1.150,72',
  due: '2026-10-20',
  status: 'queued',
  reason: '',
  sourceKind: 'text',
} as const;

async function* noEvents() {}

function createApi(overrides: Partial<RecibirApi> = {}): RecibirApi {
  return {
    createInvoiceText: vi.fn(async (_text: string) => invoice),
    createInvoiceFile: vi.fn(async (_file: File) => ({ ...invoice, sourceKind: 'pdf' })),
    process: vi.fn((_request: ProcessRequest) => noEvents()),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('RecibirPanel', () => {
  it('does not render while closed and closes on request', () => {
    const onClose = vi.fn();
    const api = createApi();

    const { rerender } = render(<RecibirPanel open={false} onClose={onClose} api={api} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<RecibirPanel open onClose={onClose} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar panel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows the test-data warning and live mode', () => {
    render(<RecibirPanel open onClose={vi.fn()} api={createApi()} />);

    expect(screen.getByText('Demo con datos de prueba. No subas facturas reales.')).toBeTruthy();
    expect(screen.getByText(/Modo en vivo/)).toBeTruthy();
  });

  for (const template of invoiceTemplates) {
    it(`loads and lets you edit “${template.label}”`, () => {
      render(<RecibirPanel open onClose={vi.fn()} api={createApi()} />);

      fireEvent.click(screen.getByRole('button', { name: template.label }));
      const textarea = screen.getByLabelText('Texto de la factura') as HTMLTextAreaElement;
      expect(textarea.value).toBe(template.content);

      const edited = `${textarea.value}\nNota editable.`;
      fireEvent.change(textarea, { target: { value: edited } });
      expect(textarea.value).toBe(edited);
    });
  }

  it('uses the Valentina seed values for the legitimate COP template', () => {
    const template = invoiceTemplates.find(({ id }) => id === 'legitimate-cop');
    expect(template?.content).toContain('Beneficiaria: Estudio Bruma S.A.S.');
    expect(template?.content).toContain('NIT: 900.123.456-7');
    expect(template?.content).toContain('Cuenta Banco Ventaluz ···· 7712');
    expect(template?.content).toContain('Monto total: COP 4.800.000,00');
    expect(template?.content).toContain('Período: noviembre de 2026');
  });

  it('labels every live template with its vendor country and invoice currency', () => {
    expect(invoiceTemplates.map(({ label }) => label)).toEqual([
      'Cobro por WhatsApp con urgencia · MX · USD',
      'Intento de manipulación (prompt injection) · CL · USD',
      'Cuenta de cobro legítima en COP · CO · COP',
    ]);
  });

  it('creates pasted text and processes its id in live mode', async () => {
    const calls: string[] = [];
    const api = createApi({
      createInvoiceText: vi.fn(async (_text: string) => {
        calls.push('create');
        return invoice;
      }),
      process: vi.fn((request: ProcessRequest) => {
        calls.push('process');
        expect(request).toEqual({ ids: [invoice.id], mode: 'live' });
        return noEvents();
      }),
    });
    render(<RecibirPanel open onClose={vi.fn()} api={api} />);

    fireEvent.change(screen.getByLabelText('Texto de la factura'), {
      target: { value: 'Factura de prueba de Andina Labs.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar y evaluar en vivo' }));

    await waitFor(() => expect(api.process).toHaveBeenCalledOnce());
    expect(api.createInvoiceText).toHaveBeenCalledWith('Factura de prueba de Andina Labs.');
    expect(calls).toEqual(['create', 'process']);
  });

  it('uploads a dropped PDF and processes its id in live mode', async () => {
    const file = new File(['contenido ficticio'], 'factura.pdf', { type: 'application/pdf' });
    const api = createApi();
    render(<RecibirPanel open onClose={vi.fn()} api={api} />);

    fireEvent.drop(screen.getByRole('region', { name: 'Zona para soltar facturas' }), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(api.createInvoiceFile).toHaveBeenCalledWith(file));
    expect(api.process).toHaveBeenCalledWith({ ids: [invoice.id], mode: 'live' });
  });

  it('shows the demo limit message when the API returns 429', async () => {
    const error = Object.assign(new Error('too many requests'), { status: 429 });
    const api = createApi({ createInvoiceText: vi.fn(async () => Promise.reject(error)) });
    render(<RecibirPanel open onClose={vi.fn()} api={api} />);
    fireEvent.change(screen.getByLabelText('Texto de la factura'), { target: { value: 'Texto de prueba.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar y evaluar en vivo' }));

    expect(await screen.findByText('Límite del demo alcanzado, intenta en un minuto')).toBeTruthy();
  });

  it('runs the queued example set in replay mode', async () => {
    const api = createApi();
    render(<RecibirPanel open onClose={vi.fn()} api={api} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar facturas de ejemplo' }));

    await waitFor(() => expect(api.process).toHaveBeenCalledWith({ mode: 'replay', examples: true }));
  });
});
