#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures/invoices/AL-037.pdf');
const TIMEOUT = 20_000;
const DEFAULT_BASE_URL = 'http://127.0.0.1:5173';
const SEED_IDS = Array.from({ length: 20 }, (_, index) => `AL-${String(index + 30).padStart(3, '0')}`);
const DECIDED_STATUSES = new Set(['ready', 'approval_required', 'review_required', 'stopped']);

class Blocked extends Error {}
class AssertionFailure extends Error {}

function parseArgs(argv) {
  const options = { baseUrl: process.env.BASE_URL || DEFAULT_BASE_URL, check: false, tonight: false, confirmReplay: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--tonight') options.tonight = true;
    else if (arg === '--confirm-server-replay') options.confirmReplay = true;
    else if (arg === '--base-url') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new AssertionFailure('--base-url requires a URL value.');
      options.baseUrl = value;
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new AssertionFailure(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/acceptance-milestone0.mjs [--base-url URL] [--confirm-server-replay] [--tonight] [--check]',
    `Default BASE_URL: ${DEFAULT_BASE_URL}`,
    '--check validates local inputs only; it does not contact the app or run e2e.',
  ].join('\n');
}

function assert(condition, message) {
  if (!condition) throw new AssertionFailure(message);
}

function assertSeedRows(rows, stage) {
  assert(Array.isArray(rows), `${stage}: GET /api/invoices did not return an array.`);
  const ids = rows.map((row) => row.id);
  assert(ids.length === SEED_IDS.length, `${stage}: expected the 20 seeded invoices, received ${ids.length}.`);
  assert(new Set(ids).size === ids.length, `${stage}: invoice IDs are not unique.`);
  assert(SEED_IDS.every((id) => ids.includes(id)), `${stage}: expected seeded IDs AL-030 through AL-049.`);
  assert(rows.every((row) => row.status === 'queued'), `${stage}: every seed invoice must be queued.`);
  return rows;
}

function assertSeedWorkspace(workspace, baseline, stage) {
  assert(workspace.company?.name === 'Andina Labs Inc.' && workspace.company?.fictional === true, `${stage}: workspace is not the fictional Andina Labs seed.`);
  if (baseline) {
    assert(JSON.stringify(workspace.rules) === JSON.stringify(baseline.rules), `${stage}: reset did not restore the initial seeded rules.`);
    assert(workspace.company?.name === baseline.company?.name && workspace.company?.fictional === true, `${stage}: reset did not restore the fictional company.`);
  }
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Blocked(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function normalizeBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AssertionFailure(`Invalid BASE_URL: ${raw || '(empty)'}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AssertionFailure('BASE_URL must be an http(s) origin or path without credentials, query, or fragment.');
  }
  return url;
}

async function runCheck(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fixture = await stat(FIXTURE).catch(() => null);
  if (!fixture?.isFile()) throw new AssertionFailure('The fictional M0 fixture is missing: fixtures/invoices/AL-037.pdf');
  process.stdout.write([
    'CHECK OK — local configuration only; no browser or app was contacted.',
    `BASE_URL: ${baseUrl.origin}`,
    `Scope: ${options.tonight ? 'M0 + optional Tonight browser checks' : 'M0 browser acceptance'}`,
    'Fixture: fixtures/invoices/AL-037.pdf (fictional Andina Labs data)',
    'No .env file was read.',
  ].join('\n') + '\n');
}

async function loadPlaywright() {
  const entry = join(ROOT, '.w/playwright/node_modules/playwright/index.mjs');
  try {
    await stat(entry);
  } catch {
    throw new Blocked('Playwright is not installed at .w/playwright. Follow scripts/acceptance-milestone0.md.');
  }
  try {
    return await import(pathToFileURL(entry).href);
  } catch {
    throw new Blocked('Could not load Playwright from .w/playwright; reinstall the documented local dependency.');
  }
}

function checkSafetyPrerequisites(baseUrl, options) {
  if (!options.confirmReplay) {
    throw new Blocked('Confirm the server was started/configured with EXTRACT_MODE=replay and JEV_MODE=replay using --confirm-server-replay. Browser interception cannot prove server mode.');
  }
  if (process.env.GEMINI_API_KEY || process.env.TYPESAFE_API_KEY) {
    throw new Blocked('Unset GEMINI_API_KEY and TYPESAFE_API_KEY in the acceptance runner environment; no key values were read or printed.');
  }
  if (isLoopback(baseUrl.hostname)) {
    if (process.env.EXTRACT_MODE !== 'replay' || process.env.JEV_MODE !== 'replay') {
      throw new Blocked('Local runner must set EXTRACT_MODE=replay and JEV_MODE=replay.');
    }
  }
}

function endpoint(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

async function responseJson(response, action) {
  if (response.status() === 404 || response.status() === 501) {
    throw new Blocked(`${action} is not ready (HTTP ${response.status()}); T11 must provide this endpoint.`);
  }
  if (!response.ok()) throw new AssertionFailure(`${action} returned HTTP ${response.status()}.`);
  try {
    return await response.json();
  } catch {
    throw new AssertionFailure(`${action} returned invalid JSON.`);
  }
}

async function apiGet(context, baseUrl, path, action) {
  let response;
  try {
    response = await context.request.get(endpoint(baseUrl, path), { timeout: TIMEOUT });
  } catch {
    throw new Blocked(`${action} could not be reached; confirm the local server or deployed URL is ready.`);
  }
  return responseJson(response, action);
}

function parseSse(raw) {
  return raw.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart());
    if (!data.length) return [];
    try {
      return [JSON.parse(data.join('\n'))];
    } catch {
      throw new AssertionFailure('The process stream included malformed JSON.');
    }
  });
}

function isApiUrl(raw, baseUrl, pathname) {
  try {
    const url = new URL(raw);
    return url.origin === baseUrl.origin && url.pathname === pathname;
  } catch {
    return false;
  }
}

async function validateReplayStream(context, baseUrl, requestBody, raw, expectedIds, requireSeedBatch) {
  assert(requestBody?.mode === 'replay', 'The process request did not explicitly use mode="replay".');
  const events = parseSse(raw);
  const decided = events.filter((event) => event.type === 'decided');
  const done = events.filter((event) => event.type === 'done');
  const errors = events.filter((event) => event.type === 'error');
  const expected = new Set(expectedIds);
  assert(decided.length === expectedIds.length, `Expected ${expectedIds.length} decided events, received ${decided.length}.`);
  assert(new Set(decided.map((event) => event.row?.id)).size === decided.length, 'The process stream repeated a decided invoice ID.');
  assert(decided.every((event) => expected.has(event.row?.id)), 'The process stream decided an unexpected invoice ID.');
  assert([...expected].every((id) => decided.some((event) => event.row?.id === id)), 'The process stream omitted an expected invoice ID.');
  assert(done.length === 1 && events.at(-1)?.type === 'done', 'The process stream must end with exactly one done event.');
  assert(done[0].stats?.mode === 'replay', 'The server reported a non-replay processing mode.');
  assert(done[0].stats?.invoices === expectedIds.length, `The final run summary did not count ${expectedIds.length} invoices.`);
  assert(events.every((event) => ['decided', 'error', 'done'].includes(event.type)), 'The process stream included an unexpected event type.');

  const records = {};
  const eventErrors = new Map();
  for (const error of errors) {
    assert(typeof error.invoiceId === 'string' && expected.has(error.invoiceId), 'A process error was not tied to an expected invoice.');
    assert(typeof error.message === 'string' && error.message.length > 0 && error.message.length <= 500, 'The process stream error was missing or not sanitized.');
    assert(!/[\r\n]|\b(?:Error|TypeError|ENOENT):|(?:\/home\/|\/tmp\/|node_modules\/)/i.test(error.message), `The process error for ${error.invoiceId} contains unsanitized details.`);
    assert(!eventErrors.has(error.invoiceId), `The process stream repeated an error for ${error.invoiceId}.`);
    eventErrors.set(error.invoiceId, error);
  }

  for (const event of decided) {
    const id = event.row.id;
    assert(DECIDED_STATUSES.has(event.row.status), `${id} has unexpected final status ${event.row.status}.`);
    const expediente = await readExpediente(context, baseUrl, id);
    const record = expediente.record;
    assert(expediente.row?.id === id && record?.id, `${id} has no persisted decision record.`);
    const extraction = record.decision?.checks?.find((check) => check.kind === 'verify' && check.id === 'extraction_failed');
    if (requireSeedBatch ? id === 'AL-037' : true) {
      assert(Boolean(expediente.sourceText) && extraction?.passed === true, `${id} lacks genuine persisted extraction evidence.`);
    }
    assert(record.decision.status === expediente.row.status && event.row.status === expediente.row.status, `${id} stream, row, and record statuses disagree.`);

    const missingJev = record.jev?.ok === false && record.jev.error === 'missing_recording';
    if (missingJev) {
      const processError = eventErrors.get(id);
      assert(processError, `${id} has an expected missing-JEV record but the stream omitted its error event.`);
      assert(record.decision.status !== 'ready' && record.decision.canApprove === false, `${id} did not fail closed after the missing JEV recording.`);
    } else {
      assert(!eventErrors.has(id), `${id} emitted an unexpected processing error.`);
      assert(record.jev?.ok === true && record.jev.recorded === true, `${id} has neither a genuine recorded JEV result nor an explicit missing recording.`);
    }
    records[id] = expediente;
  }

  assert(errors.every((event) => records[event.invoiceId]?.record?.jev?.error === 'missing_recording'), 'A non-JEV extraction, persistence, or processing error occurred.');
  const finalDecided = decided.at(-1);
  const finalCounters = finalDecided.counters;
  assert(finalCounters && ['ready', 'approval_required', 'review_required', 'stopped', 'approved', 'rejected', 'stale', 'queued']
    .every((key) => Number.isSafeInteger(finalCounters[key])), 'The final decided event has incomplete counters.');
  if (requireSeedBatch) {
    assert(expectedIds.length === SEED_IDS.length && SEED_IDS.every((id) => expected.has(id)), 'M0 did not process the complete seed batch.');
    assert(finalCounters.queued === 0, 'The final seed-batch counters still show queued invoices.');
    const counts = Object.fromEntries([...DECIDED_STATUSES].map((status) => [status, decided.filter((event) => event.row.status === status).length]));
    assert(['ready', 'approval_required', 'review_required', 'stopped'].every((status) => finalCounters[status] === counts[status]), 'Final counters do not match the 20 decided seed rows.');
    assert(finalCounters.approved === 0 && finalCounters.rejected === 0 && finalCounters.stale === 0, 'Unexpected post-decision actions changed the seed-batch counters.');
  }
  return { request: requestBody, events, decided, finalDecided, finalCounters, done: done[0], records };
}

async function captureProcess(page, context, baseUrl, invoiceId, onObserved = () => {}) {
  let request = null;
  const onRequest = (candidate) => {
    if (isApiUrl(candidate.url(), baseUrl, '/api/process') && candidate.method() === 'POST') request = candidate;
  };
  page.on('request', onRequest);
  try {
    const responsePromise = page.waitForResponse((response) => isApiUrl(response.url(), baseUrl, '/api/process'), { timeout: TIMEOUT });
    await page.getByRole('button', { name: 'Procesar', exact: true }).click({ timeout: TIMEOUT });
    const response = await responsePromise;
    if (response.status() === 404 || response.status() === 501) {
      throw new Blocked(`POST /api/process is missing (HTTP ${response.status()}); T11 must mount the replay processor.`);
    }
    assert(response.ok(), `POST /api/process returned HTTP ${response.status()}.`);
    assert((response.headers()['content-type'] || '').includes('text/event-stream'), 'POST /api/process did not return an SSE stream.');
    const body = await withTimeout(response.text(), 60_000, 'The replay SSE stream did not finish within 60 seconds.');
    const processRequest = request?.postData();
    let processBody;
    try { processBody = JSON.parse(processRequest || ''); } catch { processBody = null; }
    assert(processBody?.mode === 'replay', 'The UI did not request POST /api/process with mode="replay".');
    onObserved({ request: processBody, events: parseSse(body) });
    assert(processBody?.ids == null, 'M0 must use the default queued seed batch, not uploaded or selected IDs.');
    const result = await validateReplayStream(context, baseUrl, processBody, body, SEED_IDS, true);
    assert(result.decided.some((event) => event.row.id === invoiceId), `The stream did not decide the selected seed invoice ${invoiceId}.`);
    return { ...result, targetDecided: result.decided.find((event) => event.row.id === invoiceId) };
  } catch (error) {
    if (error instanceof Blocked || error instanceof AssertionFailure) throw error;
    if (error?.name === 'TimeoutError') throw new Blocked('Timed out waiting for the replay processing endpoint; T11 readiness is incomplete.');
    throw error;
  } finally {
    page.off('request', onRequest);
  }
}

async function readExpediente(context, baseUrl, id) {
  return apiGet(context, baseUrl, `/api/invoices/${encodeURIComponent(id)}`, `GET /api/invoices/${id}`);
}

async function createTextInvoice(context, baseUrl, text, onMutationStart = () => {}) {
  onMutationStart();
  const response = await context.request.post(endpoint(baseUrl, '/api/invoices'), {
    data: { text }, timeout: TIMEOUT,
  }).catch(() => { throw new Blocked('POST /api/invoices (JSON) could not be reached.'); });
  if (response.status() === 404 || response.status() === 501) throw new Blocked('POST /api/invoices JSON intake is missing; T11 must provide text intake.');
  return responseJson(response, 'POST /api/invoices (JSON)');
}

async function createPdfInvoice(context, baseUrl, fixturePath, onMutationStart = () => {}) {
  const bytes = await readFile(fixturePath);
  onMutationStart();
  const response = await context.request.post(endpoint(baseUrl, '/api/invoices'), {
    multipart: { file: { name: fixturePath.split('/').at(-1), mimeType: 'application/pdf', buffer: bytes } },
    timeout: TIMEOUT,
  }).catch(() => { throw new Blocked('POST /api/invoices (multipart PDF) could not be reached.'); });
  if (response.status() === 404 || response.status() === 501) throw new Blocked('POST /api/invoices multipart intake is missing; T11 must provide PDF intake.');
  return responseJson(response, 'POST /api/invoices (multipart PDF)');
}

async function processIdsReplay(context, baseUrl, ids) {
  const response = await context.request.post(endpoint(baseUrl, '/api/process'), {
    data: { ids, mode: 'replay' }, timeout: 60_000,
  }).catch(() => { throw new Blocked('POST /api/process (explicit replay IDs) could not be reached.'); });
  if (response.status() === 404 || response.status() === 501) throw new Blocked('POST /api/process is missing; explicit replay processing is not ready.');
  assert(response.ok(), `POST /api/process returned HTTP ${response.status()}.`);
  assert((response.headers()['content-type'] || '').includes('text/event-stream'), 'POST /api/process did not return an SSE stream.');
  const raw = await withTimeout(response.text(), 60_000, 'The explicit replay SSE stream did not finish within 60 seconds.');
  return validateReplayStream(context, baseUrl, { ids, mode: 'replay' }, raw, ids, false);
}

async function resetThroughUi(page, baseUrl) {
  const responsePromise = page.waitForResponse((response) => (
    isApiUrl(response.url(), baseUrl, '/api/workspace/reset') && response.request().method() === 'POST'
  ), { timeout: TIMEOUT });
  await page.getByRole('button', { name: 'Reiniciar demo', exact: true }).click({ timeout: TIMEOUT });
  const response = await responsePromise;
  if (response.status() === 404 || response.status() === 501) throw new Blocked('POST /api/workspace/reset is missing; T11 must provide workspace reset.');
  assert(response.ok(), `POST /api/workspace/reset returned HTTP ${response.status()}.`);
}

function sixStepEvidence(expediente) {
  const record = expediente.record;
  const decision = record?.decision;
  const checks = decision?.checks ?? [];
  const extraction = checks.find((check) => check.kind === 'verify' && check.id === 'extraction_failed');
  const verify = checks.filter((check) => check.kind === 'verify');
  const rules = checks.filter((check) => check.kind === 'rule');
  const judgment = checks.filter((check) => check.kind === 'judgment');
  return [
    { step: 'EXTRACT', observed: Boolean(expediente.sourceText && extraction?.passed), evidence: extraction?.id ?? null },
    { step: 'VERIFY', observed: verify.length > 0, evidence: verify.map((check) => check.id) },
    { step: 'RULES', observed: rules.length > 0, evidence: rules.map((check) => check.id) },
    { step: 'JUDGMENT', observed: record?.jev?.ok === true && judgment.length > 0, evidence: record?.jev?.ok ? judgment.map((check) => check.id) : record?.jev?.error ?? 'missing' },
    { step: 'COMBINE', observed: Boolean(decision && expediente.row.status === decision.status), evidence: decision ? { status: decision.status, canApprove: decision.canApprove } : null },
    { step: 'RECORD', observed: Boolean(record?.id && record?.seal), evidence: record ? { id: record.id, seal: record.seal } : null },
  ];
}

function validateM0(expediente) {
  assert(expediente.row?.id && expediente.row.sourceKind === 'pdf', 'The selected source is not a persisted PDF invoice.');
  assert(expediente.row.status !== 'queued', 'The invoice is still queued; no decision was persisted.');
  assert(expediente.sourceText?.includes('AL-037'), 'The extracted source text does not contain the fictional AL-037 invoice id.');
  assert(expediente.comparison?.length > 0, 'The Expediente has no comparison evidence.');
  const record = expediente.record;
  assert(record?.decision?.contractId === 'valentina-diseno-monthly', 'AL-037 was not matched to its fixed monthly contract.');
  assert(Number.isSafeInteger(record.decision.amountUsdMinor) && record.decision.amountUsdMinor > 0, 'Persisted money evidence is missing or invalid.');
  const steps = sixStepEvidence(expediente);
  for (const step of steps.filter((item) => item.step !== 'JUDGMENT')) {
    assert(step.observed, `Persisted ${step.step} evidence is missing.`);
  }
  if (record.jev?.ok) {
    assert(record.jev.recorded === true, 'Successful JEV evidence was not marked recorded; verify the server is in replay mode.');
    assert(steps.find((step) => step.step === 'JUDGMENT')?.observed, 'JEV succeeded but no judgment checks were persisted.');
  } else {
    assert(record.jev?.ok === false && record.jev.error === 'missing_recording', 'Only an explicit missing JEV recording is an acceptable no-JEV M0 state.');
    assert(expediente.row.status !== 'ready' && record.decision.canApprove === false, 'Missing JEV evidence did not fail closed.');
  }
  return steps;
}

async function assertUiCounters(page, counters) {
  const states = [
    ['ready', 'ready'],
    ['approval_required', 'approval'],
    ['review_required', 'review'],
    ['stopped', 'stopped'],
  ];
  for (const [key, tone] of states) {
    const expected = new Intl.NumberFormat('es-VE').format(counters[key]);
    await page.waitForFunction(({ currentTone, currentExpected }) => (
      document.querySelector(`.overview .metric-${currentTone} .metric-count`)?.textContent?.trim() === currentExpected
    ), { currentTone: tone, currentExpected: expected }, { timeout: TIMEOUT });
  }
  const runDescription = page.locator('.overview .run-description');
  await runDescription.waitFor({ state: 'visible', timeout: TIMEOUT });
  const runText = await runDescription.innerText();
  assert(runText.includes('20 facturas en') && runText.includes('grabado'), `The final replay run summary is not visible: ${runText}.`);
}

async function assertUiSeedRows(page) {
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.invoice-list .invoice-row')];
    return rows.length === 20 && rows.every((row) => row.querySelector('[role="status"]')?.getAttribute('aria-label') === 'En cola');
  }, null, { timeout: TIMEOUT });
}

function invoiceRow(page, id) {
  return page.locator('.invoice-list .invoice-row').filter({ has: page.getByText(id, { exact: true }) });
}

async function selectInvoice(page, id) {
  const row = invoiceRow(page, id);
  await row.waitFor({ state: 'visible', timeout: TIMEOUT });
  await row.click({ timeout: TIMEOUT });
  assert(await row.getAttribute('aria-pressed') === 'true', `${id} was not selected in Bandeja.`);
  return row;
}

async function screenshot(page, path) {
  if (page && !page.isClosed()) await page.screenshot({ path, fullPage: true, timeout: TIMEOUT }).catch(() => {});
}

async function writeJson(directory, name, value) {
  await writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.check) return runCheck(options);

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  checkSafetyPrerequisites(baseUrl, options);
  const evidenceRoot = join(ROOT, '.w/acceptance-milestone0');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceDir = join(evidenceRoot, runId);
  await mkdir(evidenceDir, { recursive: true });

  const result = {
    status: 'RUNNING',
    baseUrl: baseUrl.origin,
    scope: options.tonight ? 'M0 + optional Tonight browser subset' : 'M0 browser acceptance',
    startedAt: new Date().toISOString(),
    externalBrowserRequests: [],
    sixSteps: [],
    notes: [],
    workspaceTouched: false,
  };
  let browser;
  let context;
  let page;
  let isolationContext;

  try {
    const { chromium } = await loadPlaywright();
    const browserPath = process.env.CHROME_EXECUTABLE_PATH || join(homedir(), '.local/bin/chrome-cft');
    try {
      await stat(browserPath);
    } catch {
      throw new Blocked(`Chrome for Testing is missing at ${browserPath}; set CHROME_EXECUTABLE_PATH to the pinned executable.`);
    }
    browser = await chromium.launch({ executablePath: browserPath, headless: true, timeout: TIMEOUT });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: false });
    context.setDefaultTimeout(TIMEOUT);
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== baseUrl.origin && ['http:', 'https:'].includes(url.protocol)) {
        result.externalBrowserRequests.push({ host: url.hostname, path: url.pathname, method: route.request().method() });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', (error) => result.notes.push(`Browser page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') result.notes.push(`Browser console error: ${message.text().slice(0, 300)}`);
    });

    let health;
    try { health = await context.request.get(endpoint(baseUrl, '/health'), { timeout: TIMEOUT }); }
    catch { throw new Blocked(`GET ${endpoint(baseUrl, '/health')} is unreachable; start the app or confirm the deployed URL.`); }
    if (health.status() === 404 || health.status() === 501) throw new Blocked('GET /health is missing; the target is not a ready Visto Bueno build.');
    assert(health.ok(), `GET /health returned HTTP ${health.status()}.`);
    const healthBody = await responseJson(health, 'GET /health');
    assert(healthBody.ok === true, 'GET /health did not return {"ok":true}.');
    result.health = healthBody;

    let workspace;
    let invoices;
    try {
      workspace = await apiGet(context, baseUrl, '/api/workspace', 'GET /api/workspace');
      invoices = await apiGet(context, baseUrl, '/api/invoices', 'GET /api/invoices');
    } catch (error) {
      await page.goto(baseUrl.origin, { waitUntil: 'domcontentloaded', timeout: TIMEOUT }).catch(() => {});
      throw error;
    }
    assertSeedRows(invoices, 'Fresh workspace');
    assertSeedWorkspace(workspace, null, 'Fresh workspace');
    assert(workspace.counters?.queued === 20 && workspace.lastRun === null, 'Fresh workspace counters or lastRun do not match the seed baseline.');
    result.freshWorkspace = { invoiceCount: invoices.length, ids: invoices.map((row) => row.id), queued: invoices.every((row) => row.status === 'queued'), company: workspace.company, rules: workspace.rules };
    result.initialWorkspace = workspace;

    await page.goto(baseUrl.origin, { waitUntil: 'domcontentloaded', timeout: TIMEOUT }).catch(() => {
      throw new Blocked('The UI did not load; confirm the target is serving the Visto Bueno frontend.');
    });

    isolationContext = await browser.newContext();
    const isolatedWorkspace = await apiGet(isolationContext, baseUrl, '/api/workspace', 'GET /api/workspace (second isolated browser)');
    const isolatedInvoices = await apiGet(isolationContext, baseUrl, '/api/invoices', 'GET /api/invoices (second isolated browser)');
    const firstWorkspaceCookie = (await context.cookies(baseUrl.origin)).find((cookie) => cookie.name === 'workspace_id')?.value;
    const secondWorkspaceCookie = (await isolationContext.cookies(baseUrl.origin)).find((cookie) => cookie.name === 'workspace_id')?.value;
    if (!firstWorkspaceCookie || !secondWorkspaceCookie || firstWorkspaceCookie === secondWorkspaceCookie) {
      throw new Blocked('Could not prove distinct workspace_id cookies across fresh browser contexts; no invoice mutation was attempted.');
    }
    assertSeedRows(isolatedInvoices, 'Second fresh workspace');
    assertSeedWorkspace(isolatedWorkspace, null, 'Second fresh workspace');
    assert(isolatedWorkspace.counters?.queued === 20 && isolatedWorkspace.lastRun === null, 'The second workspace does not have the untouched seed baseline.');
    result.workspaceIsolation = { distinctWorkspaceCookies: true, sameSeedIds: true, secondWorkspaceQueued: 20, uploadedIdsShared: false };

    await page.getByRole('heading', { name: 'Andina Labs Inc.' }).waitFor({ state: 'visible', timeout: TIMEOUT })
      .catch(() => { throw new Blocked('The loaded page does not expose the T11 Bandeja UI yet.'); });
    await page.getByRole('heading', { name: 'Bandeja de facturas' }).waitFor({ state: 'visible', timeout: TIMEOUT });
    assert(await page.locator('.invoice-list .invoice-row').count() === 20, 'Bandeja does not show all 20 seeded invoices.');
    const initialSeedRow = invoiceRow(page, 'AL-037');
    await initialSeedRow.waitFor({ state: 'visible', timeout: TIMEOUT });
    await initialSeedRow.getByRole('status', { name: 'En cola' }).waitFor({ state: 'visible', timeout: TIMEOUT });
    await selectInvoice(page, 'AL-037');
    result.invoiceId = 'AL-037';
    result.workspaceTouched = true;
    result.process = await captureProcess(page, context, baseUrl, 'AL-037', (observed) => { result.processObserved = observed; });
    result.process.finalCounterSource = 'last decided event in the complete 20-row default seed batch';
    await assertUiCounters(page, result.process.finalCounters);
    const expediente = result.process.records['AL-037'];
    result.expediente = expediente;
    result.sixSteps = validateM0(expediente);
    const isolatedAfterReplay = await apiGet(isolationContext, baseUrl, '/api/invoices', 'GET /api/invoices after first workspace replay');
    assertSeedRows(isolatedAfterReplay, 'Second workspace after first workspace replay');
    assert(isolatedAfterReplay.every((row) => row.status === 'queued'), 'The second workspace observed the first workspace replay decisions.');
    result.workspaceIsolation.secondWorkspaceUnchangedAfterReplay = true;
    await isolationContext.close();
    isolationContext = null;

    const row = invoiceRow(page, 'AL-037');
    await row.waitFor({ state: 'visible', timeout: TIMEOUT });
    assert((await row.textContent())?.includes(expediente.row.payee), 'The processed invoice is not visible in Bandeja.');
    const statusLabels = {
      ready: 'Lista para pagar',
      approval_required: 'Requiere tu aprobación',
      review_required: 'Requiere revisión',
      stopped: 'Frenada',
    };
    await row.getByRole('status', { name: statusLabels[expediente.row.status] }).waitFor({ state: 'visible', timeout: TIMEOUT });
    await page.getByRole('heading', { name: 'Comparación con tus registros' }).waitFor({ state: 'visible', timeout: TIMEOUT });
    await page.getByRole('heading', { name: 'Trazabilidad de la decisión' }).waitFor({ state: 'visible', timeout: TIMEOUT });
    await page.getByRole('heading', { name: 'Documento' }).waitFor({ state: 'visible', timeout: TIMEOUT });
    await page.getByRole('tab', { name: 'Texto que leyó el agente' }).click();
    const sourceView = page.locator('.document-text');
    await sourceView.waitFor({ state: 'visible', timeout: TIMEOUT });
    assert((await sourceView.innerText()).includes('AL-037'), 'The Expediente text view does not show the source invoice text.');
    const historyButton = page.getByRole('button', { name: 'Ver registro completo', exact: true });
    await historyButton.waitFor({ state: 'visible', timeout: TIMEOUT });
    await historyButton.click();
    assert(await page.locator('.record-history').isVisible(), 'The full persisted record history did not open.');
    assert((await page.locator('.decision-seal').innerText()).includes(expediente.record.seal), 'The Expediente seal is not visible.');
    if (!expediente.record.jev?.ok) {
      await page.getByText('JEV no conectado', { exact: false }).waitFor({ state: 'visible', timeout: TIMEOUT });
    }
    result.ui = { bandeja: true, expediente: true, comparison: true, trail: true, sourceText: true, seal: true };
    await screenshot(page, join(evidenceDir, 'm0.png'));

    if (options.tonight) {
      result.tonight = await runTonightSubset({ page, context, baseUrl, onMutationStart: () => { result.workspaceTouched = true; } });
    }

    await resetThroughUi(page, baseUrl);
    const resetWorkspace = await apiGet(context, baseUrl, '/api/workspace', 'GET /api/workspace after reset');
    const resetInvoices = await apiGet(context, baseUrl, '/api/invoices', 'GET /api/invoices after reset');
    assertSeedRows(resetInvoices, 'Workspace reset');
    assertSeedWorkspace(resetWorkspace, workspace, 'Workspace reset');
    assert(resetWorkspace.lastRun === null, 'Reset did not clear the workspace run summary.');
    await assertUiSeedRows(page);
    result.reset = { invoiceCount: resetInvoices.length, ids: resetInvoices.map((row) => row.id), allQueued: true, rulesRestored: true, companyRestored: true, lastRunCleared: true };

    assert(result.externalBrowserRequests.length === 0, 'A cross-origin browser request was attempted and blocked; inspect network.json.');
    assert(result.notes.length === 0, 'The browser emitted runtime or console errors; inspect result.json.');
    if (options.tonight && result.tonight?.positiveApproval?.startsWith('BLOCKED')) {
      result.status = 'BLOCKED';
      result.message = result.tonight.positiveApproval;
    } else {
      result.status = 'PASS';
    }
    result.finishedAt = new Date().toISOString();
  } catch (error) {
    result.status = error instanceof Blocked ? 'BLOCKED' : 'FAIL';
    result.message = error?.message || String(error);
    result.finishedAt = new Date().toISOString();
    await screenshot(page, join(evidenceDir, 'failure.png'));
    if (result.workspaceTouched && page && !page.isClosed()) {
      try {
        await resetThroughUi(page, baseUrl);
        const [remaining, workspaceAfterCleanup] = await Promise.all([
          apiGet(context, baseUrl, '/api/invoices', 'GET /api/invoices after failure cleanup'),
          apiGet(context, baseUrl, '/api/workspace', 'GET /api/workspace after failure cleanup'),
        ]);
        assertSeedRows(remaining, 'Failure cleanup');
        assertSeedWorkspace(workspaceAfterCleanup, result.initialWorkspace, 'Failure cleanup');
        assert(workspaceAfterCleanup.lastRun === null, 'Failure cleanup did not clear lastRun.');
        result.cleanup = 'Acceptance workspace reset and verified as the 20 queued seed fixtures.';
      } catch {
        result.cleanup = 'Could not verify the seeded reset state; inspect this isolated workspace before reuse.';
      }
    }
  } finally {
    if (isolationContext) await isolationContext.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  await writeJson(evidenceDir, 'result.json', result);
  await writeJson(evidenceDir, 'network.json', { externalBrowserRequests: result.externalBrowserRequests });
  if (result.process) await writeJson(evidenceDir, 'process-events.json', result.process);
  else if (result.processObserved) await writeJson(evidenceDir, 'process-events.json', result.processObserved);
  if (result.expediente) await writeJson(evidenceDir, 'expediente.json', result.expediente);
  process.stdout.write(`${result.status}: ${result.message || (options.tonight ? 'M0 browser assertions passed; external Tonight gates remain unverified.' : 'M0 browser assertions passed.')}\n`);
  process.stdout.write(`Evidence: ${evidenceDir}\n`);
  if (options.tonight && result.status === 'PASS') {
    process.stdout.write('Tonight scope: browser-only; labeled-set, transaction/adversarial unit gates, and genuine recording inventory remain external prerequisites.\n');
  }
  if (result.status === 'FAIL') process.exitCode = 1;
  else if (result.status === 'BLOCKED') process.exitCode = 2;
}

async function expectCreatedInvoice(row, kind, description) {
  assert(typeof row?.id === 'string' && !SEED_IDS.includes(row.id), `${description} returned a seed ID or no independent upload ID.`);
  assert(row.status === 'queued' && row.sourceKind === kind, `${description} did not return a queued ${kind} invoice.`);
  return row;
}

async function runTonightSubset({ page, context, baseUrl, onMutationStart }) {
  const summary = {
    textReplay: 'NOT RUN', pdfReplay: 'NOT RUN', stoppedApprovalDenied: 'NOT RUN',
    reevaluateReplay: 'NOT RUN', integrityResolutionDenied: 'NOT RUN', positiveApproval: 'NOT RUN',
  };
  const text = await readFile(join(ROOT, 'fixtures/invoices/AL-030.txt'), 'utf8');
  const textUpload = await expectCreatedInvoice(
    await createTextInvoice(context, baseUrl, text, onMutationStart), 'text', 'Text intake',
  );
  const textRun = await processIdsReplay(context, baseUrl, [textUpload.id]);
  const textExpediente = textRun.records[textUpload.id];
  assert(textExpediente.sourceText?.includes('AL-030'), 'Text replay did not preserve the fictional fixture source text.');
  summary.textReplay = 'PASS (JSON intake ID processed explicitly in replay mode)';

  const stoppedUpload = await expectCreatedInvoice(
    await createPdfInvoice(context, baseUrl, join(ROOT, 'fixtures/invoices/AL-039.pdf'), onMutationStart), 'pdf', 'AL-039 PDF intake',
  );
  const stoppedRun = await processIdsReplay(context, baseUrl, [stoppedUpload.id]);
  const stopped = stoppedRun.records[stoppedUpload.id];
  summary.pdfReplay = 'PASS (multipart PDF intake ID processed explicitly in replay mode)';
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  const stoppedRow = await selectInvoice(page, stoppedUpload.id);
  await stoppedRow.getByRole('status', { name: 'Frenada' }).waitFor({ state: 'visible', timeout: TIMEOUT });
  assert(stopped.row.status === 'stopped' && stopped.record?.decision?.canApprove === false, 'AL-039 was not deterministically stopped.');
  assert(await page.getByRole('button', { name: 'Aprobar', exact: true }).count() === 0, 'The UI exposed Aprobar for a stopped invoice.');
  const stoppedAttempt = await context.request.post(endpoint(baseUrl, `/api/invoices/${encodeURIComponent(stoppedUpload.id)}/approve`), {
    data: { approver: 'Aceptación automatizada (demo)', reason: 'Prueba de seguridad: una factura frenada no debe aprobarse.', idempotencyKey: randomUUID() },
    timeout: TIMEOUT,
  });
  if (stoppedAttempt.status() === 404 || stoppedAttempt.status() === 501) throw new Blocked('Approval safety prerequisite is missing: POST /api/invoices/:id/approve is not ready.');
  assert(stoppedAttempt.status() === 409, `A stopped invoice approval attempt returned HTTP ${stoppedAttempt.status()}, expected 409.`);
  const stillStopped = await readExpediente(context, baseUrl, stoppedUpload.id);
  assert(stillStopped.row.status === 'stopped', 'The stopped invoice changed state after the denied approval attempt.');
  summary.stoppedApprovalDenied = 'PASS';

  const reevaluateResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && isApiUrl(response.url(), baseUrl, new URL(response.url()).pathname)
      && new URL(response.url()).pathname.endsWith('/reevaluate')
  ), { timeout: TIMEOUT });
  await page.getByRole('button', { name: 'Re-evaluar esta factura', exact: true }).click();
  const reevaluateResponse = await reevaluateResponsePromise;
  if (reevaluateResponse.status() === 404 || reevaluateResponse.status() === 501) throw new Blocked('Replay re-evaluation prerequisite is missing: POST /api/invoices/:id/reevaluate is not ready.');
  assert(reevaluateResponse.ok(), `Replay re-evaluation returned HTTP ${reevaluateResponse.status()}.`);
  const reevaluated = await readExpediente(context, baseUrl, stoppedUpload.id);
  assert(reevaluated.row.status === 'stopped' && reevaluated.record?.decision?.canApprove === false, 'Replay re-evaluation upgraded the stopped invoice.');
  summary.reevaluateReplay = 'PASS';

  const integrityUpload = await expectCreatedInvoice(
    await createPdfInvoice(context, baseUrl, join(ROOT, 'fixtures/invoices/AL-047.pdf'), onMutationStart), 'pdf', 'AL-047 PDF intake',
  );
  const integrityRun = await processIdsReplay(context, baseUrl, [integrityUpload.id]);
  const integrity = integrityRun.records[integrityUpload.id];
  const integrityCheck = integrity.record?.decision?.checks?.find((check) => check.id === 'ambiguous_amount' && check.passed === false);
  if (!integrityCheck) throw new Blocked('AL-047 did not expose ambiguous_amount; no generic resolution probe was sent.');
  const integrityFlag = integrity.record.decision.flags?.find((flag) => flag.checkId === 'ambiguous_amount');
  if (!integrityFlag) throw new Blocked('The integrity check has no exposed flag id; no generic resolution probe was sent.');
  const resolutionAttempt = await context.request.post(endpoint(baseUrl,
    `/api/invoices/${encodeURIComponent(integrityUpload.id)}/flags/${encodeURIComponent(integrityFlag.id)}/resolve`), {
    data: { choice: 'not_applicable', reason: 'Prueba de seguridad: monto ambiguo no se resuelve genéricamente.', approver: 'Aceptación automatizada (demo)' },
    timeout: TIMEOUT,
  });
  if (resolutionAttempt.status() === 404 || resolutionAttempt.status() === 501) throw new Blocked('Flag-resolution safety prerequisite is missing: POST /api/invoices/:id/flags/:flagId/resolve is not ready.');
  assert(resolutionAttempt.status() >= 400 && resolutionAttempt.status() < 500, `Generic resolution of ambiguous_amount returned HTTP ${resolutionAttempt.status()}; expected a client-side refusal.`);
  const stillIntegrityBlocked = await readExpediente(context, baseUrl, integrityUpload.id);
  assert(['review_required', 'stopped'].includes(stillIntegrityBlocked.row.status), 'The integrity invoice became eligible after a generic resolution attempt.');
  assert(stillIntegrityBlocked.record?.decision?.canApprove === false, 'The integrity invoice became approvable after a generic resolution attempt.');
  assert(!stillIntegrityBlocked.record.decision.flags.find((flag) => flag.id === integrityFlag.id)?.resolution, 'The integrity flag was marked resolved despite the refusal.');
  summary.integrityResolutionDenied = 'PASS';

  const approvalUpload = await expectCreatedInvoice(
    await createPdfInvoice(context, baseUrl, join(ROOT, 'fixtures/invoices/AL-038.pdf'), onMutationStart), 'pdf', 'AL-038 PDF intake',
  );
  const approvalRun = await processIdsReplay(context, baseUrl, [approvalUpload.id]);
  const approval = approvalRun.records[approvalUpload.id];
  if (approval.record?.jev?.ok !== true || approval.record.jev.recorded !== true) {
    summary.positiveApproval = 'BLOCKED: no genuine successful JEV replay evidence for AL-038; no approval action was taken.';
    return summary;
  }
  if (approval.row.status !== 'approval_required' || approval.record.decision.canApprove !== true) {
    summary.positiveApproval = 'BLOCKED: AL-038 replay evidence did not produce an eligible approval-required invoice; no approval action was taken.';
    return summary;
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await selectInvoice(page, approvalUpload.id);
  await page.getByLabel(/^Tu nombre/).fill('Aceptación automatizada (demo)');
  await page.getByLabel('Motivo', { exact: true }).fill('Aprobación de prueba con evidencia de replay genuina.');
  const approvalResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).origin === baseUrl.origin
      && new URL(response.url()).pathname.endsWith('/approve')
  ), { timeout: TIMEOUT });
  await page.getByRole('button', { name: 'Aprobar', exact: true }).click();
  const approved = await approvalResponse;
  assert(approved.ok(), `Eligible approval returned HTTP ${approved.status()}.`);
  const afterApproval = await readExpediente(context, baseUrl, approvalUpload.id);
  assert(afterApproval.row.status === 'approved', 'A genuine eligible approval did not persist as approved.');
  summary.positiveApproval = 'PASS';
  return summary;
}

run().catch(async (error) => {
  const status = error instanceof Blocked ? 'BLOCKED' : 'FAIL';
  process.stderr.write(`${status}: ${error?.message || String(error)}\n`);
  if (status === 'FAIL') process.exitCode = 1;
  else process.exitCode = 2;
});
