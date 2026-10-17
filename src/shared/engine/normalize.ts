/** Normalize identifiers and names without depending on runtime locale. */
export function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
}

/** Compare named bank words plus the last four digits, whether or not the source masks the account. */
export function normalizeAccount(value: string): string {
  const descriptorsRemoved = value.normalize('NFKC').replace(
    /\bcuentas?(?:\s+de\s+ahorros?|\s+corriente)?\b|\b(?:corriente|de\s+ahorros?)\b/giu,
    ' ',
  );
  const normalized = normalize(descriptorsRemoved);
  const bankWords = normalized.replace(/\d/g, '');
  const digits = normalized.replace(/\D/g, '');
  const hasInstitutionName = !/^(?:banco|bancos|bank|banks|bancario|bancaria|bancarios|bancarias)$/u.test(bankWords);
  if (!bankWords || !hasInstitutionName || digits.length < 4) return '';
  return `${bankWords}:${digits.slice(-4)}`;
}
