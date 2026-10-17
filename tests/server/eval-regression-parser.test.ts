import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, parseRegressionReport } from '../../scripts/eval-labeled';

const file = 'tests/server/adversarial.test.ts';
const passing = (name = file) => ({
  success: true,
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  testResults: [{
    name,
    status: 'passed',
    assertionResults: [{ status: 'passed' }, { status: 'passed' }],
  }],
});

const probes: Array<[string, unknown]> = [
  ['duplicate suite', {
    ...passing(),
    numTotalTests: 4,
    numPassedTests: 4,
    testResults: [passing().testResults[0], passing().testResults[0]],
  }],
  ['extra failing file', {
    success: true,
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 1,
    testResults: [
      { name: file, status: 'passed', assertionResults: [{ status: 'passed' }] },
      { name: 'tests/server/other.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }] },
    ],
  }],
  ['fake suite suffix', passing('tests/server/adversarial-fake.test.ts')],
  ['other directory', passing('tests/shared/adversarial.test.ts')],
  ['negative counts', { ...passing(), numTotalTests: -1, numPassedTests: -1 }],
  ['nested failure', {
    ...passing(),
    numTotalTests: 1,
    numPassedTests: 1,
    testResults: [{
      name: file,
      status: 'passed',
      assertionResults: [{ status: 'passed', assertionResults: [{ status: 'failed' }] }],
    }],
  }],
  ['null counts', { ...passing(), numTotalTests: null, numPassedTests: null }],
  ['summary only', { numTotalTests: 3, numPassedTests: 3, numFailedTests: 0 }],
  ['null report', null],
  ['malformed report shape', '{not json'],
  ['parent traversal', passing('../tests/server/adversarial.test.ts')],
  ['string counts', { ...passing(), numTotalTests: '2', numPassedTests: '2', numFailedTests: '0' }],
  ['Windows traversal', passing('..\\tests\\server\\adversarial.test.ts')],
  ['xAdversarial suffix', passing('tests/server/xadversarial.test.ts')],
  ['zero assertions', {
    success: true,
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    testResults: [{ name: file, status: 'passed', assertionResults: [] }],
  }],
];

describe('trusted regression report parser', () => {
  it.each(probes)('rejects the %s probe', (_name, report) => {
    expect(parseRegressionReport(report)).toBeUndefined();
  });

  it('accepts only one complete, passing result for the canonical suite', () => {
    expect(parseRegressionReport(passing())).toMatchObject({ tests: 2, unsafeApprovals: 0 });
    expect(parseRegressionReport(passing(resolve(process.cwd(), file)))).toMatchObject({
      tests: 2,
      unsafeApprovals: 0,
    });
  });

  it('rejects fractional counts and any failed assertion', () => {
    expect(parseRegressionReport({ ...passing(), numTotalTests: 1.5, numPassedTests: 1.5 })).toBeUndefined();
    const failed = passing();
    failed.testResults[0].assertionResults[1] = { status: 'failed' };
    expect(parseRegressionReport({ ...failed, numFailedTests: 1, numPassedTests: 1 })).toBeUndefined();
  });

  it('removes external regression-report arguments', () => {
    expect(parseArgs(['--out', 'report.json'])).toEqual({ out: 'report.json' });
    expect(() => parseArgs(['--out', 'report.json', '--regression', 'user.json'])).toThrow(/unknown option/i);
  });
});
