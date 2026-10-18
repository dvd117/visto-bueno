import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ClientDirectory, ClientSummary } from '../../shared/api';
import type { Db } from '../db/db';
import { getOwnedWorkspaceClient, listOwnedWorkspaceClients, readCompanyProfile } from '../db/workspace';
import type { ServerEnv } from '../middleware/workspace';
import { activeClientCookie } from '../middleware/workspace';

const clientSwitchSchema = z.object({
  clientId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

function parseBody(c: Context<ServerEnv>): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(c.get('requestBytes'))) as unknown;
  } catch {
    return null;
  }
}

function clientSummary(db: Db, clientId: string, workspaceId: string, name: string): ClientSummary {
  const counts = db.prepare(`SELECT COUNT(*) AS invoice_count,
    SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_count
    FROM invoices WHERE workspace_id = ?`).get(workspaceId) as { invoice_count: number; ready_count: number | null };
  return {
    id: clientId,
    name,
    invoiceCount: counts.invoice_count,
    readyCount: counts.ready_count ?? 0,
  };
}

export function createClientRoutes({ db }: { db: Db }): Hono<ServerEnv> {
  const routes = new Hono<ServerEnv>();

  routes.get('/clients', (c) => {
    const clients = listOwnedWorkspaceClients(db, c.get('ownerId')).map((client) => clientSummary(
      db,
      client.clientId,
      client.id,
      readCompanyProfile(db, client.id).name,
    ));
    const body: ClientDirectory = { activeId: c.get('clientId'), clients };
    return c.json(body);
  });

  routes.post('/clients/switch', (c) => {
    const parsed = clientSwitchSchema.safeParse(parseBody(c));
    if (!parsed.success) return c.json({ error: 'invalid_request', message: 'Elige un cliente válido.' }, 400);
    const client = getOwnedWorkspaceClient(db, c.get('ownerId'), parsed.data.clientId);
    if (!client) return c.json({ error: 'not_found', message: 'No encontré ese espacio de trabajo.' }, 404);
    c.header('Set-Cookie', activeClientCookie(client.clientId), { append: true });
    return c.json({ activeId: client.clientId });
  });

  return routes;
}
