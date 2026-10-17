import { randomUUID } from 'node:crypto';
import type { LabeledInvoice, EvaluationRunner, RunnerResult } from './run';
import { DEFAULT_DEMO_TODAY } from '../db/decide';
import { getInvoice, openDb } from '../db/db';
import { ensureWorkspace } from '../db/workspace';
import { ensureExampleInvoices, readExampleFixtures } from '../fixtures';
import { processBatch } from '../pipeline';

export const EVALUATION_TODAY = '2026-10-16';

export function loadLabeledInvoices(root = process.cwd()): LabeledInvoice[] {
  return readExampleFixtures(root)
    .map(({ invoiceId, expected }) => ({ invoiceId, expected }))
    .sort((left, right) => left.invoiceId < right.invoiceId ? -1 : left.invoiceId > right.invoiceId ? 1 : 0);
}

export function assertReplayOnly(): void {
  const modes = [process.env.EXTRACT_MODE, process.env.JEV_MODE];
  if (modes.some((mode) => mode !== undefined && mode !== 'replay')) {
    throw new Error('Replay-only evaluation refuses record or live provider modes.');
  }
}

export interface ReplayPipelineSession {
  labels: LabeledInvoice[];
  runner: EvaluationRunner;
  close(): void;
}

export function createReplayPipelineRunner(): ReplayPipelineSession {
  assertReplayOnly();
  if (DEFAULT_DEMO_TODAY !== EVALUATION_TODAY) {
    throw new Error(`Replay evaluation requires today=${EVALUATION_TODAY}.`);
  }

  const db = openDb(':memory:');
  const workspaceId = `eval-${randomUUID()}`;
  ensureWorkspace(db, workspaceId);
  const fixtures = ensureExampleInvoices(db, workspaceId);
  const labels = fixtures
    .map(({ invoiceId, expected }) => ({ invoiceId, expected }))
    .sort((left, right) => left.invoiceId < right.invoiceId ? -1 : left.invoiceId > right.invoiceId ? 1 : 0);
  let replayResults: Map<string, RunnerResult> | undefined;
  let replayPromise: Promise<void> | undefined;

  async function replayLabeledSet(): Promise<void> {
    const results = new Map<string, RunnerResult>();
    try {
      const stats = await processBatch({ db }, {
        workspaceId,
        ids: labels.map(({ invoiceId }) => invoiceId),
        mode: 'replay',
        extractMode: 'replay',
        jevMode: 'replay',
        ip: null,
        emit: () => undefined,
      });
      if (stats.invoices !== labels.length) {
        for (const { invoiceId } of labels) {
          results.set(invoiceId, { ok: false, invoiceId, reason: 'incomplete_run' });
        }
      } else {
        for (const { invoiceId } of labels) {
          const invoice = getInvoice(db, workspaceId, invoiceId);
          const decision = invoice?.latestRecord?.decision;
          if (!invoice || !decision) {
            results.set(invoiceId, { ok: false, invoiceId, reason: 'incomplete_run' });
          } else if (!invoice.extraction?.ok
            || (invoice.jev && !invoice.jev.ok && invoice.jev.error === 'missing_recording')
            || (invoice.jev?.ok && !invoice.jev.recorded)) {
            results.set(invoiceId, { ok: false, invoiceId, reason: 'missing_recording' });
          } else if (!invoice.jev?.ok) {
            results.set(invoiceId, { ok: false, invoiceId, reason: 'runner_failed' });
          } else {
            results.set(invoiceId, {
              ok: true,
              invoiceId,
              decision,
              mode: 'replay',
              recordingsComplete: true,
            });
          }
        }
      }
    } catch {
      for (const { invoiceId } of labels) {
        results.set(invoiceId, { ok: false, invoiceId, reason: 'runner_failed' });
      }
    }
    replayResults = results;
  }

  const runner: EvaluationRunner = async (invoiceId) => {
    replayPromise ??= replayLabeledSet();
    await replayPromise;
    return replayResults?.get(invoiceId)
      ?? { ok: false, invoiceId, reason: 'incomplete_run' };
  };

  return {
    labels,
    runner,
    close() {
      db.close();
    },
  };
}
