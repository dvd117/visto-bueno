import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { Db } from '../db/db';
import {
  ensureClientWorkspaces, ensureWorkspace, getOwnedWorkspaceClient, primaryWorkspaceForOwner,
} from '../db/workspace';
import { ensureExampleInvoices } from '../fixtures';
import { getClientIp } from './ip';

export type ServerEnv = {
  Bindings: { incoming?: IncomingMessage };
  Variables: { workspaceId: string; ownerId: string; clientId: string; clientIp: string | null; requestBytes: Uint8Array };
};

export interface WorkspaceMiddlewareOptions {
  seedExamples?: boolean;
  trustProxy?: string | boolean;
  remoteAddress?: (incoming: IncomingMessage | undefined) => string | null | undefined;
}

function cookieValue(header: string | undefined, name: string): string | null {
  const prefix = `${name}=`;
  const item = header?.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
  if (!item) return null;
  const value = item.slice(prefix.length);
  return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

function cookie(name: string, value: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`;
}

function clientContextValue(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

function unknownClient(c: Context<ServerEnv>) {
  return c.json({ error: 'not_found', message: 'No encontré el cliente de esta sesión.' }, 404);
}

export function activeClientCookie(clientId: string): string {
  return cookie('active_client_id', clientId);
}

export function createDocumentWorkspaceCookieMiddleware(): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (c.req.method !== 'GET' || path === '/health' || path === '/api' || path.startsWith('/api/')
      || path === '/assets' || path.startsWith('/assets/') || /^\/favicon(?:\.[^/]*)?$/.test(path)) {
      return next();
    }

    await next();
    const contentType = c.res.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (c.res.status !== 200 || contentType !== 'text/html' || cookieValue(c.req.header('cookie'), 'workspace_id')) return;
    c.header('Set-Cookie', cookie('workspace_id', randomUUID()), { append: true });
  };
}

export function createWorkspaceMiddleware(db: Db, options: WorkspaceMiddlewareOptions = {}): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const cookieHeader = c.req.header('cookie');
    const ownerId = cookieValue(cookieHeader, 'workspace_id') ?? randomUUID();
    const requestedClientId = cookieValue(cookieHeader, 'active_client_id');
    ensureClientWorkspaces(db, ownerId, ownerId);
    const cookieClient = (requestedClientId ? getOwnedWorkspaceClient(db, ownerId, requestedClientId) : null)
      ?? primaryWorkspaceForOwner(db, ownerId);
    if (!cookieClient) throw new Error('Workspace owner has no client workspace.');

    // A present header wins after ownership validation. Direct file/download
    // links may use the query context; otherwise legacy clients fall back to the cookie.
    const headerContext = c.req.header('x-client-id');
    const queryContextPath = c.req.method === 'GET' && (
      c.req.path.startsWith('/api/files/')
      || c.req.path.startsWith('/api/export/')
      || c.req.path.endsWith('/template.csv')
    );
    const queryContext = queryContextPath ? new URL(c.req.url).searchParams.get('client_id') ?? undefined : undefined;
    const requestedContext = headerContext ?? queryContext;
    let requestClient = cookieClient;
    if (requestedContext !== undefined) {
      const clientId = clientContextValue(requestedContext);
      if (!clientId) return unknownClient(c);
      const ownedClient = getOwnedWorkspaceClient(db, ownerId, clientId);
      if (!ownedClient) return unknownClient(c);
      requestClient = ownedClient;
    }

    const workspaceId = requestClient.id;
    ensureWorkspace(db, workspaceId);
    if (requestClient.isPrimary && options.seedExamples !== false) ensureExampleInvoices(db, workspaceId);

    const remoteAddress = options.remoteAddress
      ? options.remoteAddress(c.env?.incoming)
      : c.env?.incoming?.socket.remoteAddress;
    c.set('workspaceId', workspaceId);
    c.set('ownerId', ownerId);
    c.set('clientId', requestClient.clientId);
    c.set('clientIp', getClientIp({
      forwardedFor: c.req.header('x-forwarded-for'),
      remoteAddress,
    }, { trustProxy: options.trustProxy }));

    if (!cookieValue(cookieHeader, 'workspace_id')) c.header('Set-Cookie', cookie('workspace_id', ownerId), { append: true });
    if (requestedClientId && requestedClientId !== cookieClient.clientId) {
      c.header('Set-Cookie', activeClientCookie(cookieClient.clientId), { append: true });
    }
    await next();
  };
}
