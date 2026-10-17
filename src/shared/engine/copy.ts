import type { Decision } from '../domain/types';

type DecisionCopy = Pick<Decision, 'headline' | 'nextStep'>;
type DecisionStatus = Decision['status'];

const DEFAULT_COPY: Record<DecisionStatus, DecisionCopy> = {
  stopped: {
    headline: 'Factura frenada',
    nextStep: 'Corrige la causa indicada y vuelve a evaluar la factura.',
  },
  review_required: {
    headline: 'Requiere tu revisión',
    nextStep: 'Resuelve cada observación con una razón antes de continuar.',
  },
  approval_required: {
    headline: 'Requiere tu aprobación',
    nextStep: 'Aprueba o rechaza esta factura con un motivo.',
  },
  ready: {
    headline: 'Lista para pagar',
    nextStep: null,
  },
};

const COPY_BY_CHECK: Record<string, Partial<Record<DecisionStatus, DecisionCopy>>> = {
  jev_unavailable: {
    review_required: {
      headline: 'Evaluación incompleta',
      nextStep: 'Vuelve a intentar la evaluación o revisa la factura manualmente.',
    },
  },
  instructs_agent: {
    stopped: {
      headline: 'Factura frenada',
      nextStep: 'Solicita un documento corregido y vuelve a evaluar la factura.',
    },
    review_required: {
      headline: 'Revisa una instrucción de la factura',
      nextStep: 'Confirma que la factura no pida omitir un control.',
    },
    approval_required: DEFAULT_COPY.approval_required,
  },
  artificial_urgency: {
    review_required: {
      headline: 'Revisa la urgencia del pago',
      nextStep: 'Compara la urgencia indicada con la fecha de vencimiento.',
    },
    approval_required: DEFAULT_COPY.approval_required,
  },
  scope_match: {
    stopped: {
      headline: 'Factura frenada',
      nextStep: 'Verifica el trabajo con el acuerdo antes de reevaluar.',
    },
    review_required: {
      headline: 'Revisa el alcance del trabajo',
      nextStep: 'Confirma que el trabajo corresponde al alcance acordado.',
    },
    approval_required: DEFAULT_COPY.approval_required,
  },
  fuzzy_duplicate: {
    review_required: {
      headline: 'Revisa un posible cobro duplicado',
      nextStep: 'Compara esta factura con el cobro anterior antes de continuar.',
    },
    approval_required: DEFAULT_COPY.approval_required,
  },
  document_type: {
    stopped: {
      headline: 'Factura frenada',
      nextStep: 'Solicita una factura o cuenta de cobro válida.',
    },
    review_required: {
      headline: 'Confirma el tipo de documento',
      nextStep: 'Verifica que el documento permita tramitar este pago.',
    },
    approval_required: DEFAULT_COPY.approval_required,
  },
};

const SUBTITLE_BY_CHECK: Readonly<Record<string, string | undefined>> = {
  extraction_failed: 'Duda en los datos',
  source_amountRaw: 'Duda en los datos',
  source_payoutAccount: 'Duda en los datos',
  source_payeeTaxId: 'Duda en los datos',
  source_invoiceId: 'Duda en los datos',
  multiple_tax_ids: 'Duda en los datos',
  multiple_totals: 'Duda en los datos',
  multiple_currencies: 'Duda en los datos',
  sum_mismatch: 'Duda en los datos',
  missing_amount: 'Duda en los datos',
  missing_payee: 'Duda en los datos',
  ambiguous_amount: 'Duda en los datos',
  R10: 'Duda en los datos',
  jev_unavailable: 'Evaluación incompleta',
  instructs_agent: 'Instrucción en la factura',
  artificial_urgency: 'Urgencia por confirmar',
  scope_match: 'Alcance por confirmar',
  fuzzy_duplicate: 'Posible duplicado',
  document_type: 'Tipo de documento',
  image_confirmation: 'No verificable en imagen',
  R6: 'Monto variable',
  R15: 'Excede el límite automático',
};

export function copyForDecision(status: DecisionStatus, decidingCheckId?: string): DecisionCopy {
  return (decidingCheckId ? COPY_BY_CHECK[decidingCheckId]?.[status] : undefined) ?? DEFAULT_COPY[status];
}

export function subtitleForDecision(decision: Pick<Decision, 'status' | 'checks' | 'flags'>): string | undefined {
  if (decision.status === 'review_required') {
    const unresolvedIds = new Set(decision.flags.map((flag) => flag.checkId));
    const decidingCheck = decision.checks.find((check) => check.effect === 'review' && unresolvedIds.has(check.id));
    return decidingCheck ? SUBTITLE_BY_CHECK[decidingCheck.id] : undefined;
  }

  if (decision.status !== 'approval_required') return undefined;

  const approvalCheck = decision.checks.find((check) => check.effect === 'approval');
  if (approvalCheck) return SUBTITLE_BY_CHECK[approvalCheck.id];

  const unresolvedIds = new Set(decision.flags.map((flag) => flag.checkId));
  const resolvedReview = decision.checks.find((check) => (
    check.effect === 'review' && check.id !== 'jev_unavailable' && !unresolvedIds.has(check.id)
  ));
  return resolvedReview ? 'Aprobación tras revisión' : undefined;
}
