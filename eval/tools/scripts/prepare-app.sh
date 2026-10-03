#!/usr/bin/env bash
# Runs INSIDE a container from the run image as user `agent` (piped in on stdin, never stored).
# Clones the run branch (read-only mount /src) into /workspace (a fresh Docker volume) and runs
# exactly the gate's start-up steps: composer install, npm ci, npm run build,
# php artisan migrate --seed. Writes /out/prepare.json and per-step logs to /out/logs/.
# Env: BRANCH, STEP_TIMEOUT (secs, default 1800).
set -uo pipefail
OUT=/out
mkdir -p "$OUT/logs"
STEP_TIMEOUT="${STEP_TIMEOUT:-1800}"
STEPS_JSON="[]"
FAILED_STEP=""

run_step() {
  local name="$1"; shift
  local t1 code
  t1=$(date +%s)
  timeout --kill-after=30 "$STEP_TIMEOUT" bash -c "$*" </dev/null >"$OUT/logs/$name.log" 2>&1
  code=$?
  STEPS_JSON=$(jq -c --arg n "$name" --arg c "$*" --argjson e "$code" --argjson d "$(( $(date +%s) - t1 ))" \
    '. + [{step: $n, command: $c, exit_code: $e, seconds: $d}]' <<<"$STEPS_JSON")
  [[ $code -eq 0 ]] || { FAILED_STEP="$name"; return 1; }
}

finish() {
  jq -n --argjson ok "$1" --arg failed "$FAILED_STEP" --argjson steps "$STEPS_JSON" \
     --arg head "$(git -C /workspace rev-parse HEAD 2>/dev/null)" \
     --argjson env "$([[ -f /workspace/.env ]] && echo true || echo false)" \
     '{ok: $ok, failed_step: (if $failed == "" then null else $failed end), head: $head,
       dotenv_present: $env, steps: $steps}' > "$OUT/prepare.json"
  exit 0
}

run_step clone "git clone --quiet --no-local --single-branch --branch '$BRANCH' /src /workspace" || finish false
cd /workspace || finish false
if ! run_step composer-install "composer install"; then
  # One automatic retry (a transient extraction failure was seen once); both attempts are logged.
  mv "$OUT/logs/composer-install.log" "$OUT/logs/composer-install.attempt1.log"
  FAILED_STEP=""
  run_step composer-install-retry "rm -rf vendor && composer install" || finish false
fi
run_step npm-ci "npm ci" || finish false
run_step npm-build "npm run build" || finish false
run_step migrate-seed "php artisan migrate --seed" || finish false
finish true
