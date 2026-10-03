# shellcheck shell=bash
# axe-core (via Playwright + @axe-core/playwright) on the discovered guest pages.
run_axe() {
  app_running || { emit skipped "axe-core $AXE_CORE_VERSION" '{}' "$APP_REASON"; return; }
  ensure_pages || { emit failed "axe-core $AXE_CORE_VERSION" '{}' "page discovery failed (see pages.log)"; return; }
  cp "$PAGES_JSON" "$OUT/pages.json"
  docker_run --network "container:$APP_NAME" "${HARDEN[@]}" --shm-size 1g --memory 2g \
    -v "$SCRIPTS_DIR:/scripts:ro" -v "$OUT:/out" "$BROWSER_IMG" node /scripts/axe-scan.mjs > "$OUT/axe.log" 2>&1 \
    || { emit failed "axe-core $AXE_CORE_VERSION" '{}' "axe scan failed (see axe.log)"; return; }
  local m
  m="$(jq '{ pages_scanned: ([.pages[] | select(.status == "ok")] | length),
             pages_skipped: ([.pages[] | select(.status != "ok") | {id, reason}]),
             violations: ([.pages[] | .violations // 0] | add),
             violation_nodes: ([.pages[] | .violation_nodes // 0] | add),
             by_impact: (reduce (.pages[] | .by_impact // {}) as $b ({critical:0,serious:0,moderate:0,minor:0}; with_entries(.value += ($b[.key] // 0)))),
             unique_rules: ([.pages[] | .rules[]? | .id] | unique),
             tags: .tags,
             pages: [.pages[] | {id, url, status, reason, violations, by_impact, rules: [.rules[]? | .id]}] }' "$OUT/axe-summary.json")"
  emit ok "axe-core $AXE_CORE_VERSION, @axe-core/playwright $AXE_PLAYWRIGHT_VERSION, playwright $PLAYWRIGHT_VERSION" "$m"
}
