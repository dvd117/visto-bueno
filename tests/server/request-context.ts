import { randomUUID } from 'node:crypto';
import type { createServerApp } from '../../src/server/app';
import { ensureClientWorkspaces, getOwnedWorkspaceClient, primaryWorkspaceForOwner } from '../../src/server/db/workspace';

type Runtime = ReturnType<typeof createServerApp>;
type RequestFunction = (input: string | Request, init?: RequestInit) => Promise<Response>;

/** Keep older route tests representative of the browser client, which now sends X-Client-Id. */
export function installClientContextForMutations(runtime: Runtime): void {
  const app = runtime.app as unknown as { request: RequestFunction };
  const originalRequest = app.request.bind(runtime.app);
  app.request = async (input, init) => {
    const method = init?.method?.toUpperCase() ?? (input instanceof Request ? input.method : 'GET');
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return originalRequest(input, init);

    const headers = new Headers(init?.headers);
    if (headers.has('x-client-id')) return originalRequest(input, init);
    const cookies = new Map((headers.get('cookie') ?? '').split(';').filter(Boolean).map((part) => {
      const [name, ...value] = part.trim().split('=');
      return [name ?? '', value.join('=')] as [string, string];
    }));
    const hadOwnerCookie = cookies.has('workspace_id');
    const ownerId = cookies.get('workspace_id') || randomUUID();
    ensureClientWorkspaces(runtime.db, ownerId, ownerId);
    const requestedClientId = cookies.get('active_client_id');
    const client = (requestedClientId ? getOwnedWorkspaceClient(runtime.db, ownerId, requestedClientId) : null)
      ?? primaryWorkspaceForOwner(runtime.db, ownerId);
    if (!client) throw new Error('Test workspace did not create its primary client.');
    headers.set('X-Client-Id', client.clientId);
    cookies.set('workspace_id', ownerId);
    headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await originalRequest(input, { ...init, headers });
    if (!hadOwnerCookie && !response.headers.has('set-cookie')) {
      response.headers.append('set-cookie', `workspace_id=${ownerId}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return response;
  };
}
