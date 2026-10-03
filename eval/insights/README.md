# eval/insights — post-run insights for #OneShotShop v2

Turns one finished run into evidence for the LinkedIn posts and the agentic-engineers.dev build
pages: how the agent worked, what it decided and why, where it struggled, how it handled the
hard B2B cases, how it tested itself, and the numbers.

Three stages, only the last one costs money:

| Stage | Tool | Output (in `runs/<run-id>/insights/`) |
|---|---|---|
| 1. deterministic numbers | `extract.mjs` | `stats.json` |
| 2. readable, redacted transcript | `condense.mjs` | `digest.md` (≤ 150k chars by default) |
| 3. analysis (owner launches a paid agent) | `insights-prompt.md` → `analysis-prompt.md` | `insights.md`, `insights.json` |

Node ≥ 18 and git only. No npm dependencies, no network. Inputs are never modified: git is read
with `log`/`ls-tree`/`cat-file`/`show` on the run ref, nothing is checked out.

## Run it

```bash
eval/insights/insights.sh <run-id>
# options: --runs-dir DIR  --out DIR  --repo DIR  --budget 150000  --agent codex|claude|cursor|opencode  --usage-csv FILE
```

It runs stages 1 and 2, renders `analysis-prompt.md` with absolute paths and prints the exact
`claude -p --model sonnet …` command for stage 3 (Claude Sonnet, version not pinned; it never
starts an agent). The printed command runs the
analyst from the insights directory with the run checkout added read-only (`--add-dir`, writes
to the repo denied), so the run's own `CLAUDE.md`/`AGENTS.md` are not loaded as instructions.
Afterwards:

```bash
node eval/insights/check-insights.mjs runs/<run-id>/insights   # structure + every number traced to stats.json
```

The scripts also work standalone, e.g. on v1 logs:

```bash
node eval/insights/extract.mjs  --transcripts <dir|file>... --repo <git dir> --ref <branch> [--base <ref>] [--since ISO] [--until ISO] --out stats.json
node eval/insights/condense.mjs --transcripts <dir|file>... --budget 150000 --out digest.md
```

Defaults with `--run-dir runs/<id>`: transcripts from `transcripts/` (searched recursively, format
auto-detected), repo `workspace/`, ref `meta.result.head`, base `meta.result.base_commit`
(else `meta.spec.commit`, else merge-base with `main`). Time-window filters for Cursor come from
`meta.first_session_start`/`finished_at`.

`--since`/`--until` restrict the transcripts to the build window (both scripts). Use them when a
session continued after the build (e.g. a later "is everything committed?" chat in the same
Codex session).

**The analyst reads the working tree**, so `--repo` must be checked out at the run head
(`insights.sh` warns if it is not). For an old branch, point `--repo` at a clone of it.

## What `stats.json` contains

- `duration.transcript` — website rule: wall = first..last timestamp over **all** transcript files;
  every gap > 30 min in the union timeline (no agent wrote anything) is idle and subtracted.
  `duration.harness` repeats the harness's own `meta.json` timing for comparison.
- `activity` — model requests, user turns, compactions, tool calls (total / orchestrator /
  sub-agents, by tool and by inner tool for Codex `exec`), shell commands by category
  (`composer`, `npm`, `artisan`, `tests`, `git`, `playwright`, `other`; compound commands are split
  into segments and classified by each segment's leading command), failed commands, retries after
  a failure, top failing commands, test runs with pass/fail and the runner's summary line
  (`Tests: 1 failed, 35 passed`), MCP calls per server, Playwright MCP calls, sub-agents.
- `tokens`, `cost` — see rules below. `cost` is the API list-price equivalent.
- `git` — commits (hash, time, author, subject, body, +/−, files) between base and head, hourly
  timeline buckets from the run start, LOC per language at head (excludes `vendor/`,
  `node_modules/`, public build output, `storage/`, lock files, binaries), tests (files and test
  cases: PHPUnit methods, `#[Test]`, Pest `it()/test()`, JS `test()/it()`; by kind), migrations,
  tables created, models/seeders/factories, FTS5 usage, app structure (Livewire/Volt/Filament/
  controllers/Blade/Vue/React/Alpine/routes), `stack` (Laravel/PHP versions, frontend flags,
  notable packages by category with locked versions, composer/npm diff vs base) and
  `hardCaseKeywordHits` (pointers for the analyst, **not** evidence that a case works).
- `agentReported` — the agent's own numbers where they exist (Claude `result.total_cost_usd` in
  `agent.jsonl`, Claude Code `cost-state`, OpenCode cost), for cross-checks only.
- `warnings` — read them; they carry caveats that must travel with the numbers.

## Token and cost rules (comparable with v1)

Implemented from the agentic-engineers.dev `CLAUDE.md` and `scripts/parse-*.mjs`:

- **Claude Code**: per `requestId` keep the streaming chunk with the highest `output_tokens`;
  dedupe requestIds globally (main first, then sub-agents in start order) to neutralise
  compaction chains; price every request at its own model. Sub-agents are clustered by requestId
  containment (union-find, ≥ 0.8) and dead clusters (0 tool calls) are excluded from the active
  count; the count is checked against `Agent`/`Task` spawns. Tool calls are counted once per
  `tool_use` id, so checkpoint replays do not inflate them.
- **Codex**: `input_tokens` includes `cached_input_tokens`; the 272K tier is applied per request
  prompt size (`last_token_usage.input_tokens`), blended per token class and applied to the
  totals; `custom_tool_call` counts as a tool call and shell commands are read from the `exec`
  program. Counter handling: see the next section.
- **Cursor**: the transcripts have no tokens or models. Pass Cursor's usage-events CSV with
  `--usage-csv`; rows are filtered to the run window, `Errored`/`Free` rows skipped, each row
  priced at its model. Map CSV model names with `--model-map '{"cursor-name":"pricing-id"}'`.
- **OpenCode** (experimental, unverified on a real build): per-message tokens from
  `opencode.db` via the `sqlite3` CLI.

### Pricing

`pricing.json` (USD per 1M tokens, `takenAt` + per-model `fetchedAt` and source URL) holds the
rates the website used for v1 plus current official prices fetched on 2026-10-02 for the models
expected in v2: `gpt-6.1-sol` ($2.00 / cached $0.10 / cache write $2.50 / output $10.00; > 272K
prompt: $4.00 / $0.20 / $5.00 / $15.00, from developers.openai.com/api/docs/pricing) and Claude
Opus 5.5, Opus 5, Sonnet 5.5, Sonnet 5, Haiku 4.5, Fable 5.1 (platform.claude.com pricing page,
including 1-hour cache-write rates, which are applied when Claude Code logs them separately).
Entries are matched in order, first match wins. `gpt-5.6-sol` deliberately keeps the v1 website
rate ($5 / $0.50 / $30) so v1 corrections change only the counting method; its current official
rate is noted in the entry. A model that matches no entry is reported unpriced (cost `null` or
`partial: true`) and listed in `warnings`, never guessed. To add a model, fetch the OpenRouter
price as described in the website's `CLAUDE.md` ("How to fetch live model prices from
OpenRouter"), add an entry with its `fetchedAt`, and update `takenAt`.

### Codex counters — differs from the v1 website rule

The website's rule for Codex team runs (CLI 0.144.x, build #15) is "sub-agent rollouts snapshot
one shared process-wide counter, never sum them". Re-checking the local logs of build #15
shows a different mechanism:

- every forked sub-agent rollout starts with a verbatim **copy of the parent's history**
  (including the parent's `token_count` events), and its own work starts at the first
  `agent_message` addressed to it;
- after that point each child's counter advances **only by its own requests**
  (`delta(total.input) == own last_token_usage.input` in 93–100 % of steps, while 16 agents ran
  in parallel, which a live shared counter cannot do); it just **starts from the parent's
  counter value at fork time** (a baseline; e.g. Galileo starts at 124.1M and adds 1.0M);
- the website's 80–98 % "membership" came from the copied parent history; on the child's own
  steps it is 0 %.

So the extractor counts, per rollout, its **own usage = final total − starting counter**
(= the sum of its own per-request `last_token_usage`), summed over root sessions, auxiliary
sessions (e.g. the auto-review "guardian") and every child whose counter advances only by its
own requests. For CLI ≥ 0.147 (independent counters, baseline 0) this equals the website rule.
The website rule is still computed for comparison in `tokens.websiteRule`.

Two caveats are reported in `warnings`: some 0.144 child rollouts are rewritten with one
timestamp for all entries ("paginated"), so their events cannot be timed; and when a child
starts at a non-zero counter without visible parent history, its earlier usage may have been
pruned, so the cost is a **lower bound**.

## Verification on v1 logs (2026-10-02)

Local v1 Codex logs (`~/.codex/sessions/2026/07/12`, `…/04/25`) with the code from the
`tecsteps/shop` clone in `~/Herd/shop`:

| Build | Website (`build-metrics.ts` / `*-data.json`) | extract.mjs | Difference explained |
|---|---|---|---|
| `2026-07-12-codex-gpt-5-6-sol-ultra` duration | 2h 54m 36s (175 min) | 2h 54m 36s | identical |
| … tokens, website rule (2 cli + 8 guardian rollouts) | in 165,865,019 / cached 163,052,032 / out 313,223 | identical | — |
| … cost, website rule | $119.74 | $120.77 | tier mix: the local logs give high-tier shares 6.8 / 17.6 / 9.5 % (uncached / cached / output), the stored data 5.9 / 16.5 / 9.4 %; token totals are identical |
| … cost, recommended (own usage incl. 16 sub-agents) | — | **$204.31** (lower bound) | the website excluded the sub-agents' own work, see "Codex counters" |
| … orchestrator tool calls | 817 | 817 | identical |
| … sub-agent tool calls | 1,411 | 875 | the website also counted the parent history copied into each child |
| `2026-04-25-codex-gpt-5-5` duration | 47m 38s (48 min) | 47m 38s | identical |
| `codex-subagents` (CLI 0.99) cost, main session only | in 37,108,094 (incl. a next-day "is everything committed?" chat) | 36,182,160 within the build window | the website kept post-build chat in the same session |
| … cost incl. 13 sub-agents (window) | $8.79 | $24.30 | sub-agents (gpt-5.3-codex + gpt-5.1-codex-mini, own counters) were never counted; 3 of 16 spawn calls failed ("agent thread limit reached"), so 13 sub-agents, not 16 |
| `codex-subagents-2` (CLI 0.101) main session | in 100,616,514, $28.40 | identical | — |
| … cost incl. 45 sub-agents | $28.40 | $52.26 | 8 of 53 spawn calls failed; 45 sub-agents ran (44 with tool calls) |
| `2026-05-04-codex-5-5-goal` main session (window) | in 820,496,265, $530.26 | identical | — |
| … cost incl. 18 sub-agents | $530.26 | $570.95 | sub-agents not counted by the v1 parser |
| … main-session tokens / cost | in 24,863,640, $18.85 | identical, $18.85 | — |
| … cost incl. sub-agents | $18.85 | $20.85 | the v1 parser read only the main file; 3 explorer sub-agents (own counters) add $2.00 |
| … tool calls | 136 | 180 (main) | v1 counted `function_call` only; +44 `apply_patch` `custom_tool_call` (website rule 5) |

No v1 Claude Code shop transcript exists on this machine; the Claude Code path was exercised on
a 284 MB / 113-file local Claude Code session (96 h, 112 sub-agent files) and on the synthetic
fixtures of the self-test.

## Condenser

`digest.md` is chronological across all agents: `HH:MM:SS (UTC) +H:MM [agent] KIND: text`.
The agent's own messages (`SAY`), plans (`PLAN`), sub-agent spawns with briefs (`SPAWN`),
inter-agent messages (`MSG`) and prompts are kept verbatim up to a length that depends on the
level; every tool call is one line (`$ cmd -> exit N [Tests: …]`); failures are marked `!!` with
their error lines; re-runs after a failure get `(retry #n, recovered|still failing)`; commits are
marked `COMMIT`. It renders at six levels of detail (collapsing routine reads, then all
successful calls per agent, then sub-agent internals, then shorter texts) and picks the most
detailed one that fits `--budget`; if even the coarsest does not fit, the lowest-priority lines
are dropped and the gaps marked. Encrypted Codex payloads (sub-agent briefs in CLI 0.144) are
shown as such, not guessed.

### Redaction

Applied to every string in `digest.md` and `stats.json`, before truncation:

1. exact values from `--secrets-file` files (`insights.sh` passes the harness `.env`,
   `secrets.env` and the run's `workspace/.env*`);
2. known formats: Anthropic/OpenAI/Stripe/GitHub/GitLab/Slack/AWS/Google keys, JWTs, private key
   blocks, Laravel `APP_KEY` (`base64:…`), `Authorization` headers, credentials in URLs,
   `*KEY|SECRET|TOKEN|PASSWORD…=value` assignments, quoted `password/secret/api_key` values,
   `?token=` style query/flag values, data URIs and encrypted blobs;
3. an entropy heuristic for long random tokens (git hashes, UUIDs, dates, slugs and identifiers
   are kept because they are evidence).

Over-redaction is accepted. Still review `digest.md` before publishing anything from it.

## Self-test

```bash
node eval/insights/test/selftest.mjs
```

Unit-tests the redactor (15 planted fake secret formats removed, 11 benign evidence strings
kept) and runs extract + condense end to end on generated Codex and Claude Code transcripts
(> 2 MB each, planted secrets in prompts, commands, outputs, sub-agent briefs and URLs) with a
20k budget: digest within budget, no planted secret in `digest.md` or `stats.json`, cost, tool,
test-run and Playwright counts present.

## Limitations

- Codex 0.144-style runs: cost is a lower bound when a child starts from a counter without visible
  history; paginated child rollouts have no per-event timestamps; sub-agent briefs are encrypted.
- Codex exec programs in 0.144 often return output without an exit code, so many commands are
  `unknown` (test outcomes are still read from the runner's summary line).
- Cursor cost requires the usage CSV; OpenCode support is untested on a real build.
- `hardCaseKeywordHits` and test counts are regex-based pointers, not proof.
- Claude Code costs are list-price equivalents (subscription runs are not billed per token);
  1M-context long-prompt surcharges are not modelled (the website does not either).
- New agent CLIs change their log formats; re-run the self-test and one known run after upgrades.

## Files

| File | Purpose |
|---|---|
| `insights.sh` | runner for one run id |
| `extract.mjs` | stats.json |
| `condense.mjs` | digest.md |
| `insights-prompt.md` | analysis prompt template (rendered to `analysis-prompt.md`) |
| `insights.schema.json` | JSON Schema of `insights.json` |
| `check-insights.mjs` | validates the analyst's output and traces every number to stats.json |
| `pricing.json` | price table with dates and sources |
| `lib/adapters/{codex,claude,cursor,opencode}.mjs` | per-agent transcript parsers |
| `lib/git.mjs`, `lib/redact.mjs`, `lib/transcripts.mjs`, `lib/util.mjs`, `lib/pricing.mjs`, `lib/args.mjs` | shared code |
| `test/selftest.mjs` | redaction + budget self-test with planted fake secrets |
