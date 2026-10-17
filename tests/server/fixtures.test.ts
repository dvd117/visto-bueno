import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateProductionAssets } from '../../src/server/fixtures';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('production invoice assets', () => {
  it('validates the committed fixtures and recording directories', () => {
    expect(() => validateProductionAssets()).not.toThrow();
  });

  it('fails startup validation when packaged recordings are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'visto-assets-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'fixtures/invoices'), { recursive: true });
    await writeFile(join(root, 'fixtures/invoices/labels.json'), JSON.stringify([{
      invoiceId: 'AL-030', file: 'fixtures/invoices/AL-030.txt', sourceKind: 'text',
      expected: 'review_required', reasonCheck: 'fixture',
    }]));
    await writeFile(join(root, 'fixtures/invoices/AL-030.txt'), 'Factura ficticia');

    expect(() => validateProductionAssets(root)).toThrow('Production invoice or recording assets are missing.');
  });
});
