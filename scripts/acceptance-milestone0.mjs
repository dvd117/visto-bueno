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

async function captureProcess(page, baseUrl, invoiceId) {
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
    const events = parseSse(body);
    const decided = events.find((event) => event.type === 'decided' && event.row?.id === invoiceId);
    const done = events.find((event) => event.type === 'done');
    assert(decided, `The stream had no decided event for ${invoiceId}.`);
    assert(done, 'The stream ended without a done event.');
    assert(done.stats?.mode === 'replay', 'The server reported a non-replay processing mode.');
    assert(!events.some((event) => event.type === 'error' && event.invoiceId === invoiceId), `The server reported a processing error for ${invoiceId}.`);
    return { request: processBody, events, decided, done };
  } catch (error) {
    if (error instanceof Blocked || error instanceof AssertionFailure) throw error;
    if (error?.name === 'TimeoutError') throw new Blocked('Timed out waiting for the replay processing endpoint; T11 readiness is incomplete.');
    throw error;
  } finally {
    page.off('request', onRequest);
  }
}

async function uploadFixture(page, baseUrl, fixturePath, onMutationStart = () => {}) {
  const bytes = await readFile(fixturePath);
  const chooserPromise = page.waitForEvent('filechooser', { timeout: TIMEOUT });
  await page.getByRole('button', { name: /Recibir factura/ }).click({ timeout: TIMEOUT });
  const chooser = await chooserPromise;
  const createPromise = page.waitForResponse((response) => (
    isApiUrl(response.url(), baseUrl, '/api/invoices') && response.request().method() === 'POST'
  ), { timeout: TIMEOUT });
  onMutationStart();
  await chooser.setFiles({ name: fixturePath.split('/').at(-1), mimeType: 'application/pdf', buffer: bytes });
  const response = await createPromise;
  if (response.status() === 404 || response.status() === 501) {
    throw new Blocked(`POST /api/invoices is missing (HTTP ${response.status()}); T11 must provide invoice intake.`);
  }
  const row = await responseJson(response, 'POST /api/invoices');
  assert(typeof row.id === 'string' && row.status === 'queued', 'Invoice intake did not return a queued invoice.');
  await page.getByRole('status').filter({ hasText: 'Factura recibida' }).waitFor({ state: 'visible', timeout: TIMEOUT }).catch(() => {});
  const rowButton = page.getByRole('button', { name: new RegExp(row.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  await rowButton.waitFor({ state: 'visible', timeout: TIMEOUT });
  return row;
}

async function readExpediente(context, baseUrl, id) {
  return apiGet(context, baseUrl, `/api/invoices/${encodeURIComponent(id)}`, `GET /api/invoices/${id}`);
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
    assert(record.jev?.ok === false && typeof record.jev.error === 'string', 'JEV failure evidence is not explicitly recorded.');
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
  await page.getByText('Última ejecución / grabado', { exact: false }).waitFor({ state: 'visible', timeout: TIMEOUT });
}

async function clickAndCapture(page, baseUrl, id) {
  const row = page.getByRole('button', { name: new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  await row.waitFor({ state: 'visible', timeout: TIMEOUT });
  await row.click({ timeout: TIMEOUT });
  return captureProcess(page, baseUrl, id);
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
    assert(Array.isArray(invoices), 'GET /api/invoices did not return an array.');
    assert(invoices.length === 0, `A fresh browser workspace already contains ${invoices.length} invoices; refusing to alter it.`);
    assert(workspace.company?.name === 'Andina Labs Inc.' && workspace.company?.fictional === true, 'The workspace is not the fictional Andina Labs seed.');
    result.freshWorkspace = { invoiceCount: invoices.length, company: workspace.company, rules: workspace.rules };
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
    assert(Array.isArray(isolatedInvoices) && isolatedInvoices.length === 0, 'A second fresh browser context did not start with an empty invoice list.');
    assert(isolatedWorkspace.company?.fictional === true, 'The second workspace did not receive the fictional seed.');
    result.workspaceIsolation = { distinctWorkspaceCookies: true, secondBrowserInvoiceCount: isolatedInvoices.length, fictionalSeed: true };

    await page.getByRole('heading', { name: 'Andina Labs Inc.' }).waitFor({ state: 'visible', timeout: TIMEOUT })
      .catch(() => { throw new Blocked('The loaded page does not expose the T11 Bandeja UI yet.'); });
    const invoice = await uploadFixture(page, baseUrl, FIXTURE, () => { result.workspaceTouched = true; });
    result.invoiceId = invoice.id;
    result.process = await clickAndCapture(page, baseUrl, invoice.id);
    assert(result.process.decided.counters && typeof result.process.decided.counters.queued === 'number', 'The decided SSE event did not include persisted counters.');
    await assertUiCounters(page, result.process.decided.counters);
    const expediente = await readExpediente(context, baseUrl, invoice.id);
    result.expediente = expediente;
    result.sixSteps = validateM0(expediente);
    const isolatedAfterInsert = await apiGet(isolationContext, baseUrl, '/api/invoices', 'GET /api/invoices (second browser after first workspace insert)');
    assert(Array.isArray(isolatedAfterInsert) && isolatedAfterInsert.length === 0, 'The second fresh browser can see the first workspace invoice.');
    result.workspaceIsolation.stillEmptyAfterOtherWorkspaceInsert = true;
    await isolationContext.close();
    isolationContext = null;

    const row = page.getByRole('button', { name: new RegExp(invoice.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
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
    await page.getByRole('button', { name: /Ver registro completo/ }).waitFor({ state: 'visible', timeout: TIMEOUT });
    assert((await page.locator('.decision-seal').innerText()).includes(expediente.record.seal), 'The Expediente seal is not visible.');
    if (!expediente.record.jev?.ok) {
      await page.getByText('JEV no conectado', { exact: false }).waitFor({ state: 'visible', timeout: TIMEOUT });
    }
    result.ui = { bandeja: true, expediente: true, comparison: true, trail: true, sourceText: true, seal: true };
    await screenshot(page, join(evidenceDir, 'm0.png'));

    if (options.tonight) {
      result.tonight = await runTonightSubset({ page, context, baseUrl });
    }

    await resetThroughUi(page, baseUrl);
    const resetWorkspace = await apiGet(context, baseUrl, '/api/workspace', 'GET /api/workspace after reset');
    const resetInvoices = await apiGet(context, baseUrl, '/api/invoices', 'GET /api/invoices after reset');
    assert(Array.isArray(resetInvoices) && resetInvoices.length === 0, 'Reiniciar demo did not clear the acceptance workspace invoices.');
    assert(JSON.stringify(resetWorkspace.rules) === JSON.stringify(workspace.rules), 'Reset did not restore the initial seeded rules.');
    assert(resetWorkspace.company?.name === workspace.company?.name && resetWorkspace.company?.fictional === true, 'Reset did not restore the fictional workspace identity.');
    assert(resetWorkspace.lastRun === null, 'Reset did not clear the workspace run summary.');
    result.reset = { invoiceCount: resetInvoices.length, rulesRestored: true, companyRestored: true, lastRunCleared: true };

    const restoredSeedInvoice = await uploadFixture(page, baseUrl, FIXTURE);
    result.reset.seedReplay = await clickAndCapture(page, baseUrl, restoredSeedInvoice.id);
    const restoredSeedExpediente = await readExpediente(context, baseUrl, restoredSeedInvoice.id);
    assert(restoredSeedExpediente.record?.decision?.contractId === 'valentina-diseno-monthly', 'After reset, the fixed AL-037 contract seed was not restored.');
    assert(Number.isSafeInteger(restoredSeedExpediente.record?.decision?.amountUsdMinor), 'After reset, the AL-037 money evidence was not restored.');
    result.reset.seedEvidence = { contractId: restoredSeedExpediente.record.decision.contractId, amountUsdMinor: restoredSeedExpediente.record.decision.amountUsdMinor };
    await resetThroughUi(page, baseUrl);
    const finalInvoices = await apiGet(context, baseUrl, '/api/invoices', 'GET /api/invoices after final reset');
    assert(Array.isArray(finalInvoices) && finalInvoices.length === 0, 'Final cleanup did not leave the acceptance workspace empty.');
    result.reset.finalInvoiceCount = finalInvoices.length;

    assert(result.externalBrowserRequests.length === 0, 'A cross-origin browser request was attempted and blocked; inspect network.json.');
    assert(result.notes.length === 0, 'The browser emitted runtime or console errors; inspect result.json.');
    result.status = 'PASS';
    result.finishedAt = new Date().toISOString();
  } catch (error) {
    result.status = error instanceof Blocked ? 'BLOCKED' : 'FAIL';
    result.message = error?.message || String(error);
    result.finishedAt = new Date().toISOString();
    await screenshot(page, join(evidenceDir, 'failure.png'));
    if (result.workspaceTouched && page && !page.isClosed()) {
      try {
        await resetThroughUi(page, baseUrl);
        const remaining = await apiGet(context, baseUrl, '/api/invoices', 'GET /api/invoices after failure cleanup');
        assert(Array.isArray(remaining) && remaining.length === 0, 'Failure cleanup left invoices in the isolated workspace.');
        result.cleanup = 'Isolated acceptance workspace reset and verified empty after failure.';
      } catch {
        result.cleanup = 'Could not trigger workspace reset after failure; inspect the isolated workspace before reuse.';
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
  if (result.expediente) await writeJson(evidenceDir, 'expediente.json', result.expediente);
  process.stdout.write(`${result.status}: ${result.message || (options.tonight ? 'M0 browser assertions passed; external Tonight gates remain unverified.' : 'M0 browser assertions passed.')}\n`);
  process.stdout.write(`Evidence: ${evidenceDir}\n`);
  if (options.tonight && result.status === 'PASS') {
    process.stdout.write('Tonight scope: browser-only; labeled-set, transaction/adversarial unit gates, and genuine recording inventory remain external prerequisites.\n');
  }
  if (result.status === 'FAIL') process.exitCode = 1;
  else if (result.status === 'BLOCKED') process.exitCode = 2;
}

async function runTonightSubset({ page, context, baseUrl }) {
  const summary = { textReplay: 'NOT RUN', stoppedApprovalDenied: 'NOT RUN', reevaluateReplay: 'NOT RUN', integrityResolutionDenied: 'NOT RUN', positiveApproval: 'NOT RUN' };

  const text = await readFile(join(ROOT, 'fixtures/invoices/AL-030.txt'), 'utf8');
  const textCreate = await page.evaluate(async (body) => {
    const response = await fetch('/api/invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: body }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, text);
  if (textCreate.status === 404 || textCreate.status === 501) throw new Blocked('Text replay prerequisite is missing: POST /api/invoices JSON intake is not ready.');
  assert(textCreate.status >= 200 && textCreate.status < 300, `Text invoice intake returned HTTP ${textCreate.status}.`);
  assert(textCreate.body?.status === 'queued' && typeof textCreate.body.id === 'string', 'Text intake did not return a queued invoice.');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.getByRole('button', { name: new RegExp(textCreate.body.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).waitFor({ state: 'visible', timeout: TIMEOUT });
  await clickAndCapture(page, baseUrl, textCreate.body.id);
  const textExpediente = await readExpediente(context, baseUrl, textCreate.body.id);
  assert(textExpediente.row.sourceKind === 'text' && textExpediente.sourceText?.includes('AL-030'), 'Text fixture was not replay-extracted into a real Expediente.');
  assert(textExpediente.record?.decision?.checks?.some((check) => check.id === 'extraction_failed' && check.passed), 'Text extraction replay did not produce persisted extraction evidence.');
  summary.textReplay = 'PASS';

  const stoppedRow = await uploadFixture(page, baseUrl, join(ROOT, 'fixtures/invoices/AL-039.pdf'));
  await clickAndCapture(page, baseUrl, stoppedRow.id);
  const stopped = await readExpediente(context, baseUrl, stoppedRow.id);
  if (!stopped.record?.jev?.ok && !stopped.record?.decision?.checks?.some((check) => check.id === 'extraction_failed' && check.passed)) {
    throw new Blocked('AL-039 extraction replay evidence is missing; cannot probe stopped-approval safety.');
  }
  assert(stopped.row.status === 'stopped' && stopped.record?.decision?.canApprove === false, 'AL-039 did not remain deterministically stopped.');
  assert(await page.getByRole('button', { name: 'Aprobar', exact: true }).count() === 0, 'The UI exposed Aprobar for a stopped invoice.');
  const stoppedAttempt = await page.evaluate(async ({ id, key }) => {
    const response = await fetch(`/api/invoices/${encodeURIComponent(id)}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approver: 'Aceptación automatizada (demo)', reason: 'Prueba de seguridad: una factura frenada no debe aprobarse.', idempotencyKey: key }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { id: stoppedRow.id, key: randomUUID() });
  if (stoppedAttempt.status === 404 || stoppedAttempt.status === 501) throw new Blocked('Approval safety prerequisite is missing: POST /api/invoices/:id/approve is not ready.');
  assert(stoppedAttempt.status === 409, `A stopped invoice approval attempt returned HTTP ${stoppedAttempt.status}, expected 409.`);
  const stillStopped = await readExpediente(context, baseUrl, stoppedRow.id);
  assert(stillStopped.row.status === 'stopped', 'The stopped invoice changed state after the denied approval attempt.');
  summary.stoppedApprovalDenied = 'PASS';
  const reevaluateResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/reevaluate')
  ), { timeout: TIMEOUT });
  await page.getByRole('button', { name: 'Re-evaluar esta factura', exact: true }).click();
  const reevaluateResponse = await reevaluateResponsePromise;
  if (reevaluateResponse.status() === 404 || reevaluateResponse.status() === 501) throw new Blocked('Replay re-evaluation prerequisite is missing: POST /api/invoices/:id/reevaluate is not ready.');
  assert(reevaluateResponse.ok(), `Replay re-evaluation returned HTTP ${reevaluateResponse.status()}.`);
  const reevaluated = await readExpediente(context, baseUrl, stoppedRow.id);
  assert(reevaluated.row.status === 'stopped' && reevaluated.record?.decision?.canApprove === false, 'Replay re-evaluation upgraded the stopped invoice.');
  summary.reevaluateReplay = 'PASS';

  const integrityRow = await uploadFixture(page, baseUrl, join(ROOT, 'fixtures/invoices/AL-047.pdf'));
  await clickAndCapture(page, baseUrl, integrityRow.id);
  const integrity = await readExpediente(context, baseUrl, integrityRow.id);
  if (!integrity.record?.decision?.checks?.some((check) => check.id === 'ambiguous_amount' && check.passed === false)) {
    throw new Blocked('AL-047 did not expose its expected ambiguous_amount integrity check; cannot test generic resolution safety.');
  }
  const integrityFlag = integrity.record.decision.flags?.find((flag) => flag.checkId === 'ambiguous_amount');
  if (!integrityFlag) throw new Blocked('The integrity check has no exposed flag id; no generic resolution probe was sent.');
  const resolutionAttempt = await page.evaluate(async ({ invoiceId, flagId }) => {
    const response = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/flags/${encodeURIComponent(flagId)}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice: 'not_applicable', reason: 'Prueba de seguridad: monto ambiguo no se resuelve genéricamente.', approver: 'Aceptación automatizada (demo)' }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { invoiceId: integrityRow.id, flagId: integrityFlag.id });
  if (resolutionAttempt.status === 404 || resolutionAttempt.status === 501) throw new Blocked('Flag-resolution safety prerequisite is missing: POST /api/invoices/:id/flags/:flagId/resolve is not ready.');
  assert(resolutionAttempt.status >= 400 && resolutionAttempt.status < 500, `Generic resolution of ambiguous_amount returned HTTP ${resolutionAttempt.status}; expected a client-side refusal.`);
  const stillIntegrityBlocked = await readExpediente(context, baseUrl, integrityRow.id);
  assert(['review_required', 'stopped'].includes(stillIntegrityBlocked.row.status), 'The integrity invoice became eligible after a generic resolution attempt.');
  assert(stillIntegrityBlocked.record?.decision?.canApprove === false, 'The integrity invoice became approvable after a generic resolution attempt.');
  assert(!stillIntegrityBlocked.record.decision.flags.find((flag) => flag.id === integrityFlag.id)?.resolution, 'The integrity flag was marked resolved despite the refusal.');
  summary.integrityResolutionDenied = 'PASS';

  const approvalRow = await uploadFixture(page, baseUrl, join(ROOT, 'fixtures/invoices/AL-038.pdf'));
  await clickAndCapture(page, baseUrl, approvalRow.id);
  const approval = await readExpediente(context, baseUrl, approvalRow.id);
  const extracted = approval.record?.decision?.checks?.some((check) => check.id === 'extraction_failed' && check.passed);
  if (!extracted) throw new Blocked('AL-038 extraction replay evidence is missing; positive approval is not attempted.');
  if (!approval.record?.jev?.ok || approval.record.jev.recorded !== true) {
    throw new Blocked('Positive approval is blocked: AL-038 has no genuine successful JEV replay evidence; no approval action was taken.');
  }
  assert(approval.row.status === 'approval_required' && approval.record.decision.canApprove, 'Genuine replay evidence did not produce an eligible approval-required invoice.');
  await page.getByRole('button', { name: new RegExp(approvalRow.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  await page.getByLabel(/^Tu nombre/).fill('Aceptación automatizada (demo)');
  await page.getByLabel('Motivo', { exact: true }).fill('Aprobación de prueba con evidencia de replay genuina.');
  const approvalResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/approve')
  ), { timeout: TIMEOUT });
  await page.getByRole('button', { name: 'Aprobar', exact: true }).click();
  const approved = await approvalResponse;
  assert(approved.ok(), `Eligible approval returned HTTP ${approved.status()}.`);
  const afterApproval = await readExpediente(context, baseUrl, approvalRow.id);
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
