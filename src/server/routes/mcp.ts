import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { MiddlewareHandler } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { InitializeRequestSchema, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  decideResponseSchema,
  expedienteSchema,
  mcpDecideInputSchema,
  mcpExplainInputSchema,
  mcpExportBatchInputSchema,
} from '../../shared/api-schemas';
import type { Db } from '../db/db';
import { ensureRequestWorkspace, requestClientIp, type ServerEnv, type WorkspaceMiddlewareOptions } from '../middleware/workspace';
import { createMcpSessionCreationLimiter, MAX_REQUEST_BODY_BYTES, readLimitedBody } from '../middleware/limits';

const INTERNAL_CLIENT_IP_HEADER = 'x-vb-internal-client-ip';
const MCP_SERVER_INFO = { name: 'visto-bueno', version: '1.0.0' };
const GENERIC_TOOL_ERROR = 'No pude completar la solicitud.';

type InternalFetch = (request: Request, env?: ServerEnv['Bindings']) => Response | Promise<Response>;

interface McpRouteOptions extends Pick<WorkspaceMiddlewareOptions, 'seedExamples' | 'trustProxy' | 'remoteAddress'> {
  db: Db;
  fetchApi: InternalFetch;
}

interface McpSession {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  workspaceId: string;
  requiresWorkspaceCookie: boolean;
  lastActivityAt: number;
}

export const MCP_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;
const MCP_MAX_LIVE_SESSIONS = 128;

function toolText(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

function genericToolError() {
  return toolText(GENERIC_TOOL_ERROR, true);
}

function clientIpFromToolRequest(extra: {
  requestInfo?: { headers: Record<string, string | string[] | undefined> };
}): string | null {
  const value = extra.requestInfo?.headers[INTERNAL_CLIENT_IP_HEADER];
  return typeof value === 'string' && value.length <= 64 ? value : null;
}

function internalEnvironment(clientIp: string | null): ServerEnv['Bindings'] | undefined {
  if (!clientIp) return undefined;
  return { incoming: { socket: { remoteAddress: clientIp } } as IncomingMessage };
}

function initializeMessage(request: Request, bytes: Uint8Array): { ok: true; message: unknown } | { ok: false } {
  if (request.method !== 'POST') return { ok: false };
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return { ok: false };
  const accept = request.headers.get('accept');
  if (!accept?.includes('application/json') || !accept.includes('text/event-stream')) return { ok: false };

  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { ok: false };
  }
  if (Array.isArray(message)
    || !JSONRPCMessageSchema.safeParse(message).success
    || !InitializeRequestSchema.safeParse(message).success) return { ok: false };
  return { ok: true, message };
}

function cookieNamesDifferentWorkspace(cookieHeader: string | undefined, workspaceId: string): boolean {
  const values = cookieHeader?.split(';').map((value) => value.trim())
    .filter((value) => value.startsWith('workspace_id='))
    .map((value) => value.slice('workspace_id='.length)) ?? [];
  return values.some((value) => value !== workspaceId);
}

function cookieIncludesWorkspace(cookieHeader: string | undefined, workspaceId: string): boolean {
  const values = cookieHeader?.split(';').map((value) => value.trim())
    .filter((value) => value.startsWith('workspace_id='))
    .map((value) => value.slice('workspace_id='.length)) ?? [];
  return values.length > 0 && values.every((value) => value === workspaceId);
}

export function createMcpRoute(options: McpRouteOptions): {
  handler: MiddlewareHandler<ServerEnv>;
  pruneMissingWorkspaces(): void;
  dispose(): void;
} {
  const sessions = new Map<string, McpSession>();
  const sessionCreationLimiter = createMcpSessionCreationLimiter();
  let pendingCreations = 0;

  function sessionNotFound(): Response {
    return new Response('Not Found', { status: 404 });
  }

  function workspaceExists(workspaceId: string): boolean {
    return Boolean(options.db.prepare('SELECT 1 AS found FROM workspaces WHERE id = ?').get(workspaceId));
  }

  function closeSession(sessionId: string, expected?: McpSession): void {
    const session = sessions.get(sessionId);
    if (!session || (expected && session !== expected)) return;
    sessions.delete(sessionId);
    void session.transport.close().catch(() => undefined);
    void session.server.close().catch(() => undefined);
  }

  function closeSessionState(session: McpSession): void {
    for (const [sessionId, active] of sessions) {
      if (active === session) closeSession(sessionId, session);
    }
    void session.transport.close().catch(() => undefined);
    void session.server.close().catch(() => undefined);
  }

  function pruneMissingWorkspaces(): void {
    const workspaceIds = new Set((options.db.prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>).map(({ id }) => id));
    for (const [sessionId, session] of sessions) {
      if (!workspaceIds.has(session.workspaceId)) closeSession(sessionId, session);
    }
  }

  function expireIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.lastActivityAt >= MCP_SESSION_IDLE_TTL_MS) closeSession(sessionId, session);
    }
    pruneMissingWorkspaces();
  }

  const sessionCleanupTimer = setInterval(expireIdleSessions, MCP_SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref?.();

  const handler: MiddlewareHandler<ServerEnv> = async (c) => {
    const request = c.req.raw;
    const clientIp = requestClientIp(c.env?.incoming, c.req.header('x-forwarded-for'), options);
    const headers = new Headers(request.headers);
    headers.set(INTERNAL_CLIENT_IP_HEADER, clientIp ?? '');
    const sessionId = c.req.header('mcp-session-id');
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (sessionId && !session) return sessionNotFound();
    if (session) {
      const cookie = c.req.header('cookie');
      if (session.requiresWorkspaceCookie
        ? !cookieIncludesWorkspace(cookie, session.workspaceId)
        : cookieNamesDifferentWorkspace(cookie, session.workspaceId)) return sessionNotFound();
      if (!workspaceExists(session.workspaceId) || Date.now() - session.lastActivityAt >= MCP_SESSION_IDLE_TTL_MS) {
        closeSession(sessionId!, session);
        return sessionNotFound();
      }
      session.lastActivityAt = Date.now();
    }

    let scopedRequest: Request;
    let parsedInitialize: unknown;
    if (request.method === 'POST') {
      const limited = await readLimitedBody(request, MAX_REQUEST_BODY_BYTES);
      if (!limited.ok) return c.json({ error: 'too_large', message: limited.message }, 413);
      if (!session) {
        const initialized = initializeMessage(request, limited.bytes);
        if (!initialized.ok) return new Response('Bad Request', { status: 400 });
        parsedInitialize = initialized.message;
      }
      scopedRequest = new Request(request, { headers, body: session ? limited.bytes : new Uint8Array() });
    } else {
      scopedRequest = new Request(request, { headers });
    }

    if (session) {
      // The session may have expired or its workspace may have been removed while a POST body streamed in.
      if (!sessionId || sessions.get(sessionId) !== session || !workspaceExists(session.workspaceId)) {
        if (sessionId) closeSession(sessionId, session);
        return sessionNotFound();
      }
      session.lastActivityAt = Date.now();
      try {
        return await session.transport.handleRequest(scopedRequest);
      } catch {
        return new Response('Internal Server Error', { status: 500 });
      }
    }

    if (parsedInitialize === undefined) return new Response('Bad Request', { status: 400 });
    expireIdleSessions();
    if (sessions.size + pendingCreations >= MCP_MAX_LIVE_SESSIONS) {
      return new Response('Service Unavailable', { status: 503 });
    }
    if (!sessionCreationLimiter.reserve(clientIp)) return new Response('Too Many Requests', { status: 429 });

    pendingCreations += 1;
    let workspaceId: string | undefined;
    let workspaceWasNew = false;
    let sessionState: McpSession | undefined;
    let server: McpServer | undefined;
    let transport: WebStandardStreamableHTTPServerTransport | undefined;
    try {
      const requestedWorkspaceId = c.req.header('cookie')?.split(';').map((value) => value.trim())
        .find((value) => value.startsWith('workspace_id='))?.slice('workspace_id='.length);
      const workspaceExisted = requestedWorkspaceId ? workspaceExists(requestedWorkspaceId) : false;
      const workspace = ensureRequestWorkspace(options.db, c.req.header('cookie'), options);
      workspaceId = workspace.workspaceId;
      workspaceWasNew = !workspaceExisted;
      server = new McpServer(MCP_SERVER_INFO);
      sessionState = {
        server,
        transport: null as unknown as WebStandardStreamableHTTPServerTransport,
        workspaceId,
        requiresWorkspaceCookie: !workspace.isNew,
        lastActivityAt: Date.now(),
      };
      const currentSession = sessionState;
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized(id) {
          sessions.set(id, currentSession);
        },
        onsessionclosed(id) {
          const closedSession = sessions.get(id);
          if (closedSession) {
            sessions.delete(id);
            void closedSession.server.close().catch(() => undefined);
          } else {
            void currentSession.server.close().catch(() => undefined);
          }
        },
      });
      sessionState.transport = transport;

      server.registerTool('decide', {
        title: 'Decide invoice',
        description: 'Evalúa una factura con el mismo pipeline de la API. Registra una decisión automática; no aprueba ni rechaza.',
        inputSchema: mcpDecideInputSchema,
      }, async (input, extra) => {
        try {
          const requestHeaders = new Headers({
            cookie: `workspace_id=${currentSession.workspaceId}`,
            'Idempotency-Key': input.idempotencyKey,
          });
          let body: FormData | string;
          if ('file' in input) {
            const form = new FormData();
            const bytes = Buffer.from(input.file.contentBase64, 'base64');
            form.set('file', new File([bytes], input.file.name, { type: input.file.mimeType }));
            body = form;
          } else {
            requestHeaders.set('content-type', 'application/json');
            body = JSON.stringify('invoiceId' in input ? { invoiceId: input.invoiceId } : { text: input.text });
          }
          const response = await options.fetchApi(new Request('http://visto-bueno.internal/api/v1/decide', {
            method: 'POST', headers: requestHeaders, body,
          }), internalEnvironment(clientIpFromToolRequest(extra)));
          if (!response.ok) return genericToolError();
          const parsed = decideResponseSchema.safeParse(await response.json());
          return parsed.success ? toolText(JSON.stringify(parsed.data)) : genericToolError();
        } catch {
          return genericToolError();
        }
      });

      server.registerTool('explain', {
        title: 'Explain invoice',
        description: 'Read-only expediente: historial de decisiones, citas de evidencia y sello, limitado al workspace de esta sesión.',
        inputSchema: mcpExplainInputSchema,
        annotations: { readOnlyHint: true },
      }, async ({ invoiceId }, extra) => {
        try {
          const response = await options.fetchApi(new Request(
            `http://visto-bueno.internal/api/invoices/${encodeURIComponent(invoiceId)}`,
            { headers: { cookie: `workspace_id=${currentSession.workspaceId}` } },
          ), internalEnvironment(clientIpFromToolRequest(extra)));
          if (!response.ok) return genericToolError();
          const parsed = expedienteSchema.safeParse(await response.json());
          return parsed.success ? toolText(JSON.stringify(parsed.data)) : genericToolError();
        } catch {
          return genericToolError();
        }
      });

      server.registerTool('export_batch', {
        title: 'Export payment batch',
        description: 'Devuelve el CSV de pagos del workspace: facturas listas elegibles y ya aprobadas. No aprueba facturas.',
        inputSchema: mcpExportBatchInputSchema,
        annotations: { readOnlyHint: true },
      }, async ({ readyIds }, extra) => {
        try {
          let path = '/api/export/payments.csv';
          if (readyIds !== undefined) {
            const query = new URLSearchParams({ batch: '1' });
            readyIds.forEach((id) => query.append('ready', id));
            path += `?${query.toString()}`;
          }
          const response = await options.fetchApi(new Request(`http://visto-bueno.internal${path}`, {
            headers: { cookie: `workspace_id=${currentSession.workspaceId}` },
          }), internalEnvironment(clientIpFromToolRequest(extra)));
          if (!response.ok) return genericToolError();
          return toolText(await response.text());
        } catch {
          return genericToolError();
        }
      });

      await server.connect(transport);
      const response = await transport.handleRequest(scopedRequest, { parsedBody: parsedInitialize });
      if (response.status !== 200) {
        closeSessionState(sessionState);
        if (workspaceWasNew && workspaceId) options.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
      }
      return response;
    } catch {
      if (sessionState) closeSessionState(sessionState);
      else {
        if (transport) void transport.close().catch(() => undefined);
        if (server) void server.close().catch(() => undefined);
      }
      if (workspaceWasNew && workspaceId) options.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
      return new Response('Internal Server Error', { status: 500 });
    } finally {
      pendingCreations -= 1;
    }
  };

  return {
    handler,
    pruneMissingWorkspaces,
    dispose() {
      clearInterval(sessionCleanupTimer);
      for (const [sessionId, session] of sessions) closeSession(sessionId, session);
    },
  };
}
