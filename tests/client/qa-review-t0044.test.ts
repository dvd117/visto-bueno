import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('t-0044 Datos overflow cue', () => {
  it('uses no box-shadow in the overflowing table cue rule', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/client/features/datos/datos.css'), 'utf8');
    const selector = ".datos-table-scroll[data-overflowing='true']::after";
    const ruleStart = css.indexOf(`${selector} {`);
    const ruleEnd = ruleStart < 0 ? -1 : css.indexOf('}', ruleStart);
    const rule = ruleStart < 0 || ruleEnd < 0 ? '' : css.slice(ruleStart, ruleEnd);

    expect(rule).not.toBe('');
    expect(rule).toMatch(/border-right\s*:\s*2px solid #191919/iu);
    expect(rule).not.toMatch(/box-shadow\s*:/iu);
  });
});
