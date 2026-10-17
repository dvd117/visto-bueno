import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APITimeoutError, TypeSafeClient } from '@typesafe-ai/sdk';
import type { EntryType, Questions } from '@typesafe-ai/sdk';
import type { JevAnswer, JevAnswers, JevQuestionId } from '../../shared/domain/types';

type JevMode = 'replay' | 'record' | 'live';
type JevAnswerMap = Partial<Record<JevQuestionId, JevAnswer>>;

interface AskJevInput {
  state: object;
  questions: Record<string, object>;
  mode?: JevMode;
}

interface JevRecording {
  answers: JevAnswerMap;
  inputTokens: number;
  latencyMs: number;
}

const DEFAULT_MODEL = 'jev-latest';
const REQUEST_TIMEOUT_MS = 3_000;
const QUESTION_IDS = new Set<JevQuestionId>([
  'instructs_agent',
  'artificial_urgency',
  'scope_match',
  'fuzzy_duplicate',
  'document_type',
  'cost_center',
]);
const TIMEOUT = Symbol('jev-timeout');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Cyclic request');
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Cyclic request');
    seen.add(value);
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    const result = typeof toJSON === 'function'
      ? canonicalize(toJSON.call(value), seen)
      : Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key], seen)]),
      );
    seen.delete(value);
    return result;
  }
  return value;
}

function recordingPath(model: string, state: object, questions: Record<string, object>): string {
  const canonical = JSON.stringify(canonicalize({ model, state, questions }));
  if (canonical === undefined) throw new TypeError('Invalid request');
  const key = createHash('sha256').update(canonical).digest('hex');
  return join(process.cwd(), 'recordings', `${key}.json`);
}

function isProbabilityMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(
    (probability) => typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1,
  );
}

function parseAnswers(value: unknown, questions: Record<string, object>): JevAnswerMap | null {
  if (!isRecord(value)) return null;
  const ids = Object.keys(questions);
  if (ids.length === 0 || ids.some((id) => !QUESTION_IDS.has(id as JevQuestionId))) return null;
  if (Object.keys(value).length !== ids.length || ids.some((id) => !(id in value))) return null;

  const answers: JevAnswerMap = {};
  for (const id of ids) {
    const question = questions[id];
    const answer = value[id];
    if (!isRecord(question) || !isRecord(answer) || answer.type !== question.type) return null;

    if (answer.type === 'noul') {
      if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return null;
      answers[id as JevQuestionId] = { type: 'noul', noul: answer.noul };
      continue;
    }

    if (answer.type === 'choice') {
      if (typeof answer.choice !== 'string' || !isProbabilityMap(answer.probabilities)
        || typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)
        || answer.confidence < 0 || answer.confidence > 1) return null;
      if (isRecord(question.criteria) && !(answer.choice in question.criteria)) return null;
      answers[id as JevQuestionId] = {
        type: 'choice',
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
      continue;
    }

    if (answer.type === 'score') {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)
        || !isProbabilityMap(answer.probabilities)
        || typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)
        || answer.confidence < 0 || answer.confidence > 1) return null;
      answers[id as JevQuestionId] = {
        type: 'score',
        score: answer.score,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
      continue;
    }

    return null;
  }
  return answers;
}

function parseRecording(value: unknown, questions: Record<string, object>): JevRecording | null {
  if (!isRecord(value)) return null;
  const answers = parseAnswers(value.answers, questions);
  if (!answers || typeof value.inputTokens !== 'number' || !Number.isInteger(value.inputTokens) || value.inputTokens < 0
    || typeof value.latencyMs !== 'number' || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) return null;
  return { answers, inputTokens: value.inputTokens, latencyMs: value.latencyMs };
}

function getMode(mode?: JevMode): JevMode | null {
  const value = mode ?? process.env.JEV_MODE ?? 'replay';
  return value === 'replay' || value === 'record' || value === 'live' ? value : null;
}

async function replay(path: string, questions: Record<string, object>): Promise<JevAnswers> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { ok: false, error: 'missing_recording' };
    return { ok: false, error: 'http_error' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, error: 'malformed' };
  }
  const recording = parseRecording(parsed, questions);
  if (!recording) return { ok: false, error: 'malformed' };
  return { ok: true, ...recording, recorded: true };
}

export async function askJev(input: AskJevInput): Promise<JevAnswers> {
  try {
    const mode = getMode(input?.mode);
    if (!mode || !input || typeof input.state !== 'object' || input.state === null || !isRecord(input.questions)) {
      return { ok: false, error: 'malformed' };
    }
    const model = process.env.JEV_MODEL?.trim() || DEFAULT_MODEL;
    const path = recordingPath(model, input.state, input.questions);

    if (mode === 'replay') return await replay(path, input.questions);

    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) return { ok: false, error: 'no_key' };

    const client = new TypeSafeClient({
      apiKey,
      defaultModel: model,
      logLevel: 'off',
      retry: { maxRetries: 0 },
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let result: unknown;

    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(TIMEOUT);
        }, REQUEST_TIMEOUT_MS);
      });
      const response = client.systemOne(
        {
          state: input.state as NonNullable<EntryType>,
          questions: input.questions as Questions,
          model,
        },
        { timeout: REQUEST_TIMEOUT_MS, retry: { maxRetries: 0 }, signal: controller.signal },
      );
      result = await Promise.race([response, timeout]);
    } catch (error) {
      if (error === TIMEOUT || error instanceof APITimeoutError) return { ok: false, error: 'timeout' };
      return { ok: false, error: 'http_error' };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    if (!isRecord(result)) return { ok: false, error: 'malformed' };
    const answers = parseAnswers(result.answers, input.questions);
    const usage = result.usage;
    if (!answers || !isRecord(usage)
      || (usage.input_tokens !== null && (typeof usage.input_tokens !== 'number'
        || !Number.isInteger(usage.input_tokens) || usage.input_tokens < 0))) {
      return { ok: false, error: 'malformed' };
    }

    const recording: JevRecording = {
      answers,
      inputTokens: usage.input_tokens ?? 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
    if (mode === 'record') {
      try {
        await mkdir(join(process.cwd(), 'recordings'), { recursive: true });
        await writeFile(path, JSON.stringify(recording));
      } catch {
        return { ok: false, error: 'http_error' };
      }
    }
    return { ok: true, ...recording, recorded: mode === 'record' };
  } catch {
    return { ok: false, error: 'malformed' };
  }
}
