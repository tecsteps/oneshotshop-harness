#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2329  # jq filters use $vars; step_* are called indirectly
# Post-run pipeline, called by ./oneshotshop:
#   lib/evaluate.sh run <branch> [--steps a,b] [--from <step>] [--force]
#   lib/evaluate.sh status <branch>
# Steps (in order): gate tools testplan perf insights human report
# State: runs/<branch>/evaluate.json (resumable), log: runs/<branch>/evaluate.log
# Whole script in main(): bash parses it completely before running, so editing this file
# while a long run/evaluation is in progress cannot corrupt the running process.
main() {
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
# shellcheck source=lib/versions.sh
source "$HARNESS_DIR/lib/versions.sh"

ALL_STEPS=(gate tools testplan perf insights human report)
# Step scripts live in eval/ (owned by other folders); override the base dir for tests.
EVAL_DIR="${ONESHOTSHOP_EVAL_DIR:-$HARNESS_DIR/eval}"
CLAUDE_BIN="${ONESHOTSHOP_CLAUDE_BIN:-claude}"
INSIGHTS_BUDGET_USD="${ONESHOTSHOP_INSIGHTS_BUDGET_USD:-10}"
TESTPLAN_ESTIMATE="${ONESHOTSHOP_TESTPLAN_ESTIMATE:-see eval/testplan (browser agent, pass 1)}"

BRANCH="" RUN_DIR="" STATE="" LOG="" PIDFILE=""

init_run() {
  BRANCH="$1"
  RUN_DIR="$RUNS_DIR/$BRANCH"; STATE="$RUN_DIR/evaluate.json"; LOG="$RUN_DIR/evaluate.log"; PIDFILE="$RUN_DIR/evaluate.pid"
  [[ -f "$RUN_DIR/meta.json" ]] || die "no run '$BRANCH' in runs/"
  if [[ ! -f "$STATE" ]]; then
    jq -n --arg b "$BRANCH" '{branch: $b, steps: ({} as $o | reduce ("gate","tools","testplan","perf","insights","human","report") as $s
         ($o; .[$s] = {status: "pending", started: null, finished: null, duration_secs: null, cost_usd: null, error: null, note: null}))}' > "$STATE"
  fi
  ensure_step_keys
}
ensure_step_keys() {   # only writes when a step key is missing (status must stay read-only)
  jq -e '.steps | has("gate") and has("tools") and has("testplan") and has("perf") and has("insights") and has("human") and has("report")' "$STATE" >/dev/null 2>&1 && return 0
  jq '.steps |= ((["gate","tools","testplan","perf","insights","human","report"] | map({(.): {status: "pending", started: null, finished: null, duration_secs: null, cost_usd: null, error: null, note: null}}) | add) + .)' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}
st_get() { jq -r --arg s "$1" ".steps[\$s].$2 // empty" "$STATE"; }
st_set() {   # st_set <step> <jq assignment on .steps[$s]> [jq args]
  local s="$1" f="$2"; shift 2
  jq --arg s "$s" "$@" ".steps[\$s] |= ($f) | .updated_at = (now | todate)" "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}
# In the detached worker (default) stdout+stderr ARE the log file: write once, never to a terminal,
# so a closed/reused terminal can never SIGPIPE the evaluation or the step runners it calls.
# In --foreground mode the log file is written first and the terminal only best-effort.
WORKER="${ONESHOTSHOP_EVAL_WORKER:-0}"
elog() {
  local line; line="$(printf '[evaluate %s] %s' "$(date +%H:%M:%S)" "$*")"
  if [[ "$WORKER" == 1 ]]; then printf '%s\n' "$line" >&2
  else printf '%s\n' "$line" >> "$LOG"; printf '%s\n' "$line" >&2 2>/dev/null || true; fi
}

# Run a command with output appended to the log (and shown).
logged() {
  if [[ "$WORKER" == 1 ]]; then "$@" 2>&1; return $?; fi
  "$@" 2>&1 | tee -a "$LOG" 2>/dev/null; return "${PIPESTATUS[0]}"
}

gate_passed() { [[ -f "$RUN_DIR/gate.json" ]] && [[ "$(jq -r '.pass' "$RUN_DIR/gate.json")" == true ]] && [[ "$(jq -r '.scoring_valid // true' "$RUN_DIR/gate.json")" == true ]]; }

# ------------------------------------------------------------------------------ steps
# Each step_* returns 0 = done, 1 = failed, 2 = skipped (STEP_NOTE explains), 3 = pending.
STEP_NOTE="" STEP_COST=""

step_gate() {
  local code=0
  logged "$HARNESS_DIR/verify.sh" "$BRANCH" || code=$?
  [[ -f "$RUN_DIR/gate.json" ]] || { STEP_NOTE="verify.sh produced no gate.json"; return 1; }
  if [[ "$(jq -r .failed_step "$RUN_DIR/gate.json")" == harness ]]; then STEP_NOTE="gate harness error"; return 1; fi
  if gate_passed; then STEP_NOTE="pass"; else STEP_NOTE="FAIL at $(jq -r '.failed_step // "?"' "$RUN_DIR/gate.json") (app not runnable; testplan/ZAP/axe will be skipped)"; fi
  [[ $code -eq 0 || $code -eq 1 ]] && return 0 || return 1
}

step_tools() {
  local script="$EVAL_DIR/tools/run.sh" gp=0
  [[ -x "$script" ]] || { STEP_NOTE="missing $script"; return 1; }
  gate_passed && gp=1
  # EVAL_GATE_PASSED=0 tells the tools runner to do static analysis only (no ZAP/axe).
  local code=0
  EVAL_GATE_PASSED="$gp" logged "$script" "$BRANCH" || code=$?
  [[ $code -eq 0 ]] || { STEP_NOTE="eval/tools/run.sh exited $code (see evaluate.log)"; return 1; }
  [[ -f "$RUN_DIR/tools/summary.json" ]] || { STEP_NOTE="no tools/summary.json written"; return 1; }
  STEP_NOTE=$([[ $gp == 1 ]] && echo "static + dynamic" || echo "static only; ZAP/axe skipped: gate failed")
}

step_testplan() {
  local script="$EVAL_DIR/testplan/run.sh" out="$RUN_DIR/testplan/pass-1"
  gate_passed || { STEP_NOTE="gate failed"; return 2; }
  [[ -x "$script" ]] || { STEP_NOTE="missing $script"; return 1; }
  elog "PAID STEP testplan pass 1 — estimated cost: $TESTPLAN_ESTIMATE"
  local code=0
  rm -f "$out/preflight.json"
  logged "$script" "$BRANCH" --pass 1 || code=$?
  # The runner's Playwright preflight (MCP handshake + navigate to the app) gates the suites.
  if [[ -f "$out/preflight.json" && "$(jq -r '.ok // .pass // false' "$out/preflight.json")" != true ]]; then
    STEP_NOTE="Playwright preflight failed: $(jq -r '.error // .message // "see testplan/pass-1/preflight.json"' "$out/preflight.json" | head -c 300)"
    return 1
  fi
  [[ $code -eq 0 ]] || { STEP_NOTE="eval/testplan/run.sh exited $code (see evaluate.log)"; return 1; }
  [[ -f "$out/results.json" && -f "$out/score.json" ]] || { STEP_NOTE="missing results.json/score.json in testplan/pass-1"; return 1; }
  STEP_COST="$(jq -r '.cost_usd // .cost.usd // .cost.total_usd // empty' "$out/score.json" 2>/dev/null || true)"
  [[ -z "$STEP_COST" && -f "$out/cost.json" ]] && STEP_COST="$(jq -r '.cost_usd // .usd // empty' "$out/cost.json")"
  STEP_NOTE="score: $(jq -c '.total // .score // .percent // empty' "$out/score.json" 2>/dev/null | head -c 200)"
}

# perf runs after testplan, so its aggregation already includes the QA traffic (perf/qa-*).
step_perf() {
  local script="$EVAL_DIR/perf/run.sh" code=0
  gate_passed || { STEP_NOTE="gate failed"; return 2; }
  [[ -x "$script" ]] || { STEP_NOTE="missing $script"; return 1; }
  logged "$script" "$BRANCH" || code=$?
  [[ $code -eq 0 ]] || { STEP_NOTE="eval/perf/run.sh exited $code (see evaluate.log)"; return 1; }
  [[ -f "$RUN_DIR/perf/summary.json" ]] || { STEP_NOTE="no perf/summary.json written"; return 1; }
  STEP_NOTE="$(perf_headline)"
}
perf_headline() {
  local f="$RUN_DIR/perf/summary.json"
  [[ -f "$f" ]] || { echo "-"; return; }
  jq -r '.headline as $h | ($h.journey_customer // {}) as $c | ($h.journey_server // {}) as $j | [
      "journey \($c.round_trips // "?") round trips / \($c.queries // "?") queries (\(($c.skipped // []) | length) steps skipped)",
      "q/req p95 \($j.queries_per_request_p95 // "?")",
      "N+1 \($j.n_plus_one_distinct_statements // "?")",
      "missing idx \($j.missing_index_suspects // "?")",
      (if $h.qa_server then "QA \($h.qa_server.requests) req, N+1 \($h.qa_server.n_plus_one_distinct_statements // "?")" else "no QA traffic" end),
      "stack \((.stack.detected // {}) | if type == "object" then ([to_entries[] | select(.value == true) | .key] | if length == 0 then "plain" else join("+") end) else tostring end)"
    ] | join(", ")' "$f" 2>/dev/null || echo "see perf/summary.json"
}

step_insights() {
  local script="$EVAL_DIR/insights/insights.sh" check="$EVAL_DIR/insights/check-insights.mjs"
  local dir="$RUN_DIR/insights" printed
  [[ -x "$script" ]] || { STEP_NOTE="missing $script"; return 1; }
  mkdir -p "$dir"
  printed="$dir/insights-sh.out"
  "$script" "$BRANCH" > "$printed" 2>> "$LOG" || { STEP_NOTE="insights.sh failed (see evaluate.log)"; return 1; }
  cat "$printed" >> "$LOG"
  # insights.sh writes the exact analysis command to insights/analysis-cmd.sh (prompt on stdin).
  [[ -f "$dir/analysis-cmd.sh" ]] || { STEP_NOTE="insights.sh wrote no insights/analysis-cmd.sh"; return 1; }
  # Runs on the host with the owner's own Claude Code login (no credentials from .env).
  elog "PAID STEP insights analysis — host claude -p --model sonnet, capped at \$$INSIGHTS_BUDGET_USD (--max-budget-usd)"
  CLAUDE_BIN="$CLAUDE_BIN" bash "$dir/analysis-cmd.sh" --output-format json --max-budget-usd "$INSIGHTS_BUDGET_USD" \
    > "$dir/analysis-run.json" 2>> "$LOG" || { STEP_NOTE="analysis agent failed (see insights/analysis-run.json, evaluate.log)"; return 1; }
  STEP_COST="$(jq -r '.total_cost_usd // empty' "$dir/analysis-run.json" 2>/dev/null || true)"
  if [[ "$(jq -r '.is_error // false' "$dir/analysis-run.json" 2>/dev/null)" == true ]]; then
    STEP_NOTE="analysis agent reported an error: $(jq -r '.result // ""' "$dir/analysis-run.json" | head -c 200)"; return 1
  fi
  [[ -f "$dir/insights.json" ]] || { STEP_NOTE="analysis wrote no insights.json"; return 1; }
  logged node "$check" "$dir" || { STEP_NOTE="check-insights failed"; return 1; }
  STEP_NOTE="insights.json checked"
}

step_human() {
  local dir="$RUN_DIR/human"
  mkdir -p "$dir/screenshots"
  [[ -f "$dir/impression.md" ]] || cp "$HARNESS_DIR/lib/templates/impression.md" "$dir/impression.md"
  [[ -f "$dir/screenshots/README.md" ]] || cp "$HARNESS_DIR/lib/templates/screenshots-README.md" "$dir/screenshots/README.md"
  local shots bad
  shots="$(find "$dir/screenshots" -maxdepth 1 -type f | sed 's#.*/##' | grep -cE '^[0-9]{2}-[a-z0-9-]+\.(png|jpe?g|webp)$' || true)"
  bad="$(find "$dir/screenshots" -maxdepth 1 -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.webp' \) | sed 's#.*/##' | grep -vE '^[0-9]{2}-[a-z0-9-]+\.(png|jpe?g|webp)$' | tr '\n' ',' | sed 's/,$//' || true)"
  [[ -n "$bad" ]] && elog "   WARNING: ignored screenshots (rename to NN-short-title.png): $bad"
  if cmp -s "$dir/impression.md" "$HARNESS_DIR/lib/templates/impression.md"; then
    STEP_NOTE="waiting for you: edit runs/$BRANCH/human/impression.md, add screenshots to runs/$BRANCH/human/screenshots/ ($shots so far), then ./oneshotshop evaluate $BRANCH --steps human,report"
    return 3
  fi
  STEP_NOTE="impression written, $shots screenshot(s)${bad:+; ignored: $bad}"
}

step_report() {
  logged node "$HARNESS_DIR/lib/report.mjs" "$HARNESS_DIR" "$BRANCH" || { STEP_NOTE="report.json failed schema validation"; return 1; }
  STEP_NOTE="runs/$BRANCH/report.json"
}

# ------------------------------------------------------------------------------ driver
run_step() {
  local s="$1" t0 code=0 status
  STEP_NOTE="" STEP_COST=""
  t0="$(now_epoch)"
  st_set "$s" '.status = "running" | .started = $t | .finished = null | .error = null | .note = null | .cost_usd = null' --arg t "$(now_iso)"
  elog "── $s"
  "step_$s" || code=$?
  case $code in 0) status="done" ;; 2) status=skipped ;; 3) status=pending ;; *) status=failed ;; esac
  st_set "$s" '.status = $st | .finished = $t | .duration_secs = $d
      | .cost_usd = (if $c == "" then null else (($c | tonumber) * 10000 | round / 10000) end)
      | .note = (if $n == "" or $st == "failed" then null else $n end)
      | .error = (if $st == "failed" then (if $n == "" then "step exited non-zero (see evaluate.log)" else $n end) else null end)' \
    --arg st "$status" --arg t "$(now_iso)" --argjson d "$(( $(now_epoch) - t0 ))" --arg c "$STEP_COST" --arg n "$STEP_NOTE"
  elog "   $s: $status${STEP_NOTE:+ — $STEP_NOTE}${STEP_COST:+ (cost \$$STEP_COST)}"
  [[ $status != failed ]]
}

# pid of a live evaluate for this run (pid file, or any process running it), empty if none.
eval_alive_pid() {
  local pid=""
  [[ -f "$PIDFILE" ]] && pid="$(cat "$PIDFILE" 2>/dev/null)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; return; fi
  pgrep -f "lib/evaluate.sh run $BRANCH( |$)" 2>/dev/null | grep -v "^$$\$" | head -n1 || true
}

cmd_run() {
  init_run "$1"; shift
  local only="" from="" force=false s i selected=() mode=follow args=("$@")
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --steps) only="$2"; shift 2 ;;
      --from) from="$2"; shift 2 ;;
      --force) force=true; shift ;;
      --detach) mode=detach; shift ;;
      --foreground) mode=foreground; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  [[ "$(jq -r .status "$RUN_DIR/meta.json")" == finished ]] || die "run $BRANCH is not finished (./oneshotshop finish $BRANCH)"

  if [[ "$WORKER" != 1 ]]; then
    local alive; alive="$(eval_alive_pid)"
    [[ -z "$alive" ]] || die "an evaluate for $BRANCH is already running (pid $alive); follow it: tail -f runs/$BRANCH/evaluate.log"
    if [[ "$mode" == foreground ]]; then
      trap '' PIPE
      echo $$ > "$PIDFILE"; trap 'rm -f "$PIDFILE"' EXIT
    else
      # Detached worker in its own session: survives a closed terminal and Ctrl-C of the follower.
      local filtered=() a
      for a in "${args[@]}"; do [[ "$a" == --detach || "$a" == --follow ]] || filtered+=("$a"); done
      local start_line; start_line=$(( $(wc -l < "$LOG" 2>/dev/null || echo 0) + 1 ))
      ONESHOTSHOP_EVAL_WORKER=1 nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec: $!"' \
        "${BASH_SOURCE[0]}" run "$BRANCH" ${filtered[@]+"${filtered[@]}"} >> "$LOG" 2>&1 < /dev/null &
      local wpid=$!
      echo "$wpid" > "$PIDFILE"
      log "evaluate $BRANCH running detached (pid $wpid); log: runs/$BRANCH/evaluate.log"
      if [[ "$mode" == detach ]]; then
        log "follow: tail -f runs/$BRANCH/evaluate.log    status: ./oneshotshop status $BRANCH"; exit 0
      fi
      log "following the log; Ctrl-C (or closing the terminal) stops following, NOT the evaluation"
      trap 'echo; log "stopped following; evaluation continues (pid $wpid). ./oneshotshop status $BRANCH"; kill "$tpid" 2>/dev/null; exit 0' INT TERM HUP
      tail -n "+$start_line" -f "$LOG" 2>/dev/null & local tpid=$!
      local code=0; wait "$wpid" || code=$?
      sleep 1; kill "$tpid" 2>/dev/null || true
      exit "$code"
    fi
  else
    echo $$ > "$PIDFILE"; trap 'rm -f "$PIDFILE"' EXIT
  fi
  local started=false
  [[ -z "$from" ]] && started=true
  for s in "${ALL_STEPS[@]}"; do
    [[ "$s" == "$from" ]] && started=true
    $started || continue
    if [[ -n "$only" && ",$only," != *",$s,"* ]]; then continue; fi
    selected+=("$s")
  done
  [[ -z "$from" || " ${ALL_STEPS[*]} " == *" $from "* ]] || die "unknown step '$from' (steps: ${ALL_STEPS[*]})"
  [[ ${#selected[@]} -gt 0 ]] || die "no steps selected"
  elog "evaluate $BRANCH: ${selected[*]}${from:+ (from $from)}${force:+}"
  for i in "${!selected[@]}"; do
    s="${selected[$i]}"
    # --from re-runs the named step and everything after it; --force re-runs all selected.
    if ! $force && [[ -z "$from" ]] && [[ "$(st_get "$s" status)" == "done" ]] && [[ "$s" != human && "$s" != report ]]; then
      elog "── $s: done (skip; use --force or --from $s to re-run)"; continue
    fi
    if ! run_step "$s"; then
      elog "stopped at '$s'. Fix it, then resume with: ./oneshotshop evaluate $BRANCH"
      cmd_status "$BRANCH"; exit 1
    fi
    if [[ "$s" == testplan && " ${selected[*]} " != *" perf "* && -f "$RUN_DIR/perf/summary.json" && -x "$EVAL_DIR/perf/run.sh" ]]; then
      elog "── perf: re-aggregating with the new QA traffic (--aggregate-only)"
      logged "$EVAL_DIR/perf/run.sh" "$BRANCH" --aggregate-only || elog "   perf --aggregate-only failed (perf step result unchanged)"
    fi
  done
  if [[ "$(st_get human status)" != "done" ]]; then
    elog "REMINDER: your human impression is still missing — runs/$BRANCH/human/impression.md and runs/$BRANCH/human/screenshots/; then ./oneshotshop evaluate $BRANCH --steps human,report"
  fi
  cmd_status "$BRANCH"
}

cmd_status() {
  init_run "$1"
  local alive; alive="$(eval_alive_pid)"
  if [[ -n "$alive" ]]; then printf '\nevaluate: RUNNING (pid %s)   log: runs/%s/evaluate.log\n' "$alive" "$BRANCH"
  elif [[ -f "$PIDFILE" ]]; then printf '\nevaluate: not running (stale pid file: the last evaluate ended abnormally; re-run ./oneshotshop evaluate %s to resume)\n' "$BRANCH"
  else printf '\nevaluate: not running\n'; fi
  local pre="$RUN_DIR/testplan/pass-1/preflight.json"
  printf '\nPlaywright MCP  run (agent container): %s / Chromium %s\n' \
    "$(jq -r '.mcp.playwright_mcp // "-"' "$RUN_DIR/meta.json")" "$(jq -r '.mcp.chromium // "-"' "$RUN_DIR/meta.json")"
  printf 'Playwright MCP  evaluator (host):      %s / Chromium %s   (pinned: %s, lib/versions.sh)\n' \
    "$( [[ -f "$pre" ]] && jq -r '.playwright_mcp // "-"' "$pre" || echo "-")" "$( [[ -f "$pre" ]] && jq -r '.chromium // "-"' "$pre" || echo "-")" "$PLAYWRIGHT_MCP_VERSION"
  printf '\n%-10s %-8s %-20s %8s %9s  %s\n' STEP STATUS FINISHED SECS COST NOTE
  jq -r '.steps | to_entries[] | [.key, .value.status, (.value.finished // "-"), ((.value.duration_secs // "-") | tostring),
         (if .value.cost_usd == null then "-" else ("$" + (.value.cost_usd | tostring)) end), (.value.error // .value.note // "")] | @tsv' "$STATE" \
    | awk -F'\t' '{printf "%-10s %-8s %-20s %8s %9s  %s\n", $1, $2, $3, $4, $5, $6}'
  printf '%-10s %-8s %-20s %8s %9s\n\n' total "" "" "" "\$$(jq '[.steps[].cost_usd // 0] | add' "$STATE")"
  printf 'Perf: %s\n\n' "$(perf_headline)"
}

case "${1:-}" in
  run) shift; cmd_run "$@" ;;
  status) shift; cmd_status "$@" ;;
  *) die "usage: lib/evaluate.sh run|status <branch> ..." ;;
esac
}
main "$@"; exit $?
