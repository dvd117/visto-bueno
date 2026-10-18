import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/db';
import { createServerApp, serverRuntime } from '../../src/server/app';

afterAll(() => serverRuntime.dispose());

function cookies(response: Response, previous = ''): string {
  const parts = new Map(previous.split(';').filter(Boolean).map((value) => value.trim().split('=') as [string, string]));
  for (const match of (response.headers.get('set-cookie') ?? '').matchAll(/(?:^|,\s*)(workspace_id|active_client_id)=([A-Za-z0-9_-]+)/g)) {
    parts.set(match[1]!, match[2]!);
  }
  return [...parts].map((part) => part.join('=')).join('; ');
}

describe('K1 round-2 client context regression probes', () => {
  it('routes an Andina tab write to Andina after another tab switches the shared cookie to Marea', async () => {
    const runtime = createServerApp({ db: openDb(':memory:'), autoCleanup: false });
    try {
      const initial = await runtime.app.request('/api/clients');
      const ownerCookie = cookies(initial);
      const directory = await initial.json() as { clients: Array<{ id: string }> };
      const andinaId = directory.clients[0]!.id;
      const mareaId = directory.clients[1]!.id;
      const before = await runtime.app.request('/api/data/budgets', {
        headers: { cookie: ownerCookie, 'X-Client-Id': andinaId },
      });
      const andinaBudgets = await before.json() as Array<Record<string, unknown>>;
      expect(andinaBudgets.length).toBeGreaterThan(0);

      const switched = await runtime.app.request('/api/clients/switch', {
        method: 'POST',
        headers: { cookie: ownerCookie, 'content-type': 'application/json', 'X-Client-Id': andinaId },
        body: JSON.stringify({ clientId: mareaId }),
      });
      expect(switched.status).toBe(200);
      const sharedCookie = cookies(switched, ownerCookie);

      // Tab A still displays Andina, but the browser sends the cookie Tab B changed to Marea.
      const save = await runtime.app.request('/api/data/budgets', {
        method: 'PUT',
        headers: { cookie: sharedCookie, 'content-type': 'application/json', 'X-Client-Id': andinaId },
        body: JSON.stringify({ ...andinaBudgets[0], approvedUsdMinor: 12345 }),
      });
      expect(save.status).toBe(200);
      expect(await save.json()).toMatchObject({ approvedUsdMinor: 12345 });

      const stillAndina = await runtime.app.request('/api/data/budgets', {
        headers: { cookie: sharedCookie, 'X-Client-Id': andinaId },
      });
      expect(await stillAndina.json()).toContainEqual(expect.objectContaining({ approvedUsdMinor: 12345 }));

      const marea = await runtime.app.request('/api/data/budgets', {
        headers: { cookie: sharedCookie, 'X-Client-Id': mareaId },
      });
      expect(await marea.json()).toEqual([]);
    } finally {
      runtime.dispose();
    }
  });

  it('routes a mutating request without the header to the cookie-active client', async () => {
    const runtime = createServerApp({ db: openDb(':memory:'), autoCleanup: false });
    try {
      const initial = await runtime.app.request('/api/clients');
      const ownerCookie = cookies(initial);
      const directory = await initial.json() as { clients: Array<{ id: string }> };
      const andinaId = directory.clients[0]!.id;
      const mareaId = directory.clients[1]!.id;
      const switched = await runtime.app.request('/api/clients/switch', {
        method: 'POST',
        headers: { cookie: ownerCookie, 'content-type': 'application/json', 'X-Client-Id': andinaId },
        body: JSON.stringify({ clientId: mareaId }),
      });
      expect(switched.status).toBe(200);
      const activeCookie = cookies(switched, ownerCookie);

      const response = await runtime.app.request('/api/invoices', {
        method: 'POST', headers: { cookie: activeCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'No client header' }),
      });
      expect(response.status).toBe(201);
      const created = await response.json() as { id: string };

      const activeInvoices = await runtime.app.request('/api/invoices', { headers: { cookie: activeCookie } });
      expect(await activeInvoices.json()).toContainEqual(expect.objectContaining({ id: created.id }));
    } finally {
      runtime.dispose();
    }
  });

  it('routes direct file links by their owner-validated client query', async () => {
    const runtime = createServerApp({ db: openDb(':memory:'), autoCleanup: false });
    try {
      const initial = await runtime.app.request('/api/clients');
      const ownerCookie = cookies(initial);
      const directory = await initial.json() as { clients: Array<{ id: string }> };
      const andinaId = directory.clients[0]!.id;
      const mareaId = directory.clients[1]!.id;
      const switched = await runtime.app.request('/api/clients/switch', {
        method: 'POST',
        headers: { cookie: ownerCookie, 'content-type': 'application/json', 'X-Client-Id': andinaId },
        body: JSON.stringify({ clientId: mareaId }),
      });
      const activeCookie = cookies(switched, ownerCookie);

      const scoped = await runtime.app.request(`/api/files/AL-032?client_id=${andinaId}`, {
        headers: { cookie: activeCookie },
      });
      expect(scoped.status).toBe(200);
      expect(scoped.headers.get('content-type')).toBe('application/pdf');

      const cookieFallback = await runtime.app.request('/api/files/AL-032', {
        headers: { cookie: activeCookie },
      });
      expect(cookieFallback.status).toBe(404);
    } finally {
      runtime.dispose();
    }
  });

  it('does not allow an owner to select another owner’s client with the context header', async () => {
    const runtime = createServerApp({ db: openDb(':memory:'), autoCleanup: false });
    try {
      const first = await runtime.app.request('/api/clients');
      const firstCookie = cookies(first);
      const firstDirectory = await first.json() as { clients: Array<{ id: string }> };
      const second = await runtime.app.request('/api/clients');
      const secondDirectory = await second.json() as { clients: Array<{ id: string }> };
      const response = await runtime.app.request('/api/data/budgets', {
        headers: { cookie: firstCookie, 'X-Client-Id': secondDirectory.clients[0]!.id },
      });
      expect(response.status).toBe(404);
      expect(firstDirectory.clients.map((client) => client.id)).not.toContain(secondDirectory.clients[0]!.id);
    } finally {
      runtime.dispose();
    }
  });
});
