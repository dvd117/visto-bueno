/** Normalize identifiers and names without depending on runtime locale. */
export function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
}

/** Compare bank words plus the last four digits, whether or not the source masks the account. */
export function normalizeAccount(value: string): string {
  const normalized = normalize(value);
  const bankWords = normalized.replace(/\d/g, '');
  const digits = normalized.replace(/\D/g, '');
  if (!bankWords || digits.length < 4) return '';
  return `${bankWords}:${digits.slice(-4)}`;
}
