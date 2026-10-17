import Decimal from 'decimal.js';

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

export interface ExtractionMeasurement {
  model: string;
  usageMetadata?: GeminiUsageMetadata;
  costUsd: string | null;
}

// Gemini Developer API Standard paid-tier prices, USD per 1M tokens (checked 2026-10-17).
const GEMINI_3_1_FLASH_LITE_PRICING_USD_PER_MILLION_TOKENS = {
  input: '0.25',
  output: '1.50',
} as const;

const PRICING_BY_MODEL: Record<string, typeof GEMINI_3_1_FLASH_LITE_PRICING_USD_PER_MILLION_TOKENS> = {
  'gemini-3.1-flash-lite': GEMINI_3_1_FLASH_LITE_PRICING_USD_PER_MILLION_TOKENS,
};

const USAGE_FIELDS = [
  'promptTokenCount',
  'candidatesTokenCount',
  'totalTokenCount',
  'thoughtsTokenCount',
  'toolUsePromptTokenCount',
] as const;

export function normalizeUsageMetadata(value: unknown): GeminiUsageMetadata | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const source = value as Record<string, unknown>;
  const usage: GeminiUsageMetadata = {};
  for (const field of USAGE_FIELDS) {
    const count = source[field];
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0) return undefined;
    usage[field] = count as number;
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function calculateGeminiCostUsd(model: string, usage: GeminiUsageMetadata | undefined): string | null {
  const pricing = PRICING_BY_MODEL[model];
  if (!pricing || usage?.promptTokenCount === undefined || usage.candidatesTokenCount === undefined) return null;

  const inputTokens = new Decimal(usage.promptTokenCount).plus(usage.toolUsePromptTokenCount ?? 0);
  const outputTokens = new Decimal(usage.candidatesTokenCount).plus(usage.thoughtsTokenCount ?? 0);
  return inputTokens
    .mul(pricing.input)
    .plus(outputTokens.mul(pricing.output))
    .div(1_000_000)
    .toFixed(8);
}

export function isCostUsd(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return false;
  try {
    const cost = new Decimal(value);
    return cost.isFinite() && !cost.isNegative();
  } catch {
    return false;
  }
}

export function logExtractionMeasurement(invoiceId: string, measurement: ExtractionMeasurement): void {
  console.info(JSON.stringify({
    event: 'gemini_extraction_cost',
    invoiceId,
    model: measurement.model,
    promptTokenCount: measurement.usageMetadata?.promptTokenCount ?? null,
    candidatesTokenCount: measurement.usageMetadata?.candidatesTokenCount ?? null,
    thoughtsTokenCount: measurement.usageMetadata?.thoughtsTokenCount ?? null,
    toolUsePromptTokenCount: measurement.usageMetadata?.toolUsePromptTokenCount ?? null,
    totalTokenCount: measurement.usageMetadata?.totalTokenCount ?? null,
    costUsd: measurement.costUsd,
  }));
}
