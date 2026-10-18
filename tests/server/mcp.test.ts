import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Expediente, DecideResponse } from '../../src/shared/api';
import { createServerApp, serverRuntime } from '../../src/server/app';
import { getInvoice, openDb } from '../../src/server/db/db';
import { createLiveCallLimiter, MAX_REQUEST_BODY_BYTES } from '../../src/server/middleware/limits';
import { MCP_SESSION_IDLE_TTL_MS } from '../../src/server/routes/mcp';
import type { SourceKind } from '../../src/shared/domain/types';

const runtimes: Array<ReturnType<typeof createServerApp>> = [];
const clients: Client[] = [];
const MCP_INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-regression', version: '1' } },
};
const MCP_HEADERS = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};

function makeRuntime(options: Partial<Parameters<typeof createServerApp>[0]> = {}) {
  const runtime = createServerApp({
    db: openDb(':memory:'),
    autoCleanup: false,
    remoteAddress: () => '192.0.2.10',
    ...options,
  });
  runtimes.push(runtime);
  return runtime;
}

type TestMcpClient = Client & { connectMcp(): Promise<void> };

function connectMcp(
  app: ReturnType<typeof createServerApp>['app'],
  cookie?: string,
  responses: Response[] = [],
): TestMcpClient {
  const client = new Client({ name: 'visto-bueno-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (input, init) => {
      const response = await app.request(input, init);
      responses.push(response);
      return response;
    },
    ...(cookie ? { requestInit: { headers: { cookie } } } : {}),
  });
  clients.push(client);
  return Object.assign(client, { connectMcp: () => client.connect(transport) });
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function toolText(result: ToolResult): string {
  if (!('content' in result)) throw new Error('Expected an immediate MCP tool result.');
  const content: unknown = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error('Expected MCP content blocks.');
  const text = content.find((item): item is { type: 'text'; text: string } =>
    Boolean(item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string'))?.text;
  if (text === undefined) throw new Error('Expected a text result from MCP tool.');
  return text;
}

function toolJson<T>(result: ToolResult): T {
  return JSON.parse(toolText(result)) as T;
}

async function visitorCookie(app: ReturnType<typeof createServerApp>['app']): Promise<string> {
  const response = await app.request('/api/invoices');
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(cookie).toMatch(/^workspace_id=/);
  return cookie;
}

async function initializeOverHttp(
  app: ReturnType<typeof createServerApp>['app'],
  options: { cookie?: string; forwardedFor?: string; body?: string } = {},
) {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: {
      ...MCP_HEADERS,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.forwardedFor ? { 'x-forwarded-for': options.forwardedFor } : {}),
    },
    body: options.body ?? JSON.stringify(MCP_INITIALIZE),
  });
  const responseBody = await response.text();
  return { status: response.status, sessionId: response.headers.get('mcp-session-id'), responseBody };
}

function sessionRequestHeaders(sessionId: string, cookie?: string): Record<string, string> {
  return {
    ...MCP_HEADERS,
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-03-26',
    ...(cookie ? { cookie } : {}),
  };
}

async function requestToolsList(app: ReturnType<typeof createServerApp>['app'], sessionId: string) {
  return app.request('/mcp', {
    method: 'POST',
    headers: sessionRequestHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => {
    try { await client.close(); } catch { /* A deliberately failed connect has nothing to close. */ }
  }));
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  rmSync(resolve('.w', 'mcp-live-inputs'), { recursive: true, force: true });
});

afterAll(() => serverRuntime.dispose());

describe('I3 MCP server', () => {
  it('binds each session to its initialization workspace for POST, GET, and DELETE', async () => {
    const { app } = makeRuntime();
    const cookieA = await visitorCookie(app);
    const cookieB = await visitorCookie(app);
    const created = await app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'PRIVATE WORKSPACE A MARKER' }),
    });
    const invoiceId = (await created.json() as { id: string }).id;
    const initialized = await initializeOverHttp(app, { cookie: cookieA });
    expect(initialized.status).toBe(200);
    expect(initialized.sessionId).toBeTruthy();
    const sessionId = initialized.sessionId!;

    const post = await app.request('/mcp', {
      method: 'POST',
      headers: sessionRequestHeaders(sessionId, cookieB),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'explain', arguments: { invoiceId } },
      }),
    });
    const postBody = await post.text();
    expect(post.status).toBe(404);
    expect(postBody).not.toContain('PRIVATE WORKSPACE A MARKER');

    const get = await app.request('/mcp', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-03-26',
        cookie: cookieB,
      },
    });
    expect(get.status).toBe(404);
    await get.body?.cancel();

    const deletion = await app.request('/mcp', {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26', cookie: cookieB },
    });
    expect(deletion.status).toBe(404);
    const ownerRequest = await requestToolsList(app, sessionId);
    expect(ownerRequest.status).toBe(200);
    await ownerRequest.body?.cancel();
  });

  it('does not create a workspace for an invalid initialize body', async () => {
    const { app, db } = makeRuntime({ seedExamples: false });
    for (let index = 0; index < 16; index += 1) {
      const result = await initializeOverHttp(app, { body: '{"method":"initialize"}' });
      expect(result.status).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toMatchObject({ count: 0 });
    expect((await initializeOverHttp(app)).status).toBe(200);
  });

  it('rate-limits session creation per IP without minting rejected workspaces', async () => {
    const { app, db } = makeRuntime({ seedExamples: false });
    const attempts = await Promise.all([
      initializeOverHttp(app), initializeOverHttp(app), initializeOverHttp(app), initializeOverHttp(app),
    ]);
    expect(attempts.map(({ status }) => status)).toEqual([200, 200, 200, 429]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toMatchObject({ count: 3 });
  });

  it('caps live sessions globally even when initialization comes from distinct IPs', async () => {
    const { app, db } = makeRuntime({ seedExamples: false, trustProxy: true });
    const statuses: number[] = [];
    for (let index = 1; index <= 129; index += 1) {
      const result = await initializeOverHttp(app, { forwardedFor: `203.0.113.${index}` });
      statuses.push(result.status);
    }
    expect(statuses.slice(0, 128).every((status) => status === 200)).toBe(true);
    expect(statuses[128]).toBe(503);
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toMatchObject({ count: 128 });
  });

  it('expires idle sessions and drops sessions after workspace TTL cleanup', async () => {
    vi.useFakeTimers();
    try {
      const runtime = makeRuntime({ seedExamples: false, autoCleanup: true });
      const first = await initializeOverHttp(runtime.app);
      expect(first.status).toBe(200);
      expect(first.sessionId).toBeTruthy();
      await vi.advanceTimersByTimeAsync(MCP_SESSION_IDLE_TTL_MS + 60 * 1000);
      const expired = await requestToolsList(runtime.app, first.sessionId!);
      expect(expired.status).toBe(404);
      await expired.body?.cancel();

      const second = await initializeOverHttp(runtime.app);
      expect(second.status).toBe(200);
      runtime.db.prepare("UPDATE workspaces SET last_seen = '2000-01-01T00:00:00.000Z'").run();
      await runtime.runTtlCleanup();
      expect(runtime.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toMatchObject({ count: 0 });
      const missingWorkspace = await requestToolsList(runtime.app, second.sessionId!);
      expect(missingWorkspace.status).toBe(404);
      await missingWorkspace.body?.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces the API streaming body limit before parsing or workspace creation', async () => {
    const paddedInitialize = {
      ...MCP_INITIALIZE,
      params: { ...MCP_INITIALIZE.params, capabilities: { padding: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1_000_000) } },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(paddedInitialize));
    for (const contentLength of [String(bytes.byteLength), '0', undefined]) {
      const runtime = makeRuntime({ seedExamples: false });
      let emitted = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted >= bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(emitted + 64 * 1024, bytes.byteLength);
          controller.enqueue(bytes.slice(emitted, end));
          emitted = end;
        },
      });
      const headers = new Headers(MCP_HEADERS);
      if (contentLength !== undefined) headers.set('content-length', contentLength);
      const request = new Request('http://localhost/mcp', {
        method: 'POST', headers, body: stream, duplex: 'half',
      } as RequestInit);
      const response = await runtime.app.fetch(request);
      expect(response.status).toBe(413);
      expect(emitted).toBeLessThan(bytes.byteLength);
      expect(runtime.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toMatchObject({ count: 0 });
      await response.text();
      runtime.dispose();
    }
  });

  it('exposes only safe tools and has no approve or reject capability', async () => {
    const { app, db } = makeRuntime();
    const client = connectMcp(app);
    await client.connectMcp();

    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual(['decide', 'explain', 'export_batch']);
    for (const name of ['approve', 'reject']) {
      const result = await client.callTool({ name, arguments: { invoiceId: 'AL-030' } });
      expect(result.isError).toBe(true);
    }
    const attemptedScopeOverride = await client.callTool({
      name: 'explain', arguments: { invoiceId: 'AL-030', workspaceId: 'another-visitor' },
    });
    expect(attemptedScopeOverride.isError).toBe(true);
    expect(toolText(attemptedScopeOverride)).not.toContain('another-visitor');

    const workspaceId = (db.prepare('SELECT id FROM workspaces').get() as { id: string }).id;
    const forgedSession = await app.request('/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': workspaceId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(forgedSession.status).toBe(404);
    expect(getInvoice(db, workspaceId, 'AL-030')?.status).toBe('queued');
    expect(db.prepare('SELECT COUNT(*) AS count FROM decision_records WHERE workspace_id = ?').get(workspaceId))
      .toMatchObject({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ?').get(workspaceId))
      .toMatchObject({ count: 0 });
  });

  it('creates a separate seeded workspace per MCP session and scopes tool arguments to it', async () => {
    const { app, db } = makeRuntime();
    const firstResponses: Response[] = [];
    const first = connectMcp(app, undefined, firstResponses);
    const second = connectMcp(app);
    await Promise.all([first.connectMcp(), second.connectMcp()]);
    expect(firstResponses[0]?.headers.get('set-cookie')).toBeNull();

    const secondBefore = toolJson<Expediente>(await second.callTool({ name: 'explain', arguments: { invoiceId: 'AL-030' } }));
    expect(secondBefore.row.id).toBe('AL-030');
    expect(secondBefore.record).toBeNull();

    const decision = await first.callTool({
      name: 'decide', arguments: { invoiceId: 'AL-030', idempotencyKey: 'session-isolation' },
    });
    expect(decision.isError).not.toBe(true);
    const firstAfter = toolJson<Expediente>(await first.callTool({ name: 'explain', arguments: { invoiceId: 'AL-030' } }));
    const secondAfter = toolJson<Expediente>(await second.callTool({ name: 'explain', arguments: { invoiceId: 'AL-030' } }));
    expect(firstAfter.record).not.toBeNull();
    expect(secondAfter.record).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toMatchObject({ count: 2 });
  });

  it('uses an existing visitor cookie but cannot reach that visitor from another MCP session', async () => {
    const { app } = makeRuntime();
    const cookie = await visitorCookie(app);
    const created = await app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Private visitor invoice.' }),
    });
    expect(created.status).toBe(201);
    const invoiceId = (await created.json() as { id: string }).id;

    const owner = connectMcp(app, cookie);
    const stranger = connectMcp(app);
    await Promise.all([owner.connectMcp(), stranger.connectMcp()]);

    const owned = await owner.callTool({ name: 'explain', arguments: { invoiceId } });
    expect(owned.isError).not.toBe(true);
    expect(toolJson<Expediente>(owned).sourceText).toBe('Private visitor invoice.');

    const hidden = await stranger.callTool({ name: 'explain', arguments: { invoiceId } });
    expect(hidden.isError).toBe(true);
    expect(toolText(hidden)).not.toContain(invoiceId);
  });

  it('matches /api/v1/decide for a seeded id and preserves idempotency conflicts', async () => {
    const { app } = makeRuntime();
    const api = await app.request('/api/v1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'http-parity' },
      body: JSON.stringify({ invoiceId: 'AL-030' }),
    });
    expect(api.status).toBe(200);
    const apiResult = await api.json() as DecideResponse;

    const client = connectMcp(app);
    await client.connectMcp();
    const toolResult = await client.callTool({
      name: 'decide', arguments: { invoiceId: 'AL-030', idempotencyKey: 'mcp-parity' },
    });
    expect(toolResult.isError).not.toBe(true);
    const mcpResult = toolJson<DecideResponse>(toolResult);
    expect({ state: mcpResult.state, headline: mcpResult.headline, reasons: mcpResult.reasons, checks: mcpResult.checks })
      .toEqual({ state: apiResult.state, headline: apiResult.headline, reasons: apiResult.reasons, checks: apiResult.checks });

    const retry = await client.callTool({
      name: 'decide', arguments: { invoiceId: 'AL-030', idempotencyKey: 'mcp-parity' },
    });
    expect(toolJson<DecideResponse>(retry)).toEqual(mcpResult);
    const conflict = await client.callTool({
      name: 'decide', arguments: { invoiceId: 'AL-031', idempotencyKey: 'mcp-parity' },
    });
    expect(conflict.isError).toBe(true);
    expect(toolText(conflict)).not.toContain('idempotency_conflict');
    expect(toolText(conflict)).not.toContain('stack');
  });

  it('sends new text and file inputs through I2 live extraction and the shared call limiter', async () => {
    const uploadDirectory = resolve('.w', 'mcp-live-inputs');
    const limiter = createLiveCallLimiter();
    const reserveCall = vi.spyOn(limiter, 'reserveCall');
    const extractProvider = vi.fn(async (input: { kind: SourceKind; mode?: string; onAttempt?: () => void }) => {
      input.onAttempt?.();
      return { ok: false as const, error: 'unreadable' as const, sourceKind: input.kind };
    });
    const { app } = makeRuntime({ seedExamples: false, uploadDirectory, limiter, extractProvider });
    const client = connectMcp(app);
    await client.connectMcp();

    const text = await client.callTool({
      name: 'decide', arguments: { text: 'Fictional invoice text.', idempotencyKey: 'mcp-live-text' },
    });
    expect(toolJson<DecideResponse>(text).state).toBe('review_required');
    const file = await client.callTool({
      name: 'decide',
      arguments: {
        file: {
          name: 'invoice.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.7\n').toString('base64'),
        },
        idempotencyKey: 'mcp-live-file',
      },
    });
    expect(toolJson<DecideResponse>(file).state).toBe('review_required');

    expect(extractProvider).toHaveBeenCalledTimes(2);
    expect(extractProvider.mock.calls.map(([input]) => input.mode)).toEqual(['live', 'live']);
    expect(reserveCall).toHaveBeenCalledTimes(2);
    expect(reserveCall).toHaveBeenCalledWith(expect.objectContaining({ ip: '192.0.2.10', mode: 'live' }));
  });

  it('returns the exact UI batch-export CSV as tool text', async () => {
    const { app } = makeRuntime();
    const cookie = await visitorCookie(app);
    const decision = await app.request('/api/v1/decide', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'Idempotency-Key': 'ready-for-export' },
      body: JSON.stringify({ invoiceId: 'AL-030' }),
    });
    expect(decision.status).toBe(200);

    const expectedResponse = await app.request('/api/export/payments.csv?batch=1&ready=AL-030', { headers: { cookie } });
    const expectedCsv = await expectedResponse.text();
    const client = connectMcp(app, cookie);
    await client.connectMcp();
    const result = await client.callTool({ name: 'export_batch', arguments: { readyIds: ['AL-030'] } });

    expect(result.isError).not.toBe(true);
    expect(toolText(result)).toBe(expectedCsv);
  });
});
