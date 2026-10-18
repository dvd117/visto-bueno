import { afterAll, afterEach, expect, it } from 'vitest';
import { createServerApp, serverRuntime } from '../../src/server/app';
import { getDecisionHistory, getInvoice, openDb } from '../../src/server/db/db';
import { extract } from '../../src/server/extract';
import { createLiveCallLimiter, MAX_REQUEST_BODY_BYTES } from '../../src/server/middleware/limits';

const runtimes: ReturnType<typeof createServerApp>[] = [];
function runtime(options: Partial<Parameters<typeof createServerApp>[0]> = {}) {
  const value = createServerApp({ db: openDb(':memory:'), autoCleanup: false, remoteAddress: () => '192.0.2.10', ...options });
  runtimes.push(value);
  return value;
}
afterEach(() => { for (const value of runtimes.splice(0)) value.dispose(); });
afterAll(() => serverRuntime.dispose());
function decide(app: ReturnType<typeof runtime>['app'], cookie: string, key: string, body: object) {
  return app.request('/api/v1/decide', { method: 'POST', headers: {
    cookie, 'content-type': 'application/json', 'Idempotency-Key': key,
  }, body: JSON.stringify(body) });
}

it('rejects a reused key for a different invoice instead of returning the first invoice ready', async () => {
  const { app, db } = runtime();
  const first = await decide(app, 'workspace_id=review-body', 'same-key', { invoiceId: 'AL-030' });
  const firstBody = await first.json() as { state: string };
  expect(first.status).toBe(200);
  expect(firstBody.state).toBe('ready');
  const mismatch = await decide(app, 'workspace_id=review-body', 'same-key', { invoiceId: 'AL-042' });
  const mismatchBody = await mismatch.json() as { error: string };
  expect(mismatch.status).toBe(409);
  expect(mismatchBody).toMatchObject({ error: 'idempotency_conflict' });
  expect(getInvoice(db, 'review-body', 'AL-030')?.status).toBe('ready');
  expect(getInvoice(db, 'review-body', 'AL-042')?.status).toBe('queued');
});

it('preserves an existing seed invoice and its human rejection when a concurrent decide cannot save', async () => {
  let pause = false;
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  const { app, db } = runtime({ extractProvider: async (input) => {
    if (pause) { entered(); await released; }
    return extract(input);
  } });
  const cookie = 'workspace_id=review-race';
  const first = await decide(app, cookie, 'initial', { invoiceId: 'AL-042' });
  expect(first.status).toBe(200);
  expect((await first.json() as { state: string }).state).toBe('stopped');
  pause = true;
  const inFlight = decide(app, cookie, 'second', { invoiceId: 'AL-042' });
  await started;
  const rejection = await app.request('/api/invoices/AL-042/reject', { method: 'POST', headers: {
    cookie, 'content-type': 'application/json',
  }, body: JSON.stringify({ approver: 'Demo Reviewer', reason: 'Incorrect bank account', idempotencyKey: 'human-reject' }) });
  expect(rejection.status).toBe(200);
  expect(getInvoice(db, 'review-race', 'AL-042')?.status).toBe('rejected');
  resume();
  const finished = await inFlight;
  const row = getInvoice(db, 'review-race', 'AL-042');
  const audit = db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND invoice_id = ?').get('review-race', 'AL-042');
  const history = getDecisionHistory(db, 'review-race', 'AL-042');
  expect(finished.status).toBe(409);
  expect(row?.status).toBe('rejected');
  expect(audit).toMatchObject({ n: 2 });
  expect(history).toHaveLength(1);
});

it('enforces body size, file type/signatures and workspace isolation', async () => {
  const { app } = runtime();
  const first = await decide(app, 'workspace_id=review-a', 'key', { invoiceId: 'AL-030' });
  const other = await decide(app, 'workspace_id=review-b', 'key', { invoiceId: 'AL-042' });
  expect((await first.json() as { state: string }).state).toBe('ready');
  expect((await other.json() as { state: string }).state).toBe('stopped');
  const huge = await decide(app, 'workspace_id=review-a', 'huge', { text: 'x'.repeat(MAX_REQUEST_BODY_BYTES) });
  expect(huge.status).toBe(413);
  for (const [name, type] of [['invoice.png', 'image/png'], ['invoice.exe', 'application/octet-stream']]) {
    const form = new FormData(); form.set('file', new File(['not a real image'], name, { type }));
    const response = await app.request('/api/v1/decide', { method: 'POST', headers: { cookie: 'workspace_id=review-a', 'Idempotency-Key': name }, body: form });
    expect(response.status).toBe(400);
  }
});

it('blocks every paid model attempt at a zero daily cap and fails closed', async () => {
  // Actual extract calls the quota hook before its HTTP request; no paid call can run.
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'not-a-real-key';
  try {
    const { app } = runtime({ limiter: createLiveCallLimiter({ dailyCap: 0 }) });
    const response = await decide(app, 'workspace_id=review-quota', 'quota', { text: 'Fictional invoice' });
    const body = await response.json() as { state: string; checks: Array<{ id: string }> };
    expect(response.status).toBe(200);
    expect(body.state).toBe('review_required');
    expect(body.checks.some((c: { id: string }) => c.id === 'extraction_failed')).toBe(true);
  } finally {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
  }
});
