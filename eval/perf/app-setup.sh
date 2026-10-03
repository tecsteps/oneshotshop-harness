#!/usr/bin/env bash
# Runs INSIDE the perf app container as `agent` (piped in on stdin by eval/perf/run.sh).
# Exactly the README start command of the gate (lib/gate.sh), but the server listens on 0.0.0.0
# so the port published to the host's 127.0.0.1 reaches it, and it keeps running.
# Prints one JSON line {failed_step, http_status, steps}.
set -uo pipefail
OUT=/tmp/oss-perf; mkdir -p "$OUT/logs"
cd /workspace || exit 1
STEP_TIMEOUT="${EVAL_STEP_TIMEOUT:-1800}"
steps="[]"; failed=""
step() {
  local name="$1"; shift; local t1 code
  t1=$(date +%s)
  timeout --kill-after=30 "$STEP_TIMEOUT" bash -c "$*" </dev/null >"$OUT/logs/$name.log" 2>&1; code=$?
  steps=$(jq -c --arg n "$name" --argjson e "$code" --argjson d "$(( $(date +%s) - t1 ))" '. + [{step:$n, exit_code:$e, seconds:$d}]' <<<"$steps")
  [[ $code -eq 0 ]] || { failed="$name"; return 1; }
}
done_json() { jq -nc --arg f "$failed" --argjson s "$steps" --arg http "${1:-}" '{failed_step: (if $f=="" then null else $f end), http_status: $http, steps: $s}'; exit 0; }
step composer-install "composer install" || done_json
step npm-ci "npm ci" || done_json
step npm-build "npm run build" || done_json
step migrate-seed "php artisan migrate --seed" || done_json
setsid nohup php artisan serve --host=0.0.0.0 --port=8000 >"$OUT/logs/serve.log" 2>&1 < /dev/null &
status=""
for _ in $(seq 1 60); do
  status=$(curl -s -o /dev/null -w '%{http_code}' -A oss-perf-check --max-time 30 http://127.0.0.1:8000/ || true)
  [[ "$status" == 200 ]] && break; sleep 2
done
[[ "$status" == 200 ]] || failed="http-get-root"
done_json "$status"
