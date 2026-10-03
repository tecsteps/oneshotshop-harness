# shellcheck shell=bash
# Trivy: dependency vulnerabilities from composer.lock / package-lock.json (dev deps included).
# The vulnerability DB lives in the Docker volume oneshotshop-tools-trivy-cache and is refreshed
# by Trivy when older than its update interval; TOOLS_TRIVY_SKIP_DB_UPDATE=1 rescans with the
# cached DB unchanged (use it to compare several runs against one DB snapshot).
run_trivy() {
  local -a extra=()
  [[ "${TOOLS_TRIVY_SKIP_DB_UPDATE:-0}" == 1 ]] && extra+=(--skip-db-update)
  rm -f "$SRC/.trivyignore" "$SRC/.trivyignore.yaml" "$SRC/trivy.yaml"
  docker_run --network bridge -v "$SRC:/src:ro" -v "$OUT:/out" -v oneshotshop-tools-trivy-cache:/cache \
    "$TRIVY_IMAGE" fs --cache-dir /cache --scanners vuln --include-dev-deps --format json \
      --output /out/trivy.json --skip-dirs /src/vendor --skip-dirs /src/node_modules --quiet "${extra[@]}" /src \
      > "$OUT/trivy.log" 2>&1 || { emit failed "trivy ${TRIVY_IMAGE%%@*}" '{}' "trivy failed (see trivy.log)"; return; }
  docker_run --network none -v oneshotshop-tools-trivy-cache:/cache "$TRIVY_IMAGE" version --cache-dir /cache --format json \
    > "$OUT/trivy-version.json" 2>/dev/null || echo '{}' > "$OUT/trivy-version.json"
  local m targets db
  m="$(jq '
    [ .Results[]? as $r | $r.Vulnerabilities[]? | {target: $r.Target, id: .VulnerabilityID, pkg: .PkgName, ver: .InstalledVersion, sev: .Severity, fixed: .FixedVersion} ]
    | unique_by([.target, .id, .pkg, .ver]) as $v
    | { vulnerabilities: ($v | length),
        by_severity: ({CRITICAL:0,HIGH:0,MEDIUM:0,LOW:0,UNKNOWN:0} + ($v | group_by(.sev) | map({key: .[0].sev, value: length}) | from_entries)),
        by_target: ($v | group_by(.target) | map({key: .[0].target, value: length}) | from_entries),
        vulnerable_packages: ($v | map("\(.pkg)@\(.ver)") | unique),
        fixable: ($v | map(select(.fixed != null and .fixed != "")) | length) }' "$OUT/trivy.json")"
  targets="$(jq -c '[.Results[]? | {target: .Target, type: .Type, packages: (.Packages // [] | length)}]' "$OUT/trivy.json")"
  db="$(jq -c '{version: (.VulnerabilityDB.Version // null), updated_at: (.VulnerabilityDB.UpdatedAt // null),
                next_update: (.VulnerabilityDB.NextUpdate // null), downloaded_at: (.VulnerabilityDB.DownloadedAt // null)}' "$OUT/trivy-version.json")"
  m="$(jq --argjson t "$targets" --argjson db "$db" '. + {lockfiles_scanned: $t, db: $db}' <<<"$m")"
  local tag="${TRIVY_IMAGE%%@*}"; emit ok "trivy ${tag##*:}" "$m"
}
