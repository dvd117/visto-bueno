import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Db } from '../db/db';
import { ensureWorkspace } from '../db/workspace';
import { ensureExampleInvoices } from '../fixtures';
import { getClientIp } from './ip';

export type ServerEnv = {
  Bindings: { incoming?: IncomingMessage };
  Variables: { workspaceId: string; clientIp: string | null; requestBytes: Uint8Array };
};

export interface WorkspaceMiddlewareOptions {
  seedExamples?: boolean;
  trustProxy?: string | boolean;
  remoteAddress?: (incoming: IncomingMessage | undefined) => string | null | undefined;
}

function cookieValue(header: string | undefined): string | null {
  const item = header?.split(';').map((value) => value.trim()).find((value) => value.startsWith('workspace_id='));
  if (!item) return null;
  const value = item.slice('workspace_id='.length);
  return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

function workspaceCookie(workspaceId: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `workspace_id=${workspaceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`;
}

export function ensureRequestWorkspace(
  db: Db,
  cookieHeader: string | undefined,
  options: Pick<WorkspaceMiddlewareOptions, 'seedExamples'> = {},
): { workspaceId: string; isNew: boolean } {
  const existingId = cookieValue(cookieHeader);
  const workspaceId = existingId ?? randomUUID();
  ensureWorkspace(db, workspaceId);
  if (options.seedExamples !== false) ensureExampleInvoices(db, workspaceId);
  return { workspaceId, isNew: existingId === null };
}

export function requestClientIp(
  incoming: IncomingMessage | undefined,
  forwardedFor: string | undefined,
  options: Pick<WorkspaceMiddlewareOptions, 'trustProxy' | 'remoteAddress'> = {},
): string | null {
  const remoteAddress = options.remoteAddress
    ? options.remoteAddress(incoming)
    : incoming?.socket.remoteAddress;
  return getClientIp({ forwardedFor, remoteAddress }, { trustProxy: options.trustProxy });
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
    if (c.res.status !== 200 || contentType !== 'text/html' || cookieValue(c.req.header('cookie'))) return;
    c.header('Set-Cookie', workspaceCookie(randomUUID()), { append: true });
  };
}

export function createWorkspaceMiddleware(db: Db, options: WorkspaceMiddlewareOptions = {}): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const { workspaceId, isNew } = ensureRequestWorkspace(db, c.req.header('cookie'), options);
    c.set('workspaceId', workspaceId);
    c.set('clientIp', requestClientIp(c.env?.incoming, c.req.header('x-forwarded-for'), options));

    if (isNew) c.header('Set-Cookie', workspaceCookie(workspaceId));
    await next();
  };
}
