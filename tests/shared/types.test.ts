import { describe, expectTypeOf, it } from 'vitest';
import type { InvoiceRow, ProcessEvent, SimulationResult } from '../../src/shared/api';
import type { Decision, ExtractionResult, InvoiceStatus, JevAnswers, Money } from '../../src/shared/domain/types';

describe('domain contract', () => {
  it('money is integer minor units plus currency', () => {
    expectTypeOf<Money>().toEqualTypeOf<{ currency: 'USD' | 'COP' | 'MXN'; minor: number }>();
  });

  it('extraction result and jev answers are discriminated on ok', () => {
    expectTypeOf<Extract<ExtractionResult, { ok: false }>['error']>()
      .toEqualTypeOf<'rate_limited' | 'timeout' | 'unreadable' | 'too_large'>();
    expectTypeOf<Extract<JevAnswers, { ok: false }>['error']>()
      .toEqualTypeOf<'no_key' | 'timeout' | 'malformed' | 'http_error' | 'missing_recording'>();
  });

  it('a decision can never be approved, rejected, stale or queued', () => {
    expectTypeOf<Decision['status']>().toEqualTypeOf<'ready' | 'approval_required' | 'review_required' | 'stopped'>();
    expectTypeOf<InvoiceRow['status']>().toEqualTypeOf<InvoiceStatus>();
  });

  it('simulation never reports unsafe approvals', () => {
    expectTypeOf<SimulationResult['unsafeApprovals']>().toEqualTypeOf<0>();
    expectTypeOf<ProcessEvent['type']>().toEqualTypeOf<'decided' | 'error' | 'done'>();
  });
});
