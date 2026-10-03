#!/usr/bin/env bash
# eval/perf/prepare.sh --container <name> [--workdir /workspace] [--reset] [--check-url <url>]
#
# Opt-in for any evaluation step that runs the app in a container from a THROWAWAY copy of the
# run workspace (never the run branch). Call it once after `composer install` has run in that
# container; before or after `php artisan serve` is started does not matter.
#   - copies the harness probe package into the container (/tmp/oss-perf-probe)
#   - installs it into the copy (path repo + composer require --dev; fallbacks see probe-install.sh)
#   - enables it (storage/perf/ENABLED); from then on every HTTP request Laravel handles appends
#     one line to <workdir>/storage/perf/requests.jsonl and gets an X-OSS-Perf-Id response header
# stdout: one JSON line {ok, method, notes[, check]}; exit 0 if ok, 1 otherwise. Never fatal for
# the caller's own step: callers should log and continue when it fails.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C="" WD=/workspace RESET=0 CHECK=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) C="$2"; shift 2 ;;
    --workdir) WD="$2"; shift 2 ;;
    --reset) RESET=1; shift ;;
    --check-url) CHECK="$2"; shift 2 ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) echo "prepare.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
[[ -n "$C" ]] || { echo "prepare.sh: --container required" >&2; exit 2; }

docker exec -u agent "$C" bash -c 'rm -rf /tmp/oss-perf-probe && mkdir -p /tmp/oss-perf-probe'
COPYFILE_DISABLE=1 tar -C "$HERE/probe" -cf - . | docker exec -i -u agent "$C" bash -c 'tar -xf - -C /tmp/oss-perf-probe 2>/dev/null' 
out="$(docker exec -i -u agent -w "$WD" -e OSS_PERF_WORKDIR="$WD" -e OSS_PERF_RESET="$RESET" "$C" bash -s < "$HERE/probe-install.sh" | tail -n 1)"
if [[ -n "$CHECK" ]] && jq -e .ok <<<"$out" >/dev/null 2>&1; then
  # One marked request (excluded from aggregation) proves the probe records and sets its header.
  hdr="$(curl -s -o /dev/null -D - -A 'oss-perf-check' --max-time 60 "$CHECK" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-oss-perf-id"{print $2}')"
  out="$(jq -c --arg h "$hdr" '. + {check: {url_header_seen: ($h != ""), perf_id: $h}} | .ok = (.ok and $h != "")' <<<"$out")"
fi
echo "$out"
jq -e .ok <<<"$out" >/dev/null 2>&1
