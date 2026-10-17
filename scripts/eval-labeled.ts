import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RegressionEvidence, EvaluationResult } from '../src/server/eval/run';
import { assertEvaluationSafe, runEvaluation } from '../src/server/eval/run';
import { assertReplayOnly, createReplayPipelineRunner } from '../src/server/eval/pipeline-runner';

interface CliOptions {
  out: string;
}

const ADVERSARIAL_SUITE = 'tests/server/adversarial.test.ts';
const REGRESSION_SOURCE = `Local Vitest run: ${ADVERSARIAL_SUITE}`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function containsNestedAssertionOrFailure(value: unknown, topLevel = false): boolean {
  if (Array.isArray(value)) return value.some((item) => containsNestedAssertionOrFailure(item));
  if (!isObject(value)) return false;
  if (!topLevel && ['passed', 'failed', 'skipped', 'pending', 'todo'].includes(String(value.status))) return true;
  if (value.status === 'failed' || 'assertionResults' in value) return true;
  return Object.values(value).some((child) => containsNestedAssertionOrFailure(child));
}

export function parseArgs(args: readonly string[]): CliOptions {
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== '--out') throw new Error(`Unknown option: ${option}`);
    if (out !== undefined) throw new Error('Option --out may only be supplied once.');
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --out.');
    out = value;
    index += 1;
  }
  if (!out) throw new Error('Usage: eval-labeled.ts --out <json-path>');
  return { out };
}

export function parseRegressionReport(report: unknown, root = process.cwd()): RegressionEvidence | undefined {
  if (!isObject(report) || report.success !== true || !Array.isArray(report.testResults)
    || report.testResults.length !== 1) return undefined;

  const total = report.numTotalTests;
  const passed = report.numPassedTests;
  const failed = report.numFailedTests;
  if (!isNonNegativeSafeInteger(total) || !isNonNegativeSafeInteger(passed)
    || !isNonNegativeSafeInteger(failed) || total === 0 || passed === 0 || failed !== 0) return undefined;

  for (const countKey of ['numPendingTests', 'numTodoTests', 'numSkippedTests']) {
    if (countKey in report && (!isNonNegativeSafeInteger(report[countKey]) || report[countKey] !== 0)) return undefined;
  }

  const fileResult = report.testResults[0];
  const canonicalPath = resolve(root, ADVERSARIAL_SUITE);
  if (!isObject(fileResult)
    || (fileResult.name !== ADVERSARIAL_SUITE && fileResult.name !== canonicalPath)
    || fileResult.status !== 'passed'
    || !Array.isArray(fileResult.assertionResults)
    || fileResult.assertionResults.length === 0) return undefined;

  for (const assertion of fileResult.assertionResults) {
    if (!isObject(assertion) || assertion.status !== 'passed'
      || containsNestedAssertionOrFailure(assertion, true)) return undefined;
  }

  const assertionCount = fileResult.assertionResults.length;
  if (total !== assertionCount || passed !== assertionCount || failed !== 0) return undefined;

  return {
    tests: passed,
    unsafeApprovals: 0,
    source: REGRESSION_SOURCE,
  };
}

async function runAdversarialSuite(reportPath: string, root: string): Promise<boolean> {
  return new Promise((resolveExit) => {
    const vitest = resolve(root, 'node_modules/.bin/vitest');
    const child = spawn(vitest, [
      'run',
      ADVERSARIAL_SUITE,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ], { cwd: root, env: process.env, stdio: 'ignore' });
    child.once('error', () => resolveExit(false));
    child.once('close', (code) => resolveExit(code === 0));
  });
}

async function loadRegressionEvidence(root: string): Promise<RegressionEvidence | undefined> {
  let temporaryDirectory: string | undefined;
  try {
    temporaryDirectory = await mkdtemp(join(resolve(process.env.TMPDIR || tmpdir()), 'visto-bueno-eval-'));
    const reportPath = join(temporaryDirectory, 'vitest.json');
    const reportFile = await open(reportPath, 'wx');
    await reportFile.close();
    const successfulExit = await runAdversarialSuite(reportPath, root);
    const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
    const evidence = parseRegressionReport(report, root);
    return successfulExit ? evidence : undefined;
  } catch {
    return undefined;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function labeledStatus(result: EvaluationResult): string {
  const labeled = result.labeled;
  if (labeled.status === 'unavailable') {
    return `Replay: unavailable (${labeled.reason}${labeled.invoiceId ? `, ${labeled.invoiceId}` : ''}).`;
  }
  const mismatches = labeled.total - labeled.correct;
  return `Replay: ${labeled.correct}/${labeled.total} correct; ${mismatches} mismatch(es); ` +
    `${labeled.unsafeApprovals} unsafe ready decision(s).`;
}

function hasMismatchOrUnsafe(result: EvaluationResult): boolean {
  if (result.status === 'blocked') return true;
  return result.labeled.correct !== result.labeled.total || result.labeled.unsafeApprovals > 0
    || result.regression.unsafeApprovals > 0;
}

export async function runCli(args: readonly string[]): Promise<number> {
  const options = parseArgs(args);
  assertReplayOnly();
  const root = process.cwd();
  const regression = await loadRegressionEvidence(root);
  const session = createReplayPipelineRunner();
  try {
    const result = await runEvaluation({
      labels: session.labels,
      runner: session.runner,
      ...(regression ? { regression } : {}),
    });
    let safetyError: string | undefined;
    try {
      assertEvaluationSafe(result);
    } catch (error) {
      safetyError = error instanceof Error ? error.message : 'Evaluation safety assertion failed.';
    }

    const outPath = resolve(options.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    console.log(labeledStatus(result));
    console.log(`Regression: ${result.regression.status === 'available'
      ? `${result.regression.tests} tests; ${result.regression.unsafeApprovals} unsafe finding(s).`
      : 'unavailable (the local trusted adversarial run did not produce valid evidence).'}`);
    if (safetyError) console.log(`Safety: ${safetyError}`);
    const blocked = result.status === 'blocked';
    const mismatch = hasMismatchOrUnsafe(result);
    console.log(`Overall: ${blocked ? 'BLOCKED' : mismatch ? 'FAIL' : 'PASS'}. JSON: ${outPath}`);
    return blocked || mismatch ? 1 : 0;
  } finally {
    session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Evaluation could not start.';
    console.error(message);
    process.exitCode = 1;
  });
}
