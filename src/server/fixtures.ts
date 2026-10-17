import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InvoiceStatus, SourceKind } from '../shared/domain/types';
import { createInvoice, type Db } from './db/db';

export interface ExampleFixture {
  invoiceId: string;
  file: string;
  sourceKind: SourceKind;
  expected: Exclude<InvoiceStatus, 'queued' | 'approved' | 'rejected' | 'stale'>;
  reasonCheck: string;
}

const SOURCE_KINDS = new Set<SourceKind>(['pdf', 'image', 'text']);
const DECISIONS = new Set(['ready', 'approval_required', 'review_required', 'stopped']);

export function readExampleFixtures(root = process.cwd()): ExampleFixture[] {
  const labelPath = resolve(root, 'fixtures/invoices/labels.json');
  const raw: unknown = JSON.parse(readFileSync(labelPath, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Invoice fixture labels are unavailable.');

  const fixtures = raw.map((item): ExampleFixture => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid invoice fixture label.');
    const value = item as Record<string, unknown>;
    if (typeof value.invoiceId !== 'string' || !/^AL-\d{3}$/.test(value.invoiceId)
      || typeof value.file !== 'string' || value.file !== `fixtures/invoices/${value.invoiceId}.${value.file.split('.').at(-1)}`
      || typeof value.sourceKind !== 'string' || !SOURCE_KINDS.has(value.sourceKind as SourceKind)
      || typeof value.expected !== 'string' || !DECISIONS.has(value.expected)
      || typeof value.reasonCheck !== 'string' || !value.reasonCheck) {
      throw new Error('Invalid invoice fixture label.');
    }
    return {
      invoiceId: value.invoiceId,
      file: value.file,
      sourceKind: value.sourceKind as SourceKind,
      expected: value.expected as ExampleFixture['expected'],
      reasonCheck: value.reasonCheck,
    };
  });

  const ids = new Set(fixtures.map(({ invoiceId }) => invoiceId));
  if (ids.size !== fixtures.length) throw new Error('Duplicate invoice fixture label.');
  return fixtures.sort((left, right) => left.invoiceId.localeCompare(right.invoiceId));
}

export function validateProductionAssets(root = process.cwd()): void {
  const fixtures = readExampleFixtures(root);
  const required = [
    ...fixtures.map(({ file }) => file),
    'recordings',
    'src/server/extract/recordings',
  ];
  if (required.some((path) => !existsSync(resolve(root, path)))) {
    throw new Error('Production invoice or recording assets are missing.');
  }
}

export function ensureExampleInvoices(db: Db, workspaceId: string, root = process.cwd()): ExampleFixture[] {
  const fixtures = readExampleFixtures(root);
  const find = db.prepare('SELECT 1 FROM invoices WHERE workspace_id = ? AND id = ?');
  db.transaction(() => {
    for (const fixture of fixtures) {
      if (find.get(workspaceId, fixture.invoiceId)) continue;
      createInvoice(db, workspaceId, {
        id: fixture.invoiceId,
        sourceKind: fixture.sourceKind,
        ...(fixture.sourceKind === 'text' ? { sourceText: readFileSync(resolve(root, fixture.file), 'utf8') } : {}),
        filePath: fixture.file,
      });
    }
  }).immediate();
  return fixtures;
}
