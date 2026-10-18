import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { getInvoice, openDb } from '../../src/server/db/db';
import { createServerApp } from '../../src/server/app';

const runtimes: Array<ReturnType<typeof createServerApp>> = [];
const uploadDirectory = resolve('.w', 'clients-reset');

function makeRuntime() {
  const runtime = createServerApp({
    db: openDb(':memory:'),
    uploadDirectory,
    autoCleanup: false,
    remoteAddress: () => '192.0.2.10',
  });
  runtimes.push(runtime);
  return runtime;
}

function cookieHeader(response: Response, previous = ''): string {
  const cookies = new Map(previous.split(';').map((part) => part.trim()).filter(Boolean)
    .map((part) => part.split('=', 2) as [string, string]));
  const headers = response.headers.get('set-cookie') ?? '';
  for (const match of headers.matchAll(/(?:^|,\s*)(workspace_id|active_client_id)=([A-Za-z0-9_-]+)/g)) {
    cookies.set(match[1], match[2]);
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

type ClientSummary = { id: string; name: string; invoiceCount: number; readyCount: number };
type ClientDirectory = { activeId: string; clients: ClientSummary[] };
type WorkspaceTable = 'vendors' | 'contracts' | 'budgets' | 'commitments';

function workspaceRowCount(db: ReturnType<typeof openDb>, table: WorkspaceTable, workspaceId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`)
    .get(workspaceId) as { count: number }).count;
}

async function clients(app: ReturnType<typeof makeRuntime>['app'], cookie?: string) {
  const response = await app.request('/api/clients', { headers: cookie ? { cookie } : {} });
  return { response, cookie: cookieHeader(response, cookie), directory: await response.json() as ClientDirectory };
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  rmSync(uploadDirectory, { recursive: true, force: true });
});

describe('K1 multiple clients', () => {
  it('creates separate fictional client workspaces and refuses another owner’s client id', async () => {
    const { app, db } = makeRuntime();
    const ownerA = await clients(app);
    const ownerB = await clients(app);

    expect(ownerA.response.status).toBe(200);
    expect(ownerA.directory.clients.map(({ name }) => name)).toEqual(['Andina Labs Inc.', 'Marea Norte SpA']);
    expect(ownerA.directory.activeId).toBe(ownerA.directory.clients[0].id);
    expect(ownerA.directory.clients[1]).toMatchObject({ invoiceCount: 0, readyCount: 0 });
    const ownerToken = ownerA.cookie.match(/(?:^|; )workspace_id=([^;]+)/)?.[1];
    expect(ownerA.directory.clients.map(({ id }) => id)).not.toContain(ownerToken);
    expect(ownerB.directory.clients.map(({ id }) => id)).not.toContain(ownerA.directory.clients[1].id);
    const secondaryWorkspaceId = (db.prepare('SELECT workspace_id FROM workspace_clients WHERE client_id = ?')
      .get(ownerA.directory.clients[1].id) as { workspace_id: string }).workspace_id;
    expect(['vendors', 'contracts', 'budgets', 'commitments'].map((table) =>
      workspaceRowCount(db, table as WorkspaceTable, secondaryWorkspaceId))).toEqual([0, 0, 0, 0]);

    const switched = await app.request('/api/clients/switch', {
      method: 'POST',
      headers: { cookie: ownerA.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: ownerA.directory.clients[1].id }),
    });
    expect(switched.status).toBe(200);
    const ownerASecondaryCookie = cookieHeader(switched, ownerA.cookie);
    const secondaryInvoices = await app.request('/api/invoices', { headers: { cookie: ownerASecondaryCookie } });
    expect(await secondaryInvoices.json()).toEqual([]);
    const secondaryCompany = await app.request('/api/company', { headers: { cookie: ownerASecondaryCookie } });
    expect(await secondaryCompany.json()).toMatchObject({ name: 'Marea Norte SpA' });

    const crossOwnerSwitch = await app.request('/api/clients/switch', {
      method: 'POST',
      headers: { cookie: ownerB.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: ownerA.directory.clients[1].id }),
    });
    expect(crossOwnerSwitch.status).toBe(404);
    const ownerBCompany = await app.request('/api/company', { headers: { cookie: ownerB.cookie } });
    expect(await ownerBCompany.json()).toMatchObject({ name: 'Andina Labs Inc.' });
    const ownerBDirectory = await clients(app, ownerB.cookie);
    expect(ownerBDirectory.directory.clients.map(({ id }) => id)).not.toContain(ownerA.directory.clients[1].id);
    const foreignClientCookie = `${ownerB.cookie}; active_client_id=${ownerA.directory.clients[1].id}`;
    const foreignClientAttempt = await app.request('/api/company', { headers: { cookie: foreignClientCookie } });
    expect(await foreignClientAttempt.json()).toMatchObject({ name: 'Andina Labs Inc.' });
  });

  it('reset purges uploaded data and files in every client workspace while keeping the empty demo client empty', async () => {
    const { app, db } = makeRuntime();
    const owner = await clients(app);
    const primary = owner.directory.clients[0];
    const secondary = owner.directory.clients[1];
    const primaryWorkspaceId = (db.prepare('SELECT workspace_id FROM workspace_clients WHERE client_id = ?')
      .get(primary.id) as { workspace_id: string }).workspace_id;
    const secondaryWorkspaceId = (db.prepare('SELECT workspace_id FROM workspace_clients WHERE client_id = ?')
      .get(secondary.id) as { workspace_id: string }).workspace_id;
    const customInvoice = await app.request('/api/invoices', {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'INV-PRIVATE-1\nProveedor ficticio\nServicio de prueba' }),
    });
    const customInvoiceId = (await customInvoice.json() as { id: string }).id;

    const switched = await app.request('/api/clients/switch', {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: secondary.id }),
    });
    const secondaryCookie = cookieHeader(switched, owner.cookie);
    const form = new FormData();
    form.set('file', new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], 'private.png', { type: 'image/png' }));
    const uploaded = await app.request('/api/invoices', { method: 'POST', headers: { cookie: secondaryCookie }, body: form });
    const uploadedId = (await uploaded.json() as { id: string }).id;
    const uploadedPath = getInvoice(db, secondaryWorkspaceId, uploadedId)!.filePath!;
    expect(existsSync(resolve(uploadDirectory, uploadedPath!.replace(/^uploads\//, '')))).toBe(true);

    const reset = await app.request('/api/workspace/reset', { method: 'POST', headers: { cookie: secondaryCookie } });
    expect(reset.status).toBe(200);
    expect(getInvoice(db, primaryWorkspaceId, customInvoiceId)).toBeNull();
    expect(getInvoice(db, secondaryWorkspaceId, uploadedId)).toBeNull();
    expect(existsSync(resolve(uploadDirectory, uploadedPath.replace(/^uploads\//, '')))).toBe(false);
    expect(['vendors', 'contracts', 'budgets', 'commitments'].map((table) =>
      workspaceRowCount(db, table as WorkspaceTable, secondaryWorkspaceId))).toEqual([0, 0, 0, 0]);

    const primaryInvoices = await app.request('/api/invoices', { headers: { cookie: owner.cookie } });
    expect(await primaryInvoices.json()).toHaveLength(20);
    const secondaryInvoices = await app.request('/api/invoices', { headers: { cookie: secondaryCookie } });
    expect(await secondaryInvoices.json()).toEqual([]);
    const directoryAfterReset = await clients(app, secondaryCookie);
    expect(directoryAfterReset.directory.clients).toMatchObject([
      { id: primary.id, name: 'Andina Labs Inc.', invoiceCount: 20 },
      { id: secondary.id, name: 'Marea Norte SpA', invoiceCount: 0 },
    ]);
  });
});
