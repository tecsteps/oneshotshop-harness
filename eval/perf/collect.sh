#!/usr/bin/env bash
# eval/perf/collect.sh --container <name> <out-dir> [--prefix qa-] [--workdir /workspace] [--reset]
#
# Call at the end of a session in which the probe was enabled (prepare.sh), while the container
# still runs. Runs `php artisan oss-perf:explain` (EXPLAIN QUERY PLAN for every statement shape
# seen, against the app's current SQLite DB) and copies out:
#   <out-dir>/<prefix>requests.jsonl   one line per HTTP request (see eval/perf/README.md)
#   <out-dir>/<prefix>explain.json     query plans, full scans, missing-index suspects, table sizes
# --reset truncates the container's request log afterwards (next session starts empty).
# The QA/testplan step uses: collect.sh --container "$C" runs/<run-id>/perf --prefix qa-
set -euo pipefail
C="" OUT="" PREFIX="" WD=/workspace RESET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) C="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --workdir) WD="$2"; shift 2 ;;
    --reset) RESET=1; shift ;;
    -h|--help) sed -n 2,12p "$0"; exit 0 ;;
    -*) echo "collect.sh: unknown option $1" >&2; exit 2 ;;
    *) OUT="$1"; shift ;;
  esac
done
[[ -n "$C" && -n "$OUT" ]] || { echo "usage: collect.sh --container <name> <out-dir> [--prefix p]" >&2; exit 2; }
mkdir -p "$OUT"
docker exec -u agent -w "$WD" "$C" bash -c 'php artisan oss-perf:explain --out=/tmp/oss-perf-explain.json 2>&1 | tail -n 1' >&2 || true
docker exec -u agent -w "$WD" "$C" bash -c 'cat storage/perf/requests.jsonl 2>/dev/null || true' > "$OUT/${PREFIX}requests.jsonl"
docker exec -u agent "$C" bash -c 'cat /tmp/oss-perf-explain.json 2>/dev/null || echo "{}"' > "$OUT/${PREFIX}explain.json"
if [[ $RESET == 1 ]]; then docker exec -u agent -w "$WD" "$C" bash -c ': > storage/perf/requests.jsonl' || true; fi
n="$(wc -l < "$OUT/${PREFIX}requests.jsonl" | tr -d ' ')"
echo "{\"requests\": $n, \"requests_file\": \"$OUT/${PREFIX}requests.jsonl\", \"explain_file\": \"$OUT/${PREFIX}explain.json\"}"
