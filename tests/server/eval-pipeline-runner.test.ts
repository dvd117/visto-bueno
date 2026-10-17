import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEvaluation } from '../../src/server/eval/run';
import { createReplayPipelineRunner, loadLabeledInvoices } from '../../src/server/eval/pipeline-runner';

const runners: Array<ReturnType<typeof createReplayPipelineRunner>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
  vi.unstubAllEnvs();
});

describe('replay pipeline runner', () => {
  it('loads all genuine labels in lexical invoice order', () => {
    const labels = loadLabeledInvoices();

    expect(labels).toHaveLength(20);
    expect(labels.map(({ invoiceId }) => invoiceId)).toEqual(
      [...labels.map(({ invoiceId }) => invoiceId)].sort(),
    );
  });

  it('runs the real pipeline sequentially in replay with no provider keys', async () => {
    vi.stubEnv('EXTRACT_MODE', 'replay');
    vi.stubEnv('JEV_MODE', 'replay');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const session = createReplayPipelineRunner();
    runners.push(session);
    const called: string[] = [];

    const result = await runEvaluation({
      labels: [...session.labels].reverse(),
      runner: async (invoiceId) => {
        called.push(invoiceId);
        return session.runner(invoiceId);
      },
    });

    expect(called).toEqual([...called].sort());
    expect(called).toHaveLength(20);
    expect(result.labeled).toMatchObject({ status: 'available', mode: 'replay', total: 20 });
    const approvalLabel = await session.runner('AL-035');
    expect(approvalLabel).toMatchObject({ ok: true, mode: 'replay', recordingsComplete: true });
    if (approvalLabel.ok) expect(approvalLabel.decision.status).not.toBe('ready');
  });

  it('returns missing_recording instead of a failure-derived decision when extraction evidence is absent', async () => {
    const recordingDirectory = await mkdtemp(join(process.cwd(), '.w', 't', 'eval-missing-'));
    vi.stubEnv('EXTRACT_MODE', 'replay');
    vi.stubEnv('JEV_MODE', 'replay');
    vi.stubEnv('EXTRACT_RECORDINGS_DIR', recordingDirectory);
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const session = createReplayPipelineRunner();
    runners.push(session);

    try {
      await expect(session.runner('AL-030')).resolves.toEqual({
        ok: false,
        invoiceId: 'AL-030',
        reason: 'missing_recording',
      });
    } finally {
      await rm(recordingDirectory, { recursive: true, force: true });
    }
  });

  it('refuses provider modes before starting an evaluation', () => {
    vi.stubEnv('EXTRACT_MODE', 'record');

    expect(() => createReplayPipelineRunner()).toThrow(/replay-only/i);

    vi.stubEnv('EXTRACT_MODE', 'replay');
    vi.stubEnv('JEV_MODE', 'live');
    expect(() => createReplayPipelineRunner()).toThrow(/replay-only/i);
  });
});
