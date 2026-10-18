import { useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { CURRENCIES, CURRENCY_DEFINITIONS } from '../../../shared/domain/currencies';
import type { CompanyPreview, CompanyRecord } from '../../../shared/api';
import type {
  Budget, Contract, CostCenter, Currency, FxRate, Treasury, Vendor, VendorCountry,
} from '../../../shared/domain/types';
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
  { value: 'PE', label: 'Perú (PE)' }, { value: 'AR', label: 'Argentina (AR)' },
  { value: 'US', label: 'Estados Unidos (US)' },
];
const currencyLabels: Record<Currency, string> = {
  USD: 'Dólar estadounidense (USD)', COP: 'Peso colombiano (COP)', MXN: 'Peso mexicano (MXN)',
  CLP: 'Peso chileno (CLP)', PEN: 'Sol peruano (PEN)', ARS: 'Peso argentino (ARS)', VES: 'Bolívar venezolano (VES)',
};
const currencyOptions = CURRENCIES.map((value) => ({ value, label: currencyLabels[value] }));
const costCenterOptions = [
  { value: 'ingenieria', label: 'Ingeniería' }, { value: 'diseno', label: 'Diseño' },
  { value: 'operaciones', label: 'Operaciones' }, { value: 'legal', label: 'Legal' },
];

function minorToDecimal(minor: number, currency: Currency) {
  const exponent = CURRENCY_DEFINITIONS[currency].exponent;
  return new Decimal(minor).div(new Decimal(10).pow(exponent)).toFixed(exponent);
}

function decimalToMinor(value: string, currency: Currency) {
  const normalized = value.trim();
  const exponent = CURRENCY_DEFINITIONS[currency].exponent;
  const pattern = exponent === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${exponent}})?$`);
  if (!pattern.test(normalized)) throw new Error(`Usa un monto con hasta ${exponent} decimales para ${currency}.`);
  const minor = new Decimal(normalized).mul(new Decimal(10).pow(exponent));
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
  textColumn('amount', 'Monto fijo', (row) => row.amountMinor === undefined ? '' : minorToDecimal(row.amountMinor, row.currency), (row, value) => {
    const amountMinor = value.trim() === '' ? undefined : decimalToMinor(value, row.currency);
    return { ...row, amountMinor, ...(amountMinor === undefined ? {} : { rateMinor: undefined, unit: undefined, maxUnitsPerPeriod: undefined }) };
  }),
  textColumn('rate', 'Tarifa por unidad', (row) => row.rateMinor === undefined ? '' : minorToDecimal(row.rateMinor, row.currency), (row, value) => {
    const rateMinor = value.trim() === '' ? undefined : decimalToMinor(value, row.currency);
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
  textColumn('approvedUsdMinor', 'Presupuesto aprobado (USD)', (row) => minorToDecimal(row.approvedUsdMinor, 'USD'), (row, amount) => ({ ...row, approvedUsdMinor: decimalToMinor(amount, 'USD') })),
];

const treasuryColumns: Column<TreasuryEditorRow>[] = [
  textColumn('record', 'Registro', (row) => row.kind === 'balance' ? 'Saldo disponible' : 'Tipo de cambio', (row) => row, { editable: false }),
  textColumn('currency', 'Moneda', (row) => row.kind === 'balance' ? 'USD' : row.currency, (row, currency) => row.kind === 'fx' ? { ...row, currency: currency as Currency } : row, {
    options: currencyOptions, editable: (row) => row.kind === 'fx',
  }),
  textColumn('value', 'Valor', (row) => row.kind === 'balance' ? minorToDecimal(row.balanceUsdMinor, 'USD') : row.perUsd, (row, value) => {
    if (row.kind === 'balance') return { ...row, balanceUsdMinor: decimalToMinor(value, 'USD') };
    if (!/^\d+(?:\.\d+)?$/.test(value.trim()) || new Decimal(value).lessThanOrEqualTo(0)) {
      throw new Error('Usa una tasa decimal mayor que cero.');
    }
    return { ...row, perUsd: value.trim() };
  }),
  textColumn('date', 'Fecha de vigencia', (row) => row.kind === 'balance' ? '—' : row.date, (row, date) => row.kind === 'fx' ? { ...row, date } : row, {
    inputType: 'date', editable: (row) => row.kind === 'fx',
  }),
];

type CompanyFormValues = {
  name: string;
  operatingCountries: VendorCountry[];
  vendorCountries: VendorCountry[];
  currencies: Currency[];
  perPaymentUsd: string;
  monthlyUsd: string;
  approvalThresholdUsd: string;
};

type ImpactState =
  | { key: string; status: 'loading' | 'error' }
  | { key: string; status: 'ready'; result: CompanyPreview };

const impactRows: Array<{ key: keyof CompanyPreview['counts']; label: string }> = [
  { key: 'ready', label: 'listas' },
  { key: 'approval_required', label: 'requieren tu aprobación' },
  { key: 'review_required', label: 'requieren revisión' },
  { key: 'stopped', label: 'frenadas' },
];

const controlClass = 'datos-control w-full border border-line bg-page px-3 py-2 text-ink focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-ink';
const choiceClass = 'inline-flex min-h-11 cursor-pointer items-center gap-2 border border-line px-3 py-2 text-sm text-ink has-[:disabled]:cursor-default has-[:disabled]:text-soft focus-within:outline focus-within:outline-[3px] focus-within:outline-offset-2 focus-within:outline-ink';
const buttonClass = 'min-h-11 bg-ink px-4 py-2 font-semibold text-white focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50';

function formFromRecord(record: CompanyRecord): CompanyFormValues {
  return {
    name: record.name,
    operatingCountries: record.operatingCountries,
    vendorCountries: record.vendorCountries,
    currencies: record.currencies,
    perPaymentUsd: minorToDecimal(record.limits.perPaymentUsdMinor, 'USD'),
    monthlyUsd: minorToDecimal(record.limits.monthlyUsdMinor, 'USD'),
    approvalThresholdUsd: minorToDecimal(record.limits.approvalThresholdUsdMinor, 'USD'),
  };
}

function companyFromForm(form: CompanyFormValues): { company: CompanyRecord | null; error: string | null } {
  const name = form.name.trim();
  if (!name) return { company: null, error: 'Escribe el nombre de la empresa.' };
  if (form.operatingCountries.length === 0) return { company: null, error: 'Elige al menos un país donde opera.' };
  if (form.vendorCountries.length === 0) return { company: null, error: 'Elige al menos un país de proveedores.' };
  try {
    const limits = {
      perPaymentUsdMinor: decimalToMinor(form.perPaymentUsd, 'USD'),
      monthlyUsdMinor: decimalToMinor(form.monthlyUsd, 'USD'),
      approvalThresholdUsdMinor: decimalToMinor(form.approvalThresholdUsd, 'USD'),
    };
    if (limits.approvalThresholdUsdMinor >= limits.perPaymentUsdMinor) {
      return { company: null, error: 'Debe ser menor que el límite por pago.' };
    }
    return {
      company: {
        name,
        operatingCountries: [...form.operatingCountries].sort(),
        vendorCountries: [...form.vendorCountries].sort(),
        currencies: [...form.currencies].sort(),
        limits,
      },
      error: null,
    };
  } catch (cause) {
    return { company: null, error: cause instanceof Error ? cause.message : 'Revisa los montos.' };
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join('|') === [...b].sort().join('|');
}

function sameLimits(a: CompanyRecord['limits'], b: CompanyRecord['limits']): boolean {
  return a.perPaymentUsdMinor === b.perPaymentUsdMinor
    && a.monthlyUsdMinor === b.monthlyUsdMinor
    && a.approvalThresholdUsdMinor === b.approvalThresholdUsdMinor;
}

function sameCompany(a: CompanyRecord, b: CompanyRecord): boolean {
  return a.name === b.name
    && sameSet(a.operatingCountries, b.operatingCountries)
    && sameSet(a.vendorCountries, b.vendorCountries)
    && sameSet(a.currencies, b.currencies)
    && sameLimits(a.limits, b.limits);
}

function toggle<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function deltaLabel(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return '0';
}

function CompanyProfileSection({ api }: { api: DatosApi }) {
  const [company, setCompany] = useState<CompanyRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.getCompany()
      .then((record) => { if (active) setCompany(record); })
      .catch(() => { if (active) setLoadError('No pude cargar el perfil de la empresa. Recarga la página para intentarlo de nuevo.'); });
    return () => { active = false; };
  }, [api]);

  return (
    <section aria-labelledby="company-heading" className="mb-10 space-y-4 border-t-[3px] border-line-bold pt-4">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-soft">00 / PERFIL</p>
        <h2 id="company-heading" className="text-xl font-bold tracking-tight">Perfil de la empresa</h2>
        <p className="mt-1 max-w-2xl text-xs text-soft">Un cambio de límite desactualiza las facturas pendientes; tú las vuelves a evaluar. Ningún cambio de perfil aprueba una excepción ni libera una factura detenida.</p>
      </div>
      {loadError ? <p role="alert" className="text-stopped">{loadError}</p>
        : !company ? <p role="status" className="text-soft">Cargando perfil…</p>
          : <CompanyEditor api={api} initial={company} />}
    </section>
  );
}

function CompanyEditor({ api, initial }: { api: DatosApi; initial: CompanyRecord }) {
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState(() => formFromRecord(initial));
  const [impact, setImpact] = useState<ImpactState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const { company, error: validationError } = companyFromForm(form);
  const limitsKey = company ? JSON.stringify(company.limits) : null;
  const limitsChanged = company !== null && !sameLimits(company.limits, saved.limits);
  const changed = company !== null && !sameCompany(company, saved);
  const currentImpact = limitsChanged && impact?.key === limitsKey ? impact : null;
  const impactReady = currentImpact?.status === 'ready' ? currentImpact : null;
  const canSave = changed && !saving && (!limitsChanged || impactReady !== null);

  useEffect(() => {
    if (!company || !limitsChanged || !limitsKey) {
      setImpact(null);
      return undefined;
    }
    let active = true;
    setImpact({ key: limitsKey, status: 'loading' });
    api.previewCompany(company)
      .then((result) => { if (active) setImpact({ key: limitsKey, status: 'ready', result }); })
      .catch(() => { if (active) setImpact({ key: limitsKey, status: 'error' }); });
    return () => { active = false; };
    // Depends on the limits only, so name and country edits never re-run the preview.
  }, [api, limitsChanged, limitsKey]);

  async function save() {
    if (!company || !canSave) return;
    const staleCount = impactReady?.result.staleCount ?? 0;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const next = await api.saveCompany(company);
      setSaved(next);
      setForm(formFromRecord(next));
      setSaveMessage(limitsChanged
        ? `Perfil guardado. Quedaron ${staleCount} facturas pendientes desactualizadas; reevalúalas en la Bandeja.`
        : 'Perfil guardado.');
    } catch {
      setSaveError('No pude guardar el perfil. Tus cambios siguen sin aplicarse.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="grid gap-6 lg:grid-cols-2" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="space-y-5">
        <div className="space-y-1">
          <label className="block text-sm font-semibold" htmlFor="company-name">Nombre de la empresa</label>
          <input
            className={controlClass}
            disabled={saving}
            id="company-name"
            onChange={(event) => setForm({ ...form, name: event.currentTarget.value })}
            type="text"
            value={form.name}
          />
        </div>

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="text-sm font-semibold">Países donde opera</legend>
          <div className="flex flex-wrap gap-2">
            {countryOptions.map((option) => {
              const code = option.value as VendorCountry;
              return (
                <label className={choiceClass} key={option.value}>
                  <input
                    checked={form.operatingCountries.includes(code)}
                    onChange={() => setForm({ ...form, operatingCountries: toggle(form.operatingCountries, code) })}
                    type="checkbox"
                  />
                  {option.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="text-sm font-semibold">Países de proveedores</legend>
          <div className="flex flex-wrap gap-2">
            {countryOptions.map((option) => {
              const code = option.value as VendorCountry;
              return (
                <label className={choiceClass} key={option.value}>
                  <input
                    checked={form.vendorCountries.includes(code)}
                    onChange={() => setForm({ ...form, vendorCountries: toggle(form.vendorCountries, code) })}
                    type="checkbox"
                  />
                  {option.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="text-sm font-semibold">Monedas que paga</legend>
          <div className="flex flex-wrap gap-2">
            {currencyOptions.map((option) => {
              const base = option.value === 'USD';
              return (
                <label className={choiceClass} key={option.value}>
                  <input
                    checked={form.currencies.includes(option.value)}
                    disabled={base}
                    onChange={() => setForm({ ...form, currencies: toggle(form.currencies, option.value) })}
                    type="checkbox"
                  />
                  {option.label}{base ? ' · base' : ''}
                </label>
              );
            })}
          </div>
          <p className="text-xs text-soft">USD es la moneda base y siempre está activa. Países y monedas se guardan en el perfil; hoy solo los límites cambian las decisiones.</p>
        </fieldset>
      </div>

      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          {([
            ['perPaymentUsd', 'Límite por pago (USD)', 'company-payment-limit'],
            ['monthlyUsd', 'Límite mensual (USD)', 'company-monthly-limit'],
            ['approvalThresholdUsd', 'Umbral de aprobación humana (USD)', 'company-approval-threshold'],
          ] as const).map(([field, label, id]) => (
            <div className="space-y-1" key={field}>
              <label className="block text-sm font-semibold" htmlFor={id}>{label}</label>
              <input
                className={controlClass}
                disabled={saving}
                id={id}
                inputMode="decimal"
                onChange={(event) => setForm({ ...form, [field]: event.currentTarget.value })}
                type="text"
                value={form[field]}
              />
            </div>
          ))}
        </div>
        {validationError && <p role="alert" className="text-sm text-stopped">{validationError}</p>}

        <section aria-labelledby="company-impact-title" className="space-y-2 border border-line p-4">
          <h3 id="company-impact-title" className="text-sm font-bold">Impacto en la Bandeja</h3>
          {!limitsChanged && <p className="text-xs text-soft">Cambia un límite para ver cómo afecta a las facturas antes de guardar.</p>}
          {currentImpact?.status === 'loading' && <p role="status" className="text-xs text-soft">Calculando el impacto…</p>}
          {currentImpact?.status === 'error' && <p role="alert" className="text-xs text-stopped">No pude calcular el impacto. El perfil sigue sin guardar.</p>}
          {impactReady && (
            <div aria-live="polite" className="space-y-2 text-sm">
              <p>
                Con estos límites, tu bandeja queda así:{' '}
                {impactRows.map(({ key, label }, index) => (
                  <span key={key}>
                    {impactReady.result.counts[key]} {label} ({deltaLabel(impactReady.result.deltas[key])}){index < impactRows.length - 1 ? ' · ' : ''}
                  </span>
                ))}
              </p>
              <p>Facturas pendientes que quedan desactualizadas: {impactReady.result.staleCount}. Tú las vuelves a evaluar.</p>
            </div>
          )}
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button className={buttonClass} disabled={!canSave} type="submit">
            {saving ? 'Guardando…' : 'Guardar perfil'}
          </button>
          <div aria-live="polite" className="text-sm">
            {saveMessage && <p role="status" className="text-soft">{saveMessage}</p>}
            {saveError && <p role="alert" className="text-stopped">{saveError}</p>}
          </div>
        </div>
      </div>
    </form>
  );
}

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
        <p className="mt-2 max-w-2xl text-sm text-soft">Edita los registros que usa la evaluación. Los importes respetan los decimales propios de cada moneda; CLP usa pesos enteros.</p>
      </header>

      <CompanyProfileSection api={api} />

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
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-soft">04 / DISPONIBILIDAD</p>
                  <h2 id="treasury-heading" className="text-xl font-bold tracking-tight">Saldo y tipos de cambio</h2>
                  <p className="mt-1 text-xs text-soft">Tasas ilustrativas del demo, fijas y editables; no se consulta el mercado.</p>
                </div>
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
