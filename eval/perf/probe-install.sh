#!/usr/bin/env bash
# Runs INSIDE the app container as `agent` (piped in on stdin by eval/perf/prepare.sh), in the
# Laravel root of a THROWAWAY copy of the run workspace. Needs `composer install` to have run.
# Installs the harness probe from $OSS_PERF_PROBE_SRC (default /tmp/oss-perf-probe), enables it
# (storage/perf/ENABLED) and prints one JSON line: {ok, method, provider_registered, notes}.
# Safe to run while `php artisan serve` is already running (each request re-boots the app).
#
# Env: OSS_PERF_WORKDIR (default /workspace), OSS_PERF_PROBE_SRC, OSS_PERF_RESET=1 (clear old data)
set -uo pipefail
WD="${OSS_PERF_WORKDIR:-/workspace}"
SRC="${OSS_PERF_PROBE_SRC:-/tmp/oss-perf-probe}"
LOG=/tmp/oss-perf-install.log
cd "$WD" || { echo '{"ok":false,"error":"workdir missing"}'; exit 0; }
: > "$LOG"
notes=()
method=""
PROVIDER='OneShotShop\PerfProbe\PerfProbeServiceProvider'

registered() { php artisan list --raw 2>/dev/null | grep -q '^oss-perf:explain'; }

if [[ ! -f artisan || ! -f composer.json || ! -d vendor ]]; then
  echo '{"ok":false,"error":"not a Laravel root with vendor/ (run composer install first)"}'; exit 0
fi

if registered; then
  method="already-installed"
else
  # 1) Preferred: path repository + composer require --dev (package discovery registers the provider).
  export COMPOSER_NO_INTERACTION=1 COMPOSER_NO_AUDIT=1
  cp composer.json /tmp/oss-perf-composer.json.bak
  [[ -f composer.lock ]] && cp composer.lock /tmp/oss-perf-composer.lock.bak
  composer config repositories.oss-perf-probe \
    "{\"type\":\"path\",\"url\":\"$SRC\",\"options\":{\"symlink\":false}}" >>"$LOG" 2>&1
  if timeout 600 composer require --dev --no-progress 'oneshotshop/perf-probe:1.0.0' >>"$LOG" 2>&1; then
    method="composer-require"
    php artisan package:discover >>"$LOG" 2>&1 || true
  else
    notes+=("composer require failed (see $LOG); falling back to autoload + manual provider")
    composer config --unset repositories.oss-perf-probe >>"$LOG" 2>&1 || true
    cp /tmp/oss-perf-composer.json.bak composer.json
    [[ -f /tmp/oss-perf-composer.lock.bak ]] && cp /tmp/oss-perf-composer.lock.bak composer.lock
    # 2) Fallback: PSR-4 autoload entry pointing at the probe source, no dependency resolution.
    php -r '
      $f = "composer.json"; $j = json_decode(file_get_contents($f), true);
      $j["autoload"]["psr-4"]["OneShotShop\\PerfProbe\\"] = $argv[1] . "/src/";
      file_put_contents($f, json_encode($j, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");' "$SRC" >>"$LOG" 2>&1
    composer dump-autoload >>"$LOG" 2>&1 || notes+=("composer dump-autoload failed")
    method="autoload-fallback"
  fi
  if ! registered; then
    # Package discovery disabled (dont-discover) or fallback path: register the provider by hand.
    added="$(php -r '
      $line = "\\OneShotShop\\PerfProbe\\PerfProbeServiceProvider::class,";
      foreach (["bootstrap/providers.php" => "/return\\s*\\[/", "config/app.php" => "/App\\\\Providers\\\\AppServiceProvider::class,/"] as $f => $re) {
        if (!is_file($f)) continue;
        $s = file_get_contents($f);
        if (strpos($s, "PerfProbeServiceProvider") !== false) { echo $f; exit; }
        $n = preg_replace($re, "\$0\n        " . str_replace("\\", "\\\\", $line), $s, 1, $c);
        if ($c) { file_put_contents($f, $n); echo $f; exit; }
      }' 2>>"$LOG")"
    [[ -n "$added" ]] && notes+=("provider registered by hand in $added")
    php artisan config:clear >>"$LOG" 2>&1 || true
  fi
fi

mkdir -p storage/perf/samples
if [[ "${OSS_PERF_RESET:-0}" == 1 ]]; then
  rm -f storage/perf/requests.jsonl storage/perf/explain.json storage/perf/samples/*.json
fi
date -u +%FT%TZ > storage/perf/ENABLED
chmod -R a+rwX storage/perf 2>/dev/null || true

ok=false; registered && ok=true
notes_json=$(printf '%s\n' "${notes[@]+"${notes[@]}"}" | jq -R . | jq -sc 'map(select(. != ""))')
jq -nc --argjson ok "$ok" --arg m "$method" --argjson notes "$notes_json" \
  --arg tail "$( $ok || tail -n 30 "$LOG")" \
  '{ok: $ok, method: $m, enabled_marker: "storage/perf/ENABLED", notes: $notes} + (if $tail == "" then {} else {log_tail: $tail} end)'
