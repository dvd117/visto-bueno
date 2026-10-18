import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { DecideResponse } from '../../shared/api';
import type { DecisionRecord } from '../../shared/domain/types';
import { decideResponseSchema } from '../../shared/api-schemas';
import { createInvoice, getInvoice, type Db } from '../db/db';
import type { ServerEnv } from '../middleware/workspace';
import { processBatch, type PipelineOptions, type ProcessMode } from '../pipeline';
import { fileKind, textInvoiceSchema, validFileBytes } from './api';

const idempotencyKeySchema = z.string().trim().min(1).max(120);
const seededInvoiceSchema = z.object({ invoiceId: z.string().min(1).max(80) }).strict();
const decideJsonSchema = z.union([textInvoiceSchema, seededInvoiceSchema]);

type DecideRouteOptions = PipelineOptions & { uploadDirectory: string };
type DecideInput =
  | { kind: 'text'; text: string }
  | { kind: 'seed'; invoiceId: string }
  | { kind: 'file'; sourceKind: 'pdf' | 'image'; extension: string; bytes: Uint8Array };
type ParsedInput = { ok: true; input: DecideInput } | { ok: false };
type CachedResult = { type: 'response'; response: DecideResponse } | { type: 'conflict' };

function requestBytes(c: Context<ServerEnv>): Uint8Array {
  return c.get('requestBytes') ?? new Uint8Array();
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

async function parseInput(c: Context<ServerEnv>): Promise<ParsedInput> {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    const parsed = decideJsonSchema.safeParse(parseJson(requestBytes(c)));
    if (!parsed.success) return { ok: false };
    return 'invoiceId' in parsed.data
      ? { ok: true, input: { kind: 'seed', invoiceId: parsed.data.invoiceId } }
      : { ok: true, input: { kind: 'text', text: parsed.data.text } };
  }

  if (!contentType.includes('multipart/form-data')) return { ok: false };
  try {
    const request = new Request(c.req.url, {
      method: 'POST', headers: c.req.raw.headers, body: Buffer.from(requestBytes(c)),
    });
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return { ok: false };
    const kind = fileKind(file);
    if (!kind) return { ok: false };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!validFileBytes(bytes, kind.sourceKind, kind.mimeType)) return { ok: false };
    return {
      ok: true,
      input: { kind: 'file', sourceKind: kind.sourceKind, extension: kind.extension, bytes },
    };
  } catch {
    return { ok: false };
  }
}

function responseFor(record: DecisionRecord): DecideResponse {
  return decideResponseSchema.parse({
    state: record.decision.status,
    headline: record.decision.headline,
    reasons: record.decision.checks
      .filter(({ outcome }) => outcome === 'failed' || outcome === 'pending')
      .map(({ reason }) => reason),
    checks: record.decision.checks,
    sealId: record.seal,
    decisionRecordId: record.id,
  });
}

function cachedResult(db: Db, workspaceId: string, key: string): CachedResult | null {
  const existing = db.prepare(`SELECT record_id, action FROM idempotency_keys
    WHERE workspace_id = ? AND idempotency_key = ?`).get(workspaceId, key) as
    { record_id: string; action: string } | undefined;
  if (!existing) return null;
  if (existing.action !== 'decided') return { type: 'conflict' };

  const row = db.prepare('SELECT record_json FROM decision_records WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, existing.record_id) as { record_json: string } | undefined;
  if (!row) return { type: 'conflict' };
  try {
    return { type: 'response', response: responseFor(JSON.parse(row.record_json) as DecisionRecord) };
  } catch {
    return { type: 'conflict' };
  }
}

async function withKeyLock<T>(locks: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  const tail = previous.then(() => held);
  locks.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export function createDecideRoutes(options: DecideRouteOptions): Hono<ServerEnv> {
  const router = new Hono<ServerEnv>();
  const locks = new Map<string, Promise<void>>();
  const { db, uploadDirectory } = options;

  router.post('/v1/decide', async (c) => {
    const parsedKey = idempotencyKeySchema.safeParse(c.req.header('Idempotency-Key'));
    if (!parsedKey.success) {
      return c.json({ error: 'invalid_request', message: 'Envía una clave Idempotency-Key válida.' }, 400);
    }
    const parsedInput = await parseInput(c);
    if (!parsedInput.ok) return c.json({ error: 'invalid_request', message: 'Envía texto, un PDF/imagen válido o un ID de factura de ejemplo.' }, 400);

    const workspaceId = c.get('workspaceId');
    const key = parsedKey.data;
    const lockKey = `${workspaceId}\0${key}`;
    return withKeyLock(locks, lockKey, async () => {
      const cached = cachedResult(db, workspaceId, key);
      if (cached?.type === 'conflict') {
        return c.json({ error: 'idempotency_conflict', message: 'La clave Idempotency-Key ya se usó para otra acción.' }, 409);
      }
      if (cached?.type === 'response') return c.json(cached.response);

      let invoiceId: string;
      let mode: ProcessMode;
      let savedFile: string | null = null;
      if (parsedInput.input.kind === 'seed') {
        const invoice = getInvoice(db, workspaceId, parsedInput.input.invoiceId);
        if (!invoice || !invoice.filePath?.startsWith('fixtures/invoices/')) {
          return c.json({ error: 'not_found', message: 'No encontré esta factura de ejemplo en el workspace.' }, 404);
        }
        if (invoice.status === 'approved' || invoice.status === 'rejected') {
          return c.json({ error: 'conflict', message: 'La factura ya tiene una decisión humana final.' }, 409);
        }
        invoiceId = invoice.id;
        mode = 'replay';
      } else {
        invoiceId = randomUUID();
        mode = 'live';
        if (parsedInput.input.kind === 'text') {
          try {
            createInvoice(db, workspaceId, { id: invoiceId, sourceKind: 'text', sourceText: parsedInput.input.text });
          } catch {
            return c.json({ error: 'server_error', message: 'No pude guardar la factura recibida.' }, 500);
          }
        } else {
          const name = `${invoiceId}.${parsedInput.input.extension}`;
          savedFile = resolve(uploadDirectory, name);
          try {
            await mkdir(uploadDirectory, { recursive: true });
            await writeFile(savedFile, parsedInput.input.bytes, { flag: 'wx' });
            createInvoice(db, workspaceId, {
              id: invoiceId, sourceKind: parsedInput.input.sourceKind, filePath: `uploads/${name}`,
            });
          } catch {
            if (savedFile) await rm(savedFile, { force: true });
            return c.json({ error: 'server_error', message: 'No pude guardar el archivo recibido.' }, 500);
          }
        }
      }

      await processBatch(options, {
        workspaceId,
        ids: [invoiceId],
        mode,
        ip: c.get('clientIp'),
        idempotencyKey: key,
        emit: () => undefined,
      });

      const completed = cachedResult(db, workspaceId, key);
      if (completed?.type === 'conflict') {
        return c.json({ error: 'idempotency_conflict', message: 'La clave Idempotency-Key ya se usó para otra acción.' }, 409);
      }
      if (completed?.type === 'response') return c.json(completed.response);

      if (savedFile) await rm(savedFile, { force: true });
      db.prepare('DELETE FROM invoices WHERE workspace_id = ? AND id = ?').run(workspaceId, invoiceId);
      return c.json({ error: 'server_error', message: 'No pude guardar la decisión de esta factura.' }, 500);
    });
  });

  return router;
}
