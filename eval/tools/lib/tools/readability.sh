# shellcheck shell=bash
# Readability: line-length metrics per language group (PHP, Blade, JS/TS/Vue, CSS) over the
# committed app code, same exclusions as the LOC count. Catches e.g. Blade views written as a
# few 2,000-character lines, which SonarQube barely analyses.
run_readability() {
  local img; img="$(ensure_tool_image php)"
  docker_run "${HARDEN[@]}" --network none -v "$SRC:/src:ro" -v "$SCRIPTS_DIR:/scripts:ro" -w /src "$img" bash -c '
    git ls-files -z | grep -zvE "(^|/)(vendor|node_modules|storage|public/build|public/vendor|bootstrap/cache|lang/vendor)/" \
      | php -d memory_limit=1G /scripts/readability.php' > "$OUT/readability.json" 2>"$OUT/readability.stderr" \
    || { emit failed "harness readability 1" '{}' "readability script failed (see readability.stderr)"; return; }
  emit ok "harness readability 1" "$(cat "$OUT/readability.json")"
}
