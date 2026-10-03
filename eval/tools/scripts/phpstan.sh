#!/usr/bin/env bash
# Runs INSIDE the run image as `agent` on the prepared app volume (/workspace, a throwaway copy).
# Removes the agent's own PHPStan config/baselines, composer-requires the pinned Larastan +
# PHPStan, writes a harness config and analyses app/ (+ routes/) at each level in $LEVELS.
# Env: LARASTAN_VERSION PHPSTAN_VERSION LEVELS. Writes /out/phpstan-level<N>.json, /out/phpstan-run.json.
set -uo pipefail
cd /workspace || exit 1
rm -f phpstan.neon phpstan.neon.dist phpstan.dist.neon phpstan-baseline.neon phpstan-baseline.php
INSTALL=plain
export COMPOSER_NO_AUDIT=1
req() { composer require --dev --no-interaction --no-progress --no-scripts "$@" \
          "larastan/larastan:${LARASTAN_VERSION}" "phpstan/phpstan:${PHPSTAN_VERSION}"; }
if ! req >/out/composer-require.log 2>&1; then
  INSTALL=with-all-dependencies
  if ! req -W >>/out/composer-require.log 2>&1; then
    INSTALL=with-all-dependencies-no-security-blocking
    req -W --no-security-blocking >>/out/composer-require.log 2>&1 \
      || { jq -n '{ok:false, reason:"composer require larastan failed (see composer-require.log)"}' > /out/phpstan-run.json; exit 0; }
  fi
fi
PATHS=()
for d in app routes; do [[ -d "$d" ]] && PATHS+=("/workspace/$d"); done
{
  echo "includes:"
  echo "  - /workspace/vendor/larastan/larastan/extension.neon"
  echo "parameters:"
  echo "  tmpDir: /tmp/phpstan"
  echo "  paths:"
  for p in "${PATHS[@]}"; do echo "    - $p"; done
} > /tmp/phpstan.harness.neon
cp /tmp/phpstan.harness.neon /out/phpstan.harness.neon
VERSION="phpstan $(vendor/bin/phpstan --version --no-ansi 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
for L in $LEVELS; do
  vendor/bin/phpstan analyse -c /tmp/phpstan.harness.neon --level "$L" --error-format=json --no-progress \
    --no-ansi --memory-limit=2G > "/out/phpstan-level$L.json" 2> "/out/phpstan-level$L.stderr"
  echo "$?" > "/out/phpstan-level$L.exit"
done
jq -n --arg v "$VERSION" --arg i "$INSTALL" --arg larastan "$(composer show larastan/larastan --format=json 2>/dev/null | jq -r '.versions[0] // empty')" \
  '{ok:true, phpstan_version:$v, larastan_version:$larastan, install:$i}' > /out/phpstan-run.json
