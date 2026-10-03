# shellcheck shell=bash
# Semgrep CE with the vendored, frozen rules (config/semgrep/rules + config/semgrep/harness).
# No registry access at scan time (--network none, --metrics=off); nosemgrep comments are
# disabled (--disable-nosem) and the agent's .semgrepignore is replaced by the harness one.
run_semgrep() {
  "$CONFIG_DIR/semgrep/vendor.sh" >"$OUT/rules-fetch.log" 2>&1 \
    || { emit failed "semgrep ${SEMGREP_IMAGE%%@*}" '{}' "could not fetch/verify the pinned rules (see rules-fetch.log)"; return; }
  cp "$CONFIG_DIR/semgrepignore" "$SRC/.semgrepignore"
  local nosem
  nosem="$(git -C "$SRC" grep -I -c -i 'nosemgrep' HEAD -- . 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}' || true)"
  docker_run "${HARDEN[@]}" --network none -v "$SRC:/src:ro" -v "$CONFIG_DIR/semgrep:/rules:ro" -v "$OUT:/out" -w /src \
    -e SEMGREP_ENABLE_VERSION_CHECK=0 -e SEMGREP_SEND_METRICS=off \
    "$SEMGREP_IMAGE" semgrep scan --config /rules/rules --config /rules/harness --metrics=off \
      --disable-version-check --disable-nosem --json --output /out/semgrep.json --timeout 30 --jobs 4 \
      > "$OUT/semgrep.log" 2>&1
  [[ -s "$OUT/semgrep.json" ]] || { emit failed "semgrep ${SEMGREP_IMAGE%%@*}" '{}' "no report written (see semgrep.log)"; return; }
  local rules ver m
  rules="$(find "$CONFIG_DIR/semgrep/rules" "$CONFIG_DIR/semgrep/harness" -name '*.yaml' | wc -l | tr -d ' ')"
  ver="$(jq -r '.version // empty' "$OUT/semgrep.json")"
  m="$(jq --argjson nosem "$nosem" --argjson rf "$rules" --arg src "$(head -1 "$CONFIG_DIR/semgrep/rules/SOURCE")" --arg sha "$(grep -m1 "^SHA256=" "$CONFIG_DIR/semgrep/vendor.sh" | cut -d\" -f2)" '
    (.results | map(.check_id |= sub("^rules\\.(rules|harness)\\."; ""))) as $r
    | { findings: ($r | length),
        by_severity: ({ERROR:0,WARNING:0,INFO:0} + ($r | group_by(.extra.severity) | map({key: .[0].extra.severity, value: length}) | from_entries)),
        by_category: ($r | group_by(.extra.metadata.category // "other") | map({key: (.[0].extra.metadata.category // "other"), value: length}) | from_entries),
        top_rules: ($r | group_by(.check_id) | map({rule: .[0].check_id, severity: .[0].extra.severity, count: length}) | sort_by(-.count) | .[0:15]),
        files_with_findings: ($r | map(.path) | unique | length),
        files_scanned: (.paths.scanned // [] | length),
        errors: (.errors // [] | length),
        nosemgrep_comments: $nosem, rule_files: $rf, rules_source: $src, rules_sha256: $sha }' "$OUT/semgrep.json")"
  emit ok "semgrep ${ver:-${SEMGREP_IMAGE%%@*}}" "$m"
}
