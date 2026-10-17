import { describe, expect, it, vi } from 'vitest';
import { getClientIp } from '../../src/server/middleware/ip';
import {
  createLiveCallLimiter,
  createWorkspaceTtlCleanup,
  MAX_REQUEST_BODY_BYTES,
  readLimitedBody,
} from '../../src/server/middleware/limits';

const minute = 60_000;
const day = 24 * 60 * minute;

function reserveAndStart(
  limiter: ReturnType<typeof createLiveCallLimiter>,
  input: { workspaceId: string; ip: string | null; mode?: 'live' | 'replay' },
) {
  const result = limiter.reserveCall({ ...input, mode: input.mode ?? 'live' });
  if (result.ok) expect(result.reservation.start()).toBe(true);
  return result;
}

function byteStream(size: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

describe('proxy-aware client IP', () => {
  it('ignores X-Forwarded-For unless one proxy hop is explicitly trusted', () => {
    const input = { forwardedFor: '198.51.100.44, 203.0.113.18', remoteAddress: '192.0.2.7' };

    expect(getClientIp(input, { trustProxy: '0' })).toBe('192.0.2.7');
    expect(getClientIp(input, { trustProxy: '1' })).toBe('203.0.113.18');
  });

  it('falls back to the socket address when the trusted header entry is invalid', () => {
    expect(getClientIp(
      { forwardedFor: '198.51.100.44, not-an-ip', remoteAddress: '192.0.2.7' },
      { trustProxy: '1' },
    )).toBe('192.0.2.7');
  });
});

describe('live model call limits', () => {
  it('blocks the 11th live call for one workspace in ten minutes with a generic Spanish message', () => {
    const limiter = createLiveCallLimiter({ now: () => 1_000, dailyCap: 300 });
    for (let call = 0; call < 10; call += 1) {
      expect(reserveAndStart(limiter, { workspaceId: 'ws-a', ip: `192.0.2.${call}` }).ok).toBe(true);
    }

    const blocked = reserveAndStart(limiter, { workspaceId: 'ws-a', ip: '192.0.2.20' });

    expect(blocked).toMatchObject({
      ok: false,
      status: 429,
      message: expect.stringMatching(/límite|limit/i),
    });
    if (!blocked.ok) expect(blocked.message).not.toContain('ws-a');
  });

  it('limits actual calls per IP and the global daily cap across workspaces', () => {
    const ipLimiter = createLiveCallLimiter({ now: () => 1_000, dailyCap: 300 });
    for (let call = 0; call < 30; call += 1) {
      expect(reserveAndStart(ipLimiter, { workspaceId: `ws-${call}`, ip: '192.0.2.9' }).ok).toBe(true);
    }
    expect(reserveAndStart(ipLimiter, { workspaceId: 'ws-next', ip: '192.0.2.9' }).ok).toBe(false);

    const dailyLimiter = createLiveCallLimiter({ now: () => 1_000, dailyCap: 2 });
    expect(reserveAndStart(dailyLimiter, { workspaceId: 'ws-a', ip: '192.0.2.1' }).ok).toBe(true);
    expect(reserveAndStart(dailyLimiter, { workspaceId: 'ws-b', ip: '192.0.2.2' }).ok).toBe(true);
    expect(reserveAndStart(dailyLimiter, { workspaceId: 'ws-c', ip: '192.0.2.3' }).ok).toBe(false);
  });

  it('does not charge replay and releases a reservation if no model call starts', () => {
    const limiter = createLiveCallLimiter({ now: () => 1_000, maxWorkspaceCalls: 1, dailyCap: 10 });
    const replay = reserveAndStart(limiter, { workspaceId: 'ws-a', ip: '192.0.2.1', mode: 'replay' });
    expect(replay.ok).toBe(true);

    const reservation = limiter.reserveCall({ workspaceId: 'ws-a', ip: '192.0.2.1', mode: 'live' });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;
    reservation.reservation.cancel();

    expect(reserveAndStart(limiter, { workspaceId: 'ws-a', ip: '192.0.2.1' }).ok).toBe(true);
  });

  it('expires ten-minute counters and the 24-hour global counter using the injected clock', () => {
    let now = 1_000;
    const windowLimiter = createLiveCallLimiter({ now: () => now, maxWorkspaceCalls: 1, maxIpCalls: 1, dailyCap: 3 });
    expect(reserveAndStart(windowLimiter, { workspaceId: 'ws-a', ip: '192.0.2.1' }).ok).toBe(true);

    now += 10 * minute + 1;
    expect(reserveAndStart(windowLimiter, { workspaceId: 'ws-a', ip: '192.0.2.1' }).ok).toBe(true);

    now = 2_000;
    const dailyLimiter = createLiveCallLimiter({ now: () => now, dailyCap: 1 });
    expect(reserveAndStart(dailyLimiter, { workspaceId: 'ws-b', ip: '192.0.2.2' }).ok).toBe(true);
    now += day - 1;
    expect(reserveAndStart(dailyLimiter, { workspaceId: 'ws-c', ip: '192.0.2.3' }).ok).toBe(false);
    now += 1;
    expect(reserveAndStart(dailyLimiter, { workspaceId: 'ws-c', ip: '192.0.2.3' }).ok).toBe(true);
  });
});

describe('streamed request body limit', () => {
  it('rejects actual bytes over 2 MB even if Content-Length understates the stream', async () => {
    const body = await readLimitedBody({
      headers: new Headers({ 'content-length': '1' }),
      body: byteStream(3 * 1024 * 1024),
    });

    expect(body).toMatchObject({ ok: false, status: 413 });
    if (!body.ok) expect(body.message).toMatch(/límite|máximo/i);
  });

  it('accepts a body at the exact byte limit', async () => {
    const body = await readLimitedBody({ headers: new Headers(), body: byteStream(MAX_REQUEST_BODY_BYTES) });

    expect(body.ok).toBe(true);
    if (body.ok) expect(body.bytes.byteLength).toBe(MAX_REQUEST_BODY_BYTES);
  });
});

describe('workspace TTL cleanup hook', () => {
  it('runs hourly with a 24-hour cutoff, unreferences the timer, and disposes it', async () => {
    const now = 50_000_000;
    const cleanupExpiredWorkspaces = vi.fn();
    const unref = vi.fn();
    const clearIntervalHook = vi.fn();
    const tick = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof globalThis.setInterval>;
    let scheduledIntervalMs: number | undefined;
    const setIntervalHook = ((callback: () => void, intervalMs?: number) => {
      scheduledIntervalMs = intervalMs;
      tick.mockImplementation(callback);
      return timer;
    }) as typeof globalThis.setInterval;
    const job = createWorkspaceTtlCleanup({
      cleanupExpiredWorkspaces,
      now: () => now,
      setInterval: setIntervalHook,
      clearInterval: clearIntervalHook,
    });

    expect(scheduledIntervalMs).toBe(60 * minute);
    expect(unref).toHaveBeenCalledOnce();
    tick();
    await Promise.resolve();
    expect(cleanupExpiredWorkspaces).toHaveBeenCalledWith(now - day);

    job.dispose();
    job.dispose();
    expect(clearIntervalHook).toHaveBeenCalledOnce();
  });
});
