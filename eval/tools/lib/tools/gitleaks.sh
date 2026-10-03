# shellcheck shell=bash
# Gitleaks over the run branch history since the branch point (meta.json result.base_commit).
run_gitleaks() {
  local range="HEAD" empty="$WORK/empty"; mkdir -p "$empty"
  [[ -n "$BASE_SHA" ]] && range="$BASE_SHA..HEAD"
  docker_run "${HARDEN[@]}" --network none -v "$SRC:/repo:ro" -v "$CONFIG_DIR:/config:ro" -v "$empty:/empty:ro" -v "$OUT:/out" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$GITLEAKS_IMAGE" git /repo --log-opts="$range" --config /config/gitleaks.toml \
      --gitleaks-ignore-path /empty --report-format json --report-path /out/gitleaks.json \
      --redact --exit-code 0 --no-banner --log-level warn > "$OUT/gitleaks.log" 2>&1
  [[ -f "$OUT/gitleaks.json" ]] || { emit failed "${GITLEAKS_IMAGE%%@*}" '{}' "no report written (see gitleaks.log)"; return; }
  # .env files added on the branch (only .env.example is allowed) and present at HEAD
  local added head allow
  added="$( { git -C "$SRC" log --format= --name-only --diff-filter=A "$range" 2>/dev/null | grep -E '(^|/)\.env(\.[A-Za-z0-9_.-]+)?$' | grep -vE '\.env\.example$' | sort -u; } || true)"
  added="$(printf '%s\n' "$added" | jq -R . | jq -sc 'map(select(. != ""))')"
  head="$( { git -C "$SRC" ls-tree -r --name-only HEAD | grep -E '(^|/)\.env(\.[A-Za-z0-9_.-]+)?$' | grep -vE '\.env\.example$'; } || true)"
  head="$(printf '%s\n' "$head" | jq -R . | jq -sc 'map(select(. != ""))')"
  allow="$(git -C "$SRC" grep -I -c 'gitleaks:allow' HEAD -- . 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}' || true)"
  local m
  m="$(jq --arg range "$range" --argjson added "$added" --argjson head "$head" --argjson allow "$allow" '
    { commit_range: $range, findings: length,
      unique_secrets: (map("\(.RuleID)|\(.File)|\(.StartLine)") | unique | length),
      by_rule: (group_by(.RuleID) | map({key: .[0].RuleID, value: length}) | from_entries),
      files: (map(.File) | unique),
      app_key_committed: (map(select(.RuleID == "laravel-app-key")) | length > 0),
      dotenv_files_added: $added, dotenv_files_at_head: $head,
      inline_allow_comments: $allow }' "$OUT/gitleaks.json")"
  local tag="${GITLEAKS_IMAGE%%@*}"; emit ok "gitleaks ${tag##*:v}" "$m"
}
