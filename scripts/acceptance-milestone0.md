# Milestone 0 acceptance runner

This is an opt-in Playwright browser check for the fictional Andina Labs demo. It is **not** part of `npm test`, CI, or the production image. The M0 path uses the 20 seeded invoices already present in every fresh workspace; it does not upload a replacement AL-037.

## Setup

Install Playwright only under the ignored `.w/` directory; no repo manifest changes:

```sh
mkdir -p .w/t .w/npm-cache
export npm_config_cache="$PWD/.w/npm-cache" TMPDIR=.w/t
npm install --prefix .w/playwright --no-save playwright@1.56.1
```

Use the pinned Chrome for Testing at `~/.local/bin/chrome-cft`, or set `CHROME_EXECUTABLE_PATH` to the locally installed pinned executable. Do not install a browser into the app, CI, or production image.

Local run, in two terminals. Start the app with replay-only settings and without model keys:

```sh
env -u GEMINI_API_KEY -u TYPESAFE_API_KEY EXTRACT_MODE=replay JEV_MODE=replay npm run dev
```

Then run the acceptance command with the same environment constraints:

```sh
env -u GEMINI_API_KEY -u TYPESAFE_API_KEY EXTRACT_MODE=replay JEV_MODE=replay \
  node scripts/acceptance-milestone0.mjs --confirm-server-replay
```

The default `BASE_URL` is `http://127.0.0.1:5173`; override with `BASE_URL=...` or `--base-url URL`. Deployed checks require the explicit `--confirm-server-replay` acknowledgement too: confirm the server's `EXTRACT_MODE=replay` and `JEV_MODE=replay` through the deployment operator before running. Browser interception does **not** prove server configuration. The runner refuses either model key for any target. Do not set live/record mode or supply API keys for acceptance.

Syntax/config-only check (no network, browser, or e2e claim):

```sh
node --check scripts/acceptance-milestone0.mjs
node scripts/acceptance-milestone0.mjs --check
```

Exit codes: `0` = assertions in the selected browser scope passed; `1` = assertion/runtime mismatch; `2` = prerequisite/readiness blocked. A missing T11 endpoint is reported as `BLOCKED`, never as a pass. Evidence is written only to `.w/acceptance-milestone0/<run-id>/` (JSON API/stream evidence, result, and screenshot). The runner uses an isolated browser context, blocks every cross-origin browser request, and fails if one is attempted. It does not fulfill or mock any app response.

## Mandatory M0 checklist

The script creates two fresh browser workspaces and verifies that both contain exactly the queued seed IDs `AL-030` through `AL-049`. M0 selects the existing fixed-contract seed `AL-037` in Bandeja and clicks `Procesar`; it never opens Recibir or submits a live upload. All data is fictional.

| Acceptance item | What it observes |
| --- | --- |
| `/health` and T11 readiness | Real health response plus real `/api/workspace` and `/api/invoices` responses. Missing endpoint = `BLOCKED`. |
| Fresh workspace and isolation | The two profiles have distinct `workspace_id` cookies and the same 20 queued seed IDs. After the first profile processes them, the second must still show all 20 queued. No upload IDs are used or shared in M0. |
| Six pipeline stages | Uses AL-037's persisted evidence, not invented UI stages: EXTRACT (source text + successful extraction check), VERIFY (verify checks), RULES (rule checks), JUDGMENT (genuine JEV checks or explicit missing recording), COMBINE (persisted status/canApprove), RECORD (record id + seal). |
| Safe no-JEV case | M0 may pass if JEV has the explicit `missing_recording` result and matching sanitized SSE error, AL-037 is not `ready`, `canApprove` is false, and the Expediente says JEV is unavailable. JUDGMENT is marked missing, not passed. Any other extraction, persistence, or JEV error fails. |
| Streaming | Selects AL-037, clicks the real Bandeja `Procesar` button, asserts `{ mode: "replay" }` with no explicit IDs, and validates exactly 20 `decided` events plus one final `done`. Visible counters come from the **last** decided event, not AL-037's intermediate counters. |
| Bandeja + Expediente | Confirms the invoice row, comparison, decision trail, text/source view, persisted checks, fixed contract, money amount, and seal. |
| Reset / cleanup | Calls the visible `Reiniciar demo` and verifies all 20 seed IDs are back in `queued`, baseline company/rules are restored, and `lastRun` is null. Failure cleanup uses the same seed-restoration assertions. |

The stage map is evidence mapping only. It does not claim six distinct screens or controls exist. EXTRACT, VERIFY, RULES, JUDGMENT and COMBINE are represented by the actual persisted checks/decision; RECORD is the decision record and seal. Each of the 20 seed decisions must contain persisted extraction evidence. Missing JEV is tolerated only for the explicit missing-recording case and only when its persisted result proves fail-closed behavior.

## Optional Tonight browser subset

Run with `--tonight` after M0:

```sh
env -u GEMINI_API_KEY -u TYPESAFE_API_KEY EXTRACT_MODE=replay JEV_MODE=replay \
  node scripts/acceptance-milestone0.mjs --confirm-server-replay --tonight
```

This adds real API intake/replay checks: JSON text and multipart PDFs are uploaded through `POST /api/invoices`, then each returned upload ID is processed only with an explicit `{ ids, mode: "replay" }` request. It does not use the Recibir panel's file/text submit because those controls intentionally process live. It checks stopped-approval denial (`AL-039`, expected 409 and still stopped), replay re-evaluation, and refusal of a generic resolution for `AL-047`'s `ambiguous_amount` integrity flag. It attempts positive approval only for `AL-038` after genuine extraction and successful recorded JEV evidence; it fills the declared-name and reason fields and uses the real UI. If eligible evidence is unavailable, positive approval is explicitly `BLOCKED`, no approval is attempted, the workspace is reset to the 20 queued seeds, and the command exits nonzero. New upload UUIDs are kept separate from the seeded `AL-030`–`AL-049` IDs; no JEV recording is required merely because an uploaded request has a different hash.

`--tonight` reports only the browser subset. It does **not** certify the full labeled set or the following external gates:

- Seed vendor/contract/budget/FX/money fixtures and labels: review the seed and money unit tests.
- Deterministic rules, sequential-ledger transactions, stale approval, and adversarial safety: run the existing unit/adversarial suite; browser e2e cannot prove transaction concurrency.
- Full labeled-set gate and evaluation claims: run the independent gate; e2e does not replace it.
- Genuine JEV recording inventory: require successful recorded replay evidence; never fabricate a response.
- Text/PDF extraction replay: browser subset checks one PDF plus one text fixture; it is not a broad format regression suite.

The default M0 command does not click Recibir's live-submit button and never edits rules, vendors, contracts, budgets, treasury, exports, or global/admin state. The `--tonight` API intake and approval/flag probes affect only the new fictional workspace and are followed by reset to the original 20 queued seeds.
