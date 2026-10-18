import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import Decimal from 'decimal.js';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { evaluationResultSchema, type ApiError, type DecisionAction, type FlagResolution } from '../../shared/api';
import { CURRENCIES } from '../../shared/domain/currencies';
import type { Budget, Contract, FxRate, Treasury, Vendor } from '../../shared/domain/types';
import {
  approveInvoice, markStale, rejectInvoice, resolveFlag,
} from '../db/decide';
import {
  createInvoice, getAuditLog, getInvoice, getWorkspaceData, listInvoices,
  putBudget, putContract, putTreasury, putVendor, type Db,
} from '../db/db';
import { resetWorkspace } from '../db/workspace';
import { getCounters, invoiceRows, originalMoney, toExpediente, toInvoiceRow } from '../format';
import { ensureExampleInvoices } from '../fixtures';
import { logCsv, paymentsCsv, reconciliationCsv, reportMd, type PaymentExportItem } from '../export/builders';
import { parseTable, templateCsv, type CsvTable } from '../csv';
import type { ServerEnv } from '../middleware/workspace';
import { processBatch, type PipelineOptions, type ProcessMode } from '../pipeline';

const error = (message: string, code = 'invalid_request'): ApiError => ({ error: code, message });
export const actionSchema = z.object({
  approver: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(120),
  accountLast4: z.string().max(32).optional(),
}).strict();
export const resolutionSchema = z.object({
  choice: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(500),
  approver: z.string().trim().min(1).max(120),
}).strict();
export const processSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  mode: z.enum(['replay', 'live']).optional(),
  examples: z.literal(true).optional(),
}).strict();
export const textInvoiceSchema = z.object({ text: z.string().trim().min(1).max(2 * 1024 * 1024) }).strict();

const safeInteger = z.number().int().refine(Number.isSafeInteger, 'Debe ser un entero seguro.');
const positiveInt = safeInteger.min(1);
const nonNegativeInt = safeInteger.min(0);
const countrySchema = z.enum(['CO', 'MX', 'VE', 'CL', 'PE', 'AR', 'US']);
const currencySchema = z.enum(CURRENCIES);
const costCenterSchema = z.enum(['ingenieria', 'diseno', 'operaciones', 'legal']);
function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export const vendorSchema = z.object({
  id: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200),
  taxId: z.string().trim().min(1).max(100), country: countrySchema,
  payoutCurrency: currencySchema, payoutAccount: z.string().trim().min(1).max(200),
  status: z.enum(['allowed', 'blocked']), version: positiveInt,
}).strict();
export const contractSchema = z.object({
  id: z.string().trim().min(1).max(100), vendorId: z.string().trim().min(1).max(100),
  scope: z.string().trim().min(1).max(500), type: z.enum(['fixed', 'variable']), currency: currencySchema,
  amountMinor: positiveInt.optional(), rateMinor: positiveInt.optional(), unit: z.string().trim().min(1).max(100).optional(),
  maxUnitsPerPeriod: positiveInt.optional(), billingFrequency: z.enum(['monthly', 'one_time', 'annual']),
  costCenter: costCenterSchema, start: z.string().refine(validIsoDate, 'La fecha de inicio no es válida.'),
  end: z.string().refine(validIsoDate, 'La fecha final no es válida.'), version: positiveInt,
}).strict().superRefine((contract, context) => {
  if (contract.start > contract.end) context.addIssue({ code: 'custom', path: ['end'], message: 'La fecha final debe ser posterior al inicio.' });
  if (contract.type === 'fixed' && (contract.amountMinor === undefined || contract.rateMinor !== undefined || contract.unit !== undefined || contract.maxUnitsPerPeriod !== undefined)) {
    context.addIssue({ code: 'custom', path: ['type'], message: 'El contrato fijo requiere monto y no admite tarifa ni unidades.' });
  }
  if (contract.type === 'variable' && (contract.rateMinor === undefined || !contract.unit || contract.maxUnitsPerPeriod === undefined || contract.amountMinor !== undefined)) {
    context.addIssue({ code: 'custom', path: ['type'], message: 'El contrato variable requiere tarifa, unidad y máximo de unidades.' });
  }
});
export const budgetSchema = z.object({
  costCenter: costCenterSchema, month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  approvedUsdMinor: nonNegativeInt,
}).strict();
const fxSchema = z.object({
  currency: currencySchema, perUsd: z.string().regex(/^\d+(?:\.\d+)?$/).refine((value) => new Decimal(value).isPositive()),
  date: z.string().refine(validIsoDate, 'La fecha de vigencia no es válida.'),
}).strict();
export const treasurySchema = z.object({
  balanceUsdMinor: nonNegativeInt, fx: z.array(fxSchema).min(1).max(20),
}).strict().superRefine((treasury, context) => {
  const currencies = treasury.fx.map((rate) => rate.currency);
  if (new Set(currencies).size !== currencies.length) {
    context.addIssue({ code: 'custom', path: ['fx'], message: 'Cada moneda debe tener un solo tipo de cambio.' });
  }
});
const tableNames = new Set(['vendors', 'contracts', 'budgets', 'treasury']);
const csvNames = new Set<CsvTable>(['vendors', 'contracts', 'budgets', 'fx']);
type ApiContext = Context<ServerEnv>;

export interface ApiRouteOptions extends PipelineOptions {
  uploadDirectory: string;
  evaluationReportPath?: string;
  lastRuns: Map<string, { invoices: number; ms: number; costUsd: string; mode: 'replay' | 'live' }>;
}

function requestBytes(c: ApiContext): Uint8Array {
  return c.get('requestBytes') ?? new Uint8Array();
}

function parseJson(c: ApiContext): unknown | null {
  try {
    return JSON.parse(new TextDecoder().decode(requestBytes(c))) as unknown;
  } catch {
    return null;
  }
}

function jsonFailure(c: ApiContext, status: 400 | 404 | 409 | 413 | 429 | 500 | 503, message: string, code?: string) {
  return c.json(error(message, code), status);
}

function fileKind(file: File): { sourceKind: 'pdf' | 'image'; extension: string; mimeType: string } | null {
  const mime = file.type.toLowerCase();
  const ext = file.name.toLowerCase().split('.').pop();
  if (mime === 'application/pdf' || ext === 'pdf') return { sourceKind: 'pdf', extension: 'pdf', mimeType: 'application/pdf' };
  if (mime === 'image/png' || ext === 'png') return { sourceKind: 'image', extension: 'png', mimeType: 'image/png' };
  if (mime === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') return { sourceKind: 'image', extension: 'jpg', mimeType: 'image/jpeg' };
  if (mime === 'image/webp' || ext === 'webp') return { sourceKind: 'image', extension: 'webp', mimeType: 'image/webp' };
  return null;
}

function validFileBytes(bytes: Uint8Array, kind: 'pdf' | 'image', mimeType: string): boolean {
  if (kind === 'pdf') return Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
  if (mimeType === 'image/png') return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';
}

function applyCsv(db: Db, workspaceId: string, table: CsvTable, rows: unknown[]): void {
  if (table === 'vendors') {
    for (const value of rows as Vendor[]) {
      putVendor(db, workspaceId, value);
      markStale(db, workspaceId, { vendorId: value.id });
    }
    return;
  }
  if (table === 'contracts') {
    for (const value of rows as Contract[]) {
      putContract(db, workspaceId, value);
      markStale(db, workspaceId, { contractId: value.id });
    }
    return;
  }
  if (table === 'budgets') {
    for (const value of rows as Budget[]) putBudget(db, workspaceId, value);
    markStale(db, workspaceId, { rules: true });
    return;
  }
  const data = getWorkspaceData(db, workspaceId);
  const fx = rows as FxRate[];
  const next: Treasury = {
    ...data.treasury,
    fx: [...data.treasury.fx.filter((old) => !fx.some((rate) => rate.currency === old.currency)), ...fx],
  };
  putTreasury(db, workspaceId, next);
  markStale(db, workspaceId, { rules: true });
}

function paymentItems(db: Db, workspaceId: string): PaymentExportItem[] {
  const data = getWorkspaceData(db, workspaceId);
  const authorizedBy = new Map<string, string>();
  for (const entry of getAuditLog(db, workspaceId)) if (entry.by) authorizedBy.set(entry.invoiceId, entry.by);
  return listInvoices(db, workspaceId).flatMap((invoice) => {
    if (!invoice.latestRecord || !invoice.vendorId || invoice.amountUsdMinor === null) return [];
    const vendor = data.vendors.find(({ id }) => id === invoice.vendorId);
    const amountOriginal = originalMoney(invoice, vendor?.payoutCurrency);
    if (!vendor || !amountOriginal) return [];
    return [{
      record: invoice.latestRecord,
      status: invoice.status,
      vendor: { taxId: vendor.taxId, payoutAccount: vendor.payoutAccount, payoutCurrency: vendor.payoutCurrency },
      amountOriginal,
      amountUsd: { currency: 'USD' as const, minor: invoice.amountUsdMinor },
      authorizedBy: authorizedBy.get(invoice.id) ?? null,
    }];
  });
}

export function createApiRoutes(options: ApiRouteOptions): Hono<ServerEnv> {
  const router = new Hono<ServerEnv>();
  const { db } = options;

  router.get('/workspace', (c) => {
    const workspaceId = c.get('workspaceId');
    const data = getWorkspaceData(db, workspaceId);
    return c.json({
      company: { name: 'Andina Labs Inc.', fictional: true as const },
      rules: data.rules,
      counters: getCounters(db, workspaceId),
      lastRun: options.lastRuns.get(workspaceId) ?? null,
    });
  });

  router.post('/workspace/reset', async (c) => {
    const workspaceId = c.get('workspaceId');
    const existing = listInvoices(db, workspaceId);
    resetWorkspace(db, workspaceId);
    options.lastRuns.delete(workspaceId);
    await Promise.all(existing.flatMap((invoice) => invoice.filePath?.startsWith('uploads/')
      ? [rm(resolve(options.uploadDirectory, basename(invoice.filePath)), { force: true })]
      : []));
    ensureExampleInvoices(db, workspaceId);
    return c.json({ ok: true });
  });

  router.get('/invoices', (c) => c.json(invoiceRows(db, c.get('workspaceId'))));

  router.get('/invoices/:id', (c) => {
    const workspaceId = c.get('workspaceId');
    const invoice = getInvoice(db, workspaceId, c.req.param('id'));
    if (!invoice) return jsonFailure(c, 404, 'No encontré esta factura.', 'not_found');
    return c.json(toExpediente(db, workspaceId, invoice));
  });

  router.post('/invoices', async (c) => {
    const workspaceId = c.get('workspaceId');
    const type = c.req.header('content-type')?.toLowerCase() ?? '';
    let invoice;
    if (type.includes('application/json')) {
      const parsed = textInvoiceSchema.safeParse(parseJson(c));
      if (!parsed.success) return jsonFailure(c, 400, 'Escribe el texto de una factura para continuar.');
      invoice = createInvoice(db, workspaceId, { id: randomUUID(), sourceKind: 'text', sourceText: parsed.data.text });
    } else if (type.includes('multipart/form-data')) {
      try {
        const request = new Request(c.req.url, {
          method: 'POST', headers: c.req.raw.headers, body: Buffer.from(requestBytes(c)),
        });
        const form = await request.formData();
        const file = form.get('file');
        if (!(file instanceof File)) return jsonFailure(c, 400, 'Selecciona un PDF o una imagen.');
        const kind = fileKind(file);
        if (!kind || file.size === 0) return jsonFailure(c, 400, 'El archivo debe ser un PDF o una imagen válida.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!validFileBytes(bytes, kind.sourceKind, kind.mimeType)) return jsonFailure(c, 400, 'El archivo debe ser un PDF o una imagen válida.');
        const id = randomUUID();
        const name = `${id}.${kind.extension}`;
        await mkdir(options.uploadDirectory, { recursive: true });
        await writeFile(resolve(options.uploadDirectory, name), bytes, { flag: 'wx' });
        try {
          invoice = createInvoice(db, workspaceId, { id, sourceKind: kind.sourceKind, filePath: `uploads/${name}` });
        } catch {
          await rm(resolve(options.uploadDirectory, name), { force: true });
          return jsonFailure(c, 400, 'No pude guardar el archivo recibido.');
        }
      } catch {
        return jsonFailure(c, 400, 'No pude leer el archivo recibido.');
      }
    } else {
      return jsonFailure(c, 400, 'Envía el texto o un archivo de factura.');
    }
    return c.json(toInvoiceRow(invoice), 201);
  });

  router.post('/process', async (c) => {
    const parsed = processSchema.safeParse(parseJson(c));
    if (!parsed.success) return jsonFailure(c, 400, 'La solicitud de procesamiento no es válida.');
    const workspaceId = c.get('workspaceId');
    const mode: ProcessMode = parsed.data.mode ?? 'replay';
    let ids: string[];
    if (parsed.data.examples) {
      if (parsed.data.ids !== undefined || mode !== 'replay') {
        return jsonFailure(c, 400, 'Las facturas de ejemplo solo se procesan en modo de reproducción.');
      }
      const fixtures = ensureExampleInvoices(db, workspaceId);
      ids = fixtures.map(({ invoiceId }) => invoiceId);
      db.transaction(() => {
        for (const id of ids) {
          const invoice = getInvoice(db, workspaceId, id);
          if (!invoice || invoice.status === 'approved' || invoice.status === 'rejected') continue;
          db.prepare(`UPDATE invoices SET status = 'queued', extraction_json = NULL, jev_json = NULL,
            invoice_hash = NULL, vendor_id = NULL, contract_id = NULL, invoice_date = NULL, due_date = NULL,
            evaluated_today = NULL, month = NULL, contract_period = NULL, cost_center = NULL,
            amount_usd_minor = NULL, normalized_invoice_id = NULL, source_text = CASE WHEN source_kind = 'text' THEN source_text ELSE NULL END,
            updated_at = ? WHERE workspace_id = ? AND id = ?`).run(new Date().toISOString(), workspaceId, id);
          db.prepare('DELETE FROM commitments WHERE workspace_id = ? AND invoice_id = ?').run(workspaceId, id);
        }
      }).immediate();
    } else if (parsed.data.ids === undefined) {
      if (mode !== 'replay') return jsonFailure(c, 400, 'Elige facturas recibidas para procesar en vivo.');
      ids = (db.prepare("SELECT id FROM invoices WHERE workspace_id = ? AND status = 'queued' ORDER BY id")
        .all(workspaceId) as Array<{ id: string }>).map(({ id }) => id);
    } else {
      ids = [...new Set(parsed.data.ids)];
    }
    const unknown = ids.find((id) => !getInvoice(db, workspaceId, id));
    if (unknown) return jsonFailure(c, 404, 'No encontré una de las facturas solicitadas.', 'not_found');

    return streamSSE(c, async (stream) => {
      const stats = await processBatch(options, {
        workspaceId,
        ids,
        mode,
        ip: c.get('clientIp'),
        emit: (event) => stream.writeSSE({ data: JSON.stringify(event) }),
      });
      options.lastRuns.set(workspaceId, stats);
    });
  });

  router.post('/invoices/:id/approve', (c) => {
    const workspaceId = c.get('workspaceId');
    const id = c.req.param('id');
    if (!getInvoice(db, workspaceId, id)) return jsonFailure(c, 404, 'No encontré esta factura.', 'not_found');
    const action = actionSchema.safeParse(parseJson(c));
    if (!action.success) return jsonFailure(c, 400, 'Indica quién aprueba, un motivo y una clave de acción.');
    try {
      const result = approveInvoice(db, workspaceId, id, action.data as DecisionAction);
      const invoice = getInvoice(db, workspaceId, id)!;
      if (!result.ok) return c.json({ error: 'conflict' as const, expediente: toExpediente(db, workspaceId, invoice) }, 409);
      return c.json(toExpediente(db, workspaceId, invoice));
    } catch {
      const invoice = getInvoice(db, workspaceId, id);
      if (!invoice) return jsonFailure(c, 404, 'No encontré esta factura.', 'not_found');
      return c.json({ error: 'conflict' as const, expediente: toExpediente(db, workspaceId, invoice) }, 409);
    }
  });

  router.post('/invoices/:id/reject', (c) => {
    const workspaceId = c.get('workspaceId');
    const id = c.req.param('id');
    if (!getInvoice(db, workspaceId, id)) return jsonFailure(c, 404, 'No encontré esta factura.', 'not_found');
    const action = actionSchema.safeParse(parseJson(c));
    if (!action.success) return jsonFailure(c, 400, 'Indica quién rechaza, un motivo y una clave de acción.');
    try {
      const invoice = rejectInvoice(db, workspaceId, id, action.data as DecisionAction);
      return c.json(toExpediente(db, workspaceId, invoice));
    } catch {
      const invoice = getInvoice(db, workspaceId, id);
      if (!invoice) return jsonFailure(c, 404, 'No encontré esta factura.', 'not_found');
      return c.json({ error: 'conflict' as const, expediente: toExpediente(db, workspaceId, invoice) }, 409);
    }
  });

  router.post('/invoices/:id/flags/:flagId/resolve', (c) => {
    const workspaceId = c.get('workspaceId');
    const id = c.req.param('id');
    if (!getInvoice(db, workspaceId, id)) return jsonFailure(c, 404, 'No encontré esta factura.', 'not_found');
    const resolution = resolutionSchema.safeParse(parseJson(c));
    if (!resolution.success) return jsonFailure(c, 400, 'Indica una decisión, un motivo y quién la resuelve.');
    try {
      resolveFlag(db, workspaceId, id, c.req.param('flagId'), resolution.data as FlagResolution);
      return c.json(toExpediente(db, workspaceId, getInvoice(db, workspaceId, id)!));
    } catch {
      return c.json({ error: 'conflict' as const, expediente: toExpediente(db, workspaceId, getInvoice(db, workspaceId, id)!) }, 409);
    }
  });

  router.post('/invoices/:id/reevaluate', async (c) => {
    const workspaceId = c.get('workspaceId');
    const id = c.req.param('id');
    if (!getInvoice(db, workspaceId, id)) return jsonFailure(c, 404, 'No encontré esta factura.', 'not_found');
    await processBatch(options, { workspaceId, ids: [id], mode: 'replay', ip: c.get('clientIp'), emit: () => undefined });
    return c.json(toExpediente(db, workspaceId, getInvoice(db, workspaceId, id)!));
  });

  router.get('/data/:table', (c) => {
    const table = c.req.param('table');
    if (!tableNames.has(table)) return jsonFailure(c, 404, 'No encontré esa tabla.', 'not_found');
    const data = getWorkspaceData(db, c.get('workspaceId'));
    if (table === 'treasury') return c.json(data.treasury);
    return c.json(data[table as 'vendors' | 'contracts' | 'budgets']);
  });

  router.put('/data/:table', (c) => {
    const table = c.req.param('table');
    if (!tableNames.has(table)) return jsonFailure(c, 404, 'No encontré esa tabla.', 'not_found');
    const workspaceId = c.get('workspaceId');
    const body = parseJson(c);
    try {
      const saved = db.transaction(() => {
        if (table === 'vendors') {
          const parsed = vendorSchema.parse(body) as Vendor;
          const result = putVendor(db, workspaceId, parsed);
          markStale(db, workspaceId, { vendorId: parsed.id });
          return result;
        }
        if (table === 'contracts') {
          const parsed = contractSchema.parse(body) as Contract;
          const result = putContract(db, workspaceId, parsed);
          markStale(db, workspaceId, { contractId: parsed.id });
          return result;
        }
        if (table === 'budgets') {
          const parsed = budgetSchema.parse(body) as Budget;
          putBudget(db, workspaceId, parsed);
          markStale(db, workspaceId, { rules: true });
          return parsed;
        }
        const parsed = treasurySchema.parse(body) as Treasury;
        putTreasury(db, workspaceId, parsed);
        markStale(db, workspaceId, { rules: true });
        return parsed;
      }).immediate();
      return c.json(saved);
    } catch {
      return jsonFailure(c, 400, 'Los datos no son válidos o no coinciden con los registros existentes.');
    }
  });

  router.post('/data/:table/csv', async (c) => {
    const table = c.req.param('table') as CsvTable;
    if (!csvNames.has(table)) return jsonFailure(c, 404, 'No encontré esa plantilla CSV.', 'not_found');
    try {
      const request = new Request(c.req.url, {
        method: 'POST', headers: c.req.raw.headers, body: Buffer.from(requestBytes(c)),
      });
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File) || file.size === 0) return jsonFailure(c, 400, 'Selecciona un archivo CSV.');
      const parsed = parseTable(table, await file.text());
      if (!parsed.ok) return jsonFailure(c, 400, parsed.summary, 'invalid_csv');
      const workspaceId = c.get('workspaceId');
      db.transaction(() => applyCsv(db, workspaceId, table, parsed.rows)).immediate();
      return c.json({ ok: true });
    } catch {
      return jsonFailure(c, 400, 'No pude procesar el archivo CSV.');
    }
  });

  router.get('/data/:table/template.csv', (c) => {
    const table = c.req.param('table') as CsvTable;
    if (!csvNames.has(table)) return jsonFailure(c, 404, 'No encontré esa plantilla CSV.', 'not_found');
    return c.body(templateCsv(table), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="plantilla-${table}.csv"`,
    });
  });

  router.get('/log', (c) => c.json(getAuditLog(db, c.get('workspaceId'))));
  const exportBatch = (url: string): ReadonlySet<string> | undefined => {
    const query = new URL(url).searchParams;
    return query.get('batch') === '1' ? new Set(query.getAll('ready')) : undefined;
  };
  router.get('/export/payments.csv', (c) => c.body(
    paymentsCsv(paymentItems(db, c.get('workspaceId')), exportBatch(c.req.url)),
    200,
    { 'Content-Type': 'text/csv; charset=utf-8' },
  ));
  router.get('/export/reconciliation.csv', (c) => c.body(
    reconciliationCsv(paymentItems(db, c.get('workspaceId')), exportBatch(c.req.url)),
    200,
    { 'Content-Type': 'text/csv; charset=utf-8' },
  ));
  router.get('/export/log.csv', (c) => c.body(logCsv(getAuditLog(db, c.get('workspaceId'))), 200, { 'Content-Type': 'text/csv; charset=utf-8' }));
  router.get('/export/report.md', (c) => c.body(reportMd(getAuditLog(db, c.get('workspaceId'))), 200, { 'Content-Type': 'text/markdown; charset=utf-8' }));

  router.get('/files/:invoiceId', async (c) => {
    const invoice = getInvoice(db, c.get('workspaceId'), c.req.param('invoiceId'));
    if (!invoice?.filePath) return jsonFailure(c, 404, 'No encontré el archivo.', 'not_found');
    let path: string;
    if (invoice.filePath.startsWith('fixtures/invoices/')) path = resolve(process.cwd(), invoice.filePath);
    else if (invoice.filePath.startsWith('uploads/')) path = resolve(options.uploadDirectory, basename(invoice.filePath));
    else return jsonFailure(c, 404, 'No encontré el archivo.', 'not_found');
    try {
      const bytes = await readFile(path);
      const extension = path.split('.').at(-1)?.toLowerCase();
      const mime = extension === 'pdf' ? 'application/pdf'
        : extension === 'png' ? 'image/png'
          : extension === 'webp' ? 'image/webp' : 'image/jpeg';
      return c.body(bytes, 200, {
        'Content-Type': mime,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      });
    } catch {
      return jsonFailure(c, 404, 'No encontré el archivo.', 'not_found');
    }
  });

  router.get('/eval', async (c) => {
    try {
      const reportPath = resolve(options.evaluationReportPath ?? 'src/server/eval/report.json');
      const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
      const parsed = evaluationResultSchema.safeParse(report);
      if (parsed.success) return c.json(parsed.data);
    } catch {
      // Missing or malformed report artifacts remain unavailable.
    }
    return jsonFailure(c, 503, 'La evaluación todavía no está disponible.', 'unavailable');
  });
  return router;
}
