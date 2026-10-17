import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SourceKind } from '../../src/shared/domain/types';
import { extract } from '../../src/server/extract/index';

interface LabeledInvoice {
  invoiceId: string;
  file: string;
  sourceKind: SourceKind;
}

const labels = JSON.parse(await readFile('fixtures/invoices/labels.json', 'utf8')) as LabeledInvoice[];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('recorded labeled-set extractions', () => {
  beforeAll(() => {
    vi.stubEnv('EXTRACT_MODE', 'replay');
    vi.stubEnv('GEMINI_API_KEY', '');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('replays every fixture and keeps chosen amounts in text/PDF source', async () => {
    const failures: string[] = [];

    for (const label of labels) {
      const result = label.sourceKind === 'text'
        ? await extract({ kind: label.sourceKind, text: await readFile(label.file, 'utf8') })
        : await extract({ kind: label.sourceKind, bytes: await readFile(label.file) });

      if (!result.ok) {
        failures.push(`${label.invoiceId}: error=${result.error}`);
        continue;
      }

      if (label.sourceKind === 'text' || label.sourceKind === 'pdf') {
        const amountRaw = result.claims.amountRaw;
        if (!amountRaw || !normalizeWhitespace(result.sourceText).includes(normalizeWhitespace(amountRaw))) {
          failures.push(`${label.invoiceId}: amountRaw=${JSON.stringify(amountRaw)}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
