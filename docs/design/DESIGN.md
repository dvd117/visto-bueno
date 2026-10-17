# DESIGN.md: Visto Bueno

**Direction: C · Expediente suizo** ("nothing is hidden; clarity as a form of safety"), from `mockup.html` (direction C; open it and press "C"). Chosen 2026-10-16 by the architect; both reviewing models also picked C. The mockup is the visual reference for every screen. Where this file and the mockup differ, this file wins.

## Principles

1. **Evidence over decoration.** Rules, type weight and whitespace carry hierarchy. No shadows, no rounded corners, no gradients, no fills except state color and the wash.
2. **Color means state, nothing else.** The four state colors are the only hues in the UI. Everything else is ink on white.
3. **The difference is impossible to miss.** A differing value gets the stopped color, heavier weight, 3 px stopped rules above and below its row, and a "No coincide" label.
4. **Never color alone.** Every state shows glyph + label. Every difference shows a text label.
5. **Calm density.** Big numerals for counts; small, quiet metadata; generous row padding.

## Tokens

```css
:root {
  --page: #ffffff; --sheet: #ffffff; --raised: #ffffff; --wash: #f5f5f5;
  --ink: #191919; --soft: #555555; --faint: #6d6d6d;
  --line: #d9d9d9; --line-bold: #1a1a1a; --focus: #191919;
  --ready: #18734f; --approval: #986411; --review: #245e88; --stopped: #b12621;
  --extract-bg: #ededed; --extract-border: #171717;
  --suspect-bg: #f8e5e3; --suspect-text: #ad2c25;
}
```

Light theme only (finance tool, demo on a laptop). Radius: 0 everywhere.

Tailwind theme (`tailwind.config` `theme.extend`):

```js
colors: {
  page: '#ffffff', wash: '#f5f5f5', ink: '#191919', soft: '#555555', faint: '#6d6d6d',
  line: '#d9d9d9', 'line-bold': '#1a1a1a',
  ready: '#18734f', approval: '#986411', review: '#245e88', stopped: '#b12621',
  'suspect-bg': '#f8e5e3', 'suspect-text': '#ad2c25', 'extract-bg': '#ededed',
},
borderRadius: { none: '0', DEFAULT: '0' },
fontFamily: {
  sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
  mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
},
```

## Type

System sans for everything; mono only for the document text view and ids where alignment matters. `font-variant-numeric: tabular-nums` globally.

| Role | Size / weight / tracking |
|---|---|
| Display (record vendor, section titles) | 30–33 px / 790–800 / -0.05 to -0.06em |
| Company name | **28 px** / 770 / -0.055em (smaller than the mockup's 40 px: see fixes) |
| Metric count | 52 px / 760 / -0.06em, line-height 1 |
| Section heading (h3) | 21 px / 750 / -0.04em |
| Eyebrow | 10 px / 770 / uppercase / 0.12–0.17em (e.g. "01 / ENTRADA Y CLASIFICACIÓN") |
| Body | 13 px / 400–600, line-height 1.45 |
| Metadata, reasons | 10–11 px / soft or faint color |
| Document text | 11 px mono, line-height 1.85 |

## Structure

- **Rules:** panels have no box; a 3 px `line-bold` rule on top. Rows separated by 1 px `line`. Counters band: 3 px top rule, 1 px bottom rule.
- **Grid:** max width 1510 px; workspace 45 / 55 columns, 28 px gap. Below 760 px: one column, list then record. Below 480 px: comparison collapses to two columns with the field name as a row label (as in the mockup).
- **Selected row:** wash background + 4 px inset ink bar on the left.

## Components (match the mockup)

- **State chip:** 17 px square bordered glyph + label in state color. Glyphs: Lista para pagar `✓`, Requiere tu aprobación `▣`, Requiere revisión `?`, Frenada `×`. Large variant in the record: 4 px top rule + 1 px bottom rule in state color, uppercase label.
- **Counters:** glyph + label row, big numeral below; fifth cell is the run stat ("Última ejecución / grabada", "0,8 s", "20 facturas en 0,8 s · US$0,0009 · respuestas grabadas"; "en vivo" when live).
- **Invoice row:** ordinal · id (eyebrow style) · vendor (14 px / 780) · concept · reason (faint) | amount (original) + `US$` equivalent | chip + "Vence 25 oct". The whole row is a `<button>` with `aria-pressed`.
- **Qué hacer box:** 4 px stopped left rule, 1 px top/bottom lines, uppercase label "QUÉ HACER", copy, outlined button "Re-evaluar esta factura".
- **Comparison table:** columns Dato · En la factura · En tus registros; header "1 diferencia · 6 campos"; differing row per principle 3.
- **Decision trail:** bordered list; per row: 19 px bordered glyph (✓ pass in ready, × fail in stopped, ! alert in approval color), check name, explanation, source right-aligned: "Regla" or "Juicio · JEV 0,71" with an 89 × 4 px bar.
- **Document:** segmented toggle "Documento original | Texto que leyó el agente" (selected = ink fill); text view uses `.extracted` (extract-bg + 1.5 px ink underline) and `.suspect` (suspect-bg, suspect-text, 3 px stopped left rule). The original view shows the real PDF/image (embed), not a reconstruction.
- **Seal:** 1 px bold top rule, 10 px soft text: "Sello #8f3a1c · Reglas v3 · 16 oct 2026, 21:14".
- **Buttons:** primary = ink fill, white text; secondary = 1 px ink outline. No radius. Focus: 3 px ink outline, 3 px offset.
- **Toast:** bottom-center, ink background, for confirmations ("Demo reiniciada", "Límite del demo alcanzado, intenta en un minuto").

## Patterns the mockup does not show (build in the same language)

- **Approval form** (`Requiere tu aprobación`): inside the record, after the trail: "Tu nombre (identidad declarada, demo)" and "Motivo" inputs (1 px line border, no radius), buttons "Aprobar" (primary) and "Rechazar" (secondary). Disabled until both filled.
- **Flag resolution** (`Requiere revisión`): one block per flag with the flag reason, a choice (radio list, e.g. "No es duplicado" / "Sí es duplicado") and "Motivo"; resolved flags collapse to a single line with ✓ and who resolved it.
- **Stale:** chip-like label "Desactualizada" in soft color with `↻`, and a banner in the record: "Cambiaron las reglas o los datos. Re-evalúa antes de decidir."
- **Reglas:** same panel language; locked rules show a text label "Fijo por seguridad" in soft caps (no icon font, no emoji); impact bar as a counters band in miniature with deltas ("+1", "−2") in state colors.
- **Tables in Preparar datos:** comparison-table styling; inline-edit cells get a 1 px ink outline on focus.
- **Empty states:** eyebrow + one sentence + one primary button (e.g. "Aún no hay facturas · Cargar facturas de ejemplo").

## Fixes to the mockup (apply these)

1. **Compact the masthead.** At 1440 × 900 the first invoice rows and the record headline must be visible without scrolling. One header line: wordmark `visto.bueno` · "Andina Labs Inc." (28 px) · "Datos ficticios" tag · nav · actions. The demo banner becomes a thin 32 px strip above the header.
2. **"Procesar" stays on the list panel** (mockup position), and also appears in the empty state.
3. **Remove the "Tres direcciones" switch bar** and any direction A/B styles.
4. **Real document view:** no "representación construida" caption; embed the actual file.
5. **No emoji anywhere** (the Gemini mockup used them; do not import).

## Motion

Functional only: chips reveal row by row while processing (150 ms ease-out, 60 ms stagger), counters tick to their final value over the run, selected-row inset bar transitions 130 ms. Everything off under `prefers-reduced-motion` (final state shown).

## Voice

Latin American Spanish, "tú", plain and professional. Short sentences. Name the action ("Verifica el cambio con Nube Andina por un canal seguro…"). Never "IA mágica", never exclamation marks.
