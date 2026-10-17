import { describe, expect, it } from 'vitest';
import type { Decision, DecisionRecord, JevAnswers, Rules } from '../../src/shared/domain/types';
import { buildRecord, sealOf } from '../../src/server/engine/record';

const rules: Rules = {
  version: 3,
  perPaymentLimitUsdMinor: 250_000,
  monthlyLimitUsdMinor: 2_000_000,
  approvalThresholdUsdMinor: 100_000,
  fuzzyDuplicateWindowDays: 60,
  preset: 'equilibrado',
};

const dataVersions: DecisionRecord['dataVersions'] = {
  vendor: 2,
  contract: 4,
  fxDate: '2026-10-15',
};

const jev: JevAnswers = {
  ok: true,
  answers: {
    document_type: {
      type: 'choice',
      choice: 'factura',
      confidence: 0.9,
      probabilities: { factura: 0.9, 'cuenta de cobro': 0.1 },
    },
  },
  latencyMs: 40,
  recorded: true,
  inputTokens: 25,
};

function sealInput() {
  return {
    invoiceHash: 'fictional-invoice-hash',
    rules,
    dataVersions,
    jev,
    status: 'ready',
  };
}

function readyDecision(): Decision {
  return {
    status: 'ready',
    checks: [],
    flags: [],
    canApprove: true,
    headline: 'Lista para pagar',
    nextStep: null,
    amountUsdMinor: 12_000,
    contractId: 'contract-demo',
    costCenter: 'operaciones',
  };
}

describe('decision record seal', () => {
  it('is stable when keys are reordered recursively', () => {
    const reordered = {
      status: 'ready',
      jev: {
        inputTokens: 25,
        recorded: true,
        latencyMs: 40,
        answers: {
          document_type: {
            probabilities: { 'cuenta de cobro': 0.1, factura: 0.9 },
            confidence: 0.9,
            choice: 'factura',
            type: 'choice',
          },
        },
        ok: true,
      } as JevAnswers,
      dataVersions: { fxDate: '2026-10-15', contract: 4, vendor: 2 },
      rules: {
        preset: 'equilibrado',
        fuzzyDuplicateWindowDays: 60,
        approvalThresholdUsdMinor: 100_000,
        monthlyLimitUsdMinor: 2_000_000,
        perPaymentLimitUsdMinor: 250_000,
        version: 3,
      } satisfies Rules,
      invoiceHash: 'fictional-invoice-hash',
    };
    expect(sealOf(reordered)).toBe(sealOf(sealInput()));
  });

  it('changes when sealed decision inputs change', () => {
    const base = sealOf(sealInput());
    const changedJev: JevAnswers = {
      ...jev,
      answers: {
        document_type: {
          type: 'choice',
          choice: 'recibo',
          confidence: 0.9,
          probabilities: { recibo: 0.9, 'cuenta de cobro': 0.1 },
        },
      },
    };
    expect(sealOf({ ...sealInput(), rules: { ...rules, version: rules.version + 1 } })).not.toBe(base);
    expect(sealOf({ ...sealInput(), jev: changedJev })).not.toBe(base);
    expect(sealOf({ ...sealInput(), status: 'stopped' })).not.toBe(base);
    expect(sealOf({ ...sealInput(), invoiceHash: 'another-fictional-hash' })).not.toBe(base);
    expect(sealOf({ ...sealInput(), dataVersions: { ...dataVersions, vendor: 9 } })).not.toBe(base);
  });

  it('returns six lowercase hexadecimal characters', () => {
    expect(sealOf(sealInput())).toMatch(/^[0-9a-f]{6}$/);
  });

  it('builds a record and seals the decision status with its snapshots', () => {
    const input = {
      id: 'record-demo-1',
      invoiceId: 'invoice-demo-1',
      invoiceHash: 'fictional-invoice-hash',
      decision: readyDecision(),
      rulesSnapshot: rules,
      dataVersions,
      jev,
      createdAt: '2026-10-16T21:00:00.000Z',
      supersedes: 'record-demo-0',
    };
    const record = buildRecord(input);

    expect(record).toMatchObject({
      id: input.id,
      invoiceId: input.invoiceId,
      decision: input.decision,
      rulesSnapshot: input.rulesSnapshot,
      dataVersions: input.dataVersions,
      jev: input.jev,
      createdAt: input.createdAt,
      supersedes: input.supersedes,
      seal: sealOf({
        invoiceHash: input.invoiceHash,
        rules: input.rulesSnapshot,
        dataVersions: input.dataVersions,
        jev: input.jev,
        status: input.decision.status,
      }),
    });
    expect(record).not.toHaveProperty('invoiceHash');
  });
});
