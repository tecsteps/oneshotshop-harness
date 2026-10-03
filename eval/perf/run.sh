#!/usr/bin/env bash
# eval/perf/run.sh <run-id> [options] — performance-efficiency step (machine-independent work metrics).
#
#   1. fresh clone of the run branch -> runs/<id>/perf/.checkout (throwaway, never the run branch)
#   2. app container from the run's image: README start command (as the gate), port -> 127.0.0.1:<port>
#   3. prepare.sh: install + enable the server-side probe in that copy
#   4. journey.mjs (host Chromium via playwright-core): fixed guest + customer journey
#   5. collect.sh: request log + EXPLAIN QUERY PLAN -> journey-requests.jsonl, journey-explain.json
#   6. aggregate.mjs -> summary.json (also folds in qa-requests.jsonl/qa-explain.json if the QA
#      session captured them with the same probe)
#
# Options:
#   --workspace <dir>   source repo/dir (default runs/<id>/workspace, branch from meta.json)
#   --out <dir>         output dir (default runs/<id>/perf)
#   --image <ref>       image (default: meta.json image id, else oneshotshop-runner:current)
#   --port <n>          host port (default: a free one)
#   --cpus <n> --memory <size>   container limits (default 8 / 16g, as the gate)
#   --aggregate-only    only (re)build summary.json from the files already in the out dir
#   --keep              keep container and checkout for inspection
# Whole script in main(): bash parses it completely before running, so editing this file
# while a long run/evaluation is in progress cannot corrupt the running process.
main() {
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/common.sh
source "$HERE/../../lib/common.sh"

RUN_ID="" WS="" OUT="" IMG="" PORT="" CPUS=8 MEMORY=16g AGG_ONLY=false KEEP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --image) IMG="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --aggregate-only) AGG_ONLY=true; shift ;;
    --keep) KEEP=true; shift ;;
    -h|--help) sed -n 2,22p "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) RUN_ID="$1"; shift ;;
  esac
done
[[ -n "$RUN_ID" ]] || die "usage: eval/perf/run.sh <run-id> [options]"
RUN_DIR="$RUNS_DIR/$RUN_ID"
META="$RUN_DIR/meta.json"
OUT="${OUT:-$RUN_DIR/perf}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
plog() { printf '[perf] %s\n' "$*" >&2; }

aggregate() { node "$HERE/aggregate.mjs" "$OUT" --run-id "$RUN_ID"; }
if $AGG_ONLY; then aggregate; exit 0; fi

BRANCH=""
if [[ -f "$META" ]]; then
  BRANCH="$(jq -r '.branch // empty' "$META")"
  [[ -n "$IMG" ]] || IMG="$(jq -r '.image.id // empty' "$META")"
fi
WS="${WS:-$RUN_DIR/workspace}"
[[ -d "$WS" ]] || die "workspace $WS not found"
IMG="${IMG:-$IMAGE}"
IMAGE="$IMG"; require_docker
if [[ -f "$RUN_DIR/gate.json" && "$(jq -r .pass "$RUN_DIR/gate.json")" != true ]]; then
  warn "gate did not pass for $RUN_ID; trying anyway (summary will say if the app did not start)"
fi

# --- 1. throwaway copy (committed state only when it is a git repo) ---
CHECKOUT="$OUT/.checkout"
rm -rf "$CHECKOUT"
if git -C "$WS" rev-parse --git-dir >/dev/null 2>&1; then
  if [[ -n "$BRANCH" ]] && git -C "$WS" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git clone --quiet --no-local --single-branch --branch "$BRANCH" "$WS" "$CHECKOUT"
  else
    git clone --quiet --no-local "$WS" "$CHECKOUT"
  fi
else
  mkdir -p "$CHECKOUT"; rsync -a --exclude vendor --exclude node_modules "$WS/" "$CHECKOUT/"
fi
COMMIT="$(git -C "$CHECKOUT" rev-parse HEAD 2>/dev/null || echo none)"
node "$HERE/stack.mjs" "$CHECKOUT" > "$OUT/stack.json"

# --- 2. app container ---
[[ -n "$PORT" ]] || PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
C="oneshotshop-perf-$(printf '%s' "$RUN_ID" | tr -c 'a-zA-Z0-9_.-' '-' | cut -c1-60)"
docker rm -f "$C" >/dev/null 2>&1 || true
cleanup() { $KEEP || { docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$CHECKOUT"; }; }
trap cleanup EXIT
docker run -d --name "$C" --init --network bridge \
  --cpus "$CPUS" --memory "$MEMORY" --memory-swap "$MEMORY" --pids-limit 8192 \
  --cap-drop ALL --security-opt no-new-privileges \
  -p "127.0.0.1:$PORT:8000" -v "$CHECKOUT:/workspace" "$IMG" sleep infinity >/dev/null
plog "app setup in $C (README start command), host port $PORT"
SETUP="$(docker exec -i -u agent -w /workspace "$C" bash -s < "$HERE/app-setup.sh" | tail -n 1)"
echo "$SETUP" > "$OUT/app-setup.json"
if [[ "$(jq -r '.failed_step // empty' <<<"$SETUP")" != "" ]]; then
  docker exec -u agent "$C" bash -c 'tail -n 40 /tmp/oss-perf/logs/*.log' > "$OUT/app-setup.log" 2>&1 || true
  jq -n --arg r "$RUN_ID" --argjson s "$SETUP" '{schema: "oss-perf-summary/1", run_id: $r, error: "app did not start", app_setup: $s}' > "$OUT/summary.json"
  die "app setup failed at $(jq -r .failed_step <<<"$SETUP") (see $OUT/app-setup.log)"
fi

# --- 3. probe ---
BASE="http://127.0.0.1:$PORT"
plog "installing probe"
if ! "$HERE/prepare.sh" --container "$C" --reset --check-url "$BASE/" > "$OUT/prepare.json"; then
  cat "$OUT/prepare.json" >&2
  die "probe could not be installed (see $OUT/prepare.json)"
fi

# --- 4. journey ---
PW_CORE=""
for d in "$HERE/../testplan/.playwright" "$HERE/.playwright"; do
  [[ -d "$d/node_modules/playwright-core" ]] && { PW_CORE="$d/node_modules/playwright-core"; export PLAYWRIGHT_BROWSERS_PATH="$d/browsers"; break; }
done
if [[ -z "$PW_CORE" && -x "$HERE/../testplan/runner/playwright-setup.sh" ]]; then
  plog "installing pinned Playwright via eval/testplan/runner/playwright-setup.sh"
  "$HERE/../testplan/runner/playwright-setup.sh" >/dev/null
  PW_CORE="$HERE/../testplan/.playwright/node_modules/playwright-core"; export PLAYWRIGHT_BROWSERS_PATH="$HERE/../testplan/.playwright/browsers"
fi
plog "journey against $BASE"
node "$HERE/journey.mjs" --base "$BASE" --out "$OUT/journey.json" --playwright-core "$PW_CORE" || warn "journey exited non-zero"

# --- 5. collect + 6. aggregate ---
"$HERE/collect.sh" --container "$C" "$OUT" --prefix journey- >/dev/null
jq --arg c "$COMMIT" --arg i "$IMG" '. + {checkout_commit: $c, image: $i}' "$OUT/prepare.json" > "$OUT/prepare.json.tmp" && mv "$OUT/prepare.json.tmp" "$OUT/prepare.json"
aggregate
plog "done -> $OUT/summary.json"
}
main "$@"; exit $?
