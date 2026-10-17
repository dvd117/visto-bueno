import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../src/shared/api';
import type { Decision, DecisionRecord, InvoiceStatus, Money, Rules, Vendor } from '../../src/shared/domain/types';
import { logCsv, paymentsCsv, reportMd } from '../../src/server/export/builders';

const rules: Rules = {
  version: 3,
  perPaymentLimitUsdMinor: 250_000,
  monthlyLimitUsdMinor: 2_000_000,
  approvalThresholdUsdMinor: 100_000,
  fuzzyDuplicateWindowDays: 60,
  preset: 'equilibrado',
};

const vendor: Vendor = {
  id: 'andina-labs-vendor',
  name: 'Andina Labs proveedor ficticio',
  taxId: '901.234.567-8',
  country: 'CO',
  payoutCurrency: 'COP',
  payoutAccount: 'Cuenta, "Norte"\nNueva',
  status: 'allowed',
  version: 1,
};

function decisionRecord(id: string, headline: string): DecisionRecord {
  const decision: Decision = {
    status: 'ready',
    checks: [],
    flags: [],
    canApprove: true,
    headline,
    nextStep: null,
    amountUsdMinor: 2_960,
    contractId: 'contract-fictional',
    costCenter: 'operaciones',
  };

  return {
    id,
    invoiceId: `invoice-${id}`,
    decision,
    rulesSnapshot: rules,
    dataVersions: { vendor: 1, contract: 1, fxDate: '2026-10-15' },
    jev: { ok: false, error: 'missing_recording' },
    seal: `seal-${id}`,
    createdAt: '2026-10-16T21:00:00.000Z',
  };
}

const simpleVendor: Vendor = { ...vendor, payoutAccount: 'Cuenta demo 7788' };

function paymentItem(status: InvoiceStatus, id: string = status, paymentVendor: Vendor = vendor) {
  const amountOriginal: Money = { currency: 'COP', minor: 123_456 };
  const amountUsd: Money & { currency: 'USD' } = { currency: 'USD', minor: 2_960 };
  return {
    record: decisionRecord(id, `Decisión ${id}`),
    status,
    vendor: paymentVendor,
    amountOriginal,
    amountUsd,
    authorizedBy: status === 'approved' ? 'María, "Finanzas"' : null,
  };
}

function logEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    at: '2026-10-16T21:00:00.000Z',
    invoiceId: 'invoice-demo',
    status: 'ready',
    headline: 'Lista para pagar',
    seal: 'abc123',
    by: null,
    ...overrides,
  };
}

describe('export builders', () => {
  it('exports only current ready and approved payments with the exact header', () => {
    const csv = paymentsCsv([
      paymentItem('ready', 'ready-1', simpleVendor),
      paymentItem('approved', 'approved-1', simpleVendor),
      ...(['stopped', 'queued', 'stale', 'rejected', 'review_required', 'approval_required'] as const)
        .map((status) => paymentItem(status, status)),
    ]);

    const [header, ...rows] = csv.split('\n');
    expect(header).toBe('vendor_tax_id,payout_account,payout_currency,amount_original,amount_usd,fx_date,decision_id,authorized_by,seal');
    expect(rows).toHaveLength(2);
    expect(csv).toContain('901.234.567-8,Cuenta demo 7788,COP,1234.56,29.60,2026-10-15,ready-1,,seal-ready-1');
    expect(csv).toContain('approved-1,"María, ""Finanzas""",seal-approved-1');
    expect(csv).not.toContain('stale');
    expect(csv).not.toContain('queued');
    expect(csv).not.toContain('stopped');
  });

  it('quotes CSV values containing delimiters, quotes, or newlines', () => {
    const csv = paymentsCsv([paymentItem('approved', 'quoted')]);
    expect(csv).toContain('"Cuenta, ""Norte""\nNueva"');
    expect(csv).toContain('"María, ""Finanzas"""');
  });

  it('exports zero-decimal CLP amounts with the decision rate date', () => {
    const clpVendor = { ...simpleVendor, payoutCurrency: 'CLP' as const };
    const item = {
      ...paymentItem('ready', 'clp-ready', clpVendor),
      amountOriginal: { currency: 'CLP' as const, minor: 1234 },
    };

    expect(paymentsCsv([item])).toContain('901.234.567-8,Cuenta demo 7788,CLP,1234,29.60,2026-10-15,clp-ready,,seal-clp-ready');
  });

  it('sorts the audit log chronologically and includes seals', () => {
    const csv = logCsv([
      logEntry({ at: '2026-10-16T21:02:00.000Z', invoiceId: 'invoice-2', seal: 'seal-two' }),
      logEntry({ at: '2026-10-16T21:01:00.000Z', invoiceId: 'invoice-1', seal: 'seal-one' }),
    ]);

    expect(csv.indexOf('invoice-1')).toBeLessThan(csv.indexOf('invoice-2'));
    expect(csv).toContain('seal-one');
    expect(csv).toContain('seal-two');
  });

  it('includes each chronological decision headline and seal in the Markdown report', () => {
    const report = reportMd([
      logEntry({ at: '2026-10-16T21:02:00.000Z', invoiceId: 'invoice-2', headline: 'Requiere tu aprobación', seal: 'seal-two' }),
      logEntry({ at: '2026-10-16T21:01:00.000Z', invoiceId: 'invoice-1', headline: 'Lista para pagar', seal: 'seal-one' }),
    ]);

    expect(report).toContain('Lista para pagar');
    expect(report).toContain('seal-one');
    expect(report).toContain('Requiere tu aprobación');
    expect(report).toContain('seal-two');
    expect(report.indexOf('invoice-1')).toBeLessThan(report.indexOf('invoice-2'));
  });
});
