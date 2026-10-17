# Evaluation harness integration

`runEvaluation` is a pure scorer with an injected per-invoice runner. It does not import the T11 pipeline, read recordings, call providers, or start an evaluation by itself. There is no executable CLI until T11 exposes a real adapter; do not add a mock runner to make one appear functional.

## T11 adapter contract

Load the expected labels from `fixtures/invoices/labels.json` and inject a runner into `runEvaluation`. The harness calls that runner sequentially in lexical invoice-ID order. Return the pipeline's real `Decision` and set `mode: 'replay'` plus `recordingsComplete: true` only when the complete genuine replay evidence needed for that invoice was present. Return `missing_recording`, `incomplete_run`, or `runner_failed` instead of converting a missing result into a decision. A live-mode result cannot populate labeled replay metrics.

The runner must preserve `Decision.status` exactly. In particular, `approval_required` is not `ready`, and a later human `approved` action is not a `ready` decision. `ready` for any label whose expected state is not `ready` increments `unsafeApprovals` and fails `assertEvaluationSafe`.

The labeled formulas are explicit: `correct` is an exact state match; `falseEscalations` counts expected autonomous states (`ready` or `stopped`) that instead land in `approval_required` or `review_required`; `autonomyPct` is correctly matched autonomous decisions divided by the full labeled set, rounded to two decimals. Thus an incorrect autonomous decision cannot inflate autonomy.

## Evidence and availability

- Supply `regression` only from verified adversarial/rule-test evidence or an accurately generated test report. `tests` must be positive; no count or safety badge is synthesized by the harness.
- Labeled metrics are unavailable if the runner is absent, a replay recording is missing, any result fails or is mismatched, or the label set is empty/invalid. Partial results are discarded.
- `liveSample` is optional and accepts only measured per-invoice latency, cost, and failure values. An absent or invalid sample produces an unavailable live section, never zero latency or cost. Its p50 is the median measured latency, `costUsd` is the sum of measured sample costs, and `failures` is the measured failure count. Replay metrics remain separate.
- `EvalReport` has no unavailable state. Check `EvaluationResult.status` before using its `report`; a report exists only when regression evidence and the complete replay-labeled run are available. An available report may omit `live`.

The synthetic decisions in `tests/server/eval.test.ts` exercise scoring only. They are not provider recordings, integration results, or runtime stand-ins.
