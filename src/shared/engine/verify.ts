import { parseAmount } from '../domain/money';
import { isCurrency } from '../domain/currencies';
import type { CheckOutcome, CheckResult, Currency, ExtractionClaims, ExtractionResult, Money, Vendor } from '../domain/types';
import { analyzeAccount, normalize, normalizeAccount } from './normalize';

const EXTRACTION_FAILURE_REASONS: Record<Extract<ExtractionResult, { ok: false }>['error'], string> = {
  rate_limited: 'No pude leer la factura (límite del servicio)',
  timeout: 'No pude leer la factura (tiempo de espera agotado)',
  unreadable: 'No pude leer la factura',
  too_large: 'El documento supera el límite permitido',
};

const SOURCE_FIELDS = [
  ['amountRaw', 'Fuente del monto'],
  ['payoutAccount', 'Fuente de la cuenta bancaria'],
  ['payeeTaxId', 'Fuente de la identificación tributaria'],
  ['invoiceId', 'Fuente del número de factura'],
] as const;

function check(
  id: string,
  label: string,
  passed: boolean,
  effect: CheckResult['effect'],
  reason: string,
  outcome: CheckOutcome = passed ? 'passed' : 'failed',
): CheckResult {
  return { id, kind: 'verify', label, passed, outcome, effect, reason };
}

function uniqueNormalized(values: Array<string | null | undefined>): Set<string> {
  return new Set(values.filter((value): value is string => Boolean(value?.trim())).map(normalize));
}

export function hasSingleUnambiguousAccount(values: Array<string | null | undefined>): boolean {
  const candidates = values.filter((value): value is string => Boolean(value?.trim())).map((value) => {
    const account = analyzeAccount(value);
    return { value, account };
  });
  if (candidates.some(({ account }) => account.ambiguous)) return false;

  const keys = new Set(candidates.map(({ value, account }) => account.key || `raw:${normalize(value)}`));
  if (keys.size > 1) return false;

  const visibleDigits = new Set(candidates.flatMap(({ account }) => account.visibleDigits));
  return visibleDigits.size < 2;
}

function uniqueTotalValues(values: Array<string | null | undefined>, currency: Currency | null): Set<string> {
  const totals = new Set<string>();
  for (const value of values) {
    if (!value?.trim()) continue;
    const parsed = currency ? parseAmount(value, { currency }) : null;
    totals.add(parsed?.ok ? `${parsed.money.currency}:${parsed.money.minor}` : `raw:${normalize(value)}`);
  }
  return totals;
}

function hasLiteralWithWhitespaceNormalization(sourceText: string, value: string): boolean {
  const collapseWhitespace = (text: string) => text.replace(/\s+/gu, ' ').trim();
  return collapseWhitespace(sourceText).includes(collapseWhitespace(value));
}

function matchVendor(claims: ExtractionClaims, vendors: Vendor[]): Vendor | null {
  if (claims.payeeTaxId?.trim()) {
    const taxId = normalize(claims.payeeTaxId);
    const byTaxId = vendors.filter((vendor) => normalize(vendor.taxId) === taxId);
    return byTaxId.length === 1 ? byTaxId[0] : null;
  }

  if (claims.taxIdsFound.some((candidate) => candidate.trim() !== '')) return null;

  const account = claims.payoutAccount ? normalizeAccount(claims.payoutAccount) : '';
  if (!account) return null;
  const byAccount = vendors.filter((vendor) => normalizeAccount(vendor.payoutAccount) === account);
  return byAccount.length === 1 ? byAccount[0] : null;
}

function selectedCurrency(claims: ExtractionClaims, vendor: Vendor | null): Currency | null {
  if (isCurrency(claims.currency)) return claims.currency;
  return vendor?.payoutCurrency ?? null;
}

function parseClaimedAmount(raw: string | null, currency: Currency | null): Money | null {
  if (!raw?.trim() || !currency) return null;
  const parsed = parseAmount(raw, { currency });
  return parsed.ok ? parsed.money : null;
}

function parseSum(claims: ExtractionClaims, currency: Currency | null): boolean | null {
  if (!claims.subtotalRaw || !claims.taxesRaw || !claims.amountRaw) return null;
  const subtotal = parseClaimedAmount(claims.subtotalRaw, currency);
  const taxes = parseClaimedAmount(claims.taxesRaw, currency);
  const total = parseClaimedAmount(claims.amountRaw, currency);
  if (!subtotal || !taxes || !total) return false;
  if (subtotal.currency !== taxes.currency || subtotal.currency !== total.currency) return false;
  return Number.isSafeInteger(subtotal.minor + taxes.minor) && subtotal.minor + taxes.minor === total.minor;
}

export function verifyClaims(
  extraction: ExtractionResult,
  vendors: Vendor[],
): { checks: CheckResult[]; vendor: Vendor | null; money: Money | null } {
  if (!extraction.ok) {
    return {
      checks: [check('extraction_failed', 'No se pudo leer la factura', false, 'review', EXTRACTION_FAILURE_REASONS[extraction.error], 'pending')],
      vendor: null,
      money: null,
    };
  }

  const { claims, sourceText, sourceKind } = extraction;
  const vendor = matchVendor(claims, vendors);
  const currency = selectedCurrency(claims, vendor);
  const money = parseClaimedAmount(claims.amountRaw, currency);
  const checks: CheckResult[] = [check('extraction_failed', 'Extracción disponible', true, 'none', 'La factura se pudo leer.')];

  for (const [field, label] of SOURCE_FIELDS) {
    if (sourceKind === 'image') {
      checks.push(check(`source_${field}`, label, false, 'approval', 'No verificable en imagen.', 'pending'));
      continue;
    }
    const value = claims[field];
    if (value === null || value.trim() === '') continue;
    const passed = hasLiteralWithWhitespaceNormalization(sourceText, value);
    checks.push(check(
      `source_${field}`,
      label,
      passed,
      passed ? 'none' : 'review',
      passed ? 'El dato aparece en el documento.' : `No pude confirmar ${field === 'amountRaw' ? 'el monto' : field === 'payoutAccount' ? 'la cuenta bancaria' : field === 'payeeTaxId' ? 'la identificación tributaria' : 'el número de factura'} en el documento`,
    ));
  }

  const singleAccount = hasSingleUnambiguousAccount([...claims.accountsFound, claims.payoutAccount]);
  const multipleAccounts = !singleAccount;
  checks.push(check(
    'two_accounts', 'Una sola cuenta bancaria', !multipleAccounts, multipleAccounts ? 'stop' : 'none',
    multipleAccounts ? 'La factura muestra dos cuentas bancarias distintas' : 'La factura muestra como máximo una cuenta bancaria.',
  ));

  const taxIds = uniqueNormalized([...claims.taxIdsFound, claims.payeeTaxId]);
  const multipleTaxIds = taxIds.size > 1;
  checks.push(check(
    'multiple_tax_ids', 'Identificación tributaria consistente', !multipleTaxIds, multipleTaxIds ? 'review' : 'none',
    multipleTaxIds ? 'La factura muestra más de una identificación tributaria.' : 'La identificación tributaria es consistente.',
  ));

  const totals = uniqueTotalValues([...claims.amountsFound, claims.amountRaw], currency);
  const multipleTotals = totals.size > 1;
  checks.push(check(
    'multiple_totals', 'Total consistente', !multipleTotals, multipleTotals ? 'review' : 'none',
    multipleTotals ? 'La factura muestra más de un total posible.' : 'La factura muestra como máximo un total posible.',
  ));

  const currencies = uniqueNormalized([...claims.currenciesFound, claims.currency]);
  const multipleCurrencies = claims.hasMultipleCurrenciesShown || currencies.size > 1;
  checks.push(check(
    'multiple_currencies', 'Moneda consistente', !multipleCurrencies, multipleCurrencies ? 'review' : 'none',
    multipleCurrencies ? 'La factura muestra más de una moneda.' : 'La factura muestra una sola moneda.',
  ));

  const sumMatches = parseSum(claims, currency);
  const sumMismatch = sumMatches === false;
  checks.push(check(
    'sum_mismatch', 'Suma de subtotal e impuestos', !sumMismatch, sumMismatch ? 'review' : 'none',
    sumMismatch ? 'El subtotal y los impuestos no coinciden con el total.' : 'La suma del subtotal y los impuestos coincide con el total o no aplica.',
    sumMatches === null ? 'not_applicable' : sumMismatch ? 'failed' : 'passed',
  ));

  const hasAmount = Boolean(claims.amountRaw?.trim());
  checks.push(check(
    'missing_amount', 'Monto presente', hasAmount, hasAmount ? 'none' : 'review',
    hasAmount ? 'La factura contiene un monto.' : 'La factura no contiene un monto verificable.',
  ));

  const hasPayee = [claims.payeeName, claims.payeeTaxId, claims.payoutAccount].some((value) => Boolean(value?.trim()));
  checks.push(check(
    'missing_payee', 'Beneficiario presente', hasPayee, hasPayee ? 'none' : 'review',
    hasPayee ? 'La factura identifica un beneficiario.' : 'La factura no identifica un beneficiario.',
  ));

  const amountResult = hasAmount && currency ? parseAmount(claims.amountRaw!, { currency }) : null;
  const amountIsUnambiguous = !hasAmount || (amountResult !== null && amountResult.ok);
  checks.push(check(
    'ambiguous_amount', 'Monto interpretable', amountIsUnambiguous,
    amountIsUnambiguous ? 'none' : 'review',
    amountIsUnambiguous ? 'El monto se puede interpretar sin adivinar.' : 'No pude interpretar el monto sin adivinar.',
    amountIsUnambiguous ? 'passed' : 'failed',
  ));

  const imageSource = sourceKind === 'image';
  checks.push(check(
    'image_confirmation', 'Confirmación visual de la imagen', true,
    imageSource ? 'approval' : 'none',
    imageSource ? 'Confirma los datos contra la imagen antes de aprobar.' : 'No requiere confirmación visual.',
    imageSource ? 'pending' : 'not_applicable',
  ));

  return { checks, vendor, money };
}
