import type { Comparison, Counters, Expediente, InvoiceRow } from '../shared/api';
import type { DecisionRecord, Money } from '../shared/domain/types';
import { formatMoney, parseAmount } from '../shared/domain/money';
import { getDecisionHistory, listInvoices, type Db, type StoredInvoice } from './db/db';

function amountText(invoice: StoredInvoice): string {
  const claims = invoice.extraction?.ok ? invoice.extraction.claims : null;
  if (!claims?.amountRaw) return '—';
  const currency = claims.currency === 'USD' || claims.currency === 'COP' || claims.currency === 'MXN'
    ? claims.currency
    : null;
  if (!currency) return claims.amountRaw;
  const parsed = parseAmount(claims.amountRaw, { currency });
  return parsed.ok ? formatMoney(parsed.money) : claims.amountRaw;
}

export function toInvoiceRow(invoice: StoredInvoice): InvoiceRow {
  const extraction = invoice.extraction?.ok ? invoice.extraction : null;
  const decision = invoice.latestRecord?.decision;
  return {
    id: invoice.id,
    payee: extraction?.claims.payeeName ?? 'Proveedor por identificar',
    concept: extraction?.claims.description?.trim() || invoice.sourceText?.trim().slice(0, 120) || 'Factura recibida',
    amount: amountText(invoice),
    amountUsd: invoice.amountUsdMinor === null ? null : formatMoney({ currency: 'USD', minor: invoice.amountUsdMinor }),
    due: invoice.dueDate,
    status: invoice.status,
    reason: decision?.headline ?? (invoice.status === 'queued' ? 'Pendiente de evaluación' : 'Revisa el expediente'),
    sourceKind: invoice.sourceKind,
  };
}

export function getCounters(db: Db, workspaceId: string): Counters {
  const counters: Counters = {
    ready: 0, approval_required: 0, review_required: 0, stopped: 0,
    approved: 0, rejected: 0, stale: 0, queued: 0,
  };
  for (const invoice of listInvoices(db, workspaceId)) counters[invoice.status] += 1;
  return counters;
}

function comparisons(record: DecisionRecord | null): Comparison[] {
  return (record?.decision.checks ?? []).flatMap((check) => {
    if (!check.evidence) return [];
    const invoice = check.evidence.invoice ?? null;
    const expected = check.evidence.record ?? null;
    return [{ field: check.label, invoice, record: expected, differs: invoice !== expected }];
  });
}

function marks(invoice: StoredInvoice): Expediente['marks'] {
  if (!invoice.extraction?.ok) return [];
  const values = Object.values(invoice.extraction.claims.evidenceQuotes)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .slice(0, 30)
    .map((text) => ({ text: text.slice(0, 8000), kind: 'value' as const }));
  const suspicious = invoice.extraction.claims.suspiciousPassages
    .slice(0, 30)
    .map((text) => ({ text: text.slice(0, 8000), kind: 'suspicious' as const }));
  return [...values, ...suspicious];
}

export function toExpediente(db: Db, workspaceId: string, invoice: StoredInvoice): Expediente {
  const record = invoice.latestRecord;
  return {
    row: toInvoiceRow(invoice),
    record,
    comparison: comparisons(record),
    sourceText: invoice.sourceText?.slice(0, 8000) ?? null,
    marks: marks(invoice),
    fileUrl: invoice.filePath ? `/api/files/${encodeURIComponent(invoice.id)}` : null,
    history: getDecisionHistory(db, workspaceId, invoice.id),
  };
}

export function invoiceRows(db: Db, workspaceId: string): InvoiceRow[] {
  return listInvoices(db, workspaceId).map(toInvoiceRow);
}

export function originalMoney(invoice: StoredInvoice, vendorCurrency?: Money['currency']): Money | null {
  if (!invoice.extraction?.ok || !invoice.extraction.claims.amountRaw) return null;
  const currency = invoice.extraction.claims.currency;
  const validCurrency = currency === 'USD' || currency === 'COP' || currency === 'MXN' ? currency : vendorCurrency;
  if (!validCurrency) return null;
  const parsed = parseAmount(invoice.extraction.claims.amountRaw, { currency: validCurrency });
  return parsed.ok ? parsed.money : null;
}
