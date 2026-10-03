# eval/ — evaluating a finished run

Everything here runs **after** a run is finished, on the host, never inside the building
agent's container, and nothing here is ever visible to the building agent. One command drives
it all:

```bash
./oneshotshop evaluate <branch>      # resumable; see the top-level README, "After the run"
./oneshotshop status <branch>        # per-step status, costs, Playwright versions, perf headline
```

## Steps (in `evaluate` order)

| # | Step | Script / docs | Output in `runs/<branch>/` | Cost |
|---|---|---|---|---|
| 1 | gate | [`../verify.sh`](../verify.sh), [`../lib/gate.sh`](../lib/gate.sh) — strict README start command on a fresh clone | `gate.json`, `gate/logs/` | free |
| 2 | tools | [`tools/README.md`](tools/README.md) — pinned code-quality/security tools (static always; ZAP/axe/Lighthouse only if the gate passed) | `tools/summary.json` | free |
| 3 | testplan | [`testplan/testplan.md`](testplan/testplan.md), [`testplan/run.sh`](testplan/run.sh), [`testplan/weights.md`](testplan/weights.md) — functional acceptance test: host `claude -p --model sonnet` driving headless Playwright against the app in a container; skipped if the gate failed | `testplan/pass-1/{preflight,results,score}.json` | **paid** |
| 4 | perf | [`perf/README.md`](perf/README.md) — machine-independent work metrics (queries, N+1, round trips); after testplan so it folds in the QA traffic; skipped if the gate failed | `perf/summary.json` | free |
| 5 | insights | [`insights/README.md`](insights/README.md) — deterministic stats + digest of the agent's transcripts, then host `claude -p --model sonnet` analysis, then `check-insights.mjs` | `insights/{stats,insights}.json`, `insights/insights.md` | **paid** |
| 6 | human | templates in [`../lib/templates/`](../lib/templates/) — your impression and screenshots; never blocks | `human/impression.md`, `human/screenshots/` | — |
| 7 | report | [`../lib/report.mjs`](../lib/report.mjs), schema [`report.schema.json`](report.schema.json) — everything combined, the single input for the website | `report.json` | free |

## Shared rules

- **Same image**: app containers (gate, tools, testplan, perf) use the image id recorded in the
  run's `meta.json`, and start the app with exactly the README start command.
- **Same browser toolset**: the Playwright MCP version is pinned once in
  [`../lib/versions.sh`](../lib/versions.sh). Building agents get it in their container via
  `lib/playwright-mcp-install.sh` + `agents/<agent>/mcp.sh`; the host-side evaluator (testplan,
  perf) installs the same version and its Chromium into the harness-owned cache
  `testplan/.playwright` via [`testplan/runner/playwright-setup.sh`](testplan/runner/playwright-setup.sh).
  `status` and `report.json` show both.
- **Paid steps** run as host `claude -p --model sonnet` with the owner's own Claude Code login
  (no credentials from `.env`), print a note before starting and record their actual cost.
- **Fresh clones only**: every step clones the run branch into a throwaway checkout; the run's
  workspace is never modified (insights reads it at the run head).
