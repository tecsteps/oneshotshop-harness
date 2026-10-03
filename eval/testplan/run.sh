#!/usr/bin/env bash
# eval/testplan/run.sh <run-id> [--pass N] [--suites S01,S02] [options]
#
# Automated functional acceptance test of a finished run (eval/testplan/testplan.md).
#  1. Fresh clone of the run branch; app container from the run's recorded image, started like the
#     gate (composer install, npm ci, npm run build, php artisan migrate --seed, php artisan serve on
#     0.0.0.0), port published to 127.0.0.1 only.
#  2. Pinned Playwright MCP + Chromium in eval/testplan/.playwright (version from lib/versions.sh);
#     preflight = MCP stdio handshake + navigate to the shop's "/". Abort if it fails.
#  3. Per suite: reset (migrate:fresh --seed + MAILMARK) via docker exec, then ONE host `claude -p`
#     (model alias sonnet, headless Playwright, three narrow helper commands, nothing else).
#  4. results.json + score.json (weights.md) in runs/<run-id>/testplan/pass-<N>/.
# Resumable: suites with a finished result are skipped unless named in --suites.
# Whole script in main(): bash parses it completely before running, so editing this file
# while a long run/evaluation is in progress cannot corrupt the running process.
main() {
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/common.sh
source "$HERE/../../lib/common.sh"
# shellcheck source=../../lib/versions.sh
source "$HARNESS_DIR/lib/versions.sh"

usage() {
  cat <<EOF
Usage: eval/testplan/run.sh <run-id> [options]

  --pass N             pass number (default 1) -> runs/<run-id>/testplan/pass-N/
  --suites S01,S03     run (or re-run) only these suites; default: all suites not yet done
  --checks S01-01,...  debug: evaluate only these check IDs (suite marked partial, score incomplete)
  --model <alias>      evaluator model (default: sonnet; version not pinned, resolved id is recorded)
  --headed             debug: show the browser (default: headless)
  --suite-timeout <d>  limit per suite (default 2h)
  --from-remote        clone the branch from the spec repo instead of runs/<run-id>/workspace
  --keep-app           leave the app container running afterwards (for debugging)
  --dry-run            everything up to (not including) the claude -p calls: app, preflight, prompts
  --budget-usd X       --max-budget-usd of each suite call (default 12)
  --recheck-budget-usd X  --max-budget-usd of each second-pass call for a FAIL check (default 2.5)
  --recheck-max N      at most N second-pass calls per suite (default 25)
  --recheck-suite-budget-usd X  no new second-pass call once they cost X in a suite (default 8)
  --no-recheck         no second pass for FAIL checks
  --cpus N / --memory M  app container limits (default 8 / 16g)
EOF
}

RUN_ID="" PASS=1 SUITES="" CHECKS="" MODEL=sonnet HEADED=false SUITE_TIMEOUT=2h FROM_REMOTE=false
KEEP_APP=false DRY=false CPUS=8 MEMORY=16g BUDGET=12 RECHECK_BUDGET=2.5 RECHECK_MAX=25 RECHECK_SUITE=8 NO_RECHECK=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pass) PASS="$2"; shift 2 ;;
    --suites) SUITES="$2"; shift 2 ;;
    --checks) CHECKS="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --headed) HEADED=true; shift ;;
    --suite-timeout) SUITE_TIMEOUT="$2"; shift 2 ;;
    --from-remote) FROM_REMOTE=true; shift ;;
    --keep-app) KEEP_APP=true; shift ;;
    --dry-run) DRY=true; shift ;;
    --budget-usd) BUDGET="$2"; shift 2 ;;
    --recheck-budget-usd) RECHECK_BUDGET="$2"; shift 2 ;;
    --recheck-max) RECHECK_MAX="$2"; shift 2 ;;
    --recheck-suite-budget-usd) RECHECK_SUITE="$2"; shift 2 ;;
    --no-recheck) NO_RECHECK=true; shift ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) RUN_ID="$1"; shift ;;
  esac
done
[[ -n "$RUN_ID" ]] || { usage; exit 1; }
RUN_DIR="$RUNS_DIR/$RUN_ID"; META="$RUN_DIR/meta.json"
[[ -f "$META" ]] || die "no meta.json for run $RUN_ID"
command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "Docker daemon not reachable"
CLAUDE_BIN="${ONESHOTSHOP_CLAUDE_BIN:-claude}"
$DRY || command -v "$CLAUDE_BIN" >/dev/null || die "claude CLI not found on the host"
IMAGE="$(jq -r '.image.id' "$META")"; BRANCH="$(jq -r '.branch' "$META")"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE recorded for this run is not present locally"

PASS_DIR="$RUN_DIR/testplan/pass-$PASS"
# A pass is bound to one version of the plan: never mix suite results graded with different plans.
PLAN_SHA="$(sha256_file "$HERE/testplan.md")"
# Blind grading (feature-detected): expectations.json + testplan.evaluator.md rendered for this testplan.md.
PLAN_MODE="$(cd "$HERE/runner" && python3 -c 'from plan import Plan; print(Plan().mode)')" \
  || die "test plan bundle invalid (see the error above; run calc/render.py again)"
EXP_SHA=""; EVMD_SHA=""
if [[ "$PLAN_MODE" == blind ]]; then EXP_SHA="$(sha256_file "$HERE/expectations.json")"; EVMD_SHA="$(sha256_file "$HERE/testplan.evaluator.md")"; fi
if [[ -d "$PASS_DIR" ]]; then
  OLD_SHA="$(jq -r '.plan_sha256 // empty' "$PASS_DIR/pass-meta.json" 2>/dev/null || true)"
  OLD_EXP="$(jq -r '.expectations_sha256 // empty' "$PASS_DIR/pass-meta.json" 2>/dev/null || true)"
  OLD_EVMD="$(jq -r '.evaluator_md_sha256 // empty' "$PASS_DIR/pass-meta.json" 2>/dev/null || true)"
  HAS_SUITES=false; compgen -G "$PASS_DIR/suites/S*.json" >/dev/null && HAS_SUITES=true
  if [[ -n "$OLD_SHA" && "$OLD_SHA" != "$PLAN_SHA" ]] || [[ -z "$OLD_SHA" && $HAS_SUITES == true ]] \
     || [[ $HAS_SUITES == true && ( "$OLD_EXP" != "$EXP_SHA" || "$OLD_EVMD" != "$EVMD_SHA" ) ]]; then
    next=$PASS; while [[ -d "$RUN_DIR/testplan/pass-$next" ]]; do next=$((next + 1)); done
    die "pass $PASS of $RUN_ID was graded with a different version of testplan.md (recorded: ${OLD_SHA:-none}, current: $PLAN_SHA). Results must not be mixed; start a new pass with --pass $next"
  fi
fi
mkdir -p "$PASS_DIR"/{logs,suites,transcripts,prompts}
RLOG="$PASS_DIR/run.log"
exec > >(tee -a "$RLOG") 2>&1
log "testplan pass $PASS for $RUN_ID ($(now_iso)); grading mode: $PLAN_MODE"

# ------------------------------------------------------------------ suites to run
ALL_SUITES=$(sed -n 's/^## \(S[0-9][0-9]\) .*/\1/p' "$HERE/testplan.md" | tr '\n' ' ')
if [[ -n "$SUITES" ]]; then TODO="${SUITES//,/ }"
else
  TODO=""
  for s in $ALL_SUITES; do
    f="$PASS_DIR/suites/$s.json"
    if [[ -f "$f" && "$(jq -r '.status' "$f")" == "done" && "$(jq -r '.partial' "$f")" == false ]]; then continue; fi
    TODO+="$s "
  done
fi
for s in $TODO; do [[ " $ALL_SUITES " == *" $s "* ]] || die "unknown suite $s"; done
if [[ -z "${TODO// /}" ]]; then log "all suites done; recomputing score"; python3 "$HERE/runner/score.py" "$PASS_DIR"; exit 0; fi
log "suites to run: $TODO"

# ------------------------------------------------------------------ Playwright (host, pinned)
PW_JSON="$("$HERE/runner/playwright-setup.sh" 2>>"$PASS_DIR/logs/playwright-setup.log" | tail -n1)" \
  || { jq -n --arg e "Playwright MCP/Chromium install failed (see logs/playwright-setup.log)" '{ok:false, error:$e}' > "$PASS_DIR/preflight.json"; die "Playwright setup failed"; }
log "playwright: $PW_JSON"

# ------------------------------------------------------------------ app container (like the gate)
CHECKOUT="$PASS_DIR/app-checkout"
rm -rf "$CHECKOUT"
if $FROM_REMOTE; then SOURCE="$(jq -r '.spec.source' "$META")"; else SOURCE="$RUN_DIR/workspace"; fi
git clone --quiet --no-local --single-branch --branch "$BRANCH" "$SOURCE" "$CHECKOUT" || die "clone of $BRANCH failed"
COMMIT="$(git -C "$CHECKOUT" rev-parse HEAD)"

PORT=8000
port_busy() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }
while port_busy "$PORT"; do PORT=$((PORT + 1)); done
[[ $PORT == 8000 ]] || warn "port 8000 busy on the host; using $PORT (absolute links to :8000 from APP_URL would break)"
URL="http://127.0.0.1:$PORT"

APP="oneshotshop-testplan-$RUN_ID-p$PASS"
docker rm -f "$APP" >/dev/null 2>&1 || true
PERF_OK=false
cleanup() {
  # Passive performance capture of the QA session (eval/perf contract), while the app still runs.
  if $PERF_OK && docker inspect "$APP" >/dev/null 2>&1; then
    "$HARNESS_DIR/eval/perf/collect.sh" --container "$APP" "$RUN_DIR/perf" --prefix qa- \
      >>"$PASS_DIR/logs/perf-collect.log" 2>&1 && log "perf: QA requests collected -> runs/$RUN_ID/perf/qa-requests.jsonl" \
      || warn "perf: collect failed (see logs/perf-collect.log)"
  fi
  $KEEP_APP || docker rm -f "$APP" >/dev/null 2>&1 || true; $KEEP_APP || rm -rf "$CHECKOUT"
}
trap cleanup EXIT
docker create --name "$APP" --init --network bridge -p "127.0.0.1:$PORT:8000" \
  --cpus "$CPUS" --memory "$MEMORY" --memory-swap "$MEMORY" --pids-limit 8192 \
  --cap-drop ALL --security-opt no-new-privileges \
  -v "$CHECKOUT:/workspace" -u agent -w /workspace "$IMAGE" sleep infinity >/dev/null
docker start "$APP" >/dev/null
log "app container $APP: composer install, npm ci, npm run build, migrate --seed, serve (this takes a while)"
APP_JSON="$(docker exec -i -u agent -w /workspace "$APP" bash -s < "$HERE/runner/app-setup.sh" | tail -n1)"
docker cp -q "$APP:/tmp/oss-eval/logs/." "$PASS_DIR/logs/app/" 2>/dev/null || mkdir -p "$PASS_DIR/logs/app"
echo "$APP_JSON" > "$PASS_DIR/app-setup.json"
if [[ "$(jq -r '.failed_step // empty' <<<"$APP_JSON")" != "" ]]; then
  jq -n --arg e "app setup failed at $(jq -r .failed_step <<<"$APP_JSON")" --argjson pw "$PW_JSON" '{ok:false, error:$e} + $pw' > "$PASS_DIR/preflight.json"
  die "app setup failed: $APP_JSON"
fi

# ------------------------------------------------------------------ passive perf probe (optional)
PERF_JSON='{"ok":false,"error":"eval/perf/prepare.sh not found"}'
if [[ -x "$HARNESS_DIR/eval/perf/prepare.sh" ]]; then
  PERF_JSON="$("$HARNESS_DIR/eval/perf/prepare.sh" --container "$APP" --reset --check-url "$URL/" \
    2>>"$PASS_DIR/logs/perf-prepare.log" | tail -n1 || true)"
  jq -e . >/dev/null 2>&1 <<<"$PERF_JSON" || PERF_JSON='{"ok":false,"error":"prepare.sh gave no JSON (see logs/perf-prepare.log)"}'
fi
if [[ "$(jq -r .ok <<<"$PERF_JSON")" == true ]]; then PERF_OK=true; log "perf probe active: $PERF_JSON"
else warn "perf probe not active, continuing without it: $PERF_JSON"; fi

# ------------------------------------------------------------------ MCP config + preflight
MCP_BIN="$(jq -r .mcp_bin <<<"$PW_JSON")"; BROWSERS="$(jq -r .browsers_path <<<"$PW_JSON")"
MCP_CFG="$PASS_DIR/mcp-config.json"
# Two independent browsers (separate processes, in-memory profiles): playwright = storefront contexts,
# playwright2 = admin/staff context, so customer and staff sessions never share cookies.
jq -n --arg bin "$MCP_BIN" --arg bp "$BROWSERS" --arg out "$PASS_DIR/playwright-output" --argjson headed "$HEADED" \
  'def srv($o): {command: $bin,
     args: ((if $headed then [] else ["--headless"] end) + ["--browser", "chromium", "--isolated", "--output-dir", $o]),
     env: {PLAYWRIGHT_BROWSERS_PATH: $bp}};
   {mcpServers: {playwright: srv($out), playwright2: srv($out + "-2")}}' > "$MCP_CFG"
PRE="$(node "$HERE/runner/preflight.js" "$MCP_CFG" "$URL/" 2>>"$PASS_DIR/logs/preflight.stderr.log" | tail -n1 || true)"
jq -e . >/dev/null 2>&1 <<<"$PRE" || PRE='{"ok":false,"error":"preflight produced no JSON (see logs/preflight.stderr.log)"}'
jq -n --argjson pre "$PRE" --argjson pw "$PW_JSON" \
  --arg url "$URL" --argjson headed "$HEADED" --arg at "$(now_iso)" \
  '$pre + $pw + {url: $url, headless: ($headed | not), checked_at: $at}' > "$PASS_DIR/preflight.json"
[[ "$(jq -r .ok "$PASS_DIR/preflight.json")" == true ]] || die "Playwright preflight failed: $(jq -c . "$PASS_DIR/preflight.json")"
log "preflight ok: $(jq -c '{playwright_mcp, chromium, tools, page_title, http_status}' "$PASS_DIR/preflight.json")"

jq -n --arg run "$RUN_ID" --arg branch "$BRANCH" --arg commit "$COMMIT" --arg image "$IMAGE" --argjson pass "$PASS" \
  --arg model "$MODEL" --argjson pw "$PW_JSON" --arg url "$URL" --arg claude "$("$CLAUDE_BIN" --version 2>/dev/null || echo n/a)" \
  --argjson perf "$PERF_JSON" --arg plan "$PLAN_SHA" --arg mode "$PLAN_MODE" --arg exp "$EXP_SHA" --arg evmd "$EVMD_SHA" \
  --argjson budgets "$(jq -n --argjson s "$BUDGET" --argjson r "$RECHECK_BUDGET" --argjson m "$RECHECK_MAX" --argjson off "$NO_RECHECK" \
       --argjson rs "$RECHECK_SUITE" '{suite_usd: $s, recheck_usd: $r, recheck_max: $m, recheck_suite_usd: $rs, recheck: ($off | not)}')" \
  '{run: $run, branch: $branch, commit: $commit, image_id: $image, pass: $pass, model_alias: $model,
    claude_version: $claude, url: $url, playwright: $pw, perf_probe: $perf, plan_sha256: $plan, grading_mode: $mode,
    budgets: $budgets}
   + (if $exp != "" then {expectations_sha256: $exp, evaluator_md_sha256: $evmd} else {} end)' > "$PASS_DIR/pass-meta.json"

# ------------------------------------------------------------------ suites
README_FILE="$CHECKOUT/README.md"
FAILED=0
for s in $TODO; do
  if [[ "$s" == S06 ]]; then   # avoid the 18:00 Berlin cut-off boundary (test plan 0.6)
    while :; do hm=$(TZ=Europe/Berlin date +%H%M); [[ "$hm" < 1750 || "$hm" > 1810 ]] && break
      log "S06: Berlin time $hm is within 17:50-18:10; waiting"; sleep 60; done
  fi
  log "== $s: reset"
  if ! EVAL_APP_CONTAINER="$APP" EVAL_HELPER_LOG="$PASS_DIR/helpers.log" "$HERE/runner/bin/shop-reset" \
       > "$PASS_DIR/logs/$s.reset.log" 2>&1; then
    warn "$s: reset failed (see logs/$s.reset.log); all checks of $s FAIL"
    python3 -c '
import json, sys, os
d, s, tp = sys.argv[1], sys.argv[2], sys.argv[3]
ids = [r["id"] for r in json.load(open(os.path.join(tp, "results-template.json")))["results"] if r["id"].startswith(s + "-")]
json.dump({"suite": s, "status": "reset_failed", "partial": False, "checks": ids,
           "results": [{"id": i, "result": "FAIL", "observed": "", "note": "reset failed"} for i in ids]},
          open(os.path.join(d, "suites", s + ".json"), "w"), indent=1)' "$PASS_DIR" "$s" "$HERE"
    FAILED=1; continue
  fi
  log "== $s: evaluator (claude -p --model $MODEL)"
  args=(--suite "$s" --pass-dir "$PASS_DIR" --url "$URL" --mcp-config "$MCP_CFG" --bin-dir "$HERE/runner/bin"
        --app-container "$APP" --model "$MODEL" --claude "$CLAUDE_BIN" --timeout "$(parse_duration "$SUITE_TIMEOUT")"
        --readme "$README_FILE" --budget-usd "$BUDGET" --recheck-budget-usd "$RECHECK_BUDGET" --recheck-max "$RECHECK_MAX"
        --recheck-suite-budget-usd "$RECHECK_SUITE")
  $NO_RECHECK && args+=(--no-recheck)
  [[ -n "$CHECKS" ]] && args+=(--checks "$CHECKS")
  $DRY && args+=(--dry-run)
  if python3 "$HERE/runner/suite.py" "${args[@]}"; then :; else FAILED=1; warn "$s did not finish cleanly"; fi
done

$DRY && { log "dry run: prompts in $PASS_DIR/prompts/, no claude calls made"; exit 0; }
python3 "$HERE/runner/score.py" "$PASS_DIR"
log "done: $PASS_DIR/results.json, score.json"
exit "$FAILED"
}
main "$@"; exit $?
