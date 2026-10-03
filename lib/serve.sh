#!/usr/bin/env bash
# shellcheck disable=SC2329  # cleanup() is invoked by trap
# shellcheck disable=SC2016  # sed patterns contain literal backticks
# lib/serve.sh <branch> [--port 8000] [--from-remote] — browse a finished shop on this Mac.
# Called by `./oneshotshop serve`. Starts the app exactly like the gate/evaluation: fresh clone
# of the run branch, the run's recorded image id, the README start command (reusing
# eval/tools/scripts/prepare-app.sh), then `php artisan serve --host=0.0.0.0`, published ONLY on
# 127.0.0.1:<port>. Foreground; Ctrl-C removes the container, the volume and any temp clone.
# Whole script in main(): bash parses it completely before running, so editing this file
# while a long run/evaluation is in progress cannot corrupt the running process.
main() {
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BRANCH="${1:-}"; shift || true
[[ -n "$BRANCH" ]] || die "usage: ./oneshotshop serve <branch> [--port 8000] [--from-remote]"
PORT=8000 FROM_REMOTE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --from-remote) FROM_REMOTE=true; shift ;;
    *) die "unknown option $1" ;;
  esac
done
RUN_DIR="$RUNS_DIR/$BRANCH"; META="$RUN_DIR/meta.json"
[[ -f "$META" ]] || die "no run '$BRANCH' in runs/"
[[ "$(jq -r .status "$META")" == finished ]] || die "run $BRANCH is not finished; only finished runs can be served"
IMAGE="$(jq -r '.image.id' "$META")"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "run image $IMAGE (meta.json) is not present locally"
PREPARE="$HARNESS_DIR/eval/tools/scripts/prepare-app.sh"
[[ -f "$PREPARE" ]] || die "missing $PREPARE"

NAME="oneshotshop-serve-$BRANCH"
LOGS="$RUN_DIR/serve"
TMP=""
cleanup() {
  trap - INT TERM EXIT
  jobs -p | xargs kill 2>/dev/null || true
  echo >&2
  log "stopping: removing container and volume $NAME"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$NAME" >/dev/null 2>&1 || true
  [[ -n "$TMP" ]] && rm -rf "$TMP"
  return 0
}
trap cleanup INT TERM EXIT

# --- source of the fresh clone: the run's checkout (committed) or the spec repo (pushed) ---
SRC="$RUN_DIR/workspace"
if $FROM_REMOTE; then
  TMP="$(mktemp -d)"
  REMOTE="$(jq -r .spec.source "$META")"
  log "fetching $BRANCH from $REMOTE"
  git clone --quiet --bare --single-branch --branch "$BRANCH" "$REMOTE" "$TMP/src.git" || die "branch $BRANCH not found in $REMOTE (pushed?)"
  SRC="$TMP/src.git"
fi

# --- prepare: same steps as the gate, in a fresh volume ---
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm -f "$NAME" >/dev/null 2>&1 || true
docker volume create "$NAME" >/dev/null
rm -rf "$LOGS"; mkdir -p "$LOGS"
log "preparing a fresh copy of $BRANCH (composer install, npm ci, npm run build, migrate --seed) ..."
docker run --rm -i --init --network bridge --cpus 8 --memory 4g --memory-swap 4g \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 4096 \
  -v "$SRC:/src:ro" -v "$NAME:/workspace" -v "$LOGS:/out" -e BRANCH="$BRANCH" -e STEP_TIMEOUT=1800 \
  "$IMAGE" bash -s < "$PREPARE" >/dev/null 2>"$LOGS/prepare.stderr.log" || true
if [[ "$(jq -r '.ok // false' "$LOGS/prepare.json" 2>/dev/null)" != true ]]; then
  die "preparation failed at $(jq -r '.failed_step // "?"' "$LOGS/prepare.json" 2>/dev/null) (logs: runs/$BRANCH/serve/logs/)"
fi

# --- next free port on 127.0.0.1 ---
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
p="$PORT"; while port_busy "$p"; do p=$((p + 1)); done
[[ "$p" == "$PORT" ]] || warn "port $PORT is busy, using $p"
PORT="$p"

docker run -d --name "$NAME" --init --network bridge --cpus 8 --memory 4g --memory-swap 4g \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 4096 \
  -p "127.0.0.1:$PORT:8000" -v "$NAME:/workspace" -w /workspace \
  "$IMAGE" php artisan serve --host=0.0.0.0 --port=8000 >/dev/null
status=""
for _ in $(seq 1 60); do
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/" || true)"
  [[ "$status" == 200 ]] && break
  [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" == true ]] || break
  sleep 2
done
[[ "$status" == 200 ]] || { docker logs "$NAME" 2>&1 | tail -n 20 >&2; die "GET / returned '${status:-none}'"; }

# --- logins from the branch's own spec files + admin sign-in hint from its README ---
file_at() { git -C "$SRC" show "refs/heads/$BRANCH:$1" 2>/dev/null || true; }
ADMIN_MD="$(file_at specs/admin.md)"; CUST_MD="$(file_at specs/customers.md)"; README_MD="$(file_at README.md)"
admin_email="$(sed -n 's/.*Email:[^`]*`\([^`]*\)`.*/\1/p' <<<"$ADMIN_MD" | head -n1)"
admin_pw="$(sed -n 's/.*Password:[^`]*`\([^`]*\)`.*/\1/p' <<<"$ADMIN_MD" | head -n1)"
customers="$(sed -n 's/^.*- \(User: \)\{0,1\}\([^—`]*\) — `\([^`]*@[^`]*\)` — password `\([^`]*\)`.*/  \2  \3  \4/p' <<<"$CUST_MD" | head -n3)"
admin_hint="$(grep -n -i -E 'admin' <<<"$README_MD" | grep -i -E '(/[a-z0-9/_-]*admin|admin[a-z0-9/_-]*/|login|sign[ -]?in)' | head -n3 | sed 's/^[0-9]*:/  /' || true)"

cat <<EOF

================================================================================
 $BRANCH   http://127.0.0.1:$PORT/
================================================================================
 Fresh, freshly seeded copy (same steps as the gate). Bound to 127.0.0.1 only.

 Admin      ${admin_email:-?}  /  ${admin_pw:-?}
EOF
if [[ -n "$admin_hint" ]]; then printf ' Admin sign-in (from the shop README):\n%s\n' "$admin_hint"
else printf ' Admin sign-in: not found in the shop README\n'; fi
if [[ -n "$customers" ]]; then printf ' Customers (storefront):\n%s\n' "$customers"
else printf ' Customers: no specs/customers.md logins found in this branch\n'; fi
cat <<EOF

 Screenshots for the report: runs/$BRANCH/human/screenshots/NN-short-title.png
 Ctrl-C stops the server and removes the container + volume.
================================================================================

EOF
# Logs in the background + `wait`, so a signal interrupts immediately and the trap cleans up.
docker logs -f "$NAME" 2>&1 | sed -u 's/^/[serve] /' &
wait $! || true
}
main "$@"; exit $?
