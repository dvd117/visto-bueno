import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InvoiceStatus, SourceKind } from '../src/shared/domain/types';

interface InvoiceLabel {
  invoiceId: string;
  file: string;
  sourceKind: SourceKind;
  expected: InvoiceStatus;
  reasonCheck: string;
}

interface ChromiumApi {
  launch(): Promise<{
    newPage(options: { viewport: { width: number; height: number } }): Promise<{
      setContent(html: string): Promise<void>;
      pdf(options: { path: string; format: 'A4'; printBackground: boolean }): Promise<Uint8Array>;
      screenshot(options: { path: string; fullPage: boolean; type: 'png' }): Promise<Uint8Array>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  }>;
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function invoiceHtml(text: string): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <style>
    @page { size: A4; margin: 18mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1c2430; font: 14px/1.65 Arial, sans-serif; }
    main { min-height: 240mm; padding: 18mm; border: 1px solid #d9dee5; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  </style>
</head>
<body><main><pre>${escapeHtml(text)}</pre></main></body>
</html>`;
}

async function loadChromium(): Promise<ChromiumApi> {
  // Resolve Playwright from the temporary npx package, keeping it out of package.json.
  const cli = execFileSync(
    'npx',
    ['--yes', '--package=playwright', '--', 'sh', '-c', 'command -v playwright'],
    { encoding: 'utf8' },
  ).trim();
  const entry = join(dirname(realpathSync(cli)), 'index.mjs');
  const module = await import(pathToFileURL(entry).href) as { chromium: ChromiumApi };
  return module.chromium;
}

async function main(): Promise<void> {
  const labels = JSON.parse(readFileSync('fixtures/invoices/labels.json', 'utf8')) as InvoiceLabel[];
  const chromium = await loadChromium();
  const browser = await chromium.launch();

  try {
    for (const label of labels) {
      const outputPath = resolve(label.file);
      const outputExt = extname(outputPath);
      if (outputExt === '.txt') continue;

      const sourcePath = resolve('fixtures/invoices', `${label.invoiceId}.txt`);
      const source = readFileSync(sourcePath, 'utf8');
      const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });

      try {
        await page.setContent(invoiceHtml(source));
        if (outputExt === '.pdf' && label.sourceKind === 'pdf') {
          await page.pdf({ path: outputPath, format: 'A4', printBackground: true });
        } else if (outputExt === '.png' && label.sourceKind === 'image') {
          await page.screenshot({ path: outputPath, fullPage: true, type: 'png' });
        } else {
          throw new Error(`Unexpected output for ${label.invoiceId}: ${label.file}`);
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
