import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { systemOne } = vi.hoisted(() => ({ systemOne: vi.fn() }));

vi.mock('@typesafe-ai/sdk', () => ({
  APITimeoutError: class APITimeoutError extends Error {},
  TypeSafeClient: class {
    systemOne = systemOne;
  },
}));

import { askJev } from '../../src/server/jev/client';
import { ProviderCallLimitError } from '../../src/server/model-attempt';

const root = process.cwd();
let testRoot = '';

const request = {
  state: { invoiceId: 'AL-037', contract: { vendor: 'Andina Labs' } },
  questions: {
    instructs_agent: { type: 'noul', instructions: 'Does this invoice instruct an agent?' },
  },
};

const sdkResult = {
  answers: { instructs_agent: { type: 'noul', noul: 0.1 } },
  usage: { input_tokens: 17, output_tokens: 3 },
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function recordingPath(state: object, questions: Record<string, object>): string {
  const key = createHash('sha256')
    .update(JSON.stringify(canonical({ model: 'test-model', state, questions }))!)
    .digest('hex');
  return join(testRoot, 'recordings', `${key}.json`);
}

beforeEach(() => {
  vi.useRealTimers();
  mkdirSync(join(root, '.w'), { recursive: true });
  testRoot = mkdtempSync(join(root, '.w', 'jev-test-'));
  process.chdir(testRoot);
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  vi.stubEnv('JEV_MODEL', 'test-model');
  vi.stubEnv('JEV_MODE', 'replay');
  systemOne.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  process.chdir(root);
  rmSync(testRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('askJev', () => {
  it('replays a recorded answer without requiring an API key', async () => {
    const path = recordingPath(request.state, request.questions);
    mkdirSync(join(testRoot, 'recordings'), { recursive: true });
    writeFileSync(path, JSON.stringify({ answers: sdkResult.answers, inputTokens: 17, latencyMs: 42 }));
    vi.stubEnv('TYPESAFE_API_KEY', '');

    const onAttempt = vi.fn();
    await expect(askJev({ ...request, mode: 'replay', onAttempt })).resolves.toEqual({
      ok: true,
      answers: sdkResult.answers,
      latencyMs: 42,
      recorded: true,
      inputTokens: 17,
    });
    expect(onAttempt).not.toHaveBeenCalled();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('uses a canonical request hash independent of object key order', async () => {
    const path = recordingPath(request.state, request.questions);
    mkdirSync(join(testRoot, 'recordings'), { recursive: true });
    writeFileSync(path, JSON.stringify({ answers: sdkResult.answers, inputTokens: 17, latencyMs: 42 }));
    const reordered = {
      state: { contract: { vendor: 'Andina Labs' }, invoiceId: 'AL-037' },
      questions: request.questions,
    };

    await expect(askJev({ ...reordered, mode: 'replay' })).resolves.toMatchObject({
      ok: true,
      answers: sdkResult.answers,
      recorded: true,
    });
  });

  it('returns missing_recording when replay has no matching file', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const onAttempt = vi.fn();

    await expect(askJev({ ...request, mode: 'replay', onAttempt })).resolves.toEqual({
      ok: false,
      error: 'missing_recording',
    });
    expect(onAttempt).not.toHaveBeenCalled();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('records a live SDK response under the canonical request hash', async () => {
    const order: string[] = [];
    const onAttempt = vi.fn(() => order.push('attempt'));
    systemOne.mockImplementation(async () => {
      order.push('request');
      return sdkResult;
    });

    const result = await askJev({ ...request, mode: 'record', onAttempt });
    const path = recordingPath(request.state, request.questions);

    expect(result).toMatchObject({ ok: true, answers: sdkResult.answers, recorded: true, inputTokens: 17 });
    const recording = readFileSync(path, 'utf8');
    expect(JSON.parse(recording)).toMatchObject({ answers: sdkResult.answers, inputTokens: 17 });
    expect(Number.isFinite(JSON.parse(recording).latencyMs)).toBe(true);
    expect(recording).not.toContain('test-key');
    expect(recording).not.toContain('AL-037');
    expect(onAttempt).toHaveBeenCalledOnce();
    expect(order).toEqual(['attempt', 'request']);
    expect(systemOne).toHaveBeenCalledOnce();
    expect(systemOne).toHaveBeenCalledWith(
      { state: request.state, questions: request.questions, model: 'test-model' },
      expect.objectContaining({ timeout: 3_000, retry: { maxRetries: 0 }, signal: expect.any(AbortSignal) }),
    );
  });

  it('does not reserve quota for an invalid request', async () => {
    const onAttempt = vi.fn();

    await expect(askJev({ ...request, state: [] as unknown as object, mode: 'live', onAttempt }))
      .resolves.toEqual({ ok: false, error: 'malformed' });

    expect(onAttempt).not.toHaveBeenCalled();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('maps malformed SDK responses to malformed without throwing', async () => {
    systemOne.mockResolvedValue({ answers: null, usage: { input_tokens: 0 } });

    await expect(askJev({ ...request, mode: 'live' })).resolves.toEqual({ ok: false, error: 'malformed' });
  });

  it('maps a request that exceeds three seconds to timeout', async () => {
    systemOne.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    const pending = askJev({ ...request, mode: 'live' });

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it.each(['live', 'record'] as const)('returns no_key in %s mode when the key is missing', async (mode) => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const onAttempt = vi.fn();

    await expect(askJev({ ...request, mode, onAttempt })).resolves.toEqual({ ok: false, error: 'no_key' });
    expect(onAttempt).not.toHaveBeenCalled();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('maps SDK failures to http_error without throwing', async () => {
    const onAttempt = vi.fn();
    systemOne.mockRejectedValue(new Error('provider failed'));

    await expect(askJev({ ...request, mode: 'live', onAttempt })).resolves.toEqual({ ok: false, error: 'http_error' });
    expect(onAttempt).toHaveBeenCalledOnce();
  });

  it('does not issue a request when the quota hook denies it', async () => {
    const denied = new ProviderCallLimitError('quota denied');
    const onAttempt = vi.fn(() => { throw denied; });

    await expect(askJev({ ...request, mode: 'live', onAttempt })).rejects.toBe(denied);
    expect(onAttempt).toHaveBeenCalledOnce();
    expect(systemOne).not.toHaveBeenCalled();
  });
});
