#!/usr/bin/env bash
# verify.sh <branch> — the gate check (strict). Clones the run branch into a FRESH checkout
# (not the run's working dir), runs exactly the README start command in a FRESH container from
# the image id recorded for that run, and checks that GET / returns HTTP 200.
# Writes runs/<branch>/gate.json.
# Whole script in main(): bash parses it completely before running, so editing this file
# while a long run/evaluation is in progress cannot corrupt the running process.
main() {
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

usage() {
  cat <<EOF
Usage: ./verify.sh <branch> [options]     (or: ./oneshotshop verify <branch>)

Options:
  --from-remote       Clone the run branch from the spec repo (what was pushed) instead of
                      from the local run checkout (what was committed)
  --http-timeout <d>  Time to wait for GET / to return 200 (default: 120s)
  --step-timeout <d>  Limit per install/build/migrate step (default: 30m)
  --cpus <n>          CPU limit (default: 8)
  --memory <size>     Memory limit (default: 7g, the standard run limit)
  --keep              Keep the gate checkout (runs/<branch>/gate/checkout) afterwards

Diagnostics only (result is marked scoring_valid=false and must never be used for scoring):
  --env-bootstrap     If the branch has no .env, create it from .env.example + key:generate
EOF
}

RUN_ID="" FROM_REMOTE=false HTTP_TIMEOUT=120s STEP_TIMEOUT=30m CPUS=8 MEMORY=7g ENV_BOOTSTRAP=0 KEEP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-remote) FROM_REMOTE=true; shift ;;
    --http-timeout) HTTP_TIMEOUT="$2"; shift 2 ;;
    --step-timeout) STEP_TIMEOUT="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --env-bootstrap) ENV_BOOTSTRAP=1; warn "--env-bootstrap is a DIAGNOSTIC; this gate result is not valid for scoring"; shift ;;
    --keep) KEEP=true; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) RUN_ID="$1"; shift ;;
  esac
done
[[ -n "$RUN_ID" ]] || { usage; exit 1; }
RUN_DIR="$RUNS_DIR/$RUN_ID"
META="$RUN_DIR/meta.json"
[[ -f "$META" ]] || die "no meta.json for run $RUN_ID"
require_docker
# The gate uses the exact image the run used.
IMAGE="$(jq -r '.image.id' "$META")"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE recorded for this run is no longer present locally"

BRANCH="$(jq -r '.branch' "$META")"
[[ "$(jq -r .status "$META")" == finished ]] || warn "run is not finished; gating the last commit only"
EXPECTED_HEAD="$(jq -r '.result.head // empty' "$META")"
if $FROM_REMOTE; then SOURCE="$(jq -r '.spec.source' "$META")"; else SOURCE="$RUN_DIR/workspace"; fi

GATE_DIR="$RUN_DIR/gate"
CHECKOUT="$GATE_DIR/checkout"
rm -rf "$GATE_DIR"; mkdir -p "$GATE_DIR"
log "fresh clone of $BRANCH from $SOURCE"
git clone --quiet --no-local --single-branch --branch "$BRANCH" "$SOURCE" "$CHECKOUT" \
  || die "could not clone $BRANCH from $SOURCE"
HEAD="$(git -C "$CHECKOUT" rev-parse HEAD)"
[[ -z "$EXPECTED_HEAD" || "$HEAD" == "$EXPECTED_HEAD" ]] || warn "branch head $HEAD differs from meta.json ($EXPECTED_HEAD)"

CONTAINER="oneshotshop-gate-$RUN_ID"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# Only mount: the throwaway gate checkout. Gate script is copied in, not mounted.
docker create --name "$CONTAINER" --init --network bridge \
  --cpus "$CPUS" --memory "$MEMORY" --memory-swap "$MEMORY" --pids-limit 8192 \
  --cap-drop ALL --security-opt no-new-privileges \
  -v "$CHECKOUT:/workspace" \
  -e GATE_HTTP_TIMEOUT="$(parse_duration "$HTTP_TIMEOUT")" \
  -e GATE_STEP_TIMEOUT="$(parse_duration "$STEP_TIMEOUT")" \
  -e GATE_ENV_BOOTSTRAP="$ENV_BOOTSTRAP" \
  -i "$IMAGE" bash -s >/dev/null

START_ISO="$(now_iso)"; T0="$(now_epoch)"
log "running gate in $CONTAINER (composer install && npm ci && npm run build && php artisan migrate --seed && php artisan serve)"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT
# Gate script is piped in on stdin (never stored in the image or the checkout).
docker start -ai "$CONTAINER" < "$HARNESS_DIR/lib/gate.sh" 2>"$GATE_DIR/gate.stderr.log" >/dev/null || true
docker cp -q "$CONTAINER:/tmp/harness/." "$GATE_DIR/" 2>/dev/null || true
DURATION=$(( $(now_epoch) - T0 ))

if [[ -f "$GATE_DIR/gate.json" ]]; then
  jq --arg branch "$BRANCH" --arg head "$HEAD" --arg source "$SOURCE" \
     --arg image_id "$IMAGE" --arg started "$START_ISO" --argjson wall "$DURATION" \
     --argjson diag "$([[ $ENV_BOOTSTRAP == 1 ]] && echo true || echo false)" \
     '{branch: $branch, commit: $head, source: $source, image_id: $image_id,
       started_at: $started, wall_seconds: $wall,
       scoring_valid: ($diag | not), diagnostic_env_bootstrap: $diag} + .' \
     "$GATE_DIR/gate.json" > "$RUN_DIR/gate.json"
else
  jq -n --arg branch "$BRANCH" --arg err "$(tail -n 40 "$GATE_DIR/gate.stderr.log" 2>/dev/null)" \
     '{branch: $branch, pass: false, failed_step: "harness", log_excerpt: $err}' > "$RUN_DIR/gate.json"
fi
$KEEP || rm -rf "$CHECKOUT"

PASS="$(jq -r .pass "$RUN_DIR/gate.json")"
log "gate: pass=$PASS failed_step=$(jq -r '.failed_step // "-"' "$RUN_DIR/gate.json") (${DURATION}s) -> runs/$RUN_ID/gate.json"
[[ "$PASS" == true ]]
}
main "$@"; exit $?
