import { JSDOM } from 'jsdom';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createServerApp, serverRuntime } from '../../src/server/app';
import { openDb } from '../../src/server/db/db';
import { readCompanyProfile } from '../../src/server/db/workspace';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
for (const key of [
  'window', 'document', 'navigator', 'localStorage', 'StorageEvent', 'HTMLElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLAnchorElement', 'MutationObserver', 'Node', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame',
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[key],
  });
}

const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { createElement } = await import('react');
const { default: App } = await import('../../src/client/app/App');

const runtimes: Array<ReturnType<typeof createServerApp>> = [];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

afterAll(() => serverRuntime.dispose());

async function setup(options: { bootstrapClientSelection?: boolean } = {}) {
  const db = openDb(':memory:');
  const runtime = createServerApp({ db, autoCleanup: false });
  runtimes.push(runtime);
  let cookie = 'workspace_id=review-ui-owner';
  const directory = await (await runtime.app.request('/api/clients', { headers: { cookie } })).json() as {
    clients: Array<{ id: string; name: string }>;
  };
  const [andina, marea] = directory.clients;
  if (!andina || !marea) throw new Error('Expected the fictional Andina and Marea clients.');

  const context = {
    delayNextDirectory: false,
    releaseDirectory: null as null | (() => void),
    stopUploadResponse: false,
    lastWrite: null as null | { status: number; client: string | null },
    directoryClientIds: [] as Array<string | null>,
  };
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    if (path === '/api/clients') context.directoryClientIds.push(headers.get('X-Client-Id'));
    const response = await runtime.app.request(path, { ...init, headers });
    const switched = response.headers.get('set-cookie')?.match(/active_client_id=([A-Za-z0-9_-]+)/)?.[1];
    if (switched) cookie = `workspace_id=review-ui-owner; active_client_id=${switched}`;

    if (path === '/api/clients' && context.delayNextDirectory) {
      context.delayNextDirectory = false;
      return new Promise<Response>((resolve) => { context.releaseDirectory = () => resolve(response); });
    }
    if (path === '/api/invoices' && init?.method === 'POST' && context.stopUploadResponse) {
      context.lastWrite = { status: response.status, client: headers.get('X-Client-Id') };
      return new Promise<Response>(() => {});
    }
    return response;
  };
  vi.stubGlobal('fetch', vi.fn(fetcher));
  localStorage.setItem('visto-bueno:first-run-dismissed', 'true');
  if (options.bootstrapClientSelection) window.sessionStorage.removeItem('visto-bueno:client-id');
  else window.sessionStorage.setItem('visto-bueno:client-id', andina.id);
  const reloadPage = vi.fn();
  render(<App reloadPage={reloadPage} />);
  await screen.findByRole('button', { name: 'Andina Labs Inc.' });

  return {
    db,
    runtime,
    context,
    andina,
    marea,
    async reloadPageAsNewDocument() {
      await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
      cleanup();
      render(<App reloadPage={reloadPage} />);
      await screen.findByRole('button', { name: 'Marea Norte SpA' });
    },
    async otherTabSwitch() {
      const response = await runtime.app.request('/api/clients/switch', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: marea.id }),
      });
      expect(response.status).toBe(200);
      cookie = `workspace_id=review-ui-owner; active_client_id=${marea.id}`;
      act(() => window.dispatchEvent(new StorageEvent('storage', {
        key: 'visto-bueno:client-context-switch', newValue: 'external-switch',
      })));
    },
  };
}

it('REVIEW: stale directory response must not route a visible Marea invoice into Andina', async () => {
  const { db, context, andina, marea, reloadPageAsNewDocument } = await setup({ bootstrapClientSelection: true });
  expect(window.sessionStorage.getItem('visto-bueno:client-id')).toBe(andina.id);
  expect(context.directoryClientIds[0]).toBeNull();
  context.delayNextDirectory = true;
  fireEvent.click(screen.getByRole('link', { name: 'Bandeja' }));
  await waitFor(() => expect(context.releaseDirectory).toBeTypeOf('function'));

  fireEvent.click(screen.getByRole('button', { name: 'Andina Labs Inc.' }));
  fireEvent.click(screen.getByRole('option', { name: /Marea Norte SpA/ }));
  await reloadPageAsNewDocument();
  await act(async () => {
    context.releaseDirectory!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  context.stopUploadResponse = true;
  fireEvent.click(screen.getByRole('button', { name: /\+ Recibir factura/ }));
  fireEvent.change(await screen.findByLabelText('Texto de la factura'), {
    target: { value: 'New Marea invoice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar y evaluar en vivo' }));
  await waitFor(() => expect(context.lastWrite?.status).toBe(201));

  expect(screen.getByRole('button', { name: 'Marea Norte SpA' })).toBeTruthy();
  const stored = db.prepare('SELECT workspace_id FROM invoices WHERE source_text = ?')
    .get('New Marea invoice') as { workspace_id: string };
  const expected = db.prepare('SELECT workspace_id FROM workspace_clients WHERE client_id = ?')
    .get(marea.id) as { workspace_id: string };
  expect(stored.workspace_id).toBe(expected.workspace_id);
  expect(context.lastWrite?.client).toBe(marea.id);
});

it('REVIEW: a cookie-driven Datos refresh must not redirect an Andina draft to Marea', async () => {
  const { db, andina, marea, context, otherTabSwitch } = await setup();
  fireEvent.click(screen.getByRole('link', { name: 'Preparar datos' }));
  await screen.findByLabelText('Nombre de la empresa');
  fireEvent.change(screen.getByLabelText('Nombre de la empresa'), {
    target: { value: 'Andina Pending Edit' },
  });

  await otherTabSwitch();
  fireEvent.click(screen.getByRole('link', { name: 'Preparar datos' }));
  await screen.findByRole('button', { name: 'Andina Labs Inc.' });
  expect(window.sessionStorage.getItem('visto-bueno:client-id')).toBe(andina.id);
  expect(context.directoryClientIds.at(-1)).toBe(andina.id);
  fireEvent.click(screen.getByRole('button', { name: 'Guardar perfil' }));
  await screen.findByText('Perfil guardado.');

  const workspace = db.prepare('SELECT workspace_id FROM workspace_clients WHERE client_id = ?')
    .get(marea.id) as { workspace_id: string };
  expect(readCompanyProfile(db, workspace.workspace_id).name).toBe('Marea Norte SpA');
  const andinaWorkspace = db.prepare('SELECT workspace_id FROM workspace_clients WHERE client_id = ?')
    .get(andina.id) as { workspace_id: string };
  expect(readCompanyProfile(db, andinaWorkspace.workspace_id).name).toBe('Andina Pending Edit');
});
