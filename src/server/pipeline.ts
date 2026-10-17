import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import Decimal from 'decimal.js';
import type { ProcessEvent, ProcessRequest, RunStats } from '../shared/api';
import type { ExtractionResult, JevAnswers, SourceKind } from '../shared/domain/types';
import { buildJevQuestions } from '../shared/engine/jev-questions';
import { evaluateRules } from '../shared/engine/rules';
import { verifyClaims } from '../shared/engine/verify';
import { decideInvoice, DEFAULT_DEMO_TODAY } from './db/decide';
import { getInvoice, getWorkspaceData, type Db, type StoredInvoice } from './db/db';
import { ledgerView } from './db/ledger';
import { getCounters, toInvoiceRow } from './format';
import { ProviderCallLimitError, type ProviderAttemptHook } from './model-attempt';
import { askJev } from './jev/client';
import { createLiveCallLimiter } from './middleware/limits';
import { extract } from './extract';
import type { ExtractionMeasurement } from './extract/cost';

export type ProcessMode = NonNullable<ProcessRequest['mode']>;
export type ProviderMode = 'replay' | 'record' | 'live';
type ExtractProvider = typeof extract;
type JevProvider = typeof askJev;
type Emit = (event: ProcessEvent) => void | Promise<void>;

async function emitSafely(emit: Emit, event: ProcessEvent): Promise<void> {
  try {
    await emit(event);
  } catch {
    // A disconnected SSE client must not abort server-side batch decisions.
  }
}

export interface PipelineOptions {
  db: Db;
  limiter?: Pick<ReturnType<typeof createLiveCallLimiter>, 'reserveCall'>;
  extractProvider?: ExtractProvider;
  jevProvider?: JevProvider;
  uploadDirectory?: string;
  now?: () => number;
}

interface SourceInput {
  kind: SourceKind;
  bytes?: Buffer;
  text?: string;
}

interface PreparedInvoice {
  invoice: StoredInvoice;
  extraction: ExtractionResult;
  extractionMeasurement?: ExtractionMeasurement;
  jev: JevAnswers;
  extractionMessage?: string;
  jevMessage?: string;
  quotaDenied?: boolean;
  candidates: Array<{
    invoiceId: string;
    description: string;
    sourceText: string;
    contractScope: string | null;
  }>;
}

const LIVE_LIMIT_MESSAGE = 'Alcanzaste el límite de llamadas en vivo del demo. Inténtalo más tarde.';
const MAX_MODEL_TEXT = 8000;

async function mapConcurrent<T, R>(values: T[], limit: number, work: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await work(values[index]!, index);
    }
  }));
  return results;
}

function safeSourcePath(invoice: StoredInvoice, uploadDirectory: string): string | null {
  if (!invoice.filePath) return null;
  if (invoice.filePath.startsWith('fixtures/invoices/')) {
    const path = resolve(process.cwd(), invoice.filePath);
    return path.startsWith(`${resolve(process.cwd(), 'fixtures/invoices')}/`) ? path : null;
  }
  if (invoice.filePath.startsWith('uploads/')) {
    const name = basename(invoice.filePath.slice('uploads/'.length));
    if (!/^[a-zA-Z0-9_-]+\.(?:pdf|png|jpe?g|webp)$/.test(name)) return null;
    const path = resolve(uploadDirectory, name);
    return path.startsWith(`${resolve(uploadDirectory)}/`) ? path : null;
  }
  return null;
}

async function sourceInput(invoice: StoredInvoice, uploadDirectory: string): Promise<SourceInput | null> {
  if (invoice.sourceKind === 'text') {
    return invoice.sourceText === null ? null : { kind: 'text', text: invoice.sourceText };
  }
  const path = safeSourcePath(invoice, uploadDirectory);
  if (!path) return null;
  try {
    return { kind: invoice.sourceKind, bytes: await readFile(path) };
  } catch {
    return null;
  }
}

function failedExtraction(sourceKind: SourceKind, error: Extract<ExtractionResult, { ok: false }>['error']): ExtractionResult {
  return { ok: false, error, sourceKind };
}

function attemptHook(
  options: PipelineOptions,
  workspaceId: string,
  ip: string | null,
  mode: ProcessMode,
): ProviderAttemptHook {
  const limiter = options.limiter;
  if (!limiter) return () => undefined;
  return () => {
    const reservation = limiter.reserveCall({ workspaceId, ip, mode });
    if (!reservation.ok) throw new ProviderCallLimitError(reservation.message);
    if (!reservation.reservation.start()) {
      reservation.reservation.cancel();
      throw new ProviderCallLimitError(LIVE_LIMIT_MESSAGE);
    }
  };
}

function extractionFailureMessage(error: Extract<ExtractionResult, { ok: false }>['error']): string {
  switch (error) {
    case 'rate_limited': return 'No pude leer la factura (límite del servicio).';
    case 'timeout': return 'No pude leer la factura (tiempo de espera agotado).';
    case 'too_large': return 'El documento supera el límite permitido.';
    case 'unreadable': return 'No pude leer la factura.';
  }
}

function jevFailureMessage(error: Extract<JevAnswers, { ok: false }>['error']): string {
  switch (error) {
    case 'missing_recording': return 'No hay una evaluación grabada para esta solicitud.';
    case 'no_key': return 'La evaluación en vivo no está configurada.';
    case 'timeout': return 'La evaluación tardó demasiado.';
    case 'malformed': return 'La evaluación no devolvió un resultado válido.';
    case 'http_error': return 'No pude completar la evaluación.';
  }
}

function description(invoice: StoredInvoice): string {
  if (invoice.extraction?.ok) return invoice.extraction.claims.description ?? invoice.sourceText?.slice(0, 240) ?? '';
  return invoice.sourceText?.slice(0, 240) ?? '';
}

function collectCandidates(
  options: PipelineOptions,
  workspaceId: string,
  invoice: StoredInvoice,
  vendorId: string | null,
  batch: PreparedInvoice[],
  fuzzyWindowDays: number,
): PreparedInvoice['candidates'] {
  if (!vendorId) return [];
  const oldestAllowed = new Date(`${DEFAULT_DEMO_TODAY}T00:00:00.000Z`);
  oldestAllowed.setUTCDate(oldestAllowed.getUTCDate() - fuzzyWindowDays);
  const oldestDate = oldestAllowed.toISOString().slice(0, 10);
  const ids = new Set(ledgerView(options.db, workspaceId, { excludeInvoiceId: invoice.id, today: DEFAULT_DEMO_TODAY })
    .recentByVendor(vendorId, fuzzyWindowDays).map(({ invoiceId }) => invoiceId));
  const candidates = [...ids].flatMap((invoiceId) => {
    const previous = getInvoice(options.db, workspaceId, invoiceId);
    if (!previous) return [];
    const data = getWorkspaceData(options.db, workspaceId);
    const contractScope = data.contracts.find(({ id }) => id === previous.contractId)?.scope ?? null;
    return [{
      invoiceId,
      description: description(previous),
      sourceText: previous.sourceText?.slice(0, 2_000) ?? '',
      contractScope,
    }];
  });

  for (const other of batch) {
    if (other.invoice.id === invoice.id || !other.extraction.ok) continue;
    const data = getWorkspaceData(options.db, workspaceId);
    const otherVerified = verifyClaims(other.extraction, data.vendors);
    if (otherVerified.vendor?.id !== vendorId) continue;
    const otherDate = other.extraction.claims.invoiceDate;
    if (!otherDate || otherDate < oldestDate || otherDate > DEFAULT_DEMO_TODAY) continue;
    const otherRules = evaluateRules({
      vendor: otherVerified.vendor,
      contracts: data.contracts,
      money: otherVerified.money,
      claims: other.extraction.claims,
      sourceKind: other.extraction.sourceKind,
      treasury: data.treasury,
      budgets: data.budgets,
      rules: data.rules,
      ledger: ledgerView(options.db, workspaceId, { excludeInvoiceId: other.invoice.id, today: DEFAULT_DEMO_TODAY }),
      today: DEFAULT_DEMO_TODAY,
    });
    candidates.push({
      invoiceId: other.invoice.id,
      description: other.extraction.claims.description ?? '',
      sourceText: other.extraction.sourceText.slice(0, 2_000),
      contractScope: otherRules.contract?.scope ?? null,
    });
  }

  return candidates
    .filter((candidate) => candidate.invoiceId !== invoice.id)
    .sort((left, right) => left.invoiceId.localeCompare(right.invoiceId));
}

async function evaluateJev(
  options: PipelineOptions,
  workspaceId: string,
  ip: string | null,
  mode: ProviderMode,
  prepared: PreparedInvoice[],
): Promise<void> {
  const data = getWorkspaceData(options.db, workspaceId);
  await mapConcurrent(prepared, 4, async (item) => {
    if (!item.extraction.ok) {
      item.jev = { ok: false, error: 'http_error' };
      return;
    }

    const verified = verifyClaims(item.extraction, data.vendors);
    const ruleResult = evaluateRules({
      vendor: verified.vendor,
      contracts: data.contracts,
      money: verified.money,
      claims: item.extraction.claims,
      sourceKind: item.extraction.sourceKind,
      treasury: data.treasury,
      budgets: data.budgets,
      rules: data.rules,
      ledger: ledgerView(options.db, workspaceId, { excludeInvoiceId: item.invoice.id, today: DEFAULT_DEMO_TODAY }),
      today: DEFAULT_DEMO_TODAY,
    });
    item.candidates = collectCandidates(
      options, workspaceId, item.invoice, verified.vendor?.id ?? null, prepared,
      data.rules.fuzzyDuplicateWindowDays,
    );
    const questions = buildJevQuestions({
      needFuzzy: item.candidates.length > 0,
      needCostCenter: ruleResult.contract === null,
    });
    const state = {
      invoiceId: item.invoice.id,
      sourceKind: item.extraction.sourceKind,
      sourceText: item.extraction.sourceText.slice(0, MAX_MODEL_TEXT),
      claims: item.extraction.claims,
      matchedVendor: verified.vendor ? {
        id: verified.vendor.id,
        name: verified.vendor.name,
        taxId: verified.vendor.taxId,
        payoutCurrency: verified.vendor.payoutCurrency,
        payoutAccount: verified.vendor.payoutAccount,
        status: verified.vendor.status,
      } : null,
      matchedContract: ruleResult.contract ? {
        id: ruleResult.contract.id,
        scope: ruleResult.contract.scope,
        type: ruleResult.contract.type,
        currency: ruleResult.contract.currency,
        amountMinor: ruleResult.contract.amountMinor ?? null,
        rateMinor: ruleResult.contract.rateMinor ?? null,
        unit: ruleResult.contract.unit ?? null,
        maxUnitsPerPeriod: ruleResult.contract.maxUnitsPerPeriod ?? null,
        billingFrequency: ruleResult.contract.billingFrequency,
        costCenter: ruleResult.contract.costCenter,
        start: ruleResult.contract.start,
        end: ruleResult.contract.end,
      } : null,
      deterministicChecks: [...verified.checks, ...ruleResult.checks],
      recentSameVendorInvoices: item.candidates,
    };

    try {
      item.jev = await (options.jevProvider ?? askJev)({
        state,
        questions: questions as Record<string, object>,
        mode,
        onAttempt: attemptHook(options, workspaceId, ip, mode === 'replay' ? 'replay' : 'live'),
      });
    } catch (error) {
      if (error instanceof ProviderCallLimitError) {
        item.jev = { ok: false, error: 'http_error' };
        item.jevMessage = error.message;
        item.quotaDenied = true;
      } else {
        item.jev = { ok: false, error: 'http_error' };
      }
    }
  });
}

export async function processBatch(
  options: PipelineOptions,
  input: {
    workspaceId: string; ids: string[]; mode: ProcessMode; ip: string | null; emit: Emit;
    extractMode?: ProviderMode; jevMode?: ProviderMode;
  },
): Promise<RunStats> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const extractionMode = input.extractMode ?? input.mode;
  const judgmentMode = input.jevMode ?? input.mode;
  const ids = [...new Set(input.ids)].sort((left, right) => left.localeCompare(right));
  const prepared: PreparedInvoice[] = [];
  const invoices = ids.flatMap((id) => {
    const invoice = getInvoice(options.db, input.workspaceId, id);
    if (!invoice) return [];
    if (invoice.status === 'approved' || invoice.status === 'rejected') {
      prepared.push({
        invoice,
        extraction: failedExtraction(invoice.sourceKind, 'unreadable'),
        jev: { ok: false, error: 'http_error' },
        candidates: [],
        jevMessage: 'La factura ya tiene una decisión final y no se puede reprocesar.',
      });
      return [];
    }
    return [invoice];
  });

  try {
    const extracted = await mapConcurrent(invoices, 4, async (invoice) => {
      const source = await sourceInput(invoice, options.uploadDirectory ?? resolve(process.cwd(), 'data/uploads'));
      if (!source) return { invoice, extraction: failedExtraction(invoice.sourceKind, 'unreadable') };
      let extractionMeasurement: ExtractionMeasurement | undefined;
      try {
        const extraction = await (options.extractProvider ?? extract)({
          ...source,
          invoiceId: invoice.id,
          mode: extractionMode,
          onAttempt: attemptHook(options, input.workspaceId, input.ip, extractionMode === 'replay' ? 'replay' : 'live'),
          onMeasurement: (measurement) => { extractionMeasurement = measurement; },
        });
        return {
          invoice,
          extraction,
          extractionMeasurement,
        };
      } catch (cause) {
        if (cause instanceof ProviderCallLimitError) {
          return {
            invoice,
            extraction: failedExtraction(invoice.sourceKind, 'rate_limited'),
            extractionMeasurement,
            extractionMessage: cause.message,
            quotaDenied: true,
          };
        }
        return { invoice, extraction: failedExtraction(invoice.sourceKind, 'unreadable'), extractionMeasurement };
      }
    });
    prepared.push(...extracted.map(({ invoice, extraction, extractionMeasurement, extractionMessage, quotaDenied }) => ({
      invoice,
      extraction,
      ...(extractionMeasurement ? { extractionMeasurement } : {}),
      jev: { ok: false, error: 'http_error' } as JevAnswers,
      ...(extractionMessage ? { extractionMessage } : {}),
      ...(quotaDenied ? { quotaDenied } : {}),
      candidates: [],
    })));
    await evaluateJev(options, input.workspaceId, input.ip, judgmentMode, prepared);

    for (const item of prepared.sort((left, right) => left.invoice.id.localeCompare(right.invoice.id))) {
      if (item.invoice.status === 'approved' || item.invoice.status === 'rejected') {
        await emitSafely(input.emit, { type: 'error', invoiceId: item.invoice.id, message: 'La factura ya tiene una decisión final y no se puede reprocesar.' });
        continue;
      }
      if (!item.extraction.ok) await emitSafely(input.emit, {
        type: 'error', invoiceId: item.invoice.id, message: item.extractionMessage ?? extractionFailureMessage(item.extraction.error),
        ...(item.quotaDenied ? { status: 429 as const } : {}),
      });
      else if (!item.jev.ok) await emitSafely(input.emit, {
        type: 'error', invoiceId: item.invoice.id, message: item.jevMessage ?? jevFailureMessage(item.jev.error),
        ...(item.quotaDenied ? { status: 429 as const } : {}),
      });

      try {
        decideInvoice(options.db, input.workspaceId, item.invoice.id, { extraction: item.extraction, jev: item.jev });
        await emitSafely(input.emit, {
          type: 'decided',
          row: toInvoiceRow(getInvoice(options.db, input.workspaceId, item.invoice.id)!),
          counters: getCounters(options.db, input.workspaceId),
        });
      } catch {
        await emitSafely(input.emit, { type: 'error', invoiceId: item.invoice.id, message: 'No pude guardar la decisión de esta factura.' });
      }
    }
  } catch {
    await emitSafely(input.emit, { type: 'error', invoiceId: '', message: 'No pude completar el lote de evaluación.' });
  }

  const stats: RunStats = {
    invoices: ids.length,
    ms: Math.max(0, now() - startedAt),
    costUsd: measuredBatchCost(prepared.map(({ extractionMeasurement }) => extractionMeasurement).filter(
      (measurement): measurement is ExtractionMeasurement => measurement !== undefined,
    )),
    mode: input.mode,
  };
  await emitSafely(input.emit, { type: 'done', stats });
  return stats;
}

function measuredBatchCost(measurements: readonly ExtractionMeasurement[]): string {
  const costs: string[] = [];
  for (const { costUsd } of measurements) {
    if (costUsd === null) return '—';
    costs.push(costUsd);
  }
  if (costs.length === 0) return '—';
  return costs.reduce((total, cost) => total.plus(cost), new Decimal(0)).toFixed(8);
}

