import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { MiddlewareHandler } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  decideResponseSchema,
  expedienteSchema,
  mcpDecideInputSchema,
  mcpExplainInputSchema,
  mcpExportBatchInputSchema,
} from '../../shared/api-schemas';
import type { Db } from '../db/db';
import { ensureRequestWorkspace, requestClientIp, type ServerEnv, type WorkspaceMiddlewareOptions } from '../middleware/workspace';

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
}

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

function initializeRequest(request: Request): Promise<boolean> {
  if (request.method !== 'POST' || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return Promise.resolve(false);
  }
  return request.clone().json().then((body: unknown) => Boolean(
    body && typeof body === 'object' && 'method' in body && body.method === 'initialize',
  )).catch(() => false);
}

export function createMcpRoute(options: McpRouteOptions): { handler: MiddlewareHandler<ServerEnv>; dispose(): void } {
  const sessions = new Map<string, McpSession>();

  const handler: MiddlewareHandler<ServerEnv> = async (c) => {
    const request = c.req.raw;
    const clientIp = requestClientIp(c.env?.incoming, c.req.header('x-forwarded-for'), options);
    const headers = new Headers(request.headers);
    headers.set(INTERNAL_CLIENT_IP_HEADER, clientIp ?? '');
    const scopedRequest = new Request(request, { headers });
    const sessionId = c.req.header('mcp-session-id');
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (sessionId && !session) return new Response('Not Found', { status: 404 });
    if (!session) {
      if (!await initializeRequest(scopedRequest)) return new Response('Bad Request', { status: 400 });
      const { workspaceId } = ensureRequestWorkspace(options.db, c.req.header('cookie'), options);
      const server = new McpServer(MCP_SERVER_INFO);
      const sessionState: McpSession = {
        server,
        transport: null as unknown as WebStandardStreamableHTTPServerTransport,
        workspaceId,
      };
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized(id) {
          sessions.set(id, sessionState);
        },
        onsessionclosed(id) {
          sessions.delete(id);
          void server.close().catch(() => undefined);
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
            cookie: `workspace_id=${sessionState.workspaceId}`,
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
            { headers: { cookie: `workspace_id=${sessionState.workspaceId}` } },
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
            headers: { cookie: `workspace_id=${sessionState.workspaceId}` },
          }), internalEnvironment(clientIpFromToolRequest(extra)));
          if (!response.ok) return genericToolError();
          return toolText(await response.text());
        } catch {
          return genericToolError();
        }
      });

      await server.connect(transport);
      session = sessionState;
    }

    try {
      return await session.transport.handleRequest(scopedRequest);
    } catch {
      return new Response('Internal Server Error', { status: 500 });
    }
  };

  return {
    handler,
    dispose() {
      for (const session of sessions.values()) void session.server.close().catch(() => undefined);
      sessions.clear();
    },
  };
}
