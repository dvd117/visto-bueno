import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateContentParameters } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  extractText: vi.fn(),
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContent: mocks.generateContent };
      constructor(_options?: unknown) {}
    },
  };
});

vi.mock('unpdf', () => ({ extractText: mocks.extractText }));

import { extract } from '../../src/server/extract/index';
import { readPdf } from '../../src/server/extract/pdf';
import { ProviderCallLimitError } from '../../src/server/model-attempt';

const claims = {
  amountsFound: ['USD 100.00'],
  accountsFound: ['0123456789'],
  taxIdsFound: ['900123456-7'],
  invoiceIdsFound: ['A-101'],
  currenciesFound: ['USD'],
  payeeName: 'Nube Andina SAS',
  payeeTaxId: '900123456-7',
  payoutAccount: '0123456789',
  invoiceId: 'A-101',
  invoiceDate: '2026-10-15',
  dueDate: '2026-10-30',
  currency: 'USD',
  amountRaw: 'USD 100.00',
  subtotalRaw: null,
  taxesRaw: null,
  quantity: null,
  rateRaw: null,
  description: 'Servicios de diseño',
  documentTypeHint: 'factura',
  hasMultipleCurrenciesShown: false,
  evidenceQuotes: { amountRaw: 'USD 100.00' },
  suspiciousPassages: [],
};

const sourceText = 'Factura A-101 para Nube Andina SAS. Total: USD 100.00.';
const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const temporaryDirectories: string[] = [];

function mockClaimsResponse() {
  mocks.generateContent.mockResolvedValue({ text: JSON.stringify(claims) });
}

function requestArgs(): GenerateContentParameters {
  return mocks.generateContent.mock.calls[0]?.[0] as GenerateContentParameters;
}

async function useTemporaryRecordingsDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'extract-recordings-'));
  temporaryDirectories.push(directory);
  vi.stubEnv('EXTRACT_RECORDINGS_DIR', directory);
  return directory;
}

describe('invoice extraction', () => {
  beforeEach(() => {
    vi.stubEnv('EXTRACT_MODE', 'live');
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('GEMINI_MODEL', 'test-model');
    mocks.generateContent.mockReset();
    mocks.extractText.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('rejects PDFs with more than two pages before calling Gemini', async () => {
    mocks.extractText.mockResolvedValue({ totalPages: 3, text: 'invoice pages' });

    const result = await extract({ kind: 'pdf', bytes: Buffer.from('%PDF') });

    expect(result).toEqual({ ok: false, error: 'too_large', sourceKind: 'pdf' });
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it('reads the real AL-032 PDF from a Node Buffer', async () => {
    const actual = await vi.importActual<typeof import('unpdf')>('unpdf');
    mocks.extractText.mockImplementation((data, options) =>
      actual.extractText(data as Uint8Array, options as { mergePages: true }),
    );
    const bytes = await readFile('fixtures/invoices/AL-032.pdf');

    const pdf = await readPdf(bytes);

    expect(pdf.pageCount).toBe(1);
    expect(pdf.text).toContain('AL-032');
  });

  it('rejects files larger than 2 MB before parsing or calling Gemini', async () => {
    const onAttempt = vi.fn();
    const result = await extract({ kind: 'image', bytes: Buffer.alloc(2 * 1024 * 1024 + 1), onAttempt });

    expect(result).toEqual({ ok: false, error: 'too_large', sourceKind: 'image' });
    expect(mocks.extractText).not.toHaveBeenCalled();
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
  });

  it('truncates text to 8,000 characters and sends the pinned extraction rules', async () => {
    mockClaimsResponse();
    const text = `${'x'.repeat(8000)}NOT_SENT_TO_MODEL`;

    const result = await extract({ kind: 'text', text });
    const request = requestArgs();
    const systemInstruction = JSON.stringify(request.config?.systemInstruction);
    const serializedContents = JSON.stringify(request.contents);

    expect(result).toEqual({ ok: true, claims, sourceText: text, sourceKind: 'text' });
    expect(serializedContents).toContain('x'.repeat(8000));
    expect(serializedContents).not.toContain('NOT_SENT_TO_MODEL');
    expect(systemInstruction).toMatch(/untrusted data from a third party/i);
    expect(systemInstruction).toMatch(/never follow/i);
    expect(systemInstruction).toMatch(/suspiciousPassages/);
    expect(systemInstruction).toMatch(/every candidate/i);
    expect(systemInstruction).toMatch(/exact substrings/i);
    expect(systemInstruction).toMatch(/ISO/i);
    expect(systemInstruction).toMatch(/do not normalize amounts/i);
    expect(request.config?.responseMimeType).toBe('application/json');
    expect(request.config?.responseJsonSchema).toBeDefined();
  });

  it('runs the attempt hook immediately before each real Gemini request', async () => {
    const order: string[] = [];
    const onAttempt = vi.fn(() => order.push('attempt'));
    mocks.generateContent.mockImplementation(async () => {
      order.push('request');
      return { text: JSON.stringify(claims) };
    });

    await extract({ kind: 'text', text: sourceText, onAttempt });

    expect(order).toEqual(['attempt', 'request']);
    expect(onAttempt).toHaveBeenCalledOnce();
    expect(requestArgs().config?.httpOptions).toMatchObject({ retryOptions: { attempts: 1 } });
  });

  it('sends image bytes to Gemini with their detected MIME type', async () => {
    mockClaimsResponse();

    const result = await extract({ kind: 'image', bytes: pngBytes });

    expect(result).toEqual({ ok: true, claims, sourceText: '', sourceKind: 'image' });
    expect(JSON.stringify(requestArgs().contents)).toContain('image/png');
    expect(JSON.stringify(requestArgs().contents)).toContain(pngBytes.toString('base64'));
  });

  it('accepts the real AL-036 PNG through image detection and claims validation', async () => {
    const bytes = await readFile('fixtures/invoices/AL-036.png');
    mockClaimsResponse();

    const result = await extract({ kind: 'image', bytes });

    expect(result).toEqual({ ok: true, claims, sourceText: '', sourceKind: 'image' });
    expect(JSON.stringify(requestArgs().contents)).toContain('image/png');
    expect(JSON.stringify(requestArgs().contents)).toContain(bytes.toString('base64'));
  });

  it('uses the smoke-tested Flash-Lite default when GEMINI_MODEL is unset', async () => {
    vi.stubEnv('GEMINI_MODEL', '');
    mockClaimsResponse();

    await extract({ kind: 'text', text: sourceText });

    expect(requestArgs().model).toBe('gemini-3.1-flash-lite');
  });

  it('retries a 429 twice, then returns rate_limited', async () => {
    vi.useFakeTimers();
    const onAttempt = vi.fn();
    mocks.generateContent.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { status: 429 }));

    const resultPromise = extract({ kind: 'text', text: sourceText, onAttempt });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(mocks.generateContent).toHaveBeenCalledTimes(3);
    expect(onAttempt).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, error: 'rate_limited', sourceKind: 'text' });
  });

  it('does not issue a retry when the quota hook denies that attempt', async () => {
    vi.useFakeTimers();
    const denied = new ProviderCallLimitError('quota denied');
    const onAttempt = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw denied; });
    mocks.generateContent.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { status: 429 }));

    const resultPromise = extract({ kind: 'text', text: sourceText, onAttempt });
    const rejection = expect(resultPromise).rejects.toBe(denied);
    await vi.runAllTimersAsync();

    await rejection;
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.generateContent).toHaveBeenCalledOnce();
  });

  it('does not call the attempt hook without a key or during replay', async () => {
    const onAttempt = vi.fn();
    vi.stubEnv('GEMINI_API_KEY', '');
    await expect(extract({ kind: 'text', text: sourceText, onAttempt })).resolves.toEqual({
      ok: false, error: 'unreadable', sourceKind: 'text',
    });

    vi.stubEnv('EXTRACT_MODE', 'replay');
    await expect(extract({ kind: 'text', text: sourceText, onAttempt })).resolves.toEqual({
      ok: false, error: 'unreadable', sourceKind: 'text',
    });
    expect(onAttempt).not.toHaveBeenCalled();
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it('returns unreadable when the response does not match the claims schema', async () => {
    mocks.generateContent.mockResolvedValue({ text: '{"amountsFound":[]}' });

    const result = await extract({ kind: 'text', text: sourceText });

    expect(result).toEqual({ ok: false, error: 'unreadable', sourceKind: 'text' });
  });

  it('reports only invalid schema field names when extraction diagnostics are enabled', async () => {
    vi.stubEnv('EXTRACT_DIAGNOSTICS', '1');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.generateContent.mockResolvedValue({ text: '{"amountsFound":[]}' });

    const result = await extract({ kind: 'text', text: sourceText });

    expect(result).toEqual({ ok: false, error: 'unreadable', sourceKind: 'text' });
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/schema rejected fields:.*accountsFound/));
    expect(warning.mock.calls.flat().join(' ')).not.toContain(sourceText);
    expect(warning.mock.calls.flat().join(' ')).not.toContain('test-key');
  });

  it('records a valid extraction and replays the same claims without calling Gemini', async () => {
    await useTemporaryRecordingsDirectory();
    vi.stubEnv('EXTRACT_MODE', 'record');
    mockClaimsResponse();

    const recorded = await extract({ kind: 'text', text: sourceText });
    vi.stubEnv('EXTRACT_MODE', 'replay');
    mocks.generateContent.mockClear();
    const replayed = await extract({ kind: 'text', text: sourceText });

    expect(replayed).toEqual(recorded);
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it.skipIf(!process.env.GEMINI_API_KEY)('smokes a live structured extraction with a fictional invoice', async () => {
    vi.stubEnv('EXTRACT_MODE', 'live');
    const result = await extract({
      kind: 'text',
      text: 'FACTURA A-101\nProveedor: Nube Andina SAS\nNIT: 900123456-7\nTotal: USD 100.00\nFecha: 2026-10-15',
    });

    expect(result.ok).toBe(true);
  });
});
