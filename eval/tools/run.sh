#!/usr/bin/env bash
# eval/tools/run.sh <run-id> [--only tool1,tool2] [--keep-work]
#
# Deterministic code-quality / security tooling for one run. Writes
#   runs/<run-id>/tools/summary.json          one object per tool + LOC + per-KLOC normalisation
#   runs/<run-id>/tools/<tool>/result.json    that tool's entry (summary.json is rebuilt from these)
#   runs/<run-id>/tools/<tool>/...            raw tool output
# Idempotent: re-running (a subset of) tools overwrites only those tools' directories.
# Exit 0 even when tools report findings or fail; non-zero only if the step itself broke
# (bad arguments, missing run, Docker unavailable, cannot clone).
#
# Env: EVAL_GATE_PASSED=0  the start-up gate failed: ZAP, axe and Lighthouse are skipped
#                          ("gate failed"); static tools, tests and PHPStan still run.
#      TOOLS_TRIVY_SKIP_DB_UPDATE=1  reuse the cached Trivy DB unchanged (see README).
# Whole script in main(): bash parses it completely before running, so editing this file
# while a long run/evaluation is in progress cannot corrupt the running process.
main() {
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

# Execution order (static first, then everything that needs the app; PHPStan last because it
# composer-requires Larastan into the throwaway app copy).
ALL_TOOLS=(loc readability gitleaks trivy semgrep pint phpmetrics sonarqube axe lighthouse zap tests phpstan)
# Order in summary.json (the owner's numbering, LOC last).
SUMMARY_ORDER=(sonarqube phpstan semgrep trivy zap phpmetrics gitleaks pint tests axe lighthouse readability loc)
LIVE_TOOLS=" axe lighthouse zap "
AGENT_CONFIGS=(phpstan.neon phpstan.neon.dist phpstan.dist.neon phpstan-baseline.neon pint.json
  sonar-project.properties .sonarcloud.properties .semgrepignore .semgrep.yml .gitleaks.toml .gitleaksignore
  .trivyignore .trivyignore.yaml trivy.yaml)

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; echo "Tools: ${ALL_TOOLS[*]}"; }

RUN_ARG="" ONLY="" KEEP_WORK=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    --keep-work) KEEP_WORK=true; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; tdie "unknown option $1" ;;
    *) RUN_ARG="$1"; shift ;;
  esac
done
[[ -n "$RUN_ARG" ]] || { usage >&2; exit 2; }
command -v docker >/dev/null && docker info >/dev/null 2>&1 || tdie "Docker daemon not reachable"
command -v jq >/dev/null || tdie "jq not found"
load_run "$RUN_ARG"

SELECTED=()
if [[ -n "$ONLY" ]]; then
  IFS=',' read -r -a want <<<"$ONLY"
  for w in "${want[@]}"; do [[ " ${ALL_TOOLS[*]} " == *" $w "* ]] || tdie "unknown tool '$w' (tools: ${ALL_TOOLS[*]})"; done
  for t in "${ALL_TOOLS[@]}"; do [[ ",$ONLY," == *",$t,"* ]] && SELECTED+=("$t"); done
else
  SELECTED=("${ALL_TOOLS[@]}")
fi
selected() { [[ " ${SELECTED[*]} " == *" $1 "* ]]; }
any_selected() { local t; for t in "${SELECTED[@]}"; do [[ "$1" == *" $t "* ]] && return 0; done; return 1; }

TOOLS_OUT="$RUN_DIR/tools"
WORK="$TOOLS_OUT/.work"
SRC="$WORK/src"
APP_NAME="oneshotshop-tools-app-$RUN_ID"
APP_LOGS="$TOOLS_OUT/app"
PAGES_JSON="$TOOLS_OUT/pages/pages.json"
APP_OK=0 APP_RUNNING=0 APP_REASON="app not prepared" BROWSER_IMG="" SONAR_CTR=""
mkdir -p "$TOOLS_OUT"

cleanup() {
  [[ -n "${SONAR_CTR:-}" ]] && docker rm -f "$SONAR_CTR" >/dev/null 2>&1
  docker rm -f "oneshotshop-tools-sonar-$RUN_ID" >/dev/null 2>&1 || true
  docker network rm "oneshotshop-tools-sonar-$RUN_ID-net" >/dev/null 2>&1 || true
  if [[ "$KEEP_WORK" == true ]]; then
    "$TOOLS_DIR/app.sh" stop "$RUN_ID" --name "$APP_NAME" --logs "$APP_LOGS" >/dev/null 2>&1 || true
  else
    "$TOOLS_DIR/app.sh" clean "$RUN_ID" --name "$APP_NAME" --logs "$APP_LOGS" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# --- per-tool plumbing ----------------------------------------------------------------------
# Tool functions (lib/tools/<tool>.sh) run in a subshell with OUT=<tool dir> and finish with
#   emit <ok|failed|skipped> "<version>" '<metrics json>' ["<reason>"]
emit() {
  jq -n --arg s "$1" --arg v "$2" --argjson m "${3:-null}" --arg r "${4:-}" \
    '{status: $s, version: $v, metrics: $m, reason: (if $r == "" then null else $r end)}' > "$OUT/.emit.json"
}
app_ready()   { [[ "$APP_OK" == 1 ]]; }
app_running() { [[ "$APP_RUNNING" == 1 ]]; }
ensure_pages() { [[ -s "$PAGES_JSON" ]]; }
for f in "$TOOLS_DIR"/lib/tools/*.sh; do
  # shellcheck disable=SC1090
  source "$f"
done

write_result() {  # write_result <name> <started_iso> <t0> <status> <version> <metrics> <reason>
  local name="$1" dir="$TOOLS_OUT/$1"
  local files; files="$(cd "$dir" && find . -type f ! -name result.json ! -name '.emit.json' | sed 's|^\./||' | sort | jq -R . | jq -sc .)"
  jq -n --arg name "$name" --arg started "$2" --argjson dur "$(( $(now_epoch) - $3 ))" --arg status "$4" --arg version "$5" \
     --argjson metrics "${6:-null}" --arg reason "$7" --arg raw "runs/$RUN_ID/tools/$name" --argjson files "$files" \
     '{name: $name, version: (if $version == "" then null else $version end), status: $status,
       reason: (if $reason == "" then null else $reason end), started_at: $started, duration_secs: $dur,
       metrics: $metrics, raw_dir: $raw, raw_files: $files}' > "$dir/result.json"
}

skip_tool() {  # skip_tool <name> <reason>
  rm -rf "${TOOLS_OUT:?}/$1"; mkdir -p "$TOOLS_OUT/$1"
  write_result "$1" "$(now_iso)" "$(now_epoch)" skipped "" null "$2"
  tlog "$(printf '%-10s' "$1") skipped: $2"
}

run_tool() {
  local name="$1" started t0 code
  OUT="$TOOLS_OUT/$name"
  rm -rf "$OUT"; mkdir -p "$OUT"
  started="$(now_iso)"; t0="$(now_epoch)"
  tlog "$(printf '%-10s' "$name") running"
  set +e
  ( set -eo pipefail; "run_$name" ) > "$OUT/tool.log" 2>&1
  code=$?
  set -e
  if [[ -f "$OUT/.emit.json" ]]; then
    write_result "$name" "$started" "$t0" "$(jq -r .status "$OUT/.emit.json")" "$(jq -r .version "$OUT/.emit.json")" \
      "$(jq -c .metrics "$OUT/.emit.json")" "$(jq -r '.reason // ""' "$OUT/.emit.json")"
    rm -f "$OUT/.emit.json"
  else
    write_result "$name" "$started" "$t0" failed "" null "tool step crashed (exit $code); see tool.log"
  fi
  tlog "$(printf '%-10s' "$name") $(jq -r '"\(.status) in \(.duration_secs)s" + (if .reason then " (\(.reason))" else "" end)' "$OUT/result.json")"
}

# --- source checkout for static tools ------------------------------------------------------
T_START="$(now_epoch)"
tlog "run $RUN_ID: branch $BRANCH @ ${HEAD_SHA:0:12} (base ${BASE_SHA:0:12}); tools: ${SELECTED[*]}"
rm -rf "$WORK"; mkdir -p "$WORK"
git clone --quiet --no-local --single-branch --branch "$BRANCH" "$WORKSPACE" "$SRC" || tdie "cannot clone $BRANCH"
IGNORED=()
for c in "${AGENT_CONFIGS[@]}"; do
  if [[ -e "$SRC/$c" ]]; then IGNORED+=("$c"); rm -f "$SRC/$c"; fi
done
printf '%s\n' "${IGNORED[@]+"${IGNORED[@]}"}" | jq -R . | jq -s 'map(select(. != ""))' > "$TOOLS_OUT/agent-configs-ignored.json"

# --- static tools ------------------------------------------------------------------------------
for t in loc readability gitleaks trivy semgrep pint phpmetrics sonarqube; do selected "$t" && run_tool "$t"; done
# loc is needed for normalisation; compute it once if it was never run.
[[ -f "$TOOLS_OUT/loc/result.json" ]] || run_tool loc

# --- tools that need the app ---------------------------------------------------------------
NEED_APP=false
if selected tests || selected phpstan; then NEED_APP=true; fi
if any_selected "$LIVE_TOOLS" && [[ "${EVAL_GATE_PASSED:-1}" != 0 ]]; then NEED_APP=true; fi
if any_selected "$LIVE_TOOLS" && [[ "${EVAL_GATE_PASSED:-1}" == 0 ]]; then
  for t in axe lighthouse zap; do selected "$t" && skip_tool "$t" "gate failed"; done
fi
if [[ "$NEED_APP" == true ]]; then
  if "$TOOLS_DIR/app.sh" prepare "$RUN_ID" --name "$APP_NAME" --logs "$APP_LOGS"; then
    APP_OK=1
  else
    APP_REASON="app preparation failed at $(jq -r '.failed_step // "?"' "$APP_LOGS/prepare.json" 2>/dev/null) (gate steps; see tools/app/logs)"
  fi
  if any_selected "$LIVE_TOOLS" && [[ "${EVAL_GATE_PASSED:-1}" != 0 ]]; then
    {
      if [[ "$APP_OK" == 1 ]]; then
        if "$TOOLS_DIR/app.sh" start "$RUN_ID" --name "$APP_NAME" --logs "$APP_LOGS"; then
          APP_RUNNING=1
        else
          APP_REASON="app did not answer GET / with HTTP 200 (see tools/app/serve.log)"
        fi
      fi
      if [[ "$APP_RUNNING" == 1 ]] && { selected axe || selected lighthouse; }; then
        BROWSER_IMG="$(ensure_tool_image browser)" || tdie "could not build the browser tool image"
        rm -rf "$TOOLS_OUT/pages"; mkdir -p "$TOOLS_OUT/pages"
        docker_run --network "container:$APP_NAME" "${HARDEN[@]}" --shm-size 1g --memory 2g \
          -v "$SCRIPTS_DIR:/scripts:ro" -v "$TOOLS_OUT/pages:/out" "$BROWSER_IMG" node /scripts/discover-pages.mjs \
          > "$TOOLS_OUT/pages/pages.log" 2>&1 || twarn "page discovery failed (see tools/pages/pages.log)"
      fi
      for t in axe lighthouse zap; do selected "$t" && run_tool "$t"; done
      "$TOOLS_DIR/app.sh" stop "$RUN_ID" --name "$APP_NAME" --logs "$APP_LOGS" || true
      APP_RUNNING=0
    }
  fi
  for t in tests phpstan; do selected "$t" && run_tool "$t"; done
fi

# --- summary.json ------------------------------------------------------------------------------
pins="$(grep -E '^[A-Z_]+=' "$CONFIG_DIR/versions.env" | sed -E 's/^([A-Z_]+)="?([^"]*)"?$/\1\t\2/' \
        | jq -R 'split("\t") | {key: .[0], value: .[1]}' | jq -s --arg pw "$PLAYWRIGHT_VERSION" 'from_entries + {PLAYWRIGHT_VERSION: $pw}')"
results="$(for t in "${SUMMARY_ORDER[@]}"; do
  if [[ -f "$TOOLS_OUT/$t/result.json" ]]; then cat "$TOOLS_OUT/$t/result.json"
  else jq -n --arg n "$t" '{name: $n, status: "not_run", reason: "never run for this run id"}'; fi
done | jq -s .)"
jq -n --arg run "$RUN_ID" --arg branch "$BRANCH" --arg head "$HEAD_SHA" --arg base "$BASE_SHA" \
   --arg image "$RUN_IMAGE" --arg at "$(now_iso)" --argjson pins "$pins" --argjson tools "$results" \
   --arg gate "${EVAL_GATE_PASSED:-unset}" --slurpfile ign "$TOOLS_OUT/agent-configs-ignored.json" \
   --argjson last_secs "$(( $(now_epoch) - T_START ))" --arg last_tools "${SELECTED[*]}" '
  def tool($n): ($tools[] | select(.name == $n));
  def m($n): (tool($n) | select(.status == "ok") | .metrics) // null;
  def perk($v; $k): if $v == null or $k == null or $k == 0 then null else (($v / $k) * 100 | round / 100) end;
  (m("loc")) as $loc
  | (if $loc then $loc.app_code_loc / 1000 else null end) as $kloc
  | (if $loc then $loc.php_loc / 1000 else null end) as $pkloc
  | { schema: "oneshotshop-tools/1", run_id: $run, branch: $branch, commit: $head, base_commit: $base,
      run_image: $image, generated_at: $at, eval_gate_passed: $gate,
      last_invocation: {tools: ($last_tools | split(" ")), seconds: $last_secs},
      pins: $pins, agent_configs_ignored: $ign[0],
      loc: $loc,
      normalised: {
        basis: {app_code_kloc: $kloc, php_kloc: $pkloc,
                note: "per 1,000 lines of code (cloc code lines); app_code = PHP+Blade+JS/TS/Vue+CSS+HTML, php = PHP only"},
        per_kloc: {
          sonar_bugs: perk(m("sonarqube").measures.bugs; $kloc),
          sonar_vulnerabilities: perk(m("sonarqube").measures.vulnerabilities; $kloc),
          sonar_code_smells: perk(m("sonarqube").measures.codeSmells; $kloc),
          sonar_security_hotspots: perk(m("sonarqube").measures.securityHotspots; $kloc),
          sonar_debt_minutes: perk(m("sonarqube").totalDebt; $kloc),
          semgrep_findings: perk(m("semgrep").findings; $kloc),
          semgrep_error_findings: perk(m("semgrep").by_severity.ERROR; $kloc),
          phpstan_level_5_errors_per_php_kloc: perk(m("phpstan").level_5.errors; $pkloc),
          phpstan_level_8_errors_per_php_kloc: perk(m("phpstan").level_8.errors; $pkloc),
          pint_files_failing_per_php_kloc: perk(m("pint").files_failing; $pkloc),
          phpmetrics_violations_per_php_kloc: perk(m("phpmetrics").violations.total; $pkloc),
          readability_lines_over_120_per_1000_lines: (m("readability").total.over_120_per_1000_lines),
          readability_blade_lines_over_200_per_1000_lines: (m("readability").groups.Blade.over_200_per_1000_lines)
        } },
      tools: $tools }' > "$TOOLS_OUT/summary.json.tmp"
mv "$TOOLS_OUT/summary.json.tmp" "$TOOLS_OUT/summary.json"
tlog "done in $(( $(now_epoch) - T_START ))s -> runs/$RUN_ID/tools/summary.json"
jq -r '.tools[] | "  \(.name | . + " " * (11 - length)) \(.status)\(if .reason then " (" + .reason + ")" else "" end)"' "$TOOLS_OUT/summary.json" >&2
}
main "$@"; exit $?
