import type { Comparison, Counters, Expediente, InvoiceRow } from '../shared/api';
import type { Contract, Money } from '../shared/domain/types';
import { normalize } from '../shared/engine/normalize';
import { formatMoney, parseAmount } from '../shared/domain/money';
import { getDecisionHistory, getWorkspaceData, listInvoices, type Db, type StoredInvoice } from './db/db';
import { ledgerView } from './db/ledger';

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
  const concept = extraction?.claims.description?.trim() || invoice.sourceText?.trim();
  return {
    id: invoice.id,
    payee: extraction?.claims.payeeName ?? 'Proveedor por identificar',
    concept: concept ? truncateSnippet(concept) : 'Factura recibida',
    amount: amountText(invoice),
    amountUsd: invoice.amountUsdMinor === null ? null : formatMoney({ currency: 'USD', minor: invoice.amountUsdMinor }),
    due: invoice.dueDate,
    status: invoice.status,
    reason: decision?.headline ?? (invoice.status === 'queued' ? 'Pendiente de evaluación' : 'Revisa el expediente'),
    sourceKind: invoice.sourceKind,
  };
}

function truncateSnippet(value: string, limit = 120): string {
  if (value.length <= limit) return value;
  let prefix = '';
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { segment } of segmenter.segment(value)) {
    if (prefix.length + segment.length > limit) break;
    prefix += segment;
  }
  const boundary = prefix.search(/\s+\S*$/u);
  return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}

export function getCounters(db: Db, workspaceId: string): Counters {
  const counters: Counters = {
    ready: 0, approval_required: 0, review_required: 0, stopped: 0,
    approved: 0, rejected: 0, stale: 0, queued: 0,
  };
  for (const invoice of listInvoices(db, workspaceId)) counters[invoice.status] += 1;
  return counters;
}

function accountLastFour(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/gu, '') ?? '';
  return digits.length >= 4 ? `···· ${digits.slice(-4)}` : null;
}

function invoiceAmount(invoice: StoredInvoice, vendorCurrency?: Money['currency']): string | null {
  const original = originalMoney(invoice, vendorCurrency);
  const usd = invoice.amountUsdMinor === null ? null : formatMoney({ currency: 'USD', minor: invoice.amountUsdMinor });
  if (!original) return usd;
  const originalText = formatMoney(original);
  return original.currency === 'USD' && (!usd || usd === originalText)
    ? originalText
    : [originalText, usd].filter((value): value is string => value !== null).join(' · ');
}

function contractAmountComparison(invoice: StoredInvoice, contract: Contract | null, vendorCurrency?: Money['currency']): Comparison {
  const claims = invoice.extraction?.ok ? invoice.extraction.claims : null;
  const amount = invoiceAmount(invoice, vendorCurrency);
  if (!contract) {
    return { field: 'Monto facturado / monto contractual', invoice: amount, record: null, differs: true };
  }

  if (contract.type === 'fixed') {
    const expected = contract.amountMinor === undefined
      ? null
      : { currency: contract.currency, minor: contract.amountMinor };
    const actual = originalMoney(invoice, vendorCurrency);
    return {
      field: 'Monto facturado / monto contractual',
      invoice: amount,
      record: expected ? formatMoney(expected) : null,
      differs: !actual || !expected || actual.currency !== expected.currency || actual.minor !== expected.minor,
    };
  }

  const actualRate = claims?.rateRaw
    ? parseAmount(claims.rateRaw, { currency: contract.currency })
    : null;
  const expectedRate = contract.rateMinor === undefined
    ? null
    : { currency: contract.currency, minor: contract.rateMinor };
  const invoiceText = [
    amount,
    actualRate?.ok
      ? `Tarifa facturada: ${formatMoney(actualRate.money)}${contract.unit ? ` / ${contract.unit}` : ''}`
      : 'Tarifa facturada: No disponible',
  ].filter((value): value is string => value !== null).join(' · ');
  return {
    field: 'Monto facturado / monto contractual',
    invoice: invoiceText,
    record: expectedRate ? `Tarifa contractual: ${formatMoney(expectedRate)}${contract.unit ? ` / ${contract.unit}` : ''}` : null,
    differs: Boolean(actualRate?.ok && expectedRate && actualRate.money.minor !== expectedRate.minor),
  };
}

function comparisons(db: Db, workspaceId: string, invoice: StoredInvoice): Comparison[] {
  const data = getWorkspaceData(db, workspaceId);
  const claims = invoice.extraction?.ok ? invoice.extraction.claims : null;
  const record = invoice.latestRecord;
  const vendor = invoice.vendorId ? data.vendors.find((candidate) => candidate.id === invoice.vendorId) ?? null : null;
  const contractId = invoice.contractId ?? record?.decision.contractId;
  const contract = contractId ? data.contracts.find((candidate) => candidate.id === contractId) ?? null : null;
  const month = invoice.month ?? invoice.invoiceDate?.slice(0, 7) ?? claims?.invoiceDate?.slice(0, 7) ?? null;
  const invoiceDate = claims?.invoiceDate ?? invoice.invoiceDate;
  const account = accountLastFour(claims?.payoutAccount);
  const registeredAccount = accountLastFour(vendor?.payoutAccount);
  const budget = contract && month
    ? data.budgets.find((candidate) => candidate.costCenter === contract.costCenter && candidate.month === month)
    : undefined;
  const ledger = ledgerView(db, workspaceId, { excludeInvoiceId: invoice.id });
  const budgetRemaining = budget && contract && month
    ? budget.approvedUsdMinor - ledger.committedByCostCenter(contract.costCenter, month) - ledger.reservedByCostCenter(contract.costCenter, month)
    : null;
  const amountUsdMinor = invoice.amountUsdMinor ?? record?.decision.amountUsdMinor ?? null;
  const budgetRecord = budgetRemaining === null
    ? null
    : `${formatMoney({ currency: 'USD', minor: budgetRemaining })} disponible antes de esta factura`;
  const budgetInvoice = amountUsdMinor === null
    ? null
    : `${formatMoney({ currency: 'USD', minor: amountUsdMinor })} solicitado`;
  const contractPeriod = contract ? `${contract.start} a ${contract.end}` : null;
  const dateWithinPeriod = Boolean(invoiceDate && contract && contract.start <= invoiceDate && invoiceDate <= contract.end);

  return [
    {
      field: 'Beneficiario',
      invoice: claims?.payeeName ?? null,
      record: vendor?.name ?? null,
      differs: !claims?.payeeName || !vendor || normalize(claims.payeeName) !== normalize(vendor.name),
    },
    {
      field: 'Identificador fiscal',
      invoice: claims?.payeeTaxId ?? null,
      record: vendor?.taxId ?? null,
      differs: !claims?.payeeTaxId || !vendor || normalize(claims.payeeTaxId) !== normalize(vendor.taxId),
    },
    {
      field: 'Cuenta bancaria (últimos 4)',
      invoice: account,
      record: registeredAccount,
      differs: !account || !registeredAccount || account !== registeredAccount,
    },
    contractAmountComparison(invoice, contract, vendor?.payoutCurrency),
    {
      field: 'Alcance del contrato',
      invoice: claims?.description ?? null,
      record: contract?.scope ?? null,
      differs: !claims?.description || !contract || normalize(claims.description) !== normalize(contract.scope),
    },
    {
      field: 'Fecha de factura vs. período del contrato',
      invoice: invoiceDate,
      record: contractPeriod,
      differs: !dateWithinPeriod,
    },
    {
      field: 'Presupuesto restante',
      invoice: budgetInvoice,
      record: budgetRecord,
      differs: budgetRemaining === null || amountUsdMinor === null || amountUsdMinor > budgetRemaining,
    },
  ];
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
    comparison: comparisons(db, workspaceId, invoice),
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
