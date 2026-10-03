# shellcheck shell=bash
# Shared helpers for run.sh and verify.sh (sourced, never executed directly).

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC2034  # used by run.sh / verify.sh
RUNS_DIR="${HARNESS_DIR}/runs"
export DOCKER_CLI_HINTS=false
IMAGE="${ONESHOTSHOP_IMAGE:-oneshotshop-runner:current}"

log()  { printf '[harness] %s\n' "$*" >&2; }
warn() { printf '[harness] WARNING: %s\n' "$*" >&2; }
die()  { printf '[harness] ERROR: %s\n' "$*" >&2; exit 1; }

now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date -u +%s; }

SECRETS_FILE="${HARNESS_DIR}/.env"

# secret_get KEY -> prints the value of KEY from the process environment, or else from
# the git-ignored harness .env (KEY=VALUE lines). Nothing is exported or logged;
# callers decide which single variable is passed into a container.
secret_get() {
  local want="$1" line key val
  if [[ -n "${!want:-}" ]]; then printf '%s' "${!want}"; return 0; fi
  [[ -f "$SECRETS_FILE" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    line="${line#export }"
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    [[ "$key" == "$want" ]] || continue
    val="${line#*=}"
    if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    [[ -n "$val" ]] || return 1
    printf '%s' "$val"
    return 0
  done < "$SECRETS_FILE"
  return 1
}

# "12h" | "90m" | "45s" | "1d" | "3600" -> seconds
parse_duration() {
  local d="$1"
  if [[ "$d" =~ ^([0-9]+)([smhd]?)$ ]]; then
    local n="${BASH_REMATCH[1]}" u="${BASH_REMATCH[2]}"
    case "$u" in
      ""|s) echo "$n" ;;
      m) echo $((n * 60)) ;;
      h) echo $((n * 3600)) ;;
      d) echo $((n * 86400)) ;;
    esac
  else
    die "invalid duration '$d' (use e.g. 45s, 90m, 12h, 1d)"
  fi
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker CLI not found"
  docker info >/dev/null 2>&1 || die "Docker daemon not reachable (start Docker Desktop)"
  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || die "image $IMAGE not found; build it with: ${HARNESS_DIR}/docker/build.sh"
}

image_id() { docker image inspect --format '{{.Id}}' "$IMAGE"; }

sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
