import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, getInvoice } from '../../src/server/db/db';
import { ensureWorkspace } from '../../src/server/db/workspace';
import { ensureExampleInvoices } from '../../src/server/fixtures';
import { extract } from '../../src/server/extract';
import { processBatch, type ProviderMode } from '../../src/server/pipeline';
import { createLiveCallLimiter } from '../../src/server/middleware/limits';

const databases: ReturnType<typeof openDb>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('pipeline provider modes', () => {
  it('aggregates measured extraction cost into the existing batch stats field', async () => {
    const db = openDb(':memory:');
    databases.push(db);
    const workspaceId = 'measured-cost-test';
    ensureWorkspace(db, workspaceId);
    const fixture = ensureExampleInvoices(db, workspaceId).find(({ invoiceId }) => invoiceId === 'AL-030');
    expect(fixture).toBeDefined();
    const extractProvider = vi.fn(async (input: Parameters<typeof extract>[0]) => {
      input.onMeasurement?.({
        model: 'gemini-3.1-flash-lite',
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 250, totalTokenCount: 1250 },
        costUsd: '0.00062500',
      });
      return { ok: false as const, error: 'unreadable' as const, sourceKind: input.kind };
    });

    const stats = await processBatch({ db, extractProvider }, {
      workspaceId,
      ids: [fixture!.invoiceId],
      mode: 'live',
      extractMode: 'live',
      ip: null,
      emit: () => undefined,
    });

    expect(extractProvider).toHaveBeenCalledOnce();
    expect(stats.costUsd).toBe('0.00062500');
  });

  it('can replay genuine extraction and record JEV through the canonical state builder', async () => {
    const db = openDb(':memory:');
    databases.push(db);
    const workspaceId = 'record-jev-test';
    ensureWorkspace(db, workspaceId);
    const fixtures = ensureExampleInvoices(db, workspaceId);
    const fixture = fixtures.find(({ invoiceId }) => invoiceId === 'AL-030');
    expect(fixture).toBeDefined();
    const limiter = createLiveCallLimiter();
    const reserveCall = vi.spyOn(limiter, 'reserveCall');
    let extractionMode: ProviderMode | undefined;
    let judgmentMode: ProviderMode | undefined;
    const extractProvider = vi.fn(async (input: Parameters<typeof extract>[0]) => {
      extractionMode = input.mode;
      return extract(input);
    });
    const jevProvider = vi.fn(async (input: Parameters<typeof import('../../src/server/jev/client').askJev>[0]) => {
      judgmentMode = input.mode;
      return { ok: false as const, error: 'http_error' as const };
    });

    await processBatch({ db, limiter, extractProvider, jevProvider }, {
      workspaceId,
      ids: [fixture!.invoiceId],
      mode: 'live',
      extractMode: 'replay',
      jevMode: 'record',
      ip: null,
      emit: () => undefined,
    });

    expect(extractionMode).toBe('replay');
    expect(judgmentMode).toBe('record');
    expect(extractProvider).toHaveBeenCalledOnce();
    expect(jevProvider).toHaveBeenCalledOnce();
    expect(reserveCall).not.toHaveBeenCalled();
    expect(getInvoice(db, workspaceId, fixture!.invoiceId)?.latestRecord?.jev).toEqual({
      ok: false, error: 'http_error',
    });
  });

  it('finishes persisting a batch when the SSE client stops accepting events', async () => {
    const db = openDb(':memory:');
    databases.push(db);
    const workspaceId = 'disconnected-sse-test';
    ensureWorkspace(db, workspaceId);
    ensureExampleInvoices(db, workspaceId);

    const stats = await processBatch({ db }, {
      workspaceId,
      ids: ['AL-030'],
      mode: 'replay',
      ip: null,
      emit: () => { throw new Error('client disconnected'); },
    });

    expect(stats.invoices).toBe(1);
    expect(stats.costUsd).toBe('—');
    expect(getInvoice(db, workspaceId, 'AL-030')?.status).not.toBe('queued');
  });
});
