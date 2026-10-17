import Decimal from 'decimal.js';
import type { LogEntry } from '../../shared/api';
import type { DecisionRecord, InvoiceStatus, Money, Vendor } from '../../shared/domain/types';

export interface PaymentExportItem {
  record: DecisionRecord;
  status: InvoiceStatus;
  vendor: Pick<Vendor, 'taxId' | 'payoutAccount' | 'payoutCurrency'>;
  amountOriginal: Money;
  amountUsd: Money & { currency: 'USD' };
  authorizedBy: string | null;
}

const PAYMENT_HEADER = 'vendor_tax_id,payout_account,payout_currency,amount_original,amount_usd,decision_id,authorized_by,seal';
const RECONCILIATION_HEADER = 'invoice_id,status,decision_reason,check_reasons,vendor_tax_id,payout_account,payout_currency,amount_original,currency_original,amount_usd,rules_version,vendor_version,contract_version,fx_date,authorized_by,decision_id,seal';
const LOG_HEADER = 'at,invoice_id,status,headline,by,seal';

function csvCell(value: string): string {
  // Spreadsheet apps may execute formula prefixes even inside quoted CSV cells.
  const safeValue = /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value)
    ? `'${value}`
    : value;
  return /[",\r\n\t]/.test(safeValue) ? `"${safeValue.replaceAll('"', '""')}"` : safeValue;
}

function csvRow(values: string[]): string {
  return values.map(csvCell).join(',');
}

function amountText(amount: Money): string {
  return new Decimal(amount.minor).dividedBy(100).toFixed(2);
}

function chronological<T extends { at: string }>(records: T[]): T[] {
  return records
    .map((record, index) => ({ record, index, timestamp: Date.parse(record.at) }))
    .sort((left, right) => {
      if (Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp) && left.timestamp !== right.timestamp) {
        return left.timestamp - right.timestamp;
      }
      return left.record.at.localeCompare(right.record.at) || left.index - right.index;
    })
    .map(({ record }) => record);
}

function eligiblePayments(items: PaymentExportItem[], includedReadyIds?: ReadonlySet<string>): PaymentExportItem[] {
  return items.filter((item) => item.status === 'approved'
    || (item.status === 'ready' && (!includedReadyIds || includedReadyIds.has(item.record.invoiceId))));
}

export function paymentsCsv(items: PaymentExportItem[], includedReadyIds?: ReadonlySet<string>): string {
  const rows = eligiblePayments(items, includedReadyIds).map(({ record, vendor, amountOriginal, amountUsd, authorizedBy }) => csvRow([
      vendor.taxId,
      vendor.payoutAccount,
      vendor.payoutCurrency,
      amountText(amountOriginal),
      amountText(amountUsd),
      record.id,
      authorizedBy ?? '',
      record.seal,
  ]));

  return [PAYMENT_HEADER, ...rows].join('\n');
}

export function reconciliationCsv(items: PaymentExportItem[], includedReadyIds?: ReadonlySet<string>): string {
  const rows = eligiblePayments(items, includedReadyIds).map(({ record, status, vendor, amountOriginal, amountUsd, authorizedBy }) => csvRow([
    record.invoiceId,
    status,
    record.decision.headline,
    record.decision.checks.map((check) => `${check.id} (${check.outcome}) ${check.reason}`).join('; '),
    vendor.taxId,
    vendor.payoutAccount,
    vendor.payoutCurrency,
    amountText(amountOriginal),
    amountOriginal.currency,
    amountText(amountUsd),
    String(record.rulesSnapshot.version),
    record.dataVersions.vendor === undefined ? '' : String(record.dataVersions.vendor),
    record.dataVersions.contract === undefined ? '' : String(record.dataVersions.contract),
    record.dataVersions.fxDate,
    authorizedBy ?? '',
    record.id,
    record.seal,
  ]));

  return [RECONCILIATION_HEADER, ...rows].join('\n');
}

export function logCsv(records: LogEntry[]): string {
  const rows = chronological(records).map((record) => csvRow([
    record.at,
    record.invoiceId,
    record.status,
    record.headline,
    record.by ?? '',
    record.seal,
  ]));

  return [LOG_HEADER, ...rows].join('\n');
}

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  queued: 'En espera',
  ready: 'Lista para pagar',
  approval_required: 'Requiere tu aprobación',
  review_required: 'Requiere revisión',
  stopped: 'Frenada',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  stale: 'Desactualizada',
};

export function reportMd(records: LogEntry[]): string {
  const entries = chronological(records).map((record) => [
    `## ${record.headline}`,
    '',
    `- Factura: ${record.invoiceId}`,
    `- Fecha: ${record.at}`,
    `- Estado: ${STATUS_LABELS[record.status]}`,
    `- Responsable: ${record.by ?? 'No registrado'}`,
    `- Sello: \`${record.seal}\``,
  ].join('\n'));

  return ['# Bitácora de decisiones', ...entries].join('\n\n');
}
