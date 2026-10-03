#!/usr/bin/env bash
# Installs the pinned host-side dependencies of eval/codequality into harness-owned, git-ignored
# locations (idempotent; fast when already installed):
#   node_modules/          intelephense + yaml, exactly as in package-lock.json (npm ci)
#   .cache/php-tools/      nikic/php-parser, exactly as in php/composer.lock (composer in the run image)
# Usage: lib/setup.sh [run-image]
set -euo pipefail
CQ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-oneshotshop-runner:current}"
stamp() { shasum -a 256 < "$1" | cut -c1-16; }

want="$(stamp "$CQ_DIR/package-lock.json")"
if [[ "$(cat "$CQ_DIR/node_modules/.cq-stamp" 2>/dev/null)" != "$want" ]]; then
  echo "[codequality] setup: npm ci (intelephense, yaml)" >&2
  (cd "$CQ_DIR" && npm ci --no-audit --no-fund --silent) >&2
  echo "$want" > "$CQ_DIR/node_modules/.cq-stamp"
fi

want="$(stamp "$CQ_DIR/php/composer.lock")"
if [[ "$(cat "$CQ_DIR/.cache/php-tools/.cq-stamp" 2>/dev/null)" != "$want" ]]; then
  echo "[codequality] setup: composer install (nikic/php-parser) in $IMAGE" >&2
  mkdir -p "$CQ_DIR/.cache/php-tools"
  docker run --rm -v "$CQ_DIR/php:/cq/php" -v "$CQ_DIR/.cache:/cq/.cache" -w /cq/php "$IMAGE" \
    composer install --no-interaction --no-progress --no-dev --quiet >&2
  echo "$want" > "$CQ_DIR/.cache/php-tools/.cq-stamp"
fi
