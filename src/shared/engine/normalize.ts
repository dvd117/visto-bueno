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
  masked: boolean;
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

  const symbolMask = /(?:^|[\s·•*])[·•*]+[\s·•*]*$/u.exec(bankName);
  let masked = Boolean(symbolMask);
  if (symbolMask) {
    bankName = bankName.slice(0, symbolMask.index);
  } else {
    const xMask = /(?:^|[\s·•*])(x+)([\s·•*]*)$/iu.exec(bankName);
    if (xMask) {
      const [run, trailingGap] = [xMask[1], xMask[2]];
      if (run.length === 1 && trailingGap.length > 0) {
        return { key: '', digits, masked: false };
      }
      bankName = bankName.slice(0, xMask.index);
      masked = true;
    }
  }

  const normalizedBank = normalize(bankName);
  const nonInstitutionLabels = /^(?:banco|bancos|bank|banks|bancario|bancaria|bancarios|bancarias|cuentas?|deahorros?|corriente|deahorroscorriente)$/u;
  if (!normalizedBank || nonInstitutionLabels.test(normalizedBank)) return null;

  return { key: `${normalizedBank}:${digits.slice(-4)}`, digits, masked };
}

/** Compare named bank words plus the last four digits; reject ambiguous or malformed account strings. */
export function normalizeAccount(value: string): string {
  return parseAccount(value)?.key ?? '';
}

/** Full digits are available only when the text contains an unmasked number of at least five digits. */
export function unmaskedAccountDigits(value: string): string | null {
  const account = parseAccount(value);
  return account && !account.masked && account.digits.length >= 5 ? account.digits : null;
}
