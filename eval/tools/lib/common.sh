# shellcheck shell=bash
# Shared helpers for eval/tools (sourced by run.sh and app.sh; never executed directly).

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_DIR="$(cd "$TOOLS_DIR/../.." && pwd)"
RUNS_DIR="${HARNESS_DIR}/runs"
CONFIG_DIR="$TOOLS_DIR/config"
SCRIPTS_DIR="$TOOLS_DIR/scripts"
export DOCKER_CLI_HINTS=false

# shellcheck source=../config/versions.env
source "$CONFIG_DIR/versions.env"
# One Playwright version for build, gate and evaluation (lib/versions.sh is the source of truth).
if [[ -f "$HARNESS_DIR/lib/versions.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HARNESS_DIR/lib/versions.sh"
fi
PLAYWRIGHT_VERSION="${PLAYWRIGHT_DEPS_VERSION:-$PLAYWRIGHT_VERSION_FALLBACK}"

tlog()  { printf '[tools] %s\n' "$*" >&2; }
twarn() { printf '[tools] WARNING: %s\n' "$*" >&2; }
tdie()  { printf '[tools] ERROR: %s\n' "$*" >&2; exit 1; }
now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date -u +%s; }

# Every container started by eval/tools carries this label, so cleanup can find leftovers.
TOOLS_LABEL="oneshotshop.tools"

# load_run <run-id>: sets RUN_ID RUN_DIR META BRANCH RUN_IMAGE WORKSPACE HEAD_SHA BASE_SHA
load_run() {
  RUN_ID="$1"
  RUN_DIR="$RUNS_DIR/$RUN_ID"
  META="$RUN_DIR/meta.json"
  WORKSPACE="$RUN_DIR/workspace"
  [[ -f "$META" ]] || tdie "no meta.json for run $RUN_ID ($META)"
  [[ -d "$WORKSPACE/.git" ]] || tdie "no run checkout at $WORKSPACE"
  BRANCH="$(jq -r '.branch // empty' "$META")"; [[ -n "$BRANCH" ]] || BRANCH="$RUN_ID"
  RUN_IMAGE="$(jq -r '.image.id // .image.tag // empty' "$META")"
  [[ -n "$RUN_IMAGE" ]] || RUN_IMAGE="oneshotshop-runner:current"
  docker image inspect "$RUN_IMAGE" >/dev/null 2>&1 || tdie "run image $RUN_IMAGE (from meta.json) is not present locally"
  HEAD_SHA="$(git -C "$WORKSPACE" rev-parse --verify -q "refs/heads/$BRANCH" || true)"
  [[ -n "$HEAD_SHA" ]] || tdie "branch $BRANCH not found in $WORKSPACE"
  BASE_SHA="$(jq -r '.result.base_commit // .spec.commit // empty' "$META")"
  if [[ -n "$BASE_SHA" ]] && ! git -C "$WORKSPACE" cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then BASE_SHA=""; fi
}

# A local tag for the run image id (BuildKit cannot use a bare image id in FROM).
run_image_tag() {
  local id; id="$(docker image inspect -f '{{.Id}}' "$RUN_IMAGE")"
  local tag="oneshotshop-tools-base:${id#sha256:}"; tag="${tag:0:42}"
  docker image inspect "$tag" >/dev/null 2>&1 || docker tag "$id" "$tag"
  printf '%s' "$tag"
}

# ensure_tool_image <php|browser>: builds (once, cached by tag) the derived tool image on top of
# the run image and prints its tag. The tag hashes the Dockerfile + pinned versions.
ensure_tool_image() {
  local kind="$1" base dockerfile hash tag
  base="$(run_image_tag)"
  dockerfile="$TOOLS_DIR/docker/$kind-tools.Dockerfile"
  [[ "$kind" == browser ]] && dockerfile="$TOOLS_DIR/docker/browser.Dockerfile"
  local -a args
  case "$kind" in
    php) args=(--build-arg "PCOV_VERSION=$PCOV_VERSION" --build-arg "PINT_VERSION=$PINT_VERSION"
               --build-arg "PHPMETRICS_VERSION=$PHPMETRICS_VERSION" --build-arg "CLOC_VERSION=$CLOC_VERSION") ;;
    browser) args=(--build-arg "PLAYWRIGHT_VERSION=$PLAYWRIGHT_VERSION" --build-arg "AXE_PLAYWRIGHT_VERSION=$AXE_PLAYWRIGHT_VERSION"
                   --build-arg "AXE_CORE_VERSION=$AXE_CORE_VERSION" --build-arg "LIGHTHOUSE_VERSION=$LIGHTHOUSE_VERSION") ;;
  esac
  hash="$( { cat "$dockerfile"; printf '%s\n' "$base" "${args[@]}"; } | shasum -a 256 | cut -c1-12)"
  tag="oneshotshop-tools-$kind:$hash"
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    tlog "building $tag (once per run image + pins)"
    docker build -q -f "$dockerfile" --build-arg "BASE_IMAGE=$base" "${args[@]}" -t "$tag" "$TOOLS_DIR/docker" >/dev/null \
      || return 1
  fi
  printf '%s' "$tag"
}

# Hardened defaults for containers that touch agent code (same spirit as the gate).
HARDEN=(--cap-drop ALL --security-opt no-new-privileges --pids-limit 4096)

# docker_run <args...>: docker run --rm with the tools label.
docker_run() { docker run --rm --label "$TOOLS_LABEL=${RUN_ID:-none}" "$@"; }
