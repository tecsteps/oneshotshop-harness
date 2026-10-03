# eval/perf — performance efficiency (machine-independent work metrics)

Compares how efficiently each agent-built shop **executes**, without assuming its UI
architecture (Blade + Livewire, Alpine, Inertia + Vue/React, Filament, a JSON API + SPA, …) and
without using seconds as the measure (seconds depend on the owner's CPU). It measures work:

- SQL queries per request, repeated statement shapes, **N+1** (same normalized statement ≥ 5× in
  one request), exact duplicates (same SQL + same bindings), writes
- query complexity: `EXPLAIN QUERY PLAN` for every statement shape seen → full table scans, full
  index scans, temp B-trees, **missing-index suspects** (full scan of a table ≥ 50 rows filtered
  by `=`/`IN`/range on a column no index leads with), estimated rows examined (rows × executions)
- PHP peak memory and request/response body bytes per request
- **backend round trips per user action** (Livewire updates, Inertia visits, SPA API calls and
  full page loads become directly comparable) and the bytes they move
- `*_ms` values (request duration, query time, action wall time) are recorded as **secondary** only

Initial page weight (JS/CSS/transfer bytes, request count, DOM size on load) is **not** measured
here: Lighthouse in `eval/tools/` covers it for home/category/product.

## Run it

```bash
eval/perf/run.sh <run-id>                 # -> runs/<run-id>/perf/summary.json (+ raw files)
eval/perf/run.sh <run-id> --aggregate-only   # rebuild summary.json, e.g. after the QA session wrote qa-*.{jsonl,json}
# options: --workspace DIR --out DIR --image REF --port N --cpus N --memory SIZE --keep
```

Needs Docker, Node ≥ 18 and `playwright-core` + Chromium: it reuses the pinned cache of
`eval/testplan/.playwright` (installs it via `eval/testplan/runner/playwright-setup.sh` if missing).
No paid agent, no tokens. ~1 minute plus the app's install/build time.

Steps: fresh clone of the run branch into `runs/<id>/perf/.checkout` (throwaway, deleted
afterwards) → app container from the run's recorded image running exactly the README start
command (as `lib/gate.sh`, server on 0.0.0.0:8000 → `127.0.0.1:<free port>`) → `prepare.sh`
→ `journey.mjs` → `collect.sh` → `aggregate.mjs`.

## Contract for other steps (QA/testplan, tools): opt in with two calls

Any step that starts the app **in a container from a throwaway copy** of the workspace can
capture every request the app serves during its session:

```bash
# after `composer install` ran in the container (before or after `php artisan serve` starts):
eval/perf/prepare.sh --container "$C" [--workdir /workspace] [--reset] [--check-url http://127.0.0.1:$PORT/]
#   stdout: {"ok":true,"method":"composer-require|autoload-fallback|already-installed","notes":[...]}
#   exit 1 if it failed -> log it and carry on; it must never fail your step.

# at the end of the session, while the container still runs:
eval/perf/collect.sh --container "$C" runs/<run-id>/perf --prefix qa-
#   -> runs/<run-id>/perf/qa-requests.jsonl, runs/<run-id>/perf/qa-explain.json
```

For the functional QA session (testplan), use exactly `--prefix qa-`; `run.sh` (or
`run.sh <id> --aggregate-only`) folds those files into `summary.json` (`server.qa`,
`headline.qa_server`). Order does not matter: if the perf step ran first, re-run it with
`--aggregate-only` after QA. `migrate:fresh` resets (e.g. `shop-reset`) do not affect the probe.

What `prepare.sh` does to the copy (never to the run branch): adds a `path` repository
pointing at `/tmp/oss-perf-probe` and `composer require --dev oneshotshop/perf-probe` (copies, no
symlink); package discovery registers the provider. Fallbacks: if discovery is disabled
(`dont-discover`) the provider is added to `bootstrap/providers.php` (Laravel 11+) or
`config/app.php` (Laravel 10); if `composer require` fails, composer.json/lock are restored and a
PSR-4 autoload entry + manual provider registration are used instead. Then it creates
`storage/perf/ENABLED`. Enabling is a file, not an env var, because `php artisan serve` does not
pass custom env vars to the built-in server process.

What the app then does differently: one JSON line per HTTP request appended to
`storage/perf/requests.jsonl`, one sample per new statement shape in `storage/perf/samples/`,
and an `X-OSS-Perf-Id` response header. CLI commands (migrate, seed, tests, queue) are not
recorded. Requests with `oss-perf-check` in the User-Agent are excluded from aggregation; the
journey marks its own with `oss-perf-journey`.

## Files

| File | Role |
|---|---|
| `probe/` | Laravel package `oneshotshop/perf-probe` (no dependencies; Laravel 10–13): `DB::listen` + `RequestHandled` + `terminating` → `requests.jsonl`; `php artisan oss-perf:explain` |
| `probe-install.sh` | in-container installer (piped in by `prepare.sh`) |
| `prepare.sh`, `collect.sh` | the opt-in contract above |
| `app-setup.sh` | in-container README start command for `run.sh` |
| `journey.mjs` | fixed guest + customer journey in host Chromium, per-action round trips |
| `stack.mjs` | declared stack from composer.json/lock and package.json files |
| `aggregate.mjs` | → `summary.json` |
| `run.sh` | the whole step |

## Per-request record (`*requests.jsonl`)

`id, ts, kind` (`html | livewire | inertia | inertia-redirect | json | redirect | file | asset |
other`, detected from request/response headers and content type, never from the build's code),
`req {method, path, query, route_name, route_uri, action, bytes, xhr, x_livewire, x_inertia,
referer_path, ua_marker}`, `resp {status, content_type, bytes, location_path}`, `db {queries,
distinct, repeated_executions, exact_duplicates, writes, n_plus_one[], time_ms, statements[{h,
sql (normalized), n, ms, distinct_bindings}]}`, `memory_peak_bytes`, `duration_ms`, `extra`
(Livewire: component names, calls, updates, page path, snapshot bytes; Livewire response:
components + HTML bytes; HTML: `wire:id` component count, snapshot bytes, Inertia page-object
bytes/component; Inertia JSON visit: props bytes and keys).

Page typing for aggregation is loose and URL-based (`admin, auth, checkout, cart, search, account,
product, category, home, api-other, other`); Livewire updates are attributed to the page path in
their snapshot, XHR/JSON calls to their Referer. Static assets streamed through a Laravel route
(e.g. `livewire.js`) are kind `asset` and excluded from per-request statistics.

## The journey

Fixed data from the spec: customer C-10001 (`einkauf@osthafen-kueche.example`), product
WAT-001, packaging "box", promo code WELCOME10. Elements are found only by ARIA role, visible
text, label, placeholder or generic input type; client-rendered UIs are polled for up to 5 s. A
step that cannot be found is `skipped` with a reason, never guessed.

- guest: home → first category ("Beverages") → search "WAT-001" (typed at 120 ms/keystroke, so
  search-as-you-type round trips show up) → WAT-001 product page → box unit → add to cart (guests
  have no order option per spec: expected `skipped`) → cart
- customer: open login → submit login → home → category → search → product → select box →
  add to cart → open cart → change quantity to 2 → apply WELCOME10 → open checkout → up to 6
  checkout steps (selects the first option of any empty radio group, clicks continue/next) until
  a place-order button is visible. **The order is never placed.**

Per action: `round_trips` (document loads, XHR/fetch, form posts; everything to the app origin
that is not a static resource), by browser type and by server kind, request/response body bytes,
server queries / N+1 / duplicates / writes / peak memory (joined via `X-OSS-Perf-Id`), Livewire /
Inertia / JSON-API detail where present, count of static requests.

## `summary.json`

- `headline` — the comparison numbers: customer journey round trips / queries / response bytes
  (total and interactions only), and for the journey and the QA session: queries per request
  p50/p95/max, % requests with N+1, distinct N+1 statements, exact duplicates p95, full-scan and
  missing-index statements, memory p95, HTML response bytes p50
- `journey` — per action (above), totals per journey, `customer_interactions` (search typing,
  select unit, add to cart, change quantity, promo code, checkout steps), server requests the
  browser never saw (e.g. SSR calls of a separate frontend)
- `server.journey`, `server.qa` — distributions overall, `by_kind`, `by_page_type`, N+1 top
  list with pages, top statements, heaviest requests, `scans` (EXPLAIN analysis)
- `stack` — declared (composer/npm), runtime evidence (browser globals/DOM), request kinds seen,
  `detected`, `extras_ran`
- `extras` — only for what was detected: `livewire` (components per page type, snapshot bytes,
  update request/response bytes, updates by component), `inertia` (page-object/props bytes by
  component), `json_api` (endpoints with calls, queries p50, bytes), `filament_admin` (admin
  traffic, from QA only)

## Verified on (2026-10-02)

Two scratch apps built in `oneshotshop-runner:current` with the same schema (401 products,
deliberate N+1 on the category list, no index on `products.sku` / `products.category_id`):
(a) Laravel 13 + Livewire 4, (b) Laravel 13 JSON API + vanilla-JS SPA. Both: probe installed
via `composer-require`, the same two N+1 statements (categories ×24/25, units ×24) and the same
two missing-index suspects (`sku`, `category_id`) found; the journey completed every step up to
the review page and counted e.g. add-to-cart = 1 Livewire update vs 1 JSON call, checkout step =
2 Livewire updates vs 1–2 JSON calls, change-quantity = 0 (Livewire `wire:model.blur` defers)
vs 1 PATCH. The QA path (prepare on a running container → traffic → `collect --prefix qa-` →
`--aggregate-only`) and both installer fallbacks (`dont-discover`, failing `composer require`)
were exercised.

## Limitations

- SQLite only for EXPLAIN (spec rule). Rows-examined is an estimate (table rows × executions for
  full scans); SQLite has no actual-rows counter.
- Memory is PHP peak per request under `php artisan serve` (each request a fresh process); an
  app using Octane/long-lived workers would report cumulative peaks.
- Journey element discovery is heuristic (English/German labels). A build with unusual wording
  gets `skipped` steps, which `headline.journey_customer.skipped` lists; compare round trips only
  across steps that ran in both builds.
- Response bytes are uncompressed (the built-in server does not gzip): comparable across builds,
  not equal to real transfer size.
- Inertia and Filament extras are implemented from their wire formats but were not exercised
  by a test app.
- The "first category" step looks for "Beverages" (the first top-level category in the spec).
