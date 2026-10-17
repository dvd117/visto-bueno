import { z } from 'zod';
import type { ExtractionClaims } from '../../shared/domain/types';

export const extractionClaimsSchema = z.object({
  amountsFound: z.array(z.string()),
  accountsFound: z.array(z.string()),
  taxIdsFound: z.array(z.string()),
  invoiceIdsFound: z.array(z.string()),
  currenciesFound: z.array(z.string()),
  payeeName: z.string().nullable(),
  payeeTaxId: z.string().nullable(),
  payoutAccount: z.string().nullable(),
  invoiceId: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  currency: z.string().nullable(),
  amountRaw: z.string().nullable(),
  subtotalRaw: z.string().nullable(),
  taxesRaw: z.string().nullable(),
  quantity: z.string().nullable(),
  rateRaw: z.string().nullable(),
  description: z.string().nullable(),
  documentTypeHint: z.string().nullable(),
  hasMultipleCurrenciesShown: z.boolean(),
  evidenceQuotes: z.record(z.string(), z.string()),
  suspiciousPassages: z.array(z.string()),
}) satisfies z.ZodType<ExtractionClaims>;

function normalizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeGeminiSchema);
  if (value === null || typeof value !== 'object') return value;

  const entries = Object.entries(value).filter(([key]) => !['$schema', 'propertyNames'].includes(key));
  const schema = Object.fromEntries(entries.map(([key, child]) => [key, normalizeGeminiSchema(child)]));
  const type = schema.type;
  if (Array.isArray(type)) {
    const { type: _type, ...rest } = schema;
    return { ...rest, anyOf: type.map((item) => ({ type: item })) };
  }
  return schema;
}

export const geminiExtractionSchema = normalizeGeminiSchema(z.toJSONSchema(extractionClaimsSchema));
