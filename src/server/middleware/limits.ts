export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
export const LIVE_CALL_WINDOW_MS = 10 * 60 * 1000;
export const LIVE_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;
export const WORKSPACE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const MCP_SESSION_CREATE_WINDOW_MS = 60 * 1000;
export const MCP_SESSION_CREATE_LIMIT_PER_IP = 3;

const LIVE_CALL_LIMIT_MESSAGE = 'Alcanzaste el límite de llamadas en vivo del demo. Inténtalo más tarde.';
const BODY_LIMIT_MESSAGE = 'La solicitud supera el límite de carga de 2 MB.';

export interface LiveCallLimiterOptions {
  now?: () => number;
  maxWorkspaceCalls?: number;
  maxIpCalls?: number;
  dailyCap?: number;
}

export interface LiveCallInput {
  workspaceId: string;
  ip: string | null;
  mode: 'live' | 'replay';
}

export interface LiveCallReservation {
  /** Marks the start of one actual model call. Returns false if the reservation expired. */
  start(): boolean;
  /** Releases a reservation only if the model call has not started. */
  cancel(): void;
}

export type LiveCallReservationResult =
  | { ok: true; reservation: LiveCallReservation }
  | { ok: false; status: 429; message: string };

interface CallEntry {
  workspaceId: string;
  ipKey: string;
  timestamp: number;
  status: 'reserved' | 'started';
}

function readDailyCap(): number {
  const rawCap = process.env.LIVE_DAILY_CAP;
  return validateLimit(rawCap === undefined ? 300 : Number(rawCap), 'LIVE_DAILY_CAP');
}

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function noOpReservation(): LiveCallReservation {
  return { start: () => true, cancel: () => undefined };
}

/** Reserves capacity per model request; replay calls are always free. */
export function createLiveCallLimiter(options: LiveCallLimiterOptions = {}) {
  const now = options.now ?? Date.now;
  const maxWorkspaceCalls = validateLimit(options.maxWorkspaceCalls ?? 10, 'maxWorkspaceCalls');
  const maxIpCalls = validateLimit(options.maxIpCalls ?? 30, 'maxIpCalls');
  const dailyCap = validateLimit(options.dailyCap ?? readDailyCap(), 'LIVE_DAILY_CAP');
  const entries: CallEntry[] = [];

  function prune(at: number): void {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry && at - entry.timestamp >= LIVE_DAILY_WINDOW_MS) entries.splice(index, 1);
    }
  }

  function inWindow(entry: CallEntry, at: number, windowMs: number): boolean {
    return entry.status === 'reserved' || at - entry.timestamp < windowMs;
  }

  function reserveCall(input: LiveCallInput): LiveCallReservationResult {
    if (input.mode === 'replay') return { ok: true, reservation: noOpReservation() };

    const at = now();
    prune(at);
    const workspaceId = input.workspaceId || 'unknown';
    const ipKey = input.ip || 'unknown';
    const workspaceCount = entries.filter((entry) =>
      entry.workspaceId === workspaceId && inWindow(entry, at, LIVE_CALL_WINDOW_MS),
    ).length;
    const ipCount = entries.filter((entry) =>
      entry.ipKey === ipKey && inWindow(entry, at, LIVE_CALL_WINDOW_MS),
    ).length;

    if (workspaceCount >= maxWorkspaceCalls || ipCount >= maxIpCalls || entries.length >= dailyCap) {
      return { ok: false, status: 429, message: LIVE_CALL_LIMIT_MESSAGE };
    }

    const entry: CallEntry = { workspaceId, ipKey, timestamp: at, status: 'reserved' };
    entries.push(entry);
    let canceled = false;
    const reservation: LiveCallReservation = {
      start() {
        if (canceled) return false;
        if (entry.status === 'started') return true;
        if (!entries.includes(entry)) return false;
        entry.timestamp = now();
        entry.status = 'started';
        prune(entry.timestamp);
        return true;
      },
      cancel() {
        if (canceled || entry.status === 'started') return;
        canceled = true;
        const index = entries.indexOf(entry);
        if (index !== -1) entries.splice(index, 1);
      },
    };

    return { ok: true, reservation };
  }

  return { reserveCall };
}

export interface McpSessionCreationLimiterOptions {
  now?: () => number;
  windowMs?: number;
  maxPerIp?: number;
  maxTrackedIps?: number;
}

/** Limits MCP session creation separately from live model-call reservations. */
export function createMcpSessionCreationLimiter(options: McpSessionCreationLimiterOptions = {}) {
  const now = options.now ?? Date.now;
  const windowMs = validateLimit(options.windowMs ?? MCP_SESSION_CREATE_WINDOW_MS, 'windowMs');
  const maxPerIp = validateLimit(options.maxPerIp ?? MCP_SESSION_CREATE_LIMIT_PER_IP, 'maxPerIp');
  const maxTrackedIps = validateLimit(options.maxTrackedIps ?? 1024, 'maxTrackedIps');
  const timestampsByIp = new Map<string, number[]>();

  function reserve(ip: string | null): boolean {
    const at = now();
    for (const [key, timestamps] of timestampsByIp) {
      const recent = timestamps.filter((timestamp) => at - timestamp < windowMs);
      if (recent.length === 0) timestampsByIp.delete(key);
      else if (recent.length !== timestamps.length) timestampsByIp.set(key, recent);
    }

    const key = ip ?? 'unknown';
    let timestamps = timestampsByIp.get(key);
    if (!timestamps) {
      if (timestampsByIp.size >= maxTrackedIps) return false;
      timestamps = [];
      timestampsByIp.set(key, timestamps);
    }
    if (timestamps.length >= maxPerIp) return false;
    timestamps.push(at);
    return true;
  }

  return { reserve };
}

export type LimitedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 413; message: string };

/** Reads and caps the actual request stream, including when Content-Length is absent or false. */
export async function readLimitedBody(
  request: Pick<Request, 'headers' | 'body'>,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<LimitedBodyResult> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, message: BODY_LIMIT_MESSAGE };
  }

  if (!request.body) return { ok: true, bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Return the size error even if the upstream stream already failed to cancel.
        }
        return { ok: false, status: 413, message: BODY_LIMIT_MESSAGE };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export interface WorkspaceTtlCleanupOptions {
  cleanupExpiredWorkspaces: (expiredBefore: number) => void | Promise<void>;
  now?: () => number;
  ttlMs?: number;
  intervalMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

/** Schedules an injected workspace-store cleanup; no database API is coupled to this helper. */
export function createWorkspaceTtlCleanup(options: WorkspaceTtlCleanupOptions) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? WORKSPACE_TTL_MS;
  const intervalMs = options.intervalMs ?? WORKSPACE_CLEANUP_INTERVAL_MS;
  const setInterval = options.setInterval ?? globalThis.setInterval;
  const clearInterval = options.clearInterval ?? globalThis.clearInterval;
  let running: Promise<void> | null = null;
  let disposed = false;

  function runNow(): Promise<void> {
    if (running) return running;
    running = Promise.resolve()
      .then(() => options.cleanupExpiredWorkspaces(now() - ttlMs))
      .finally(() => { running = null; });
    return running;
  }

  const timer = setInterval(() => {
    if (!disposed) void runNow().catch(() => undefined);
  }, intervalMs);
  timer.unref?.();

  return {
    runNow,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
  };
}
