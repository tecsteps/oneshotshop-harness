# shellcheck shell=bash
# Laravel Pint --test with the harness config (Laravel preset); the agent's pint.json is ignored.
run_pint() {
  local img; img="$(ensure_tool_image php)"
  rm -f "$SRC/pint.json"
  docker_run "${HARDEN[@]}" --network none -v "$SRC:/src:ro" -v "$CONFIG_DIR:/config:ro" -w /src "$img" \
    /opt/tools/pint/vendor/bin/pint --test --config /config/pint.json --format json > "$OUT/pint.json" 2>"$OUT/pint.stderr" || true
  jq -e . "$OUT/pint.json" >/dev/null 2>&1 || { emit failed "pint $PINT_VERSION" '{}' "no JSON output (see pint.stderr)"; return; }
  local total m
  total="$(git -C "$SRC" ls-files -- '*.php' | grep -vE '(^|/)(vendor|node_modules|storage|bootstrap/cache|public)/' | grep -v '\.blade\.php$' | wc -l | tr -d ' ' || true)"
  m="$(jq --argjson total "$total" '{ files_failing: (.files // [] | length), php_files: $total,
          failing_ratio: (if $total > 0 then ((.files // [] | length) / $total * 1000 | round / 1000) else null end),
          files: [(.files // [])[].name] }' "$OUT/pint.json")"
  emit ok "pint $PINT_VERSION (laravel preset)" "$m"
}
