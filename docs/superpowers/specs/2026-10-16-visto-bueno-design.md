---
title: "Visto Bueno: accounts-payable agent for the Blinka challenge (30X hackathon) - design"
date: 2026-10-16
version: 2 (after builder check and three external reviews)
status: pending David's approval
owner: David Aragort
architect: Claude Opus 5.5 (hq session)
---

# Visto Bueno: design

Working name: **Visto Bueno** ("sign-off" in Spanish). An agent that reads a company's incoming invoices, checks each one against the company's own records and rules, and decides what happens to it. Every decision carries a plain-language record of why.

Built for the **Blinka challenge** ("Agentes que pagan por la empresa") at the 30X weekend hackathon, using **JEV** (TypeSafe's decision model) as the fast judgment layer.

**Thesis (use it in the pitch):** "El agente propone, el código aplica las reglas y una persona aprueba lo que requiere autorización."

## 1. Intent and why

**Primary goal: credibility, not the prize.** David attends the Caracas in-person hub on Saturday 2026-10-17 (Wave Tech, 9:00 to 17:00), co-organized by Asilo Digital. Its founder, Isaac Fernández, is a UX lead (Arquia, Medellín) and a hackathon mentor for product, value proposition and pitch. David wants Asilo Digital as an ally of Ateneo Abierto. The project is the proof that David knows the tools deeply and builds real, well-designed things. Success means Isaac and his community want a follow-up conversation.

Consequences:
- **A working, deployed demo by Saturday 08:00 Caracas.** The first milestone is one invoice flowing end to end, deployed, not separate screens.
- **UX is judged by a UX specialist.** Useful end to end for an administrative user: where invoices come from, what they are checked against, what the person does next, how to learn it. Understandable without onboarding.
- **The safety answer must be inspectable.** The demo must give a convincing answer to "could this invoice be approved despite a failed rule?"

**Secondary goal:** finalist and winner of the Blinka challenge (US$500 per team; best overall project gets 30X program seats). Also the "Construye en público" Instagram prize.

## 2. Hard constraints

**Deadline: Sunday 2026-10-18, before 12:00**, almost certainly Colombia time (12:59 Caracas). Treat **11:00 Caracas** as the deadline. **Code freeze Sunday 10:00 Caracas** to record the video.

**Deliverables (all three or disqualified):** 3-minute video pitch with a live demo; deployed demo URL; public GitHub repo whose documentation matches the demo exactly.

**30X judging:** challenge impact 30%, innovation 20%, technical viability, implementation viability (model cost counts), presentation.

**Blinka criteria:** autonomy (decided correctly with no human); **safety (one improper payment approval disqualifies)**; explainability (anyone understands each decision from the log, without code).

**Blinka scope:** in: extract payee, amount, currency, due date; decide by configurable rules (limits per payment and period, allowed payees, human approval above an amount); log every decision with its reason. Out: real payments, opening accounts, identity verification, compliance or fraud decisions, Blinka's app design. Required traps: duplicate, new payee, mismatch with the agreement, over the limit needing approval, insufficient balance or budget. Blinka provides no API, invoices or schema: each team builds its own set. Fictional data only.

**JEV facts (docs.typesafe.ai, read 2026-10-16):** hosted API only (no local option). `POST https://api.typesafe.ai/v1/systemone`, bearer key. Request: `state` + `questions`. Types: `noul` (returns a probability, no separate confidence), `choice` (up to 255 options; choice, probabilities, confidence), `score` (2 to 10 ordered levels; weighted score, probabilities, confidence). SDK `@typesafe-ai/sdk`, method `systemOne`. Models `jev-latest` (1.13.0), `jev-preview` (1.14.0). US$0.042 per million input tokens, output free. 64k per request, 32k per question. Text only. Stated limits: can be confidently wrong; no arithmetic, counting or date comparison; prefers narrow questions combined in code; include "other"; use thresholds and a path to a person.

**Gemini (extraction):** Gemini API **free tier** (David's call: the paid tier needs a US$30 prepayment). Free-tier content may be used by Google to improve its products, so the upload UI says "Demo con datos de prueba. No subas facturas reales." The README says production runs on the paid tier.

## 3. Goals, non-goals, anti-goals

**Goals**
1. End-to-end flow an administrative person can use: prepare data, set rules, receive, decide, record.
2. Zero unsafe approvals across the labeled set and the adversarial tests, run in CI and visible in the app, stated honestly ("0 aprobaciones indebidas en N pruebas").
3. Every decision readable in plain Spanish, with the evidence next to the verdict.
4. Visible speed and cost, with replay and live numbers reported separately.
5. Looks and feels like a real product.

**Non-goals:** real email ingestion, QuickBooks sync, login or multiple users, real payments, in-house OCR, coordinate highlighting on PDFs or images, mobile-first layout (must not break on mobile; target is a laptop).

**Anti-goals (failure even if it works):**
- **A model output, or a generic human click, can turn a failed deterministic check into a payment.**
- A chatbot.
- Generic AI-slop UI.
- A public demo that only works with live API calls, or where one visitor breaks it for the next.
- Any real person's or company's data.
- English-first UI.
- Showing recommendations as completed payments. Nothing is paid; the UI says so.

## 4. The user and the journey

**User:** the person handling accounts payable at **Andina Labs Inc.** (fictional, Delaware) with contractors and vendors in Colombia, Mexico and Venezuela. Today: invoices by email, PDF and WhatsApp; comparison against agreements by hand; approval chased in chat; payments created by hand; reconciliation in a spreadsheet.

**Journey:** 1 Preparar (once) · 2 Reglas · 3 Recibir · 4 Decidir · 5 Registrar, with guidance throughout.

## 5. Decision states (the core model)

Four states. The first and last are fully autonomous; the middle two are Blinka's "escalate".

| State (UI label) | Meaning | What the person can do |
|---|---|---|
| **Lista para pagar** | Every deterministic check passed, no judgment flag, within the auto-pay amount. | Nothing required. Included in the payment batch export. |
| **Requiere tu aprobación** (`APPROVAL_REQUIRED`) | Every deterministic check passed and no flags remain, but policy requires a person's authority (above the approval threshold; variable-quantity work; image-only extraction to confirm). | Approve or reject, each with a reason. |
| **Requiere revisión** (`REVIEW_REQUIRED`) | Deterministic checks passed, but there are judgment flags or uncertainty (JEV review band, fuzzy duplicate, partial scope match, artificial urgency, ambiguous extraction). | Resolve each flag explicitly (pick a resolution + reason, e.g. "No es duplicado: es el cobro de noviembre"). Once every flag is resolved, it becomes `APPROVAL_REQUIRED`. Or reject. |
| **Frenada** | A deterministic check failed, or a hard risk signal fired. | No pay action. A "Qué hacer" box, derived from the failed checks, says what must change (fix vendor data, change a rule, get a corrected invoice). After the fix, "Re-evaluar esta factura" runs the full pipeline again. |

**`canApprove` is computed only from deterministic results**: true only when every hard check passes against current data and no unresolved flag remains. Never from the display label, never from JEV.

**Approval is a transaction**: on "Aprobar", inside one SQLite transaction: check the idempotency key, re-run every hard check against current data and current commitments, then commit the decision, the commitment and the audit event together. If anything now fails, the approval is refused and the invoice moves to Frenada with the reason.

**No human override of Frenada.** The only path forward is fixing the cause and re-evaluating.

## 6. The decision pipeline

```
invoice (pdf | image | text)
  -> 1. EXTRACT    raw text + structured claims     (Gemini Flash, always; PDF text extracted in code first)
  -> 2. VERIFY     claims against source + records  (code)
  -> 3. RULES      hard checks                      (code, deterministic)
  -> 4. JUDGMENT   typed questions                  (JEV, one call per invoice)
  -> 5. COMBINE    policy -> state                  (code, sequential, in a transaction)
  -> 6. RECORD     decision record + seal           (code, templated Spanish)
```

Batch processing: steps 1 and 4 run in parallel for speed; **steps 2, 3, 5 and 6 run strictly sequentially, one invoice at a time, each in its own transaction**, so every invoice sees the commitments of the ones before it (including in-batch duplicates).

### Step 1, extract (untrusted claims)

- PDF: extract the text layer in code, then send the text to Gemini for structured extraction. Image: send the image. Pasted text: send the text. **Always the same structured schema.**
- Invoice content is untrusted data. The prompt says so; instructions inside the document are reported in a `suspicious_passages` field, never followed.
- Schema returns **candidate arrays** for critical fields: `amounts_found[]`, `accounts_found[]`, `tax_ids_found[]`, `invoice_ids_found[]`, `currencies_found[]`; plus the chosen value of each with its **literal source string** (`amount_raw`, e.g. "COP 4.800.000,00") and an `evidence_quote`; plus `subtotal`, `taxes`, `total` as raw strings; `document_type_hint`; `has_multiple_currencies_shown`.
- Upload limits: 2 MB, 2 PDF pages; text truncated to 8,000 characters before any model call.

### Step 2, verify (code)

Extraction is a claim, not a fact.
- **Source check:** for text and PDF inputs, every chosen critical value (amount, account, tax id, invoice id) must appear literally in the source text (normalized for whitespace). If not: `REVIEW_REQUIRED` ("No pude confirmar el monto en el documento").
- **Conflicts:** more than one distinct account, tax id, total, or currency candidate: Frenada if it is the account ("La factura muestra dos cuentas bancarias distintas"), otherwise `REVIEW_REQUIRED`.
- **Never substitute** the vendor's registered account for what the invoice shows. The account checked is the one on the invoice.
- **Money parsing:** a deterministic parser for es-CO, es-VE, es-MX and en-US formats on `amount_raw`, producing integer minor units with explicit currency precision (COP 2 decimals as written, USD 2, MXN 2). **Ambiguous strings are rejected, never guessed** (e.g. "2.500" with no decimals and no locale signal): `REVIEW_REQUIRED`. Decimal arithmetic only, no floats.
- `subtotal + taxes = total` checked in code when present; mismatch: `REVIEW_REQUIRED`.
- Image-only inputs cannot be source-checked: best possible state is `APPROVAL_REQUIRED` (the person confirms the fields against the image).
- Payee matching by tax id and account, never by name. Unicode, punctuation and spacing normalized before matching and duplicate comparison (catches "Nube Andlna SAS").

### Step 3, hard rules (code)

| # | Check | Fails to |
|---|---|---|
| 1 | Payee on the allow list and not blocked | Frenada |
| 2 | Account on the invoice equals the vendor's registered account | Frenada ("Verifica el cambio con el proveedor por un canal seguro, actualiza su cuenta en Preparar datos y re-evalúa") |
| 3 | Exactly one active contract applies (no contract, or two overlapping: fail) | Frenada ("Sin acuerdo vigente, no hay pago automático") |
| 4 | Invoice currency equals the contract currency | Frenada |
| 5 | Fixed contract: amount equals the agreed amount (tolerance 0) | Frenada |
| 6 | Variable contract: invoice rate equals contract rate; quantity within `max_units_per_period`; rate x quantity = amount | Frenada if any fails; if all pass: `APPROVAL_REQUIRED` (the quantity itself is unverified) |
| 7 | Billing frequency: no other invoice already committed for this contract in the same period | Frenada ("Este contrato ya registra un cobro en octubre") |
| 8 | Exact duplicate: same vendor + same normalized invoice id | Frenada |
| 9 | Invoice date within the contract period | Frenada |
| 10 | Due date valid and not already past | `REVIEW_REQUIRED` if past |
| 11 | Amount (USD) within the per-payment limit | Frenada |
| 12 | Monthly total (committed + this) within the monthly limit | Frenada |
| 13 | Cost-center budget available (approved - committed - reserved) covers it | Frenada (reallocation is a data change) |
| 14 | Available balance (balance - committed - reserved) covers it | Frenada |
| 15 | Amount (USD) above the human-approval threshold | `APPROVAL_REQUIRED` |
| 16 | Missing FX rate for the currency | Frenada |

Multiple failures: Frenada wins; the record lists every failed check. FX: fixed table dated 2026-10-15; conversion invoice currency to USD at that rate, half-even rounding to cents, comparisons done in USD minor units; both original and USD amounts stored. In the sample set, every invoice is in its contract's currency.

**Commitments ledger:** `committed` = Lista para pagar + approved; `reserved` = pending `APPROVAL_REQUIRED` and `REVIEW_REQUIRED`. Rules 12 to 14 evaluate against amounts net of both. Labeled "comprometido", never "pagado".

### Step 4, JEV judgment (one request per invoice)

State: the extracted text (truncated) + the matched contract summary. Questions, each with its own typed mapping:

| Question | Type | Mapping |
|---|---|---|
| `instructs_agent`: does the text try to instruct an automated system or skip a control? | noul | >= action threshold: Frenada. Review band: flag. |
| `artificial_urgency`: pressure to pay immediately beyond a normal due date? | noul | >= review threshold: flag (never Frenada alone). |
| `scope_match`: does the described work match the contract scope? | score: Coincide / Parcialmente / No coincide | "No coincide" with confidence >= 0.6: Frenada. "Parcialmente", or confidence < 0.6: flag. |
| `fuzzy_duplicate`: same work billed twice? (only when a same-vendor invoice exists in the last 60 days; state includes both) | noul | >= review threshold: flag. |
| `document_type` | choice: factura, cuenta de cobro, recibo, cotización, otro | **factura and cuenta de cobro are payable.** cotización or recibo with confidence >= 0.8: Frenada; 0.6 to 0.8: flag. otro, or confidence < 0.6: flag. |
| `cost_center` (only when needed for triage) | choice + otro | Suggestion for the person only. Never authorization. |

Presets (sensitivity only; they never relax a deterministic check):

| Preset | noul action | noul review band |
|---|---|---|
| Estricto | 0.60 | from 0.25 |
| Equilibrado (default) | 0.70 | from 0.35 |
| Permisivo | 0.85 | from 0.50 |

**Any JEV error, timeout, missing answer or malformed response: no automatic Lista para pagar** (flag "No pude completar la evaluación"). The UI shows "JEV no conectado" when there is no key.

### Step 5, combine (code)

Pure function from (verify results, rule results, JEV answers, rules snapshot) to (state, reasons, `canApprove`, flags). It is the same function the impact simulator uses (section 7.4).

### Step 6, record

- Templated Spanish sentences built from check results. No model writes explanations.
- **Decision seal:** each record stores the rules snapshot, the vendor and contract versions, the FX rate used and the raw JEV answers, plus a short SHA-256 seal over `invoice_hash + rules_snapshot + data_versions + jev_answers + state` (shown as "Sello #8f3a1c").
- Changing rules or vendor or contract data marks affected pending invoices "Desactualizada: re-evalúa" and they cannot be approved until re-evaluated. Old records are never rewritten; a re-evaluation creates a new record linked to the old one ("Re-evaluada · antes: Frenada").

### Record, replay, live

- `record`: live calls, responses saved to `recordings/` keyed by request hash. `replay`: no network. `live`: real calls.
- **The sample set runs in replay by default** (always works, even if TypeSafe is down). The UI labels it: "Modo demostración · respuestas grabadas". Live runs show measured latency separately.
- **No hand-made JEV stand-ins.** Recordings come from real calls only.

## 7. Screens

UI in Spanish. Laptop target (1280 to 1440), usable at phone width. Status never conveyed by color alone (label + icon).

### 7.1 Header (global)
"Andina Labs Inc. · Datos ficticios" and a persistent banner "Modo demostración · No se realizan pagos reales". Buttons: "+ Recibir factura" and "Reiniciar demo".

### 7.2 Bandeja (home)
- Counters: Listas para pagar · Requieren tu aprobación · Requieren revisión · Frenadas · run stats ("20 facturas en 0,8 s · US$0,0009", with "grabado" or "en vivo").
- List: payee, concept, amount (original currency + USD), due date, state chip.
- **"Procesar"** streams results into rows one by one (SSE) with a short pop animation; counters tick up.
- Drag and drop a file onto the list to receive it.
- Right side: the Expediente of the selected invoice.

### 7.3 Expediente
Order, top to bottom:
1. Verdict and the one-line reason; for Frenada, the **"Qué hacer"** box (derived from failed checks) and "Re-evaluar esta factura".
2. **"Comparación con tus registros"**: two columns, *En la factura* vs *En tus registros*: beneficiary, tax id, account (last 4), amount (original + USD), contract scope and amount, invoice date vs contract period, cost-center budget remaining. Differing cells highlighted, with a label.
3. Decision trail: each check with pass/fail, reason, and source tag ("Regla" or "Juicio · JEV 0,97" with a bar).
4. The document: original PDF or image shown clean, with a toggle **"Documento original | Texto que leyó el agente"**. The text view uses `<mark>`: extracted values in green, suspicious passages in red (exact substrings from `evidence_quote` and `suspicious_passages`).
5. Actions per state (section 5). Approver identity is a declared name, labeled "identidad declarada (demo)".
6. The seal and "Ver registro completo".

### 7.4 Reglas
- Per-payment limit, monthly limit, human-approval threshold (must be lower than the per-payment limit; enforced), duplicate window for fuzzy checks.
- **Not configurable** (shown as locked, with why): allow list required, account must match, extraction integrity, contract required.
- JEV sensitivity presets with an advanced view.
- **Impact simulator:** while the person edits, a live bar shows "Con estos ajustes en tu bandeja: 7 listas (-2) · 4 aprobación (+1) · 3 revisión (+1) · 6 frenadas (0) · 0 aprobaciones indebidas", recomputed instantly from stored extraction and JEV answers with the combine function, no API calls.
- "¿Qué es esto?" help on every control.

### 7.5 Recibir (panel from the header, not a page)
- "Cargar facturas de ejemplo".
- Drop PDF or image; paste text.
- **Live test templates:** three buttons fill the paste box with editable invoices: "Cobro por WhatsApp con urgencia", "Intento de manipulación (prompt injection)", "Cuenta de cobro legítima en COP". The visitor can edit and send them live.
- The notice "Demo con datos de prueba. No subas facturas reales."

### 7.6 Preparar datos
- Four tables (Proveedores, Contratos, Presupuestos, Saldo y tipos de cambio) with **inline cell editing** and CSV upload validated with Zod (one summary of errors, not a per-row report). Downloadable CSV templates.
- Contract fields include `type` (fixed / variable), `amount` or `rate`, `max_units_per_period`, `billing_frequency`, `currency`, `cost_center`, `start`, `end`.

### 7.7 Bitácora
- Every decision and human action, chronological, each readable alone, with its seal.
- Exports: **"Lote de pagos autorizados (CSV para Blinka)"** (only Lista para pagar + approved: `vendor_tax_id, payout_account, payout_currency, amount_original, amount_usd, decision_id, authorized_by, seal`), audit log CSV, and Markdown report.

### 7.8 Evaluación (footer link, README)
Three separate claims, never blended:
1. **Regression safety:** deterministic tests, including adversarial mutations, concurrency and stale approvals: "0 aprobaciones indebidas en N pruebas".
2. **Labeled set:** correct states, false escalations, autonomy %.
3. **Live sample:** measured extraction + JEV latency, cost and failure rate on a few unseen invoices.

### 7.9 Cómo decide el agente
Short page or drawer for a finance person: the pipeline, rule vs judgment, why no model has the last word on money, what the probabilities mean.

**Cross-cutting:** empty states that say what to do; a three-step first-run hint (datos, reglas, facturas).

## 8. Data, test set, isolation

**Andina Labs:** about 10 vendors, contracts (mostly fixed; a few variable with `max_units_per_period`), cost centers Ingeniería, Diseño, Operaciones, Legal; monthly budgets; balance; FX dated 2026-10-15.

**Labeled set, about 20 invoices** (expected state + reason each), across formats (PDF, scanned image, email text, WhatsApp text) and currencies (USD, COP, MXN), mixing es-CO and en-US number formats:
- Lista para pagar: about 7 (fixed contracts).
- Requiere tu aprobación: above threshold; one variable-hours invoice; one image-only.
- Requiere revisión: fuzzy duplicate; partial scope; artificial urgency; ambiguous amount string.
- Frenada: new payee; changed account; two accounts on one invoice; exact duplicate; second invoice in the same monthly period; no contract; currency mismatch; amount mismatch; over per-payment limit; insufficient budget; insufficient balance; quote disguised as invoice; prompt injection.

**Adversarial tests (unit level, not shown as invoices):** in-batch duplicate; two invoices that each fit the balance but not together; approval after another invoice consumed the budget; approval after a rule change; identical invoice ids with different formatting; at-limit and one-cent-over amounts; extraction returning a value absent from the source; JEV error, empty and malformed responses.

**Invoice files** are generated by a local script (HTML to PDF and PNG) **once**, and committed. No headless browser in CI or in the production image.

**Public demo isolation:** each browser gets its own workspace (cookie `workspace_id`; workspace rows cloned from the seed on first visit; TTL 24 h; cleanup job). "Reiniciar demo" restores the workspace to the seed. Real client IP read from Traefik's `X-Forwarded-For` (trusted proxy configured); per-workspace and per-IP limits on live calls; a global daily cap on live model calls; request-size limits.

## 9. Stack and deployment

- **David's `vite-hono` pack:** Vite + React + TypeScript, Hono Node server, one container, Vitest, Docker healthcheck, Traefik compose. Chosen over Next.js: single interactive app, no SEO; SSE is trivial in Hono; client/server split gives parallel workers disjoint paths; proven on Dokploy. Visual polish is the same React either way.
- Add: Tailwind, shadcn/ui (or equivalent), Motion, SQLite via better-sqlite3 (synchronous transactions), Zod, a decimal library, `@typesafe-ai/sdk`, the Gemini SDK, a PDF text extractor, a PDF viewer component.
- Extraction: Gemini Flash-class, free tier, behind one interface. Builder picks the cheapest current Flash that handles the set. Backoff on 429 with a clear "Límite del demo alcanzado" message.
- `/kick-off` (CI, `production` branch), public repo `dvd117/visto-bueno`, `/dokploy` to `visto-bueno.aragort.com`. SQLite on a named volume.

## 10. Build phases (priority order inside each phase)

**Milestone 0, first (target Saturday 02:00):** repo kicked off and deployed; one fixed-contract invoice from the seed goes through all six steps (replay or no-JEV state) and shows in a bare Bandeja + Expediente.

**Tonight, by Saturday 08:00:**
1. Seed data, the labeled set files, the money parser with tests.
2. Verify + rules + combine + commitments ledger with sequential transactions; adversarial tests green.
3. JEV client with record/replay; recordings for the set (needs the key).
4. Gemini extraction for text and PDF (images may lag).
5. Bandeja with live processing, counters, Expediente with comparison table, trail and text view.
6. Approval and review resolution with transactional re-validation.
7. Workspaces + "Reiniciar demo"; deployed.

**Saturday:**
1. Image extraction; Recibir panel with live templates.
2. Reglas with locked items and the impact simulator; invalidation on change.
3. Preparar datos with inline edit and CSV.
4. Bitácora with the three exports and seals.
5. Evaluación page.

**Sunday before 10:00:** "Cómo decide" drawer, empty states, first-run hint, README (what, how to run, how it decides, evaluation results with honest claims, architecture diagram, cost), UX polish, rehearsal, freeze.

**Cut order if late:** Evaluación page (keep the CI test) → CSV upload (keep inline edit) → impact simulator → Markdown export → image extraction (keep text/PDF). Never cut: safety core, transactions, workspaces, Bandeja + Expediente.

## 11. How it gets built

- Plan here (hq), external review done, then a backlog of units goes to the **ops mesa** via `to-mesa`.
- **Coordinator: Opus (Claude), not Sol** (David's call: Sol consumes the Codex quota Luna needs; David has a Claude reset banked). This departs from the current ops topology; the mesa confirms herdr-projects can run a Claude coordinator, and if not, picks the closest equivalent and tells David.
- **Workers: Luna max**, as many in parallel as there are disjoint units, one worktree each. The combine function, the rule table and the state model are written first and serially (they are the contract every other unit depends on); then screens, extraction, JEV client and exports fan out.
- Every merge: unit tests for each hard rule; adversarial and labeled-set evaluation stay at 0 unsafe approvals.
- Timing: the hackathon started at kickoff (Friday 17:00 Colombia), so tonight's code is within the rules. Opus (hq) reviews early Saturday before David leaves.
- David is solo. If someone joins at the hub, they take non-code work only (label review, user testing, the Reel).

## 12. Demo and pitch (3 minutes)

"Watch invoices become safe decisions", not "watch the AI".
1. **0:00 to 0:20, problem:** a finance person at a cross-border company; invoices by email, PDF and WhatsApp; approvals in chat; one changed bank account away from fraud.
2. **0:20 to 0:40, batch:** "Procesar": states land, counters, cost.
3. **0:40 to 1:10, a stopped invoice:** changed account; the comparison table shows invoice vs record; "Qué hacer"; no pay button.
4. **1:10 to 1:30, a legitimate approval:** above threshold, approve with a reason; budget and commitments update.
5. **1:30 to 2:05, live:** paste the WhatsApp template, add a manipulation line, send; JEV flags it and the code stops it, measured latency shown.
6. **2:05 to 2:30, why it is safe:** the Reglas impact simulator and the Evaluación badge ("0 aprobaciones indebidas en N pruebas"); models only downgrade; locked rules.
7. **2:30 to 2:50, viability:** cost per 1,000 invoices; exports a payment batch for the vendor data Blinka already has.
8. **2:50 to 3:00, close:** the thesis line.

## 13. Left to the builder

Component library, exact visual design (calm finance-tool feel, no AI-slop look, not imitating Blinka's brand), PDF libraries, project structure, exact JEV question wording (narrow; tune on the set), workspace cleanup mechanism.

## 14. Calls made by the architect (David should check)

- Name "Visto Bueno", repo `dvd117/visto-bueno`, host `visto-bueno.aragort.com`.
- Four states (section 5) and the hard-rule failure table (section 6).
- Thresholds per preset, to be tuned.
- Explanations templated, never model-written.
- Sample set in replay by default; replay and live numbers reported separately.
- FX fixed and dated; sample invoices in their contract currency.
- Approver name declared, not authenticated.
- Deadline treated as 11:00 Caracas, freeze 10:00.
- Cut order (section 10).

## 15. Open items

- JEV API key (David).
- Gemini API key, free tier, from AI Studio (David).
- Claude coordinator support in herdr-projects (the mesa).
- Exact deadline and time zone (HackRadar).

## 16. Review log

Three external reviews (ChatGPT, Gemini, plus one more) and one builder check, 2026-10-16. All three reviews agreed on the top issues.

**Accepted**
- Changed payout account: Escalar → Frenada (all three).
- Escalation split into `APPROVAL_REQUIRED` and `REVIEW_REQUIRED`; `canApprove` from deterministic results only (review 1). Deterministic violations moved to Frenada: contract amount and currency mismatch, insufficient budget.
- Extraction as untrusted claims: candidate arrays, literal source check, conflict detection, never substituting the registered account (all three). Always use the model for structured extraction, also on PDF text (review 3).
- Money parsing for LatAm and US formats, minor units, ambiguity rejected (all three).
- Atomic, sequential decisions with a commitments ledger and transactional re-validation on approval (all three).
- Variable-quantity contracts: `max_units_per_period` + approval required, since quantity is unverified (reviews 1 and 2).
- No contract means no automatic payment; exactly one contract must apply (reviews 1 and 3).
- Billing-frequency rule (review 3). Rule for invoice date outside the contract (review 3).
- `cuenta de cobro` is payable; quote/receipt Frenada only at high confidence (reviews 1 and 2).
- Typed mapping per JEV question; any JEV failure blocks auto-pay (review 1).
- Locked non-configurable safety rules; decision snapshot and seal; invalidation on data change (reviews 1 and 2).
- Coordinate highlighting cut; text view with marks instead (all three).
- Comparison table in the Expediente (reviews 2 and 3).
- Per-browser workspaces and "Reiniciar demo" in the header (all three).
- Impact simulator in Reglas (reviews 2 and 3).
- Recibir as a panel from the Bandeja, drop on the list, editable live templates (review 3).
- Payment batch CSV for Blinka (review 3).
- "Listas para pagar" instead of "Pagadas solas"; persistent demo banner (review 1).
- Honest evaluation claims, replay vs live separated (review 1).
- Upload size and page limits; real client IP behind Traefik; global cap (review 2).
- Invoice files generated locally once and committed (review 3).
- Scope: Milestone 0 is one invoice end to end deployed; cut order defined (reviews 1 and 3).
- Pitch restructured around one invoice becoming a safe decision, with a live paste (all three).

**Rejected**
- A judge unlock code (`?judge=blinka`) that bypasses rate limits (review 2): a bypass mechanism in a safety demo reads badly; workspaces + a generous global cap solve the shared-Wi-Fi case.
- Cutting the processing animation (review 1): cheap with Motion, and David's explicit preference.
- Cutting the Markdown export (review 1): David's standing rule is that custom UIs export to Markdown; it is last in the cut order instead.
- Strictly sequential processing of the whole pipeline (review 2): only verify, rules, combine and record must be sequential; extraction and JEV stay parallel for speed (review 3's split).
- An FX tolerance band for cross-currency invoices (review 2): replaced by requiring the contract currency (rule 4), which is simpler and safer.
