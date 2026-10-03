#!/usr/bin/env bash
# eval/codequality — AI + static code-quality evaluation of one run against a fixed rule catalogue.
#
#   eval/codequality/run.sh <run-id>                         extract -> judge -> score   => runs/<id>/codequality/summary.json
#   eval/codequality/run.sh <run-id> --calibrate [--repeat 3] repeat the judging N times  => runs/<id>/codequality/calibration/agreement.json
#
# Options:
#   --concurrency N    parallel Codex calls (default 16, env CQ_CONCURRENCY; adaptive backoff on rate limits)
#   --budget-usd X     stop launching calls once the API-equivalent cost reaches X (default 5, env CQ_BUDGET_USD)
#   --force-extract    redo the extraction (clone, AST inventory, app prepare, schema/routes dump)
#   --force            re-judge units even if a valid result exists (default: resume, skip finished units)
#   --kinds a,b / --units id,id / --limit N   restrict the judged units (debugging; result is "incomplete")
#   --no-app           skip the app preparation (no schema/routes dump, no vendor/ for the language server)
#   --clean            remove runs/<id>/codequality/.work afterwards (the build copy used for LSP + evidence checks)
#
# Every long-running script of the harness keeps its body in main(), so editing it while it runs is safe.
main() {
set -euo pipefail
CQ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(cd "$CQ_DIR/../.." && pwd)"
# Reuse eval/tools helpers (load_run, docker_run, HARDEN) without modifying them.
# shellcheck source=../tools/lib/common.sh
source "$HARNESS_DIR/eval/tools/lib/common.sh"
# shellcheck source=config/versions.env
source "$CQ_DIR/config/versions.env"
clog() { printf '[codequality %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
cdie() { clog "ERROR: $*"; exit 1; }

RUN="${1:-}"; [[ -n "$RUN" && "$RUN" != --* ]] || { sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 2; }
shift
CALIBRATE=0 REPEAT=3 CONC="${CQ_CONCURRENCY:-$CQ_CONCURRENCY_DEFAULT}" BUDGET="${CQ_BUDGET_USD:-$CQ_BUDGET_USD_DEFAULT}"
FORCE_EXTRACT=0 FORCE=0 NO_APP=0 CLEAN=0 SEL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --calibrate) CALIBRATE=1; shift ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    --concurrency) CONC="$2"; shift 2 ;;
    --budget-usd) BUDGET="$2"; shift 2 ;;
    --force-extract) FORCE_EXTRACT=1; shift ;;
    --force) FORCE=1; shift ;;
    --kinds|--units|--limit) SEL+=("$1" "$2"); shift 2 ;;
    --no-app) NO_APP=1; shift ;;
    --clean) CLEAN=1; shift ;;
    *) cdie "unknown option $1" ;;
  esac
done
(( CONC <= CQ_CONCURRENCY_MAX )) || cdie "--concurrency above CQ_CONCURRENCY_MAX ($CQ_CONCURRENCY_MAX)"

load_run "$RUN"   # RUN_ID RUN_DIR META BRANCH RUN_IMAGE WORKSPACE HEAD_SHA (eval/tools/lib/common.sh)
OUT="$RUN_DIR/codequality"; EX="$OUT/extract"; WORK="$OUT/.work"; SRC="$WORK/src"
mkdir -p "$OUT" "$EX"
command -v codex >/dev/null || cdie "codex CLI not found (host, logged in with the owner's Codex account)"
"$CQ_DIR/lib/setup.sh" "$RUN_IMAGE"

# ------------------------------------------------------------------ 1. deterministic extraction (no AI)
extract() {
  local t0; t0=$(now_epoch)
  clog "extract: fresh clone of $BRANCH @ ${HEAD_SHA:0:12}"
  if [[ -d "$WORK" ]]; then chmod -R u+w "$WORK" 2>/dev/null || true; rm -rf "$WORK"; fi
  mkdir -p "$WORK"
  git clone --quiet --no-local --single-branch --branch "$BRANCH" "$WORKSPACE" "$SRC"
  git -C "$SRC" checkout --quiet "$HEAD_SHA"
  rm -f "$EX"/*.json
  clog "extract: AST inventory (nikic/php-parser, run image, no network)"
  docker_run --network none "${HARDEN[@]}" -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    -v "$SRC:/src:ro" -v "$CQ_DIR/php:/cq/php:ro" -v "$CQ_DIR/.cache/php-tools:/cq/.cache/php-tools:ro" \
    "$RUN_IMAGE" php /cq/php/inventory.php /src /cq/.cache/php-tools/vendor/autoload.php > "$EX/inventory.json" 2> "$EX/inventory.stderr.log" \
    || cdie "inventory failed (see $EX/inventory.stderr.log)"
  local app=false schema=false routes=false vendor=false
  if [[ $NO_APP == 0 ]]; then
    local name="oneshotshop-cq-$RUN_ID"
    clog "extract: preparing the app like the gate (eval/tools/app.sh prepare: composer install, npm ci, build, migrate --seed)"
    if "$HARNESS_DIR/eval/tools/app.sh" prepare "$RUN_ID" --name "$name" --logs "$EX/app"; then
      app=true
      docker_run --network none "${HARDEN[@]}" -v "$name:/workspace" -v "$CQ_DIR/php:/cq/php:ro" -w /workspace "$RUN_IMAGE" \
        php /cq/php/schema.php > "$EX/schema.json" 2> "$EX/schema.stderr.log" && schema=true || { rm -f "$EX/schema.json"; clog "WARNING: schema dump failed"; }
      docker_run --network none "${HARDEN[@]}" -v "$name:/workspace" -w /workspace "$RUN_IMAGE" \
        php artisan route:list --json > "$EX/routes.json" 2> "$EX/routes.stderr.log" && jq -e 'type=="array"' "$EX/routes.json" >/dev/null && routes=true || { rm -f "$EX/routes.json"; clog "WARNING: route:list failed"; }
      # vendor/ for the language server (framework types); the copy is read-only and never judged
      docker_run --network none "${HARDEN[@]}" -v "$name:/workspace:ro" -v "$SRC:/out" "$RUN_IMAGE" \
        bash -c 'cp -a /workspace/vendor /out/vendor' 2> "$EX/vendor-copy.log" && vendor=true || clog "WARNING: vendor copy failed (LSP without framework types)"
    else
      clog "WARNING: app preparation failed: no schema dump/routes; the schema unit is judged from migrations, DB static rules are N/A"
    fi
    "$HARNESS_DIR/eval/tools/app.sh" clean "$RUN_ID" --name "$name" >/dev/null 2>&1 || true
  fi
  chmod -R a-w "$SRC"   # the build copy is read-only for the LSP and the evidence checks
  jq -n --arg b "$BRANCH" --arg c "$HEAD_SHA" --arg img "$RUN_IMAGE" --argjson s "$(( $(now_epoch) - t0 ))" \
    --argjson app "$app" --argjson schema "$schema" --argjson routes "$routes" --argjson vendor "$vendor" \
    --arg php_parser "$(jq -r .php_parser "$EX/inventory.json")" \
    '{branch: $b, commit: $c, image: $img, seconds: $s, app_prepared: $app, schema_dump: $schema, routes_dump: $routes, vendor_for_lsp: $vendor, php_parser: $php_parser}' > "$EX/extract.json"
  clog "extract: done in $(jq .seconds "$EX/extract.json")s (app $app, schema $schema, routes $routes)"
}
if [[ $FORCE_EXTRACT == 1 || ! -f "$EX/extract.json" || ! -d "$SRC" || "$(jq -r .commit "$EX/extract.json" 2>/dev/null)" != "$HEAD_SHA" ]]; then extract
else clog "extract: reusing $EX (commit ${HEAD_SHA:0:12}; --force-extract to redo)"; fi

judge_and_score() {   # <out dir>
  local out="$1"; mkdir -p "$out"
  local args=(--out "$out" --src "$SRC" --extract "$EX" --concurrency "$CONC" --budget-usd "$BUDGET" ${SEL[@]+"${SEL[@]}"})
  [[ $FORCE == 1 ]] && args+=(--force)
  node "$CQ_DIR/lib/orchestrate.mjs" judge "${args[@]}"
  node "$CQ_DIR/lib/orchestrate.mjs" score --out "$out" --src "$SRC" --extract "$EX" \
    --tools "$RUN_DIR/tools/summary.json" --perf "$RUN_DIR/perf/summary.json" --meta "$META"
}

if [[ $CALIBRATE == 1 ]]; then
  CAL="$OUT/calibration"; reps=()
  for ((k = 1; k <= REPEAT; k++)); do
    clog "calibration: repeat $k/$REPEAT"
    judge_and_score "$CAL/rep-$k"; reps+=("rep-$k")
  done
  node "$CQ_DIR/lib/orchestrate.mjs" agreement --cal "$CAL" --reps "$(IFS=,; echo "${reps[*]}")"
  clog "calibration report: $CAL/agreement.json"
else
  judge_and_score "$OUT"
  clog "summary: $OUT/summary.json"
fi
if [[ $CLEAN == 1 ]]; then chmod -R u+w "$WORK" 2>/dev/null || true; rm -rf "$WORK"; fi
}
main "$@"; exit $?
