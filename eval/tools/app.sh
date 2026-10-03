#!/usr/bin/env bash
# app.sh — start a run's app exactly like the start-up gate, for tools that need it running
# (ZAP, axe, Lighthouse here; reusable by eval/perf and others).
#
#   eval/tools/app.sh prepare <run-id>   fresh clone of the run branch into a Docker volume, then
#                                        composer install, npm ci, npm run build,
#                                        php artisan migrate --seed (the gate steps) in the run image
#   eval/tools/app.sh start   <run-id>   php artisan serve --host=127.0.0.1 --port=8000 (as the gate)
#                                        on an INTERNAL Docker network (no internet); waits for GET / = 200
#   eval/tools/app.sh reseed  <run-id>   php artisan migrate:fresh --seed --force (fresh seed state)
#   eval/tools/app.sh exec    <run-id> -- <cmd...>   run a command in the app container (/workspace)
#   eval/tools/app.sh stop    <run-id>   stop the server and remove the network (volume kept)
#   eval/tools/app.sh clean   <run-id>   stop + remove the volume
#
# Clients join the app's network namespace and use http://127.0.0.1:8000, the same URL the gate
# probes:   docker run --network container:$(eval/tools/app.sh name <run-id>) ...
#
# Options: --name <name> (default oneshotshop-app-<run-id>; container, volume = <name>,
#          network = <name>-net), --logs <dir> (default runs/<run-id>/tools/app),
#          --cpus <n> (8), --memory <size> (4g), --http-timeout <secs> (120).
# Exit codes: 0 ok; 1 the app could not be prepared/started (see <logs>/prepare.json); 2 usage.
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

CMD="${1:-}"; shift || true
APP_RUN="${1:-}"; shift || true
[[ -n "$CMD" && -n "$APP_RUN" ]] || { sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 2; }
NAME="" LOGS="" CPUS=8 MEMORY=4g HTTP_TIMEOUT=120 EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --logs) LOGS="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --http-timeout) HTTP_TIMEOUT="$2"; shift 2 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) tdie "unknown option $1" ;;
  esac
done
load_run "$APP_RUN"
NAME="${NAME:-oneshotshop-app-$RUN_ID}"
NET="$NAME-net"
LOGS="${LOGS:-$RUN_DIR/tools/app}"

app_prepare() {
  mkdir -p "$LOGS"; rm -rf "${LOGS:?}/logs" "$LOGS/prepare.json"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume create --label "$TOOLS_LABEL=$RUN_ID" "$NAME" >/dev/null
  tlog "app: preparing $BRANCH in volume $NAME (gate steps: composer install, npm ci, npm run build, migrate --seed)"
  docker_run -i --init --network bridge --cpus "$CPUS" --memory "$MEMORY" --memory-swap "$MEMORY" "${HARDEN[@]}" \
    -v "$WORKSPACE:/src:ro" -v "$NAME:/workspace" -v "$LOGS:/out" \
    -e BRANCH="$BRANCH" -e STEP_TIMEOUT=1800 \
    "$RUN_IMAGE" bash -s < "$SCRIPTS_DIR/prepare-app.sh" >/dev/null 2>"$LOGS/prepare.stderr.log" || true
  [[ -f "$LOGS/prepare.json" ]] || { jq -n '{ok:false, failed_step:"harness", steps:[]}' > "$LOGS/prepare.json"; }
  if [[ "$(jq -r .ok "$LOGS/prepare.json")" == true ]]; then
    tlog "app: prepared ($(jq -r '[.steps[]|"\(.step)=\(.seconds)s"]|join(" ")' "$LOGS/prepare.json"))"
  else
    twarn "app: preparation failed at $(jq -r .failed_step "$LOGS/prepare.json")"; return 1
  fi
}

app_start() {
  docker volume inspect "$NAME" >/dev/null 2>&1 || tdie "app volume $NAME missing; run: app.sh prepare $RUN_ID"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network inspect "$NET" >/dev/null 2>&1 \
    || docker network create --internal --label "$TOOLS_LABEL=$RUN_ID" "$NET" >/dev/null
  mkdir -p "$LOGS"
  docker run -d --name "$NAME" --label "$TOOLS_LABEL=$RUN_ID" --init --network "$NET" \
    --cpus "$CPUS" --memory "$MEMORY" --memory-swap "$MEMORY" "${HARDEN[@]}" \
    -v "$NAME:/workspace" -w /workspace "$RUN_IMAGE" \
    bash -c 'exec php artisan serve --host=127.0.0.1 --port=8000 >/tmp/serve.log 2>&1' >/dev/null
  local t1 status=""; t1=$(now_epoch)
  while (( $(now_epoch) - t1 < HTTP_TIMEOUT )); do
    status="$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' --max-time 30 http://127.0.0.1:8000/ 2>/dev/null || true)"
    [[ "$status" == 200 ]] && break
    [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" == true ]] || break
    sleep 2
  done
  docker exec "$NAME" cat /tmp/serve.log > "$LOGS/serve.log" 2>/dev/null || true
  if [[ "$status" != 200 ]]; then twarn "app: GET / returned '${status:-none}' (see $LOGS/serve.log)"; return 1; fi
  tlog "app: serving at http://127.0.0.1:8000 inside container $NAME (internal network $NET)"
}

app_reseed() {
  docker exec "$NAME" bash -c 'php artisan migrate:fresh --seed --force' >"$LOGS/reseed.log" 2>&1 \
    || { twarn "app: reseed failed (see $LOGS/reseed.log)"; return 1; }
}

app_stop() {
  docker exec "$NAME" cat /tmp/serve.log > "$LOGS/serve.log" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

case "$CMD" in
  prepare) app_prepare ;;
  start) app_start ;;
  reseed) app_reseed ;;
  exec) docker exec -i "$NAME" "${EXTRA[@]}" ;;
  stop) app_stop ;;
  clean) app_stop; docker volume rm -f "$NAME" >/dev/null 2>&1 || true ;;
  name) printf '%s\n' "$NAME" ;;
  *) tdie "unknown command $CMD" ;;
esac
