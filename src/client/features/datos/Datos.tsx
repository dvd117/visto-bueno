import { useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import type { Budget, Contract, CostCenter, Currency, FxRate, Treasury, Vendor } from '../../../shared/domain/types';
import type {
  CsvTable, DataTable, DataTableValues, DatosApi,
} from '../../lib/api-types';
export type { CsvTable, DataRowMap, DataTable, DataTableValues, DataUploadResult, DatosApi } from '../../lib/api-types';
import './datos.css';

interface Column<T> {
  key: string;
  label: string;
  value(row: T): string;
  apply(row: T, value: string): T;
  inputType?: 'text' | 'date' | 'number';
  options?: readonly { value: string; label: string }[];
  editable?: boolean | ((row: T) => boolean);
}

type TreasuryEditorRow =
  | { kind: 'balance'; id: 'balance'; balanceUsdMinor: number }
  | ({ kind: 'fx'; id: string } & FxRate);

const countryOptions = [
  { value: 'CO', label: 'Colombia (CO)' }, { value: 'MX', label: 'México (MX)' },
  { value: 'VE', label: 'Venezuela (VE)' }, { value: 'CL', label: 'Chile (CL)' },
  { value: 'US', label: 'Estados Unidos (US)' },
];
const currencyOptions = [
  { value: 'USD', label: 'Dólar estadounidense (USD)' },
  { value: 'COP', label: 'Peso colombiano (COP)' },
  { value: 'MXN', label: 'Peso mexicano (MXN)' },
];
const costCenterOptions = [
  { value: 'ingenieria', label: 'Ingeniería' }, { value: 'diseno', label: 'Diseño' },
  { value: 'operaciones', label: 'Operaciones' }, { value: 'legal', label: 'Legal' },
];

function minorToDecimal(minor: number) {
  return new Decimal(minor).div(100).toFixed(2);
}

function decimalToMinor(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Usa un monto con hasta dos decimales, por ejemplo 850.00.');
  const minor = new Decimal(normalized).mul(100);
  if (!minor.isInteger() || minor.isNegative() || minor.greaterThan(Number.MAX_SAFE_INTEGER)) {
    throw new Error('El monto debe ser positivo y estar dentro del rango permitido.');
  }
  return minor.toNumber();
}

function integerValue(value: string, optional = false) {
  if (optional && value.trim() === '') return undefined;
  if (!/^\d+$/.test(value.trim())) throw new Error('Usa un número entero positivo.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('El número debe ser mayor que cero y estar dentro del rango permitido.');
  return parsed;
}

function EditableTable<T>({
  label,
  rows,
  rowKey,
  rowLabel,
  columns,
  onSave,
}: {
  label: string;
  rows: T[];
  rowKey(row: T): string;
  rowLabel(row: T): string;
  columns: Column<T>[];
  onSave(row: T, original: T): Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;

    const updateOverflow = () => setHasOverflow(scroller.scrollWidth > scroller.clientWidth);
    updateOverflow();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateOverflow);
    observer?.observe(scroller);
    const table = scroller.querySelector('table');
    if (table) observer?.observe(table);
    window.addEventListener('resize', updateOverflow);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateOverflow);
    };
  }, [rows]);

  return (
    <>
      <div ref={scrollRef} className="datos-table-scroll overflow-x-auto" data-overflowing={hasOverflow ? 'true' : undefined}>
        <table aria-label={label} className="datos-table w-full min-w-[760px] border-collapse text-left text-xs">
          <thead className="border-y-[3px] border-line-bold bg-wash text-[10px] font-bold uppercase tracking-[0.12em] text-soft">
            <tr>
              {columns.map((column) => <th key={column.key} scope="col" className="px-3 py-3">{column.label}</th>)}
              <th scope="col" className="px-3 py-3">Acción</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={columns.length + 1} className="border-b border-line px-3 py-5 text-soft">No hay registros todavía.</td></tr>
            ) : rows.map((row) => (
              <EditableRow
                key={rowKey(row)}
                row={row}
                label={rowLabel(row)}
                columns={columns}
                onSave={onSave}
              />
            ))}
          </tbody>
        </table>
      </div>
      {hasOverflow && <p className="datos-scroll-hint" role="note">Desliza para ver más columnas</p>}
    </>
  );
}

function EditableRow<T>({
  row,
  label,
  columns,
  onSave,
}: {
  row: T;
  label: string;
  columns: Column<T>[];
  onSave(row: T, original: T): Promise<void>;
}) {
  const [draft, setDraft] = useState(() => Object.fromEntries(columns.map((column) => [column.key, column.value(row)])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const changed = columns.reduce((current, column) => column.apply(current, draft[column.key] ?? column.value(row)), row);
      await onSave(changed, row);
      setDraft(Object.fromEntries(columns.map((column) => [column.key, column.value(changed)])));
    } catch {
      setError('No se pudieron guardar los cambios. Revisa los datos e inténtalo de nuevo.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-b border-line align-top">
      {columns.map((column) => {
        const editable = typeof column.editable === 'function' ? column.editable(row) : column.editable !== false;
        return <td key={column.key} className="min-w-32 px-3 py-2">
          {!editable ? (
            <span className="font-mono text-soft">{column.value(row)}</span>
          ) : column.options ? (
            <select
              aria-label={`${column.label} — ${label}`}
              className="datos-control w-full min-w-24 border border-line bg-page px-2 py-1 text-ink focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-ink"
              value={draft[column.key] ?? ''}
              style={{ minWidth: `${Math.max(12, (column.options.find((option) => option.value === draft[column.key])?.label ?? column.label).length + 4)}ch` }}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, [column.key]: value }));
              }}
            >
              {column.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : (
            <input
              aria-label={`${column.label} — ${label}`}
              className="datos-control w-full min-w-24 border border-line bg-page px-2 py-1 text-ink focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-ink"
              type={column.inputType ?? 'text'}
              value={draft[column.key] ?? ''}
              style={{ minWidth: `${Math.max(12, (draft[column.key] ?? column.value(row)).length + 4)}ch` }}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, [column.key]: value }));
              }}
            />
          )}
        </td>;
      })}
      <td className="whitespace-nowrap px-3 py-2">
        <button
          type="button"
          className="datos-save-button bg-ink px-3 py-2 font-semibold text-white focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-wait disabled:opacity-60"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? 'Guardando…' : `Guardar cambios de ${label}`}
        </button>
        {error && <p role="alert" className="mt-2 max-w-56 whitespace-normal text-stopped">{error}</p>}
      </td>
    </tr>
  );
}

function textColumn<T>(
  key: string,
  label: string,
  value: (row: T) => string,
  apply: (row: T, value: string) => T,
  options: Pick<Column<T>, 'editable' | 'inputType' | 'options'> = {},
): Column<T> {
  return { key, label, value, apply, ...options };
}

const vendorColumns: Column<Vendor>[] = [
  textColumn('id', 'ID', (row) => row.id, (row) => row, { editable: false }),
  textColumn('name', 'Proveedor', (row) => row.name, (row, name) => ({ ...row, name })),
  textColumn('taxId', 'Identificador fiscal', (row) => row.taxId, (row, taxId) => ({ ...row, taxId })),
  textColumn('country', 'País', (row) => row.country, (row, country) => ({ ...row, country: country as Vendor['country'] }), { options: countryOptions }),
  textColumn('payoutCurrency', 'Moneda de pago', (row) => row.payoutCurrency, (row, payoutCurrency) => ({ ...row, payoutCurrency: payoutCurrency as Currency }), { options: currencyOptions }),
  textColumn('payoutAccount', 'Cuenta de pago', (row) => row.payoutAccount, (row, payoutAccount) => ({ ...row, payoutAccount })),
  textColumn('status', 'Estado', (row) => row.status, (row, status) => ({ ...row, status: status as Vendor['status'] }), { options: [{ value: 'allowed', label: 'Permitido' }, { value: 'blocked', label: 'Bloqueado' }] }),
  textColumn('version', 'Versión', (row) => String(row.version), (row) => row, { editable: false }),
];

const contractColumns: Column<Contract>[] = [
  textColumn('id', 'ID', (row) => row.id, (row) => row, { editable: false }),
  textColumn('vendorId', 'Proveedor', (row) => row.vendorId, (row, vendorId) => ({ ...row, vendorId })),
  textColumn('scope', 'Alcance', (row) => row.scope, (row, scope) => ({ ...row, scope })),
  textColumn('type', 'Tipo', (row) => row.type, (row, type) => ({ ...row, type: type as Contract['type'] }), { options: [{ value: 'fixed', label: 'Fijo' }, { value: 'variable', label: 'Variable' }] }),
  textColumn('currency', 'Moneda', (row) => row.currency, (row, currency) => ({ ...row, currency: currency as Currency }), { options: currencyOptions }),
  textColumn('amount', 'Monto fijo', (row) => row.amountMinor === undefined ? '' : minorToDecimal(row.amountMinor), (row, value) => {
    const amountMinor = value.trim() === '' ? undefined : decimalToMinor(value);
    return { ...row, amountMinor, ...(amountMinor === undefined ? {} : { rateMinor: undefined, unit: undefined, maxUnitsPerPeriod: undefined }) };
  }),
  textColumn('rate', 'Tarifa por unidad', (row) => row.rateMinor === undefined ? '' : minorToDecimal(row.rateMinor), (row, value) => {
    const rateMinor = value.trim() === '' ? undefined : decimalToMinor(value);
    return { ...row, rateMinor, ...(rateMinor === undefined ? {} : { amountMinor: undefined }) };
  }),
  textColumn('unit', 'Unidad', (row) => row.unit ?? '', (row, unit) => ({ ...row, unit: unit.trim() || undefined })),
  textColumn('maxUnitsPerPeriod', 'Máximo de unidades', (row) => row.maxUnitsPerPeriod === undefined ? '' : String(row.maxUnitsPerPeriod), (row, value) => ({ ...row, maxUnitsPerPeriod: integerValue(value, true) }), { inputType: 'number' }),
  textColumn('billingFrequency', 'Frecuencia', (row) => row.billingFrequency, (row, billingFrequency) => ({ ...row, billingFrequency: billingFrequency as Contract['billingFrequency'] }), { options: [{ value: 'monthly', label: 'Mensual' }, { value: 'one_time', label: 'Una sola vez' }, { value: 'annual', label: 'Anual' }] }),
  textColumn('costCenter', 'Centro de costo', (row) => row.costCenter, (row, costCenter) => ({ ...row, costCenter: costCenter as CostCenter }), { options: costCenterOptions }),
  textColumn('start', 'Inicio', (row) => row.start, (row, start) => ({ ...row, start }), { inputType: 'date' }),
  textColumn('end', 'Fin', (row) => row.end, (row, end) => ({ ...row, end }), { inputType: 'date' }),
  textColumn('version', 'Versión', (row) => String(row.version), (row) => row, { editable: false }),
];

const budgetColumns: Column<Budget>[] = [
  textColumn('costCenter', 'Centro de costo', (row) => row.costCenter, (row, costCenter) => ({ ...row, costCenter: costCenter as CostCenter }), { options: costCenterOptions }),
  textColumn('month', 'Mes', (row) => row.month, (row, month) => ({ ...row, month })),
  textColumn('approvedUsdMinor', 'Presupuesto aprobado (USD)', (row) => minorToDecimal(row.approvedUsdMinor), (row, amount) => ({ ...row, approvedUsdMinor: decimalToMinor(amount) })),
];

const treasuryColumns: Column<TreasuryEditorRow>[] = [
  textColumn('record', 'Registro', (row) => row.kind === 'balance' ? 'Saldo disponible' : 'Tipo de cambio', (row) => row, { editable: false }),
  textColumn('currency', 'Moneda', (row) => row.kind === 'balance' ? 'USD' : row.currency, (row, currency) => row.kind === 'fx' ? { ...row, currency: currency as Currency } : row, {
    options: currencyOptions, editable: (row) => row.kind === 'fx',
  }),
  textColumn('value', 'Valor', (row) => row.kind === 'balance' ? minorToDecimal(row.balanceUsdMinor) : row.perUsd, (row, value) => {
    if (row.kind === 'balance') return { ...row, balanceUsdMinor: decimalToMinor(value) };
    if (!/^\d+(?:\.\d+)?$/.test(value.trim()) || new Decimal(value).lessThanOrEqualTo(0)) {
      throw new Error('Usa una tasa decimal mayor que cero.');
    }
    return { ...row, perUsd: value.trim() };
  }),
  textColumn('date', 'Fecha de vigencia', (row) => row.kind === 'balance' ? '—' : row.date, (row, date) => row.kind === 'fx' ? { ...row, date } : row, {
    inputType: 'date', editable: (row) => row.kind === 'fx',
  }),
];

export default function Datos({ api }: { api: DatosApi }) {
  const [tables, setTables] = useState<DataTableValues | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploadMessages, setUploadMessages] = useState<Partial<Record<CsvTable, { message: string; error: boolean }>>>({});

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.getTable('vendors'),
      api.getTable('contracts'),
      api.getTable('budgets'),
      api.getTable('treasury'),
    ]).then(([vendors, contracts, budgets, treasury]) => {
      if (active) {
        setTables({ vendors, contracts, budgets, treasury });
        setLoadError(null);
      }
    }).catch(() => {
      if (active) setLoadError('No se pudieron cargar las tablas. Inténtalo de nuevo más tarde.');
    });
    return () => { active = false; };
  }, [api]);

  async function saveVendor(row: Vendor) {
    const saved = await api.putRow('vendors', row);
    setTables((current) => current ? { ...current, vendors: current.vendors.map((item) => item.id === saved.id ? saved : item) } : current);
  }

  async function saveContract(row: Contract) {
    const saved = await api.putRow('contracts', row);
    setTables((current) => current ? { ...current, contracts: current.contracts.map((item) => item.id === saved.id ? saved : item) } : current);
  }

  async function saveBudget(row: Budget, original: Budget) {
    const saved = await api.putRow('budgets', row);
    setTables((current) => current ? { ...current, budgets: current.budgets.map((item) => item.costCenter === original.costCenter && item.month === original.month ? saved : item) } : current);
  }

  async function saveTreasury(next: Treasury) {
    const saved = await api.putRow('treasury', next);
    setTables((current) => current ? { ...current, treasury: saved } : current);
  }

  async function upload(table: CsvTable, resource: DataTable, file: File) {
    try {
      const result = await api.uploadCsv(table, file);
      if (!result.ok) {
        setUploadMessages((current) => ({ ...current, [table]: { message: result.error.message, error: true } }));
        return;
      }
      const refreshed = await api.getTable(resource);
      setTables((current) => current ? { ...current, [resource]: refreshed } as DataTableValues : current);
      setUploadMessages((current) => ({ ...current, [table]: { message: 'El CSV se cargó correctamente.', error: false } }));
    } catch {
      setUploadMessages((current) => ({ ...current, [table]: { message: 'No se pudo cargar el CSV. Inténtalo de nuevo.', error: true } }));
    }
  }

  async function saveTreasuryRow(row: TreasuryEditorRow, original: TreasuryEditorRow) {
    if (!tables) return;
    if (row.kind === 'balance' && original.kind === 'balance') {
      await saveTreasury({ ...tables.treasury, balanceUsdMinor: row.balanceUsdMinor });
    } else if (row.kind === 'fx' && original.kind === 'fx') {
      await saveTreasury({
        ...tables.treasury,
        fx: tables.treasury.fx.map((rate) => rate.currency === original.currency && rate.date === original.date
          ? { currency: row.currency, perUsd: row.perUsd, date: row.date }
          : rate),
      });
    }
  }

  function renderUpload(table: CsvTable, resource: DataTable, label: string) {
    const message = uploadMessages[table];
    return (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        <label className="inline-flex cursor-pointer items-center gap-2 border border-ink px-3 py-2 font-semibold text-ink focus-within:outline focus-within:outline-[3px] focus-within:outline-offset-2 focus-within:outline-ink">
          <span>Subir CSV</span>
          <input
            aria-label={`Subir CSV de ${label}`}
            className="sr-only"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void upload(table, resource, file);
              event.currentTarget.value = '';
            }}
          />
        </label>
        <a className="font-semibold text-ink underline underline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-ink" href={api.templateUrl(table)} download>
          Descargar plantilla CSV
        </a>
        {message && <p className={message.error ? 'basis-full text-stopped' : 'basis-full text-soft'} role={message.error ? 'alert' : 'status'}>{message.message}</p>}
      </div>
    );
  }

  return (
    <main className="datos-page mx-auto max-w-[1510px] px-4 py-8 text-ink sm:px-6">
      <header className="mb-8 border-b border-line pb-5">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-soft">03 / CONFIGURACIÓN DE DATOS</p>
        <h1 className="text-3xl font-extrabold tracking-tight">Preparar datos</h1>
        <p className="mt-2 max-w-2xl text-sm text-soft">Edita los registros que usa la evaluación. Los importes se guardan en centavos.</p>
      </header>

      {loadError ? <p role="alert" className="border-l-4 border-stopped py-2 pl-3 text-stopped">{loadError}</p>
        : !tables ? <p role="status" className="text-soft">Cargando datos…</p>
          : <div className="space-y-10">
            <section aria-labelledby="vendors-heading" className="space-y-4 border-t-[3px] border-line-bold pt-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-soft">01 / DIRECTORIO</p><h2 id="vendors-heading" className="text-xl font-bold tracking-tight">Proveedores</h2></div>
                {renderUpload('vendors', 'vendors', 'proveedores')}
              </div>
              <EditableTable label="Proveedores" rows={tables.vendors} rowKey={(row) => row.id} rowLabel={(row) => row.name} columns={vendorColumns} onSave={saveVendor} />
            </section>

            <section aria-labelledby="contracts-heading" className="space-y-4 border-t-[3px] border-line-bold pt-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-soft">02 / ACUERDOS</p><h2 id="contracts-heading" className="text-xl font-bold tracking-tight">Contratos</h2></div>
                {renderUpload('contracts', 'contracts', 'contratos')}
              </div>
              <EditableTable label="Contratos" rows={tables.contracts} rowKey={(row) => row.id} rowLabel={(row) => row.id} columns={contractColumns} onSave={saveContract} />
            </section>

            <section aria-labelledby="budgets-heading" className="space-y-4 border-t-[3px] border-line-bold pt-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-soft">03 / LÍMITES POR ÁREA</p><h2 id="budgets-heading" className="text-xl font-bold tracking-tight">Presupuestos</h2></div>
                {renderUpload('budgets', 'budgets', 'presupuestos')}
              </div>
              <EditableTable label="Presupuestos" rows={tables.budgets} rowKey={(row) => `${row.costCenter}-${row.month}`} rowLabel={(row) => `${row.costCenter} · ${row.month}`} columns={budgetColumns} onSave={saveBudget} />
            </section>

            <section aria-labelledby="treasury-heading" className="space-y-4 border-t-[3px] border-line-bold pt-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-soft">04 / DISPONIBILIDAD</p><h2 id="treasury-heading" className="text-xl font-bold tracking-tight">Saldo y tipos de cambio</h2></div>
                {renderUpload('fx', 'treasury', 'tipos de cambio')}
              </div>
              <EditableTable
                label="Saldo y tipos de cambio"
                rows={[
                  { kind: 'balance' as const, id: 'balance' as const, balanceUsdMinor: tables.treasury.balanceUsdMinor },
                  ...tables.treasury.fx.map((rate) => ({ ...rate, kind: 'fx' as const, id: `fx-${rate.currency}-${rate.date}` })),
                ]}
                rowKey={(row) => row.id}
                rowLabel={(row) => row.kind === 'balance' ? 'Saldo disponible' : `${row.currency} · ${row.date}`}
                columns={treasuryColumns}
                onSave={saveTreasuryRow}
              />
            </section>
          </div>}
    </main>
  );
}
