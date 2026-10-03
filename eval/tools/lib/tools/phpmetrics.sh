# shellcheck shell=bash
# PhpMetrics over app/ (the application classes, as on the v1 website).
run_phpmetrics() {
  local img; img="$(ensure_tool_image php)"
  [[ -d "$SRC/app" ]] || { emit skipped "phpmetrics $PHPMETRICS_VERSION" '{}' "no app/ directory"; return; }
  docker_run "${HARDEN[@]}" --network none -v "$SRC:/src:ro" -v "$OUT:/out" -v "$SCRIPTS_DIR:/scripts:ro" -w /src "$img" bash -c '
    php -d memory_limit=2G /opt/tools/phpmetrics/vendor/bin/phpmetrics --report-json=/out/phpmetrics.json \
      --report-violations=/out/violations.xml app > /out/phpmetrics.txt 2>&1 || exit 1
    php /scripts/phpmetrics-summary.php /out/phpmetrics.json /out/violations.xml "$1" > /out/summary.json' _ "$PHPMETRICS_VERSION" \
    || { emit failed "phpmetrics $PHPMETRICS_VERSION" '{}' "phpmetrics failed (see phpmetrics.txt)"; return; }
  emit ok "phpmetrics $PHPMETRICS_VERSION" "$(cat "$OUT/summary.json")"
}
