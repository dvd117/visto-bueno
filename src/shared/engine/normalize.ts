/** Normalize identifiers and names without depending on runtime locale. */
export function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
}

const ACCOUNT_LABEL = String.raw`cuenta(?:\s+de\s+ahorros?|\s+corriente)?`;
const ACCOUNT_LABEL_AT_START = new RegExp(
  String.raw`^[^\p{L}\p{N}]*${ACCOUNT_LABEL}(?![\p{L}\p{N}])[^\p{L}\p{N}]*`,
  'iu',
);
const ACCOUNT_LABEL_BEFORE_ACCOUNT = new RegExp(
  String.raw`(?<![\p{L}\p{N}])${ACCOUNT_LABEL}(?![\p{L}\p{N}])(?=[^\p{L}]*$)`,
  'iu',
);

interface AccountParts {
  key: string;
  digits: string;
  ambiguous: boolean;
}

function parseAccount(value: string): AccountParts | null {
  if (/\p{N}/u.test(value.replace(/[0-9]/g, ''))) return null;

  let accountText = value.normalize('NFKC')
    .replace(ACCOUNT_LABEL_AT_START, ' ')
    .replace(ACCOUNT_LABEL_BEFORE_ACCOUNT, ' ');
  accountText = accountText.replace(/[^\p{L}\p{N}]*$/u, '');

  const numberMatch = /[0-9]+(?:[ -][0-9]+)*$/u.exec(accountText);
  if (!numberMatch || numberMatch.index === undefined) return null;

  const digits = numberMatch[0].replace(/[ -]/g, '');
  if (digits.length < 4) return null;

  let bankName = accountText.slice(0, numberMatch.index);
  if (/[0-9]/u.test(bankName)) return null;

  const trimmedBankName = bankName.trimEnd();
  const maskSuffix = /([\p{P}\p{S}x](?:\s*[\p{P}\p{S}x])*)$/iu.exec(trimmedBankName);
  let ambiguous = false;
  if (maskSuffix) {
    const maskPrefix = trimmedBankName.slice(0, maskSuffix.index);
    const xRunIsPartOfBankName = /^[x]+$/iu.test(maskSuffix[1])
      && Boolean(maskPrefix)
      && /[\p{L}\p{N}]$/u.test(maskPrefix);
    if (!xRunIsPartOfBankName) {
      bankName = maskPrefix;
      ambiguous = digits.length >= 5;
    }
  }

  const normalizedBank = normalize(bankName);
  const nonInstitutionLabels = /^(?:banco|bancos|bank|banks|bancario|bancaria|bancarios|bancarias|cuentas?|deahorros?|corriente|deahorroscorriente)$/u;
  if (!normalizedBank || nonInstitutionLabels.test(normalizedBank)) return null;

  return {
    key: ambiguous ? '' : `${normalizedBank}:${digits.slice(-4)}`,
    digits,
    ambiguous,
  };
}

export interface AccountAnalysis {
  key: string;
  ambiguous: boolean;
  visibleDigits: string[];
}

/** Resolve one account candidate, or mark it ambiguous when its account identity is unsafe. */
export function analyzeAccount(value: string): AccountAnalysis {
  const digitRuns = value.normalize('NFKC').match(/[0-9]+/gu) ?? [];
  const fullDigitRuns = digitRuns.filter((digits) => digits.length >= 5);
  if (fullDigitRuns.length >= 2) {
    return { key: '', ambiguous: true, visibleDigits: fullDigitRuns };
  }

  const account = parseAccount(value);
  if (!account) {
    return { key: '', ambiguous: digitRuns.length > 0, visibleDigits: fullDigitRuns };
  }

  const visibleDigits = account.digits.length >= 5 ? [account.digits] : [];
  return {
    key: account.ambiguous ? '' : account.key,
    ambiguous: account.ambiguous,
    visibleDigits,
  };
}

/** Compare named bank words plus the last four digits; ambiguous candidates have no key. */
export function normalizeAccount(value: string): string {
  const account = analyzeAccount(value);
  return account.ambiguous ? '' : account.key;
}

/** Full visible account digits are returned only when exactly one number is available. */
export function unmaskedAccountDigits(value: string): string | null {
  const { visibleDigits } = analyzeAccount(value);
  return visibleDigits.length === 1 ? visibleDigits[0] : null;
}
