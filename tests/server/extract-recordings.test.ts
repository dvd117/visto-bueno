import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseAmount } from '../../src/shared/domain/money';
import type { Currency, SourceKind } from '../../src/shared/domain/types';
import { normalizeAccount } from '../../src/shared/engine/normalize';
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

  it('validates complete account identity and keeps unit rates out of total candidates', async () => {
    const failures: string[] = [];

    for (const label of labels) {
      const result = label.sourceKind === 'text'
        ? await extract({ kind: label.sourceKind, text: await readFile(label.file, 'utf8') })
        : await extract({ kind: label.sourceKind, bytes: await readFile(label.file) });

      if (!result.ok) {
        failures.push(`${label.invoiceId}: error=${result.error}`);
        continue;
      }

      const { accountsFound, payoutAccount } = result.claims;
      if (accountsFound.length === 0 || accountsFound.some((account) => !normalizeAccount(account))) {
        failures.push(`${label.invoiceId}: account candidates omit bank identity`);
      }
      if (payoutAccount && (!normalizeAccount(payoutAccount)
        || !accountsFound.some((account) => normalizeAccount(account) === normalizeAccount(payoutAccount)))) {
        failures.push(`${label.invoiceId}: selected account is incomplete or not a source candidate`);
      }

      if (result.claims.rateRaw && result.claims.amountRaw
        && ['USD', 'COP', 'MXN'].includes(result.claims.currency ?? '')) {
        const currency = result.claims.currency as Currency;
        const rate = parseAmount(result.claims.rateRaw, { currency });
        const total = parseAmount(result.claims.amountRaw, { currency });
        const rateWasListedAsDistinctTotal = rate.ok && total.ok && rate.money.minor !== total.money.minor
          && result.claims.amountsFound.some((candidate) => {
            const parsed = parseAmount(candidate, { currency });
            return parsed.ok && parsed.money.minor === rate.money.minor;
          });
        if (rateWasListedAsDistinctTotal) failures.push(`${label.invoiceId}: per-unit rate listed as a total candidate`);
      }
    }

    expect(failures).toEqual([]);
  });
});
