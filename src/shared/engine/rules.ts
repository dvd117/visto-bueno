import Decimal from 'decimal.js';
import { parseAmount, toUsdMinor } from '../domain/money';
import type {
  Budget, CheckResult, Contract, CostCenter, Currency, ExtractionClaims, Money, Rules, Treasury, Vendor,
} from '../domain/types';
import { normalize, normalizeAccount } from './normalize';

export interface LedgerView {
  committedUsdMinor(month: string): number;
  reservedUsdMinor(month: string): number;
  committedByCostCenter(cc: CostCenter, month: string): number;
  reservedByCostCenter(cc: CostCenter, month: string): number;
  hasInvoiceId(vendorId: string, normalizedId: string): boolean;
  hasCommitmentForContractPeriod(contractId: string, period: string /* 'YYYY-MM' monthly, 'YYYY' annual, 'once' one_time */): boolean;
  recentByVendor(vendorId: string, days: number): Array<{ invoiceId: string; description: string }>;
}

export interface RuleContext {
  vendor: Vendor | null;
  contracts: Contract[];
  money: Money | null;
  claims: ExtractionClaims;
  treasury: Treasury;
  budgets: Budget[];
  rules: Rules;
  ledger: LedgerView;
  today: string;
}

const CURRENCIES: readonly Currency[] = ['USD', 'COP', 'MXN'];
const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function isCurrency(value: string | null | undefined): value is Currency {
  return CURRENCIES.includes(value as Currency);
}

function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function check(id: string, label: string, passed: boolean, effect: CheckResult['effect'], reason: string, evidence?: CheckResult['evidence']): CheckResult {
  return { id, kind: 'rule', label, passed, effect, reason, ...(evidence ? { evidence } : {}) };
}

function periodFor(contract: Contract, invoiceDate: string): string {
  if (contract.billingFrequency === 'monthly') return invoiceDate.slice(0, 7);
  if (contract.billingFrequency === 'annual') return invoiceDate.slice(0, 4);
  return 'once';
}

function maskAccount(account: string | null): string {
  const digits = account?.match(/\d/g)?.join('') ?? '';
  return `···· ${digits.length >= 4 ? digits.slice(-4) : '—'}`;
}

function monthFromDate(date: string | null): string | null {
  return isIsoDate(date) ? date.slice(0, 7) : null;
}

function invoiceCurrency(ctx: RuleContext): Currency | null {
  if (isCurrency(ctx.claims.currency)) return ctx.claims.currency;
  return ctx.vendor?.payoutCurrency ?? null;
}

function variableContractPasses(contract: Contract, ctx: RuleContext): boolean {
  if (
    !ctx.money || contract.rateMinor === undefined || !Number.isSafeInteger(contract.rateMinor) ||
    contract.maxUnitsPerPeriod === undefined || !Number.isFinite(contract.maxUnitsPerPeriod) || contract.maxUnitsPerPeriod < 0 ||
    !ctx.claims.rateRaw?.trim() || !ctx.claims.quantity?.trim()
  ) return false;

  const parsedRate = parseAmount(ctx.claims.rateRaw, { currency: contract.currency });
  if (!parsedRate.ok || parsedRate.money.minor !== contract.rateMinor) return false;

  const quantityText = ctx.claims.quantity.trim();
  if (!/^\d+(?:\.\d+)?$/.test(quantityText)) return false;

  try {
    const quantity = new Decimal(quantityText);
    if (!quantity.isFinite() || quantity.isNegative() || quantity.greaterThan(contract.maxUnitsPerPeriod)) return false;
    return new Decimal(parsedRate.money.minor).mul(quantity).eq(ctx.money.minor);
  } catch {
    return false;
  }
}

export function evaluateRules(ctx: RuleContext): { checks: CheckResult[]; contract: Contract | null; amountUsdMinor: number | null } {
  const { vendor, claims } = ctx;
  const invoiceDate = claims.invoiceDate;
  const validInvoiceDate = isIsoDate(invoiceDate) ? invoiceDate : null;
  const vendorContracts = vendor ? ctx.contracts.filter((candidate) => candidate.vendorId === vendor.id) : [];
  const activeContracts = validInvoiceDate
    ? vendorContracts.filter((candidate) => candidate.start <= validInvoiceDate && validInvoiceDate <= candidate.end)
    : [];
  const contract = activeContracts.length === 1 ? activeContracts[0] : null;
  const oneCandidateForDateCheck = vendorContracts.length === 1 ? vendorContracts[0] : null;
  const contractForDateCheck = contract ?? oneCandidateForDateCheck;
  const amountConversion = ctx.money ? toUsdMinor(ctx.money, ctx.treasury.fx) : null;
  const amountUsdMinor = amountConversion?.ok ? amountConversion.usdMinor : null;
  const fxUnavailable = ctx.money !== null && amountUsdMinor === null;
  const month = monthFromDate(invoiceDate);
  const checks: CheckResult[] = [];

  const allowed = vendor !== null && vendor.status === 'allowed';
  checks.push(check('R1', 'Proveedor autorizado', allowed, allowed ? 'none' : 'stop',
    allowed ? 'El proveedor está en la lista permitida.' : 'El proveedor no está en la lista permitida o está bloqueado.'));

  const accountMatches = !vendor || (Boolean(claims.payoutAccount)
    && normalizeAccount(claims.payoutAccount!) === normalizeAccount(vendor.payoutAccount));
  const accountEvidence = vendor && claims.payoutAccount
    ? { invoice: maskAccount(claims.payoutAccount), record: maskAccount(vendor.payoutAccount) }
    : undefined;
  checks.push(check(
    'R2', 'Cuenta bancaria registrada', accountMatches, accountMatches ? 'none' : 'stop',
    accountMatches
      ? 'La cuenta de la factura coincide con la cuenta registrada.'
      : claims.payoutAccount
        ? 'Verifica el cambio con el proveedor por un canal seguro, actualiza su cuenta en Preparar datos y re-evalúa'
        : 'La factura no identifica una cuenta bancaria para compararla con el registro.',
    accountEvidence,
  ));

  const exactlyOneContract = activeContracts.length === 1;
  checks.push(check(
    'R3', 'Un acuerdo vigente', exactlyOneContract, exactlyOneContract ? 'none' : 'stop',
    exactlyOneContract ? 'Hay un solo acuerdo vigente para esta factura.' : 'Sin acuerdo vigente, no hay pago automático',
  ));

  const claimedCurrency = invoiceCurrency(ctx);
  const currencyMatches = !contract || !claimedCurrency || contract.currency === claimedCurrency;
  checks.push(check(
    'R4', 'Moneda según el acuerdo', currencyMatches, currencyMatches ? 'none' : 'stop',
    currencyMatches ? 'La moneda coincide con el acuerdo o no aplica.' : 'La moneda de la factura no coincide con el acuerdo.',
  ));

  const fixedAmountMatches = !contract || contract.type !== 'fixed' || ctx.money === null
    || (contract.amountMinor !== undefined && ctx.money.minor === contract.amountMinor);
  checks.push(check(
    'R5', 'Monto fijo según el acuerdo', fixedAmountMatches, fixedAmountMatches ? 'none' : 'stop',
    fixedAmountMatches ? 'El monto coincide con el acuerdo o no aplica.' : 'El monto no coincide con el monto acordado.',
  ));

  const variableContract = contract?.type === 'variable' ? contract : null;
  const variable = variableContract !== null;
  const variableValid = !variableContract || variableContractPasses(variableContract, ctx);
  checks.push(check(
    'R6', 'Cantidad y tarifa variables', variableValid, variableValid ? (variable ? 'approval' : 'none') : 'stop',
    !variable ? 'No aplica a un acuerdo de monto fijo.'
      : variableValid ? 'La cantidad y la tarifa coinciden; requiere aprobación humana.'
        : 'La cantidad, tarifa o total no coincide con el acuerdo.',
  ));

  const contractPeriod = contract && validInvoiceDate ? periodFor(contract, validInvoiceDate) : null;
  const alreadyCommitted = Boolean(contract && contractPeriod
    && ctx.ledger.hasCommitmentForContractPeriod(contract.id, contractPeriod));
  let periodReason = 'No hay otro cobro comprometido para este período.';
  if (alreadyCommitted && contract && contractPeriod) {
    if (contract.billingFrequency === 'monthly' && month) {
      const monthIndex = Number(month.slice(5, 7)) - 1;
      periodReason = `Este contrato ya registra un cobro en ${MONTHS[monthIndex]}`;
    } else {
      periodReason = 'Este contrato ya registra un cobro en el período correspondiente.';
    }
  }
  checks.push(check('R7', 'Un cobro por período contractual', !alreadyCommitted, alreadyCommitted ? 'stop' : 'none', periodReason));

  const normalizedInvoiceId = claims.invoiceId ? normalize(claims.invoiceId) : '';
  const duplicate = Boolean(vendor && normalizedInvoiceId && ctx.ledger.hasInvoiceId(vendor.id, normalizedInvoiceId));
  checks.push(check(
    'R8', 'Número de factura único', !duplicate, duplicate ? 'stop' : 'none',
    duplicate ? 'Este número de factura ya existe para el proveedor.' : 'No se encontró una factura comprometida con este número.',
  ));

  const dateWithinContract = !contractForDateCheck || (validInvoiceDate !== null
    && contractForDateCheck.start <= validInvoiceDate && validInvoiceDate <= contractForDateCheck.end);
  checks.push(check(
    'R9', 'Fecha dentro del período del acuerdo', dateWithinContract, dateWithinContract ? 'none' : 'stop',
    dateWithinContract ? 'La fecha de la factura está dentro del período del acuerdo o no aplica.'
      : 'La fecha de la factura está fuera del período del contrato.',
  ));

  const validDueDate = isIsoDate(claims.dueDate) ? claims.dueDate : null;
  const dueDateIsCurrent = validDueDate !== null && isIsoDate(ctx.today) && validDueDate >= ctx.today;
  checks.push(check(
    'R10', 'Vencimiento válido y vigente', dueDateIsCurrent, dueDateIsCurrent ? 'none' : 'review',
    dueDateIsCurrent ? 'La fecha de vencimiento es válida y no ha pasado.'
      : validDueDate ? 'La fecha de vencimiento ya pasó.' : 'La fecha de vencimiento no es válida o falta.',
  ));

  const amountAvailable = ctx.money === null;
  const paymentLimitPasses = amountAvailable || (!fxUnavailable && amountUsdMinor !== null
    && amountUsdMinor <= ctx.rules.perPaymentLimitUsdMinor);
  checks.push(check(
    'R11', 'Límite por pago', paymentLimitPasses, paymentLimitPasses ? 'none' : 'stop',
    amountAvailable ? 'No aplica sin un monto verificable.'
      : fxUnavailable ? 'No se pudo convertir el monto a USD.'
        : paymentLimitPasses ? 'El monto está dentro del límite por pago.' : 'El monto supera el límite por pago.',
  ));

  const monthlyCommitted = month ? ctx.ledger.committedUsdMinor(month) : 0;
  const monthlyReserved = month ? ctx.ledger.reservedUsdMinor(month) : 0;
  const monthlyTotal = amountUsdMinor === null ? null : monthlyCommitted + monthlyReserved + amountUsdMinor;
  const monthlyLimitPasses = amountAvailable || (!fxUnavailable && monthlyTotal !== null && month !== null
    && monthlyTotal <= ctx.rules.monthlyLimitUsdMinor);
  checks.push(check(
    'R12', 'Límite mensual comprometido', monthlyLimitPasses, monthlyLimitPasses ? 'none' : 'stop',
    amountAvailable ? 'No aplica sin un monto verificable.'
      : fxUnavailable ? 'No se pudo convertir el monto a USD.'
        : monthlyLimitPasses ? 'El total mensual está dentro del límite.' : 'El total mensual supera el límite configurado.',
  ));

  const costCenter = contract?.costCenter;
  const budget = contract && month
    ? ctx.budgets.find((candidate) => candidate.costCenter === contract.costCenter && candidate.month === month)
    : undefined;
  const costCenterCommitted = costCenter && month ? ctx.ledger.committedByCostCenter(costCenter, month) : 0;
  const costCenterReserved = costCenter && month ? ctx.ledger.reservedByCostCenter(costCenter, month) : 0;
  const budgetAvailable = budget === undefined || amountUsdMinor === null
    ? null
    : budget.approvedUsdMinor - costCenterCommitted - costCenterReserved;
  const budgetPasses = !contract || amountAvailable || (!fxUnavailable && budgetAvailable !== null
    && month !== null && amountUsdMinor !== null && budgetAvailable >= amountUsdMinor);
  checks.push(check(
    'R13', 'Presupuesto del centro de costo', budgetPasses, budgetPasses ? 'none' : 'stop',
    !contract || amountAvailable ? 'No aplica sin un monto verificable o acuerdo único.'
      : fxUnavailable ? 'No se pudo convertir el monto a USD.'
        : budgetPasses ? 'El presupuesto disponible cubre este monto.'
          : 'El presupuesto disponible del centro de costo no cubre este monto.',
  ));

  const balanceCommitted = month ? ctx.ledger.committedUsdMinor(month) : 0;
  const balanceReserved = month ? ctx.ledger.reservedUsdMinor(month) : 0;
  const balanceAvailable = ctx.treasury.balanceUsdMinor - balanceCommitted - balanceReserved;
  const balancePasses = amountAvailable || (!fxUnavailable && amountUsdMinor !== null && month !== null
    && balanceAvailable >= amountUsdMinor);
  checks.push(check(
    'R14', 'Saldo disponible', balancePasses, balancePasses ? 'none' : 'stop',
    amountAvailable ? 'No aplica sin un monto verificable.'
      : fxUnavailable ? 'No se pudo convertir el monto a USD.'
        : balancePasses ? 'El saldo disponible cubre este monto.' : 'El saldo disponible no cubre este monto.',
  ));

  const approvalRequired = amountUsdMinor !== null && amountUsdMinor > ctx.rules.approvalThresholdUsdMinor;
  checks.push(check(
    'R15', 'Umbral de aprobación humana', true, approvalRequired ? 'approval' : 'none',
    approvalRequired ? 'El monto supera el umbral y requiere aprobación humana.'
      : 'El monto no supera el umbral de aprobación o no aplica.',
  ));

  const fxAvailable = ctx.money === null || amountConversion?.ok === true;
  checks.push(check(
    'R16', 'Tasa de cambio disponible', fxAvailable, fxAvailable ? 'none' : 'stop',
    fxAvailable ? 'Hay una tasa de cambio disponible para el monto.' : 'No hay una tasa de cambio para esta moneda.',
  ));

  return { checks, contract, amountUsdMinor };
}
