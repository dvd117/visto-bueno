import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Counters, Expediente as ExpedienteData, InvoiceRow } from '../../src/shared/api';
import { Bandeja } from '../../src/client/features/bandeja/Bandeja';
import Datos, { type DatosApi, type DataTable, type DataRowMap, type DataTableValues } from '../../src/client/features/datos/Datos';
import { Expediente } from '../../src/client/features/expediente/Expediente';

afterEach(cleanup);

const counters: Counters = {
  ready: 0, approval_required: 0, review_required: 0, stopped: 0,
  approved: 0, rejected: 0, stale: 0, queued: 1,
};

function makeRow(): InvoiceRow {
  return {
    id: 'AL-030', payee: 'Nube Andina S.A.S.', concept: 'Hosting octubre',
    country: 'CO', currency: 'USD',
    amount: 'USD 780,00', amountUsd: 'USD 780,00', due: '25 oct', status: 'ready',
    reason: 'Evaluación completada.', sourceKind: 'text',
  };
}

describe('integrated visual QA fixes', () => {
  it('renders the formatted USD equivalent without adding a second currency code', () => {
    const row = makeRow();
    const { container } = render(
      <Bandeja
        rows={[row]} selectedId={row.id} counters={counters} processing={false} rowRevisions={{}}
        onSelect={() => undefined} onProcess={() => undefined} onDropFiles={() => undefined}
      />,
    );

    expect(container.querySelector('.invoice-value')?.textContent).toBe('USD 780,00USD 780,00');
    expect(screen.queryByText('US$USD 780,00')).toBeNull();
  });

  it('labels a missing registered value as unavailable rather than as a match', () => {
    const expediente: ExpedienteData = {
      row: makeRow(), record: null,
      comparison: [{ field: 'Beneficiario', invoice: 'Nube Andina S.A.S.', record: null, differs: true }],
      sourceText: null, marks: [], fileUrl: null, history: [],
    };
    render(
      <Expediente
        expediente={expediente} loading={false} error={null} busy={false}
        onApprove={async () => undefined} onReject={async () => undefined}
        onResolveFlag={async () => undefined} onReevaluate={async () => undefined}
      />,
    );

    expect(screen.getByText('Sin registro')).toBeTruthy();
    expect(document.querySelector('.section-note')?.textContent).toContain('1 sin registro');
    expect(screen.queryByText('No coincide')).toBeNull();
  });

  it('shows an accessible scroll hint only when a data table overflows', async () => {
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    let overflowing = true;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return (this as HTMLElement).classList?.contains('datos-table-scroll') ? 300 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get() { return (this as HTMLElement).classList?.contains('datos-table-scroll') ? (overflowing ? 760 : 300) : 0; },
    });

    const data: DataTableValues = {
      vendors: [], contracts: [], budgets: [], treasury: { balanceUsdMinor: 0, fx: [] },
    };
    const api: DatosApi = {
      getTable: vi.fn(async (table: DataTable) => data[table]) as DatosApi['getTable'],
      putRow: vi.fn(async (_table: DataTable, row: DataRowMap[DataTable]) => row) as DatosApi['putRow'],
      uploadCsv: vi.fn(async () => ({ ok: true })),
      templateUrl: (table) => `/api/data/templates/${table}.csv`,
    };

    try {
      const { container, unmount } = render(<Datos api={api} />);
      await waitFor(() => expect(screen.getAllByText('Desliza para ver más columnas').length).toBe(4));
      expect(container.querySelector('.datos-table-scroll')?.classList.contains('overflow-x-auto')).toBe(true);

      unmount();
      overflowing = false;
      render(<Datos api={api} />);
      await screen.findByRole('table', { name: 'Proveedores' });
      expect(screen.queryByText('Desliza para ver más columnas')).toBeNull();
    } finally {
      if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
      if (originalScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
    }
  });
});
