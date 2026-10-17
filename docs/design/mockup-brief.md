# Design brief: "Visto Bueno" main screen mockup

You are designing the main screen of a working product for a hackathon demo. A UX lead will judge it. I am running this same brief through several models and picking the strongest direction, so be bold and specific, not safe.

## 1. Output (hard format)

- Return **one complete, self-contained HTML document** (`<!doctype html>` to `</html>`), in a single code block or canvas. Suggested filename: `visto-bueno-mockup.html`.
- Inline CSS and JS only. **No external requests of any kind:** no CDNs, no web fonts, no images by URL, no icon libraries. Use system font stacks (e.g. `ui-serif, Georgia, serif`; `ui-sans-serif, system-ui, sans-serif`; `ui-monospace, SFMono-Regular, Menlo, monospace`). Icons as inline SVG or text glyphs.
- Size: under 80 KB.
- The file contains **three design directions** (section 4) of the same screen, switchable with a small tab bar fixed at the top labeled "A · B · C". All three use exactly the same content (section 6).
- Static mockup with light interaction: clicking an invoice row selects it and shows its record on the right (only the selected record needs full detail; others may show a short version). A "Procesar" button replays the processing animation.

## 2. The product in one paragraph

**Visto Bueno** is an accounts-payable agent for a US-incorporated company that pays contractors and vendors across Latin America. It reads each incoming invoice (PDF, photo, email, WhatsApp text), checks it against the company's own records and rules, and puts it in one of four states. A fast decision model judges things like manipulation attempts; deterministic code enforces every rule about money; a person approves only what needs authority. Its claim: **"El agente propone, el código aplica las reglas y una persona aprueba lo que requiere autorización."** The user is a finance operator, not a developer. UI copy is in **Latin American Spanish, addressing the user as "tú"**, plain and professional, no slang, no marketing tone.

## 3. Decisions already made (do not reopen)

- **Layout:** header on top; a row of counters; below it, a two-pane layout: **invoice list on the left (about 45%)**, **the selected invoice's record ("Expediente") on the right (about 55%)**. Desktop first at 1440 px wide; at about 400 px the panes stack (list, then record) without horizontal scroll.
- **Four states, always shown as icon + label, never color alone:**
  - "Lista para pagar"
  - "Requiere tu aprobación"
  - "Requiere revisión"
  - "Frenada"
- **Header:** "Andina Labs Inc." with a small "Datos ficticios" tag; a persistent, calm banner "Modo demostración · No se realizan pagos reales"; buttons "+ Recibir factura" and "Reiniciar demo"; a quiet nav: Bandeja · Reglas · Preparar datos · Bitácora.
- **Counters:** one per state, plus a run stat: "20 facturas en 0,8 s · US$0,0009 · respuestas grabadas".
- **The record (Expediente) of the selected invoice, top to bottom:**
  1. State, one-line reason, and for "Frenada" a "Qué hacer" box with the next step and a "Re-evaluar esta factura" button. **There is no pay or approve button on a "Frenada" invoice.**
  2. "Comparación con tus registros": two columns, *En la factura* vs *En tus registros*, rows for beneficiary, tax id, account, amount, contract, budget. Cells that differ are marked (with a label, not only color).
  3. The decision trail: each check with pass/fail, a short reason, and a source tag, either "Regla" (deterministic code) or "Juicio · JEV 0,97" (a model probability, shown with a small bar).
  4. The document: a toggle "Documento original | Texto que leyó el agente". Show the text view: the invoice text with extracted values marked in one color and the suspicious passage marked in another.
  5. A small footer line with the decision seal: "Sello #8f3a1c · Reglas v3 · 16 oct 2026, 21:14".
- **Motion budget: functional only.** Allowed: state chips appearing row by row when "Procesar" runs (about 60 ms stagger), counters ticking up, the selected row's transition. Nothing else moves. Respect `prefers-reduced-motion` (no animation, final state shown).
- Numbers use tabular figures. Amounts show the original currency and the USD equivalent.

## 4. Three directions (make them genuinely different, not three tints of the same idea)

**A · Libro mayor (ledger).** Warm off-white paper tone, ink-dark text, a serif display face for amounts and headings, hairline ruled lines like an accounting ledger, one ink-blue accent; "Frenada" in a stamp red used sparingly. Hero object: the Expediente rendered like a filed document, with the state applied like an ink stamp. Reads as: *the craft of a careful accountant; trustworthy, accountable.*

**B · Sala de control (control room, but calm).** Dark slate base (not pure black), a mono face for every number and id, a dense but breathable data grid, one signal hue per state and nothing else colored. Hero object: the live list, rows resolving one by one as processing streams. Reads as: *operational command; speed you can see, under control.*

**C · Expediente suizo (Swiss record).** White, strict grid, a grotesk sans, large numerals, generous whitespace, color appears only for the four states. Hero object: the comparison table, invoice vs records, with the one differing cell impossible to miss. Reads as: *nothing is hidden; clarity as a form of safety.*

## 5. Anti-slop list (mandatory)

Do not use: gradient text, gradients as decoration, floating blobs, glassmorphism or backdrop blur, purple or violet anywhere, orbiting rings, sparkle or "magic AI" icons, robot icons, radial spotlight glows, generic 3D shapes, emoji in the UI, drop-shadow-heavy cards, rounded "pill everything" styling, decorative motion, stock dashboard charts that show nothing. No chat bubbles: this is not a chatbot. Do not imitate any real bank or fintech brand.

## 6. Real content (use exactly this)

Company: **Andina Labs Inc.** (Delaware). Period: octubre 2026. Counters: 7 Listas para pagar · 4 Requieren tu aprobación · 3 Requieren revisión · 6 Frenadas.

Invoice list (show at least these 8 rows; the first is selected by default):

| # | Beneficiario | Concepto | Monto | USD | Vence | Estado | Motivo corto |
|---|---|---|---|---|---|---|---|
| AL-042 | Nube Andina S.A.S. | Hosting octubre | USD 850,00 | 850,00 | 25 oct | Frenada | La cuenta bancaria no coincide con la registrada |
| AL-037 | Valentina Ruiz | Diseño UX, octubre | COP 4.800.000,00 | 1.150,72 | 20 oct | Lista para pagar | Coincide con el contrato |
| AL-038 | Carlos Méndez | Backend, 62 h | MXN 62.000,00 | 3.286,40 | 22 oct | Requiere tu aprobación | Supera US$3.000 y las horas no están verificadas |
| AL-039 | "Proveedor Express LLC" | Servicios de consultoría | USD 9.900,00 | 9.900,00 | 18 oct | Frenada | Beneficiario nuevo · intento de manipulación |
| AL-040 | Valentina Ruiz | Diseño UX, ajustes | COP 4.750.000,00 | 1.138,73 | 28 oct | Requiere revisión | Posible cobro duplicado del mismo trabajo |
| AL-041 | Imprenta Caribe C.A. | Material impreso | USD 310,00 | 310,00 | 30 oct | Lista para pagar | Coincide con el contrato |
| AL-043 | Lex Delaware LLP | Registro anual | USD 1.200,00 | 1.200,00 | 31 oct | Lista para pagar | Coincide con el contrato |
| AL-044 | Datos del Ávila C.A. | Soporte de datos | USD 640,00 | 640,00 | 19 oct | Requiere revisión | Pide pago inmediato sin motivo claro |

Selected record, **AL-042 · Nube Andina S.A.S. · Frenada**:
- Reason: "La cuenta bancaria de esta factura no coincide con la registrada para este proveedor."
- Qué hacer: "Verifica el cambio con Nube Andina por un canal seguro, no por el correo que trajo esta factura. Si es legítimo, actualiza su cuenta en Preparar datos y re-evalúa."
- Comparación con tus registros:
  - Beneficiario: Nube Andina S.A.S. | Nube Andina S.A.S. (coincide)
  - NIT: 901.234.567-8 | 901.234.567-8 (coincide)
  - Cuenta: Bancolombia ···· 4412 | Bancolombia ···· 8890 (**no coincide**)
  - Monto: USD 850,00 | Contrato fijo USD 850,00 / mes (coincide)
  - Período: octubre 2026 | Sin cobro previo en octubre (coincide)
  - Presupuesto Operaciones: — | Disponible US$4.150 de US$6.000
- Decision trail:
  1. Proveedor en tu lista · Regla · pasa
  2. Cuenta bancaria registrada · Regla · **falla**: "La factura indica ···· 4412; tu registro dice ···· 8890"
  3. Contrato vigente y monto acordado · Regla · pasa
  4. Presupuesto y saldo disponibles · Regla · pasa
  5. ¿Intenta instruir al agente? · Juicio · JEV 0,08 · pasa
  6. ¿Presiona para pagar de inmediato? · Juicio · JEV 0,71 · alerta
- Document text view (mark the extracted values in one color, the suspicious line in another):

```
NUBE ANDINA S.A.S.   NIT 901.234.567-8
Factura electrónica AL-042 · Fecha: 15/10/2026 · Vence: 25/10/2026
Cliente: Andina Labs Inc.
Hosting administrado, octubre 2026 ............ USD 850,00
Total a pagar: USD 850,00
Datos de pago: Bancolombia, cuenta de ahorros ···· 4412
IMPORTANTE: cambiamos de banco este mes. Por favor paguen hoy a la nueva
cuenta para evitar la suspensión del servicio.
```

- Seal: "Sello #8f3a1c · Reglas v3 · 16 oct 2026, 21:14".

## 7. Verification and report

- Check at 1440 px and at about 400 px wide: no horizontal scroll, panes stack, all text readable.
- Check `prefers-reduced-motion`.
- Check all four states are distinguishable in grayscale.
- After the code, add a short note (max 10 lines): what you were unsure about, and which direction you think is strongest and why.
