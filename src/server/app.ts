import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { Db } from './db/db';
import { openDb } from './db/db';
import { createLiveCallLimiter, createWorkspaceTtlCleanup, readLimitedBody } from './middleware/limits';
import { createWorkspaceMiddleware, type ServerEnv, type WorkspaceMiddlewareOptions } from './middleware/workspace';
import { validateProductionAssets } from './fixtures';
import { createApiRoutes } from './routes/api';
import { createRulesRoutes } from './routes/rules';
import type { PipelineOptions } from './pipeline';

export interface CreateServerAppOptions extends Partial<Omit<PipelineOptions, 'db'>>,
  Pick<WorkspaceMiddlewareOptions, 'seedExamples' | 'trustProxy' | 'remoteAddress'> {
  db?: Db;
  dbPath?: string;
  uploadDirectory?: string;
  evaluationReportPath?: string;
  autoCleanup?: boolean;
  closeDbOnDispose?: boolean;
}

export interface ServerRuntime {
  app: Hono<ServerEnv>;
  db: Db;
  dispose(): void;
  runTtlCleanup(): Promise<void>;
}

export function createServerApp(options: CreateServerAppOptions = {}): ServerRuntime {
  if (process.env.NODE_ENV === 'production') validateProductionAssets();
  const db = options.db ?? openDb(options.dbPath ?? process.env.DB_PATH ?? './data/visto-bueno.db');
  const uploadDirectory = resolve(options.uploadDirectory ?? './data/uploads');
  const limiter = options.limiter ?? createLiveCallLimiter();
  const lastRuns = new Map<string, { invoices: number; ms: number; costUsd: string; mode: 'replay' | 'live' }>();
  const app = new Hono<ServerEnv>();

  app.get('/health', (c) => c.json({ ok: true }));
  app.use('/api/*', createWorkspaceMiddleware(db, options));
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'POST' && c.req.method !== 'PUT' && c.req.method !== 'PATCH') return next();
    const result = await readLimitedBody(c.req.raw);
    if (!result.ok) return c.json({ error: 'too_large', message: result.message }, 413);
    c.set('requestBytes', result.bytes);
    await next();
  });
  app.route('/api', createApiRoutes({
    db,
    uploadDirectory,
    ...(options.evaluationReportPath ? { evaluationReportPath: options.evaluationReportPath } : {}),
    lastRuns,
    limiter,
    ...(options.extractProvider ? { extractProvider: options.extractProvider } : {}),
    ...(options.jevProvider ? { jevProvider: options.jevProvider } : {}),
    ...(options.now ? { now: options.now } : {}),
  }));
  app.route('/api', createRulesRoutes({ db }));
  app.notFound((c) => c.req.path.startsWith('/api/')
    ? c.json({ error: 'not_found', message: 'No encontré esta ruta.' }, 404)
    : c.text('Not Found', 404));
  app.onError((cause, c) => {
    if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 429) {
      return c.json({ error: 'rate_limited', message: 'Alcanzaste el límite de llamadas en vivo del demo. Inténtalo más tarde.' }, 429);
    }
    return c.json({ error: 'server_error', message: 'No pude completar la solicitud.' }, 500);
  });

  const cleanup = options.autoCleanup === false ? null : createWorkspaceTtlCleanup({
    cleanupExpiredWorkspaces(expiredBefore) {
      const cutoff = new Date(expiredBefore).toISOString();
      db.transaction(() => {
        db.prepare('DELETE FROM workspaces WHERE last_seen < ?').run(cutoff);
      }).immediate();
    },
  });

  return {
    app,
    db,
    dispose() {
      cleanup?.dispose();
      if (options.closeDbOnDispose !== false) db.close();
    },
    async runTtlCleanup() {
      await cleanup?.runNow();
    },
  };
}

export const serverRuntime = createServerApp();
export const app = serverRuntime.app;
