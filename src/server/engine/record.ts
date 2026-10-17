import { createHash } from 'node:crypto';
import type { Decision, DecisionRecord, JevAnswers, Rules } from '../../shared/domain/types';

interface SealInput {
  invoiceHash: string;
  rules: Rules;
  dataVersions: DecisionRecord['dataVersions'];
  jev: JevAnswers;
  status: string;
}

interface BuildRecordInput {
  id: string;
  invoiceId: string;
  invoiceHash: string;
  decision: Decision;
  rulesSnapshot: Rules;
  dataVersions: DecisionRecord['dataVersions'];
  jev: JevAnswers;
  createdAt: string;
  supersedes?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

export function sealOf(input: SealInput): string {
  const canonicalJson = JSON.stringify(canonicalize(input));
  return createHash('sha256').update(canonicalJson).digest('hex').slice(0, 6);
}

export function buildRecord(input: BuildRecordInput): DecisionRecord {
  return {
    id: input.id,
    invoiceId: input.invoiceId,
    decision: input.decision,
    rulesSnapshot: input.rulesSnapshot,
    dataVersions: input.dataVersions,
    jev: input.jev,
    seal: sealOf({
      invoiceHash: input.invoiceHash,
      rules: input.rulesSnapshot,
      dataVersions: input.dataVersions,
      jev: input.jev,
      status: input.decision.status,
    }),
    createdAt: input.createdAt,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
  };
}
