# Tasks: add-grounded-review

## 1. copperhead-tools client

- [x] 1.1 `src/review/tools-client.ts`: resolve `--tools`, `COPPERHEAD_TOOLS`, or `copperhead-tools` on PATH; `run <tool>` with the request on stdin; not-run and error results become errors
- [x] 1.2 Tests use an injected client; no test spawns copperhead-tools

## 2. Passes

- [x] 2.1 `src/review/prompts.ts`: rules, the bundle digest (parts, every net, the sweep, what it did not examine, sources), eight domain scopes; templates hashed
- [x] 2.2 `src/review/pass.ts`: query tools (parts, nets, pins, sweep, sources, search, read, board, placement, routing, measure, calculators, calc), `propose` with a `review-verify` pre-check, `submit`; domain-prefixed ids; turn, time and per-turn timeout budgets; sample saved every turn
- [x] 2.3 Tests: a pass with a scripted provider (queries, a pre-checked proposal, submit); stall and turn exhaustion with the warning

## 3. Run, record and replay

- [x] 3.1 `src/review/run.ts`: sweep (with `--fab` and `--fab-profile`), bundle (fab files as sources), parallel passes, merged proposals, verify, report, lockfile
- [x] 3.2 `--replay`: refuse changed proposals; re-verify into `replay/`; byte comparison
- [x] 3.3 Tests: a two-domain run never writes the design, records samples and the lockfile, and replays identically; tampered proposals are refused; `--out` inside the design or not empty is refused
- [x] 3.4 `--resume`: reuse sweep and bundle, keep ended passes, rerun the rest (an interrupted sample kept aside); a timed-out turn retried once; tests for both

## 4. CLI and protocol

- [x] 4.1 `copperhead review` in `src/cli.ts`, lazily imported
- [x] 4.2 Text tool protocol reads `arguments`, `parameters`, `input` and flat arguments; protocol tests
- [x] 4.3 SPEC.md section 3 gains the `review` command
- [x] 4.4 Run typecheck, the test suite, the build and `openspec validate add-grounded-review --strict`

## 5. Review fixes (PR #361)

- [x] 5.1 Redact pass summaries in `model/passes.json` and the progress lines; an `sk-` run glued to a word is a key only when long and holding a digit, so "mask-defined" quotations survive redaction verbatim
- [x] 5.2 Check `--out` against the design and every `--source` and `--fab` input through symbolic links
- [x] 5.3 Save the sample after a turn with no tool call and after a timed-out turn; write samples atomically; rerun a pass whose sample does not parse
- [x] 5.4 Refuse budgets that are not positive numbers before writing anything
- [x] 5.5 Inactivity watchdog and rate-limit backoff for pass turns; a specific nudge for a call written as an `<invoke>` block
- [x] 5.6 SIGINT and SIGTERM cancel the run and stop its subprocesses; exit codes 0, 2, 1, 130 and 143
- [x] 5.7 Lockfile paths relative to the working directory; replay checks the bundle's hash; a pass whose provider cannot start writes its sample and its `pass ends` line
- [x] 5.8 Tests for each, failing before the fix; a live one-domain run, its cancel, resume and byte-identical replay
