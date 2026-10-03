# shellcheck shell=bash
# OWASP ZAP baseline (spider + PASSIVE scan only, no attacks) against the running app, from
# inside the app's network namespace (http://127.0.0.1:8000, as the gate). Fresh seed first.
run_zap() {
  app_running || { emit skipped "zap ${ZAP_IMAGE%%@*}" '{}' "$APP_REASON"; return; }
  "$TOOLS_DIR/app.sh" reseed "$RUN_ID" --name "$APP_NAME" --logs "$APP_LOGS" || true
  chmod 777 "$OUT"
  docker_run --network "container:$APP_NAME" --memory 2g -v "$OUT:/zap/wrk:rw" "$ZAP_IMAGE" \
    zap-baseline.py -t http://127.0.0.1:8000/ -m "$ZAP_SPIDER_MINUTES" -J zap.json -r zap.html -I > "$OUT/zap.log" 2>&1 || true
  [[ -s "$OUT/zap.json" ]] || { emit failed "zap ${ZAP_IMAGE%%@*}" '{}' "no report written (see zap.log)"; return; }
  local m
  m="$(jq '[.site[]?.alerts[]?] as $a
    | def risk: {"3":"high","2":"medium","1":"low","0":"informational"}[.riskcode];
    { alerts: ($a | length), instances: ([$a[] | (.count | tonumber? // (.instances | length))] | add // 0),
      by_risk: ({high:0, medium:0, low:0, informational:0} + ($a | group_by(risk) | map({key: (.[0] | risk), value: length}) | from_entries)),
      instances_by_risk: ({high:0, medium:0, low:0, informational:0} + ($a | group_by(risk) | map({key: (.[0] | risk), value: ([.[] | (.count | tonumber? // 0)] | add)}) | from_entries)),
      alert_list: ($a | map({id: .pluginid, name: .alert, risk: risk, count: (.count | tonumber? // null)}) | sort_by(.risk)),
      zap_version: ."@version", spider_minutes: '"$ZAP_SPIDER_MINUTES"' }' "$OUT/zap.json")"
  emit ok "zap $(jq -r '."@version"' "$OUT/zap.json") baseline (passive)" "$m"
}
