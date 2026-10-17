# Milestone 0 acceptance runner

This is an opt-in Playwright browser check for the fictional Andina Labs demo. It is **not** part of `npm test`, CI, or the production image. The M0 path is ready to run after T11 exposes the UI/API.

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

The script creates a fresh browser workspace and refuses to continue if it already contains invoices. It uses the existing fixed-contract PDF fixture `fixtures/invoices/AL-037.pdf` only; all data is fictional.

| Acceptance item | What it observes |
| --- | --- |
| `/health` and T11 readiness | Real health response plus real `/api/workspace` and `/api/invoices` responses. Missing endpoint = `BLOCKED`. |
| Fresh workspace | Before any write, two new browser profiles must have distinct `workspace_id` cookies and zero invoices; after the first profile receives AL-037, the second is checked again and must still be empty. |
| Six pipeline stages | Uses persisted API evidence, not invented UI stages: EXTRACT (source text + successful extraction check), VERIFY (verify checks), RULES (rule checks), JUDGMENT (genuine JEV checks or explicit missing evidence), COMBINE (persisted status/canApprove), RECORD (record id + seal). |
| Safe no-JEV case | M0 may still pass if replay JEV evidence is missing, the invoice is not `ready`, `canApprove` is false, and the Expediente visibly says JEV is unavailable. The JUDGMENT step is marked missing, not passed. |
| Streaming | Clicks the real Bandeja `Procesar` button, asserts the browser sent `{ mode: "replay" }`, parses actual SSE `decided` + `done`, validates replay stats/counters, and checks the visible counter values. |
| Bandeja + Expediente | Confirms the invoice row, comparison, decision trail, text/source view, persisted checks, fixed contract, money amount, and seal. |
| Reset / seed | Calls the visible `Reiniciar demo`, checks empty invoice state and baseline company/rules, then reprocesses AL-037 to confirm its fixed contract/money seed still works; resets again for cleanup. |

The stage map is evidence mapping only. It does not claim six distinct screens or controls exist. EXTRACT, VERIFY, RULES, JUDGMENT and COMBINE are represented by the actual persisted checks/decision; RECORD is the decision record and seal.

## Optional Tonight browser subset

Run with `--tonight` after M0:

```sh
env -u GEMINI_API_KEY -u TYPESAFE_API_KEY EXTRACT_MODE=replay JEV_MODE=replay \
  node scripts/acceptance-milestone0.mjs --confirm-server-replay --tonight
```

This adds real replayed text intake (`AL-030.txt` via the JSON API, then UI processing), stopped-approval denial (`AL-039`, expected 409 and still stopped), replay re-evaluation of that stopped invoice, and rejection of a generic resolution for `AL-047`'s `ambiguous_amount` integrity flag. It tests a positive approval only for `AL-038` after extraction succeeds and the persisted JEV result is both successful and marked recorded; it fills the declared-name and reason fields and uses the real UI. If genuine replay evidence is unavailable, it reports `BLOCKED` and does not attempt approval. The isolated workspace is reset after errors when the reset control is available.

`--tonight` reports only the browser subset. It does **not** certify the full labeled set or the following external gates:

- Seed vendor/contract/budget/FX/money fixtures and labels: review the seed and money unit tests.
- Deterministic rules, sequential-ledger transactions, stale approval, and adversarial safety: run the existing unit/adversarial suite; browser e2e cannot prove transaction concurrency.
- Full labeled-set gate and evaluation claims: run the independent gate; e2e does not replace it.
- Genuine JEV recording inventory: require successful recorded replay evidence; never fabricate a response.
- Text/PDF extraction replay: browser subset checks one PDF plus one text fixture; it is not a broad format regression suite.

The default M0 command does not click Recibir's live-submit button and never edits rules, vendors, contracts, budgets, treasury, exports, or global/admin state. Approval and flag probes in `--tonight` affect only the newly created fictional workspace and are followed by reset.
