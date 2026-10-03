# eval/codequality — AI + static code-quality evaluation against a fixed rule catalogue

Judges the code of one run against a **fixed, versioned, weighted rule catalogue**
([`rules.yaml`](rules.yaml), human-readable [`rules.md`](rules.md)). Every build gets the identical
procedure: deterministic extraction and sampling, then many **small, isolated, stateless** AI calls
(one unit + the checklist for its kind), mechanical evidence verification, and deterministic scoring.
Rules that a script can decide are **static** and never sent to the AI.

```bash
eval/codequality/run.sh <run-id>                          # -> runs/<id>/codequality/summary.json
eval/codequality/run.sh <run-id> --calibrate --repeat 3   # -> runs/<id>/codequality/calibration/agreement.json
eval/codequality/run.sh <run-id> --concurrency 24 --budget-usd 3
node --test eval/codequality/test/*.test.mjs              # offline tests (no Docker, no Codex), ~1 s
node eval/codequality/lib/catalogue.mjs check|hash|render # validate the catalogue / print its hash / regenerate rules.md
```

Requires on the host: `codex` CLI logged in with the owner's Codex account (≥ 0.160.0), Node ≥ 22,
Docker, `jq`, `git`. Pinned dependencies are installed by `lib/setup.sh` into git-ignored,
harness-owned locations: `node_modules/` (intelephense 1.18.5, yaml 2.9.1 — `package-lock.json`)
and `.cache/php-tools/` (nikic/php-parser 5.9.0 — `php/composer.lock`, installed with the run
image's composer).

## Pipeline

| # | Step | AI? | What |
|---|---|---|---|
| 1 | extract | no | fresh clone of the run branch → `.work/src`; **AST inventory** (`php/inventory.php`, nikic/php-parser, run image, `--network none`): classes with kind, methods (statements, cyclomatic complexity, nesting, params), dependencies, private members, model `$fillable/$guarded/casts`, per-file facts (env(), app()/resolve(), raw SQL with interpolation, mass assignment from request data, magic numbers, statement density, empty catch), Blade views (`{!!`, POST forms without `@csrf`), tests, route registrations, migrations. App prepared exactly like the gate (`eval/tools/app.sh prepare`: composer install, npm ci, build, `migrate --seed`), then **schema dump** (`php/schema.php`: tables, columns, types, indexes, FKs, row counts), `route:list --json`, and `vendor/` copied into the read-only build copy for the language server. If the app cannot be prepared, the schema unit is judged from the migrations and DB static rules are N/A |
| 2 | sample | no | units = classes (by kind), Blade views, test files, route files, the schema. Per kind: the `top` largest (by characters) + `random` picks ordered by `sha256("<catalogue version>:<unit id>")` (the seed is the catalogue version, never the branch). Caps in `rules.yaml → procedure.sampling` (≤ 90 units; units < 200 chars skipped) |
| 3 | judge | **yes** | one `codex exec` per unit (see "AI calls"); answers every applicable rule as `pass|fail|na` with evidence `[{file, line_start, line_end, quote}]` and a reason; `--output-schema` + own schema validation |
| 4 | verify | no | every evidence item: file inside the build, line range valid (≤ 40 lines), quote (whitespace-normalised) occurs in those lines (±1 line tolerated). A fail needs ≥ 1 valid item. Invalid → the rule is **re-asked once** (same prompt + the concrete problems); still invalid → `unverified` (excluded from scores) |
| 5 | score | no | AI rule score = pass / (pass + fail) over sampled units; static rules from `lib/static-checks.mjs` (inventory, schema dump, `tools/summary.json`, `perf/summary.json`); category score (0–100) = rule-weighted mean; **CQI** = category-weighted mean; plus AI-only and static-only indices and the tools' per-KLOC metrics |
| 6 | calibrate | yes | `--calibrate --repeat N`: N independent judging passes over the same sample; per-rule unanimity, pairwise agreement, Fleiss' κ; rules below `procedure.calibration.min_unanimity` (0.80) are flagged for rewording |

## AI calls (isolation, parallelism, caching)

- **One call = one unit.** A fresh, ephemeral `codex exec --ephemeral --ignore-user-config -s read-only`
  process with `-m gpt-6-luna -c model_reasoning_effort=none` (lowest effort the API accepts for Luna;
  `minimal` is rejected), in an empty private temp directory, prompt on stdin, final answer to its
  own `-o` file, strict timeout (`procedure.call_timeout_secs`). No thread reuse, no `resume`.
  Shell, web search, apps, plugins, multi-agent, image, browser and computer-use tools are disabled
  (`lib/codex.mjs → DISABLED_FEATURES`); the only tools are the code-navigation MCP tools.
- **Prompt layout** (identical prefix first, unit last): base instructions
  [`prompts/instructions.md`](prompts/instructions.md) via `model_instructions_file` (replaces Codex's
  coding-agent prompt; identical for every call) → checklist for the unit kind (identical across calls
  and builds) → repo map (identical within a build) → unit context + numbered source. Environment
  context, permission/app/collaboration instructions and AGENTS.md are switched off so nothing
  call-specific precedes the unit.
- **Shared language server:** ONE Intelephense per build, pre-indexed once
  (`lib/lsp-bridge.mjs`), exposed to all concurrent calls as a read-only MCP server over HTTP
  (`http://127.0.0.1:<port>/mcp/<call-id>`): `find_symbol`, `definition`, `references`, `hover`,
  `document_symbols`, `read_lines` (paths confined to the build copy; no edit/rename tools). LSP
  requests are multiplexed by id over one stdio connection; tool usage is logged per call in
  `lsp-tools.jsonl`.
- **Parallelism:** bounded pool (default 16, max 32) with adaptive backoff: a rate-limit/usage error
  in the JSON events halves the concurrency and pauses (20 s doubling to 10 min), success streaks
  restore it. A global API-equivalent budget (`--budget-usd`, default 5) stops new calls (status
  `incomplete`). No wall-clock cutoff: the evaluation always runs to completion.
- **Resumable:** every unit's state lives in `calls/<unit>/result.json` keyed by the prompt hash;
  a re-run skips finished units (`--force` re-judges).
- **Prompt caching:** measured, see "Results". Codex sends its thread id as `prompt_cache_key`, so a
  fresh ephemeral process per call cannot share the provider cache beyond a small global prefix;
  forking a per-kind primer session was tested and did not pay off (it duplicates the prefix). The
  stable-prefix layout is kept so caching works automatically if Codex ever allows a fixed key.

## Outputs: `runs/<id>/codequality/`

| File | Contents |
|---|---|
| `summary.json` | `oneshotshop-codequality/1` ([schema](schema/summary.schema.json)): catalogue version + sha256, model, LSP, `scores` (CQI, AI/static indices, categories), per-rule results, unit counts, judgement/evidence stats, usage (tokens, cached share, API-equivalent USD, latency p50/p95), timing (extract, judge wall time, peak concurrency, backoffs), static metrics (tools per KLOC, perf headline) |
| `judgements.jsonl` | one line per (unit, rule): verdict, reason, evidence, `verified|unverified|missing`, re-asked |
| `static.json` | every static rule: value, score, instances, offenders (file:line) |
| `units.json` | the sample with `selected_by: top|hash` |
| `calls/<unit>/` | prompt, Codex JSON events, final message, `result.json` per attempt |
| `calls.jsonl` | one line per Codex call: duration, tokens, cost, rate limit, tool calls |
| `prompt/` | instructions, per-kind checklist + response schema, repo map (exactly what was sent) |
| `extract/` | `inventory.json`, `schema.json`, `routes.json`, `extract.json`, app logs |
| `calibration/rep-N/`, `calibration/agreement.json` | calibration passes and the agreement report |
| `.work/src` | read-only build copy (+ vendor/) used by the language server and the evidence checks (`--clean` removes it) |

## Catalogue version

Owner-approved catalogue: **version `1.0.0`**, sha256 `7c806f0eccc222ee80fdb908287bca368845fdb5e94705159b98fe2df2ee11c7`
(recorded in `config/versions.env`; every `summary.json` records the version, hash and `matches_approved`).

## Changing the catalogue

Edit `rules.yaml`, bump `catalogue.version`, run `node eval/codequality/lib/catalogue.mjs render`
(the tests fail if `rules.md` is stale), and after owner approval record the new version + hash
(`node eval/codequality/lib/catalogue.mjs hash`) in `config/versions.env` and above (the tests fail
until they match; runs warn and set `matches_approved: false`). Scores are comparable only between builds judged with the
same catalogue hash (recorded in `summary.json`). Run a calibration after rewording rules.
