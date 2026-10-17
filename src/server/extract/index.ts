import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ExtractionClaims, ExtractionResult, SourceKind } from '../../shared/domain/types';
import { ProviderCallLimitError, type ProviderAttemptHook } from '../model-attempt';
import {
  calculateGeminiCostUsd,
  isCostUsd,
  logExtractionMeasurement,
  normalizeUsageMetadata,
  type ExtractionMeasurement,
} from './cost';
import { extractClaims, isRateLimited, isTimeout, resolveGeminiModel } from './gemini';
import { readPdf } from './pdf';
import { EXTRACTION_CONTRACT_VERSION, extractionClaimsSchema } from './schema';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MODEL_TEXT_LIMIT = 8000;
const DEFAULT_RECORDINGS_DIRECTORY = fileURLToPath(new URL('./recordings/', import.meta.url));

type Mode = 'record' | 'replay' | 'live';

interface Recording {
  claims: ExtractionClaims;
  model?: string;
  usageMetadata?: ExtractionMeasurement['usageMetadata'];
  costUsd?: string | null;
}

export async function extract(input: {
  kind: SourceKind;
  bytes?: Buffer;
  text?: string;
  mode?: Mode;
  invoiceId?: string;
  onAttempt?: ProviderAttemptHook;
  onMeasurement?: (measurement: ExtractionMeasurement) => void;
}): Promise<ExtractionResult> {
  const { kind } = input;
  if ((kind === 'pdf' || kind === 'image') && !input.bytes) return failure(kind, 'unreadable');
  if (input.bytes && input.bytes.length > MAX_FILE_BYTES) return failure(kind, 'too_large');
  if (kind === 'text' && typeof input.text !== 'string') return failure(kind, 'unreadable');

  let sourceText = '';
  let image: { bytes: Buffer; mimeType: string } | undefined;
  let content: Buffer | string;

  try {
    if (kind === 'pdf') {
      const pdf = await readPdf(input.bytes!);
      if (pdf.pageCount > 2) return failure(kind, 'too_large');
      sourceText = pdf.text;
      content = input.bytes!;
    } else if (kind === 'image') {
      const mimeType = detectImageMimeType(input.bytes!);
      if (!mimeType) return failure(kind, 'unreadable');
      image = { bytes: input.bytes!, mimeType };
      content = input.bytes!;
    } else {
      sourceText = input.text!;
      content = sourceText;
    }
  } catch {
    return failure(kind, 'unreadable');
  }

  const mode = getMode(input.mode);
  if (!mode) return failure(kind, 'unreadable');
  const hash = createHash('sha256')
    .update('visto-bueno-extraction\0')
    .update(EXTRACTION_CONTRACT_VERSION).update('\0')
    .update(resolveGeminiModel()).update('\0')
    .update(kind).update('\0')
    .update(content)
    .digest('hex');
  const result = { sourceText, sourceKind: kind } as const;
  let measurementReported = false;
  const reportOnce = (invoiceId: string, measurement: ExtractionMeasurement) => {
    if (measurementReported) return;
    measurementReported = true;
    reportMeasurement(invoiceId, measurement, input.onMeasurement);
  };

  if (mode === 'replay') {
    const recording = await readRecording(hash);
    const measurement = recording?.measurement ?? {
      model: resolveGeminiModel(),
      costUsd: null,
    };
    reportOnce(input.invoiceId ?? 'unknown', measurement);
    return recording ? { ok: true, ...result, claims: recording.claims } : failure(kind, 'unreadable');
  }

  try {
    const extraction = await extractClaims({
      sourceKind: kind,
      sourceText: sourceText.slice(0, MODEL_TEXT_LIMIT),
      image,
      onAttempt: input.onAttempt,
    });
    if (!extraction) {
      reportOnce(input.invoiceId ?? 'unknown', { model: resolveGeminiModel(), costUsd: null });
      return failure(kind, 'unreadable');
    }
    const invoiceId = input.invoiceId ?? 'unknown';
    reportOnce(invoiceId, extraction.measurement);
    if (!extraction.claims) return failure(kind, 'unreadable');
    if (mode === 'record') await writeRecording(hash, extraction.claims, extraction.measurement);
    return { ok: true, ...result, claims: extraction.claims };
  } catch (error) {
    reportOnce(input.invoiceId ?? 'unknown', { model: resolveGeminiModel(), costUsd: null });
    if (error instanceof ProviderCallLimitError) throw error;
    if (isRateLimited(error)) return failure(kind, 'rate_limited');
    if (isTimeout(error)) return failure(kind, 'timeout');
    return failure(kind, 'unreadable');
  }
}

function failure(sourceKind: SourceKind, error: 'rate_limited' | 'timeout' | 'unreadable' | 'too_large'): ExtractionResult {
  return { ok: false, error, sourceKind };
}

function getMode(override?: Mode): Mode | null {
  const mode = override ?? process.env.EXTRACT_MODE ?? 'replay';
  return mode === 'record' || mode === 'replay' || mode === 'live' ? mode : null;
}

function getRecordingsDirectory(): string {
  return process.env.EXTRACT_RECORDINGS_DIR ?? DEFAULT_RECORDINGS_DIRECTORY;
}

function reportMeasurement(
  invoiceId: string,
  measurement: ExtractionMeasurement,
  onMeasurement?: (value: ExtractionMeasurement) => void,
): void {
  onMeasurement?.(measurement);
  logExtractionMeasurement(invoiceId, measurement);
}

async function readRecording(hash: string): Promise<{ claims: ExtractionClaims; measurement: ExtractionMeasurement } | null> {
  try {
    const recording = JSON.parse(await readFile(join(getRecordingsDirectory(), `${hash}.json`), 'utf8')) as Recording;
    const parsed = extractionClaimsSchema.safeParse(recording.claims);
    if (!parsed.success) return null;
    const model = typeof recording.model === 'string' && recording.model.trim()
      ? recording.model
      : resolveGeminiModel();
    const usageMetadata = normalizeUsageMetadata(recording.usageMetadata);
    const costUsd = usageMetadata
      ? (isCostUsd(recording.costUsd) ? recording.costUsd : calculateGeminiCostUsd(model, usageMetadata))
      : null;
    return {
      claims: parsed.data,
      measurement: {
        model,
        ...(usageMetadata ? { usageMetadata } : {}),
        costUsd,
      },
    };
  } catch {
    return null;
  }
}

async function writeRecording(hash: string, claims: ExtractionClaims, measurement: ExtractionMeasurement): Promise<void> {
  const directory = getRecordingsDirectory();
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `${hash}.json`);
  const temporary = join(directory, `.${hash}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({
      claims,
      model: measurement.model,
      ...(measurement.usageMetadata ? { usageMetadata: measurement.usageMetadata } : {}),
      costUsd: measurement.costUsd,
    } satisfies Recording), { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function detectImageMimeType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  return null;
}
