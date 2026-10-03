#!/usr/bin/env bash
# Gate check, executed INSIDE a fresh container as user `agent` with a fresh clone of the
# run branch at /workspace. Runs exactly the README start command, step by step, then
# checks that GET / answers HTTP 200. Writes /tmp/harness/gate.json and step logs.
#
# Env: GATE_HTTP_TIMEOUT (secs, default 120), GATE_STEP_TIMEOUT (secs, default 1800),
#      GATE_ENV_BOOTSTRAP=1 to create .env from .env.example + key:generate if .env is missing.
set -uo pipefail

OUT=/tmp/harness
mkdir -p "$OUT/logs"
cd /workspace || exit 1
HTTP_TIMEOUT="${GATE_HTTP_TIMEOUT:-120}"
STEP_TIMEOUT="${GATE_STEP_TIMEOUT:-1800}"
STEPS_JSON="[]"
FAILED_STEP=""
T0=$(date +%s)

run_step() {
  local name="$1"; shift
  local t1 code t2
  echo "== $name: $*" >&2
  t1=$(date +%s)
  timeout --kill-after=30 "$STEP_TIMEOUT" bash -c "$*" </dev/null >"$OUT/logs/$name.log" 2>&1
  code=$?
  t2=$(date +%s)
  STEPS_JSON=$(jq -c --arg n "$name" --arg c "$*" --argjson e "$code" --argjson d "$((t2 - t1))" \
    '. + [{step: $n, command: $c, exit_code: $e, seconds: $d}]' <<<"$STEPS_JSON")
  if [[ $code -ne 0 ]]; then FAILED_STEP="$name"; return 1; fi
}

finish() {
  local pass="$1" http="$2" excerpt=""
  if [[ -n "$FAILED_STEP" && -f "$OUT/logs/$FAILED_STEP.log" ]]; then
    excerpt="$(tail -n 60 "$OUT/logs/$FAILED_STEP.log")"
  elif [[ "$pass" != true && -f "$OUT/logs/serve.log" ]]; then
    excerpt="$( { tail -n 30 "$OUT/logs/serve.log"; echo '--- response body ---'; head -c 3000 "$OUT/logs/http-body.html" 2>/dev/null; echo; echo '--- laravel.log ---'; tail -n 40 storage/logs/laravel.log 2>/dev/null; } )"
  fi
  jq -n --argjson pass "$pass" --arg failed "$FAILED_STEP" --argjson steps "$STEPS_JSON" \
    --arg http "$http" --argjson total "$(( $(date +%s) - T0 ))" --arg excerpt "$excerpt" \
    --argjson env_bootstrap "${ENV_BOOTSTRAPPED:-false}" --argjson env_present "$ENV_PRESENT" \
    '{pass: $pass, failed_step: (if $failed == "" then null else $failed end),
      http_status: (if $http == "" then null else $http end), total_seconds: $total,
      dotenv_in_branch: $env_present, env_bootstrapped: $env_bootstrap,
      steps: $steps, log_excerpt: $excerpt}' > "$OUT/gate.json"
  exit 0
}

ENV_PRESENT=false; [[ -f .env ]] && ENV_PRESENT=true
ENV_BOOTSTRAPPED=false

run_step composer-install "composer install" || finish false ""
if [[ "${GATE_ENV_BOOTSTRAP:-0}" == 1 && ! -f .env && -f .env.example ]]; then
  run_step env-bootstrap "cp .env.example .env && php artisan key:generate --force" || finish false ""
  ENV_BOOTSTRAPPED=true
fi
run_step npm-ci "npm ci" || finish false ""
run_step npm-build "npm run build" || finish false ""
run_step migrate-seed "php artisan migrate --seed" || finish false ""

# Background server, exactly as in the README.
php artisan serve --host=127.0.0.1 --port=8000 >"$OUT/logs/serve.log" 2>&1 &
SERVE_PID=$!
t1=$(date +%s); status=""
while (( $(date +%s) - t1 < HTTP_TIMEOUT )); do
  status=$(curl -s -o "$OUT/logs/http-body.html" -w '%{http_code}' --max-time 30 http://127.0.0.1:8000/ || true)
  [[ "$status" == 200 ]] && break
  if ! kill -0 "$SERVE_PID" 2>/dev/null; then break; fi
  sleep 2
done
STEPS_JSON=$(jq -c --arg s "$status" --argjson d "$(( $(date +%s) - t1 ))" \
  '. + [{step: "http-get-root", command: "php artisan serve; GET /", http_status: $s, seconds: $d}]' <<<"$STEPS_JSON")
kill "$SERVE_PID" 2>/dev/null || true
if [[ "$status" == 200 ]]; then finish true "$status"; fi
FAILED_STEP="http-get-root"
finish false "$status"
