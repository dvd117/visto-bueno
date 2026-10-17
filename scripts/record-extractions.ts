import { readFile } from 'node:fs/promises';
import type { SourceKind } from '../src/shared/domain/types';
import { extract } from '../src/server/extract/index';

interface LabeledInvoice {
  invoiceId: string;
  file: string;
  sourceKind: SourceKind;
}

interface FailedInvoice {
  invoiceId: string;
  error: string;
}

const labels = JSON.parse(await readFile('fixtures/invoices/labels.json', 'utf8')) as LabeledInvoice[];
const failures: FailedInvoice[] = [];
const pause = (durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs));

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is required to record extractions.');
  process.exitCode = 1;
} else if (process.env.EXTRACT_MODE !== 'record') {
  console.error('EXTRACT_MODE=record is required.');
  process.exitCode = 1;
} else {
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index]!;
    let input: { kind: SourceKind; bytes?: Buffer; text?: string };

    try {
      input = label.sourceKind === 'text'
        ? { kind: label.sourceKind, text: await readFile(label.file, 'utf8') }
        : { kind: label.sourceKind, bytes: await readFile(label.file) };
    } catch {
      const error = 'file_read';
      failures.push({ invoiceId: label.invoiceId, error });
      console.log(`${label.invoiceId} error=${error} amounts=0 accounts=0`);
      if (index + 1 < labels.length) await pause(4000);
      continue;
    }

    const configuredMode = process.env.EXTRACT_MODE;
    process.env.EXTRACT_MODE = 'replay';
    let existing;
    try {
      existing = await extract(input);
    } finally {
      process.env.EXTRACT_MODE = configuredMode;
    }

    if (existing.ok) {
      console.log(
        `${label.invoiceId} ok(existing) amounts=${existing.claims.amountsFound.length} accounts=${existing.claims.accountsFound.length}`,
      );
    } else {
      let result = await extract(input);
      let attempts = 1;
      while (!result.ok && (result.error === 'timeout' || result.error === 'rate_limited') && attempts < 3) {
        await pause(20_000);
        result = await extract(input);
        attempts += 1;
      }

      const amountsFound = result.ok ? result.claims.amountsFound.length : 0;
      const accountsFound = result.ok ? result.claims.accountsFound.length : 0;
      const status = result.ok ? 'ok' : `error=${result.error}`;
      console.log(`${label.invoiceId} ${status} attempts=${attempts} amounts=${amountsFound} accounts=${accountsFound}`);

      if (!result.ok) failures.push({ invoiceId: label.invoiceId, error: result.error });
    }

    if (index + 1 < labels.length) await pause(4000);
  }
}

console.log('Failed invoices:');
if (failures.length === 0) {
  console.log('none');
} else {
  for (const failure of failures) console.log(`${failure.invoiceId} error=${failure.error}`);
  process.exitCode = 1;
}
