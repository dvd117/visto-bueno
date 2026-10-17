import { describe, expect, it } from 'vitest';
import { app } from '../src/server/app';

describe('health endpoint', () => {
  it('returns a liveness response without external dependencies', async () => {
    const response = await app.request('http://localhost/health');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ ok: true });
  });
});
