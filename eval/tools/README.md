# eval/tools — deterministic code-quality and security tooling

Step `tools` of the evaluation (`./oneshotshop evaluate` calls it). It runs 11 pinned tools
plus a LOC count against one run branch and writes machine-readable results. Everything runs in
Docker containers; the host needs only `bash`, `git`, `jq`, `curl`, `openssl` and Docker.

```bash
eval/tools/run.sh <run-id>                          # all tools (~5-6 min on an M-series Mac; first time +~2 min for image builds/pulls)
eval/tools/run.sh <run-id> --only semgrep,pint      # re-run some tools; others keep their last result
eval/tools/run.sh <run-id> --keep-work              # keep runs/<id>/tools/.work and the app volume (debugging)
EVAL_GATE_PASSED=0 eval/tools/run.sh <run-id>       # gate failed: ZAP, axe, Lighthouse are "skipped: gate failed"
```

Tool names: `loc readability gitleaks trivy semgrep pint phpmetrics sonarqube axe lighthouse zap tests phpstan`.

## Contract

| Output | Contents |
|---|---|
| `runs/<id>/tools/summary.json` | `schema` `oneshotshop-tools/1`, run/commit/base/image, `pins` (all versions), `agent_configs_ignored`, `loc`, `normalised.per_kloc`, and `tools[]`: one object per tool `{name, version, status: ok\|failed\|skipped\|not_run, reason, started_at, duration_secs, metrics, raw_dir, raw_files}` |
| `runs/<id>/tools/<tool>/result.json` | that tool's object; `summary.json` is rebuilt from these after every invocation |
| `runs/<id>/tools/<tool>/…` | raw tool output (reports, logs) |
| `runs/<id>/tools/pages/pages.json` | storefront URLs found by page discovery (shared by axe and Lighthouse) |
| `runs/<id>/tools/app/` | app preparation (`prepare.json`, step logs), `serve.log` |

Idempotent: a tool's directory is deleted and rewritten each time it runs; other tools are
untouched. Exit code 0 even when tools find problems or fail (the failure is recorded as
`status: failed` + `reason`); non-zero only if the step itself broke (bad arguments, missing
run/meta.json, Docker not reachable, branch cannot be cloned).

`normalised.per_kloc` divides key counts by **cloc code lines** (blank and comment lines excluded): `app_code_kloc` (PHP, Blade,
JS/TS/Vue, CSS, HTML; lock files, vendor, node_modules, storage, public/build excluded) for
SonarQube and Semgrep, `php_kloc` (PHP only) for PHPStan, Pint and PhpMetrics.

## The tools

All versions are pinned in `config/versions.env` (Docker images by tag **and** digest, packages
by exact version; Playwright comes from `lib/versions.sh` so build, gate and evaluation share
one version). All configuration is harness-owned in `config/`.

| # | Tool | Pin | Runs on | Key metrics |
|---|---|---|---|---|
| 1 | SonarQube Community Build + sonar-scanner | `sonarqube:26.9.0.129388-community`, scanner `12.2.0.4256` | committed source | v1 SonarCloud fields: `measures.{bugs, vulnerabilities, codeSmells, securityHotspots, ncloc, duplicatedLinesDensity, reliabilityRating, securityRating, maintainabilityRating}`, `issuesBySeverity`, `totalDebt` (min), `topIssues`, plus cognitive/cyclomatic complexity, debt ratio |
| 2 | Larastan / PHPStan | larastan 3.12.2, phpstan 2.2.16 | prepared app (throwaway volume) | errors at levels 5 and 8 (`app/`, `routes/`), top error identifiers, count of `@phpstan-ignore` comments |
| 3 | Semgrep CE | 1.179.0, community rules at a pinned commit + checksum (fetched, git-ignored) + harness rules in `config/semgrep/harness/` | committed source | findings by severity/category, top rules, `nosemgrep` comment count |
| 4 | Trivy | 0.75.0 | `composer.lock`, `package-lock.json` (dev deps included) | vulnerabilities by severity, per lockfile, vulnerable packages, **DB version + `updated_at`** |
| 5 | OWASP ZAP baseline | `zap-stable:2.17.0` | running app | alerts (types) and instances by risk; spider 2 min, passive rules only |
| 6 | PhpMetrics | 2.9.1 (same as v1) | `app/` | v1 `code-quality.tsx` fields: overview, complexity, maintainability, coupling, violations, halstead, top lists |
| 7 | Gitleaks | 8.30.1 | branch history `base_commit..HEAD` | findings, by rule, committed `.env` files, `APP_KEY` committed |
| 8 | Laravel Pint | 1.32.1, Laravel preset | committed source | files failing `--test` |
| 9 | Agent's own tests | run image + PCOV 1.0.12 | prepared app, **no network** | tests, assertions, passed/failed/errors/skipped, line coverage of `app/` |
| 10 | axe-core via Playwright | axe-core 4.13.0, @axe-core/playwright 4.13.0 | running app, 5 guest pages | violations (rules / nodes) by impact, per page; WCAG 2.0/2.1/2.2 A+AA rules |
| 11 | Lighthouse | 13.5.0 on Playwright's Chromium | running app, 4 guest pages | per page and preset (mobile, desktop): median of 3 runs: 4 category scores, LCP, CLS, TBT, FCP, Speed Index, total bytes, JS bytes, requests, DOM size |
| – | Readability | harness script (`scripts/readability.php`) | committed source, same exclusions as LOC | per group PHP / Blade / JS-TS-Vue / CSS: files, lines, lines > 120 and > 200 chars (absolute and per 1,000 lines), max line length with file:line, average and p95 length (non-blank lines), top-10 longest lines. SonarQube barely analyses Blade; this catches views written as a few 2,000+ character lines |
| – | LOC | cloc 1.96 | committed source | code lines per language |

### Agents cannot tune the measurement

The scan copy is a fresh clone of the committed branch. The agent's own `phpstan.neon*`,
baselines, `pint.json`, `sonar-project.properties`, `.semgrepignore`, `.gitleaks.toml`,
`.gitleaksignore`, `.trivyignore`, `trivy.yaml` are deleted from it (listed in
`agent_configs_ignored`), and every tool gets the harness config explicitly. Semgrep runs with
`--disable-nosem`; inline suppressions that cannot be disabled (`@phpstan-ignore`,
`gitleaks:allow`) are counted and reported.

### How the app is started (shared: `app.sh`)

Tests, PHPStan, ZAP, axe and Lighthouse use `eval/tools/app.sh`, which reproduces the gate:

```bash
eval/tools/app.sh prepare <run-id>   # clone into a Docker volume; composer install, npm ci, npm run build, php artisan migrate --seed (run image from meta.json)
eval/tools/app.sh start   <run-id>   # php artisan serve --host=127.0.0.1 --port=8000 on an INTERNAL network; waits for GET / = 200
eval/tools/app.sh reseed  <run-id>   # php artisan migrate:fresh --seed --force
eval/tools/app.sh stop|clean <run-id>
# clients: docker run --network container:$(eval/tools/app.sh name <run-id>) ... http://127.0.0.1:8000
```

Same image id, same commands, same hardening as `lib/gate.sh`; the app container has no
internet. Browser tools and ZAP join its network namespace, so they use the exact URL the gate
probes. Order: page discovery → axe → reseed → Lighthouse → reseed → ZAP → stop → tests →
PHPStan (last: it `composer require`s Larastan into the throwaway copy). Reusable by `eval/perf`
(use `--name` to get a separate container/volume).

### Page discovery (axe, Lighthouse)

`scripts/browser-lib.mjs`, as a guest, starting at `/` and following visible links only:
category = the home link named like "Water & Soft Drinks", else the first link with a
category-like path; products WAT-001 and NF-005 = the site search (fill SKU, Enter, open a
result that shows the SKU), else the category page; cart = the home link to a cart path. A page
that cannot be reached is recorded as `skipped` with the reason (e.g. "cart redirects guests to
sign-in").

## Caveats (read before comparing runs)

- **Trivy's vulnerability DB changes daily.** `metrics.db.updated_at` is recorded; compare runs
  only when they were scanned with the same DB. To rescan several runs against one DB snapshot,
  run them together, with `TOOLS_TRIVY_SKIP_DB_UPDATE=1` after the first.
- **Lighthouse performance scores still depend on the machine** (simulated throttling reduces,
  but does not remove, host-CPU influence; the median of 3 runs reduces noise). Score all builds
  on the same machine with nothing else heavy running.
- SonarQube: a fresh server per scan, so there is no "new code" period; the default quality gate
  only checks new-code conditions and therefore reads `OK` with no conditions. Use the measures
  and ratings, not `qualityGate`, to compare (v1 used SonarCloud PR analysis).
  Server mode is "Standard Experience" to keep bugs/vulnerabilities/code smells (v1 terms).
- The sonar-scanner image is amd64-only; on Apple Silicon it runs emulated (works, slower).
- Semgrep community rules are **not in git** (Semgrep Rules License v1.0): `config/semgrep/vendor.sh`
  fetches the selected directories of `semgrep/semgrep-rules` at a pinned commit into the
  git-ignored `config/semgrep/rules/` and verifies a SHA-256 over the rule files; the Semgrep tool
  calls it automatically when the rules are missing or do not match (`vendor.sh --check` verifies
  only). Scans themselves run with `--network none`. Harness Blade rules: `config/semgrep/harness/`.
- Tests run on the prepared app (after `migrate --seed`) with the project's own `phpunit.xml`;
  coverage is restricted to `app/` (`--coverage-filter app`). They run with `--network none` for
  determinism: a suite that fails only because it needs the network is a legitimate finding
  (`metrics.note` points to it).
- App preparation retries `composer install` once (`rm -rf vendor`, logged as step
  `composer-install-retry`, first attempt in `logs/composer-install.attempt1.log`) because of an
  occasional transient extraction failure; everything else is exactly the gate. Runner: `vendor/bin/pest`, else
  `vendor/bin/phpunit` (what `php artisan test` wraps).
- SonarQube needs ~3 GB RAM while it runs; it is started for the scan and removed afterwards.

## Files

```
run.sh                 entry point (orchestration, summary.json)
app.sh                 prepare/start/reseed/stop the app like the gate (shared)
lib/common.sh          helpers, pins, derived tool images
lib/tools/<tool>.sh    one function per tool
scripts/               in-container scripts (prepare, tests, phpstan, browser tools, summarisers)
docker/                derived images FROM the run image: PHP tools (PCOV, Pint, PhpMetrics, cloc), browser tools
config/                versions.env, pint.json, sonar-project.properties, gitleaks.toml, semgrepignore,
                       semgrep/vendor.sh (pinned fetch), semgrep/harness/ (own rules); PHPStan config is generated in the container
```

Docker objects: images `oneshotshop-tools-{base,php,browser}:*`, volume
`oneshotshop-tools-trivy-cache`, per run (removed afterwards) container/volume
`oneshotshop-tools-app-<id>`, `oneshotshop-tools-sonar-<id>`, label `oneshotshop.tools=<id>`.
