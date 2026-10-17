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
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const NON_DECIMAL_NUMBER = /\p{N}/u;
const CONFUSABLE_MASK_LETTERS = new Set(['х', 'Х', 'χ', 'Χ', 'ｘ', 'Ｘ', '×']);
const CONFUSABLE_MASK_LETTER_PATTERN = /[хХχΧ×]/gu;
const CONFUSABLE_MASK_MARKS = new Set(['∗', '⁎', '＊', '●', '∙', '・', '*']);
const CONFUSABLE_MASK_MARK_PATTERN = /[∗⁎＊●∙・*]/gu;

function decimalDigitToAscii(value: string): string {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return value;

  let zero = codePoint;
  while (zero > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return String((codePoint - zero) % 10);
}

function hasUnsafeUnicode(value: string): boolean {
  return Array.from(value).some((character) => (
    /\p{Cf}/u.test(character)
    || (/\p{C}/u.test(character) && !/\s/u.test(character))
    || /\p{M}/u.test(character)
  ));
}

function recognizedMaskSuffixRange(value: string): { start: number; end: number } | null {
  const accountText = value.replace(/[^\p{L}\p{N}]*$/u, '');
  const numberMatch = /[0-9]+(?:[ -][0-9]+)*$/u.exec(accountText);
  if (!numberMatch || numberMatch.index === undefined) return null;

  const bankPrefix = accountText.slice(0, numberMatch.index).trimEnd();
  const maskSuffix = /([\p{P}\p{S}x](?:\s*[\p{P}\p{S}x])*)$/iu.exec(bankPrefix);
  if (!maskSuffix || maskSuffix.index === undefined) return null;

  const maskPrefix = bankPrefix.slice(0, maskSuffix.index);
  const xRunIsPartOfBankName = /^[x]+$/iu.test(maskSuffix[1])
    && Boolean(maskPrefix)
    && /[\p{L}\p{N}]$/u.test(maskPrefix);
  if (xRunIsPartOfBankName) return null;

  const start = Array.from(accountText.slice(0, maskSuffix.index)).length;
  return { start, end: start + Array.from(maskSuffix[1]).length };
}

function hasNonLatinLetterOutsideMask(value: string, mappedValue: string): boolean {
  const maskRange = recognizedMaskSuffixRange(mappedValue);
  return Array.from(value).some((character, index) => (
    /\p{L}/u.test(character)
    && !/^\p{Script=Latin}$/u.test(character)
    && !(maskRange && index >= maskRange.start && index < maskRange.end
      && CONFUSABLE_MASK_LETTERS.has(character))
  ));
}

function hasEmbeddedMaskLookalike(value: string): boolean {
  const characters = Array.from(value);
  return characters.some((character, index) => (
    CONFUSABLE_MASK_MARKS.has(character)
    && index > 0
    && index < characters.length - 1
    && /\p{L}/u.test(characters[index - 1])
    && /\p{L}/u.test(characters[index + 1])
  ));
}

function prepareAccountCandidate(value: string): { value: string; ambiguous: boolean } {
  const normalized = value.normalize('NFKC');
  const mappedValue = normalized
    .replace(/\p{Nd}/gu, decimalDigitToAscii)
    .replace(CONFUSABLE_MASK_LETTER_PATTERN, 'x')
    .replace(CONFUSABLE_MASK_MARK_PATTERN, '·');
  const hasNonDecimalNumber = NON_DECIMAL_NUMBER.test(value.replace(/\p{Nd}/gu, ''))
    || NON_DECIMAL_NUMBER.test(normalized.replace(/\p{Nd}/gu, ''));
  const ambiguous = hasNonDecimalNumber
    || hasUnsafeUnicode(normalized)
    || hasNonLatinLetterOutsideMask(normalized, mappedValue)
    || hasEmbeddedMaskLookalike(normalized);

  return { value: mappedValue, ambiguous };
}

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
  const candidate = prepareAccountCandidate(value);
  const digitRuns = candidate.value.match(/[0-9]+/gu) ?? [];
  const fullDigitRuns = digitRuns.filter((digits) => digits.length >= 5);
  if (candidate.ambiguous || fullDigitRuns.length >= 2) {
    return { key: '', ambiguous: true, visibleDigits: fullDigitRuns };
  }

  const account = parseAccount(candidate.value);
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
