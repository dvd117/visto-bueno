import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverRoot = fileURLToPath(new URL('../../src/server/', import.meta.url));
const clientRoot = resolve(serverRoot, '../client');
const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const importSourcePattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(path.slice(path.lastIndexOf('.'))) ? [path] : [];
  });
}

describe('server import boundaries', () => {
  it('does not import client code', () => {
    const violations: Array<{ file: string; specifier: string }> = [];

    for (const file of sourceFiles(serverRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(importSourcePattern)) {
        const specifier = match[1].replaceAll('\\', '/');
        const resolved = specifier.startsWith('.') ? resolve(dirname(file), specifier) : null;
        const importsClient = (resolved !== null
          && (resolved === clientRoot || resolved.startsWith(`${clientRoot}${sep}`)))
          || /(?:^|\/)src\/client(?:\/|$)/.test(specifier);
        if (importsClient) {
          violations.push({ file: file.slice(serverRoot.length), specifier: match[1] });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
