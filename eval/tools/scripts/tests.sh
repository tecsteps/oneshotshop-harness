#!/usr/bin/env bash
# Runs INSIDE the tools PHP image (run image + PCOV) as `agent`, on the prepared app volume
# (/workspace). Runs the agent's own test suite with the project's runner (Pest if installed,
# else PHPUnit; `php artisan test` wraps the same runners) plus JUnit + Clover output.
# Coverage is measured over app/ (harness definition). No network (--network none). Writes /out/tests-run.json.
set -uo pipefail
cd /workspace || exit 1
if [[ -f vendor/bin/pest ]]; then RUNNER=pest; BIN=vendor/bin/pest
elif [[ -f vendor/bin/phpunit ]]; then RUNNER=phpunit; BIN=vendor/bin/phpunit
else jq -n '{runner: null, reason: "neither vendor/bin/pest nor vendor/bin/phpunit is installed"}' > /out/tests-run.json; exit 0; fi
VERSION="$(php "$BIN" --version 2>/dev/null | grep -m1 -oE "(PHPUnit|Pest)[^0-9]*[0-9][0-9.]*" | head -n1)"
T0=$(date +%s)
timeout --kill-after=30 "${TEST_TIMEOUT:-1800}" php -d memory_limit=2G -d pcov.enabled=1 "$BIN" --colors=never \
  --log-junit /out/junit.xml --coverage-clover /out/clover.xml --coverage-filter app \
  > /out/test-output.txt 2>&1 </dev/null
CODE=$?
jq -n --arg r "$RUNNER" --arg v "$VERSION" --argjson c "$CODE" --argjson d "$(( $(date +%s) - T0 ))" \
  --arg cmd "php $BIN --log-junit --coverage-clover --coverage-filter app" \
  '{runner: $r, runner_version: $v, command: $cmd, exit_code: $c, seconds: $d, timed_out: ($c == 124 or $c == 137)}' > /out/tests-run.json
php /scripts/tests-summary.php /out/junit.xml /out/clover.xml > /out/tests-summary.json 2>/out/tests-summary.err || true
