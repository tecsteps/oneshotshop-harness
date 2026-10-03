# eval/testplan — hidden functional acceptance test

Never give anything in this directory to a building agent.

| Path | Contents |
|---|---|
| `testplan.md` | the plan: evaluator rules (section 0) and all checks in suites S01–S14 (generated) |
| `weights.md`, `traceability.md`, `results-template.json` | area weights and scoring, requirement → check map, result skeleton (generated) |
| `calc/` | reference calculator (Python stdlib): `print_scenarios.py`, `selfcheck.py`, `delivery.py`, `render.py` + `templates/` |
| `run.sh`, `runner/` | automated runner: app container + host `claude -p` evaluator with headless Playwright MCP |
| `.playwright/` | pinned Playwright MCP + Chromium cache (git-ignored, created by `runner/playwright-setup.sh`) |

## Editing the plan

Edit `calc/templates/testplan.tmpl.md` (and `calc/data.py` / `calc/scenarios.py` for values), then:

```bash
python3 calc/selfcheck.py     # calculator vs. spec text, worked examples, delivery dates
python3 calc/render.py        # regenerates testplan.md, weights.md, traceability.md, results-template.json
```

Never edit `testplan.md` by hand. Every money value in a check comes from the calculator and cites
its scenario (`[calc NAME.field]`).

## Running it

```bash
eval/testplan/run.sh <run-id> [--pass N] [--suites S01,S02] [--checks S01-01,...] [--dry-run] [--headed]
```

Output: `runs/<run-id>/testplan/pass-<N>/` (`preflight.json`, `results.json`, `score.json`,
`suites/`, `transcripts/`, `prompts/`, `logs/`, `helpers.log`, `run.log`). Resumable per suite.
Cost limits: `--budget-usd` (per suite call, default 12), `--recheck-budget-usd` (per second-pass call, default 2.5),
`--recheck-max` (default 25 per suite), `--recheck-suite-budget-usd` (default 8), `--no-recheck`.

Grading is done by the harness, not by the evaluator alone (`runner/grade.py`, applied again by `runner/score.py`):
every result carries verbatim evidence quotes that must occur in the session's tool results; money amounts must
have been shown by the shop; `browser_evaluate` may only read (a PreToolUse hook, `runner/eval_hook.py`, blocks
fetch/click/value-setting scripts); typed URLs, batched actions and out-of-order steps are listed as procedural
deviations in `score.json`. Every FAIL gets a second, independent evaluator call on a fresh reset; it becomes
PASS only with verifiable evidence (both verdicts are in `results.json`). Two browsers are available:
`playwright` (storefront) and `playwright2` (admin). With `expectations.json` + `testplan.evaluator.md`
(see `runner/EXPECTATIONS.md`) the evaluator sees no expected values and values are compared mechanically.
Unit tests: `python3 runner/tests/test_grade.py`; offline re-score of an old pass:
`python3 runner/tests/offline_rescore.py runs/<id>/testplan/pass-1 <scratch-dir>`.
The QA session's requests are profiled passively via `eval/perf/prepare.sh` / `collect.sh`
(`runs/<run-id>/perf/qa-*`).

## Plan validity

The plan's expected values are tied to the calendar. It is valid for evaluations run **until about
2027-02-28**. Before running it later, check and update:

- **Lots:** the FEFO and expired-lot checks assume lot M-2701 (DAI-001, best before 2027-03-31) is
  still sellable and not yet "expiring soon" (30-day window, from 2027-03-01). The sellable stock
  figures (COF-003 120, DAI-001 360, SNK-002 400, FIS-005 30, CAN-001 180) assume the lots listed as
  sellable in `specs/products.md` have not expired. The test lot `F-TEST1` is created relative to the
  run date, so it is fine.
- **Promotions:** every active code and automatic promotion ends on 2027-12-31. The "expired" codes
  (SUMMER25, SPRING2026) and the "not yet valid" code NEWYEAR2028 (valid from 2028-01-01) must keep
  their status.
- **Years:** invoice and credit-note numbers use the current year (`INV-<year>-…`), so they need no change.
  `calc/delivery.py` knows the Berlin public holidays of every year (it computes Easter).
- **What to do:** move the dates in the spec repo (`specs/products.md` lots,
  `specs/discounts.md`). Update the validator's reference date and `calc/data.py` if stock figures
  change. Then run `calc/selfcheck.py`, `calc/render.py` and the spec validator again.
