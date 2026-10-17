import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

const distPath = resolve(process.cwd(), 'dist');
if (existsSync(distPath)) {
  app.use('/*', serveStatic({ root: distPath }));
}

const rawPort = process.env.PORT ?? '3000';
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${rawPort}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  serve(
    {
      fetch: app.fetch,
      hostname: '0.0.0.0',
      port,
    },
    (info) => {
      console.log(`[server] listening on port ${info.port}`);
    },
  );
}
