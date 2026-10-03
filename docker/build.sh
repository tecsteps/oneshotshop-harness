#!/usr/bin/env bash
# Build the run image with an explicit tag and point `oneshotshop-runner:current` at it.
#   docker/build.sh            -> oneshotshop-runner:<YYYY-MM-DD> + :current
#   docker/build.sh v2-final   -> oneshotshop-runner:v2-final     + :current
# Every run records the exact image id; verify.sh reuses that id for the gate.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${1:-$(date +%Y-%m-%d)}"
# shellcheck source=/dev/null
source "$DIR/../lib/versions.sh"
docker build --build-arg PLAYWRIGHT_DEPS_VERSION="$PLAYWRIGHT_DEPS_VERSION" -t "oneshotshop-runner:${TAG}" -t oneshotshop-runner:current "$DIR"
docker image inspect --format 'oneshotshop-runner:'"$TAG"' = {{.Id}}' "oneshotshop-runner:${TAG}"
