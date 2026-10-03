# shellcheck shell=bash
# Lighthouse (mobile + desktop presets, simulated throttling, median of N runs) on the
# discovered guest pages (home, category, WAT-001, NF-005), fresh seed state.
run_lighthouse() {
  app_running || { emit skipped "lighthouse $LIGHTHOUSE_VERSION" '{}' "$APP_REASON"; return; }
  ensure_pages || { emit failed "lighthouse $LIGHTHOUSE_VERSION" '{}' "page discovery failed (see pages.log)"; return; }
  "$TOOLS_DIR/app.sh" reseed "$RUN_ID" --name "$APP_NAME" --logs "$APP_LOGS" || true
  cp "$PAGES_JSON" "$OUT/pages.json"
  docker_run --network "container:$APP_NAME" "${HARDEN[@]}" --shm-size 1g --memory 3g -e LH_RUNS="$LIGHTHOUSE_RUNS" \
    -v "$SCRIPTS_DIR:/scripts:ro" -v "$OUT:/out" "$BROWSER_IMG" node /scripts/lighthouse-scan.mjs > "$OUT/lighthouse.log" 2>&1 \
    || { emit failed "lighthouse $LIGHTHOUSE_VERSION" '{}' "lighthouse failed (see lighthouse.log)"; return; }
  local m
  m="$(jq '{ runs_per_preset, throttling, chromium,
             pages: [.pages[] | {id, url, status, reason, mobile: .presets.mobile, desktop: .presets.desktop}],
             averages: ( . as $r | ["mobile","desktop"] | map({key: ., value: (. as $p | [$r.pages[] | .presets[$p]? | select(.status == "ok")] as $x
               | if ($x | length) == 0 then null else
                 { pages: ($x | length),
                   performance: ([$x[].scores.performance] | add / length | round), accessibility: ([$x[].scores.accessibility] | add / length | round),
                   best_practices: ([$x[].scores["best-practices"]] | add / length | round), seo: ([$x[].scores.seo] | add / length | round),
                   lcp_ms: ([$x[].lcp_ms] | add / length | round), tbt_ms: ([$x[].tbt_ms] | add / length | round),
                   cls: (([$x[].cls] | add / length) * 1000 | round / 1000), total_byte_weight: ([$x[].total_byte_weight] | add / length | round) } end)}) | from_entries ) }' \
       "$OUT/lighthouse-summary.json")"
  emit ok "lighthouse $(jq -r .lighthouse "$OUT/lighthouse-summary.json"), chromium $(jq -r .chromium "$OUT/lighthouse-summary.json")" "$m"
}
