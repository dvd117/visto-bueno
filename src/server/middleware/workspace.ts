import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
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
    const activeClient = (requestedClientId ? getOwnedWorkspaceClient(db, ownerId, requestedClientId) : null)
      ?? primaryWorkspaceForOwner(db, ownerId);
    if (!activeClient) throw new Error('Workspace owner has no client workspace.');
    const workspaceId = activeClient.id;
    ensureWorkspace(db, workspaceId);
    if (activeClient.isPrimary && options.seedExamples !== false) ensureExampleInvoices(db, workspaceId);

    const remoteAddress = options.remoteAddress
      ? options.remoteAddress(c.env?.incoming)
      : c.env?.incoming?.socket.remoteAddress;
    c.set('workspaceId', workspaceId);
    c.set('ownerId', ownerId);
    c.set('clientId', activeClient.clientId);
    c.set('clientIp', getClientIp({
      forwardedFor: c.req.header('x-forwarded-for'),
      remoteAddress,
    }, { trustProxy: options.trustProxy }));

    if (!cookieValue(cookieHeader, 'workspace_id')) c.header('Set-Cookie', cookie('workspace_id', ownerId), { append: true });
    if (requestedClientId && requestedClientId !== activeClient.clientId) {
      c.header('Set-Cookie', activeClientCookie(activeClient.clientId), { append: true });
    }
    await next();
  };
}
