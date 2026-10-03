# shellcheck shell=bash
# Larastan/PHPStan at fixed levels with the harness config, on the prepared app volume.
# Must run after every tool that needs the unmodified app (it composer-requires Larastan).
run_phpstan() {
  app_ready || { emit skipped "larastan $LARASTAN_VERSION" '{}' "$APP_REASON"; return; }
  docker_run -i --init "${HARDEN[@]}" --network bridge --cpus 8 --memory 4g --memory-swap 4g \
    -v "$APP_NAME:/workspace" -v "$OUT:/out" \
    -e LARASTAN_VERSION="$LARASTAN_VERSION" -e PHPSTAN_VERSION="$PHPSTAN_VERSION" -e LEVELS="$PHPSTAN_LEVELS" \
    "$RUN_IMAGE" bash -s < "$SCRIPTS_DIR/phpstan.sh" > "$OUT/tool-container.log" 2>&1 || true
  [[ "$(jq -r '.ok // false' "$OUT/phpstan-run.json" 2>/dev/null)" == true ]] \
    || { emit failed "larastan $LARASTAN_VERSION" '{}' "$(jq -r '.reason // "phpstan run failed"' "$OUT/phpstan-run.json" 2>/dev/null)"; return; }
  local m='{}' L inline
  for L in $PHPSTAN_LEVELS; do
    if jq -e '.totals' "$OUT/phpstan-level$L.json" >/dev/null 2>&1; then
      m="$(jq --arg L "level_$L" --slurpfile r "$OUT/phpstan-level$L.json" '. + {($L): ($r[0] | {
             errors: (.totals.file_errors + .totals.errors), file_errors: .totals.file_errors, general_errors: .totals.errors,
             files_with_errors: (.files | length),
             top_identifiers: ([.files[].messages[] | (.identifier // "unknown")] | group_by(.) | map({id: .[0], count: length}) | sort_by(-.count) | .[0:10]) })}' <<<"$m")"
    else
      m="$(jq --arg L "level_$L" '. + {($L): {errors: null, failed: true}}' <<<"$m")"
    fi
  done
  inline="$(cd "$SRC" && git grep -I -c -E '@phpstan-ignore' HEAD -- app routes 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}' || true)"
  m="$(jq --argjson i "$inline" --slurpfile run "$OUT/phpstan-run.json" \
        '. + {inline_ignore_comments: $i, paths: ["app", "routes"], composer_install_mode: $run[0].install}' <<<"$m")"
  if jq -e '[.[] | objects | select(.failed == true)] | length > 0' <<<"$m" >/dev/null; then
    emit failed "$(jq -r '.phpstan_version' "$OUT/phpstan-run.json"), larastan $LARASTAN_VERSION" "$m" "a level crashed (see phpstan-level*.stderr)"; return
  fi
  emit ok "$(jq -r '.phpstan_version' "$OUT/phpstan-run.json"), larastan $LARASTAN_VERSION" "$m"
}
