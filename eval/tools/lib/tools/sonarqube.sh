# shellcheck shell=bash
# SonarQube Community Build: a throwaway server container (started on demand, removed after
# the scan, ~3 GB RAM) + the sonar-scanner container. Harness-owned analysis settings
# (config/sonar-project.properties); "Standard Experience" mode so the metrics match the v1
# SonarCloud data (bugs / vulnerabilities / code smells, A-E ratings, debt minutes).
SONAR_METRICS="bugs,vulnerabilities,code_smells,security_hotspots,ncloc,lines,files,classes,functions,statements,duplicated_lines_density,duplicated_lines,duplicated_blocks,duplicated_files,reliability_rating,security_rating,sqale_rating,security_review_rating,security_hotspots_reviewed,sqale_index,sqale_debt_ratio,reliability_remediation_effort,security_remediation_effort,cognitive_complexity,complexity,comment_lines_density,ncloc_language_distribution"

sonar_api() { local path="$1"; shift; curl -fsS -u "$SONAR_AUTH" "$@" "http://127.0.0.1:$SONAR_PORT/api/$path"; }

sonar_stop() {
  [[ -n "${SONAR_CTR:-}" ]] || return 0
  docker logs "$SONAR_CTR" > "$OUT_SONAR/server.log" 2>&1 || true
  docker rm -f "$SONAR_CTR" >/dev/null 2>&1 || true
  docker network rm "$SONAR_CTR-net" >/dev/null 2>&1 || true
  SONAR_CTR=""
}

run_sonarqube() {
  OUT_SONAR="$OUT"
  SONAR_CTR="oneshotshop-tools-sonar-$RUN_ID"
  local net="$SONAR_CTR-net" key="oneshotshop-$RUN_ID" pw token t1 st
  rm -f "$SRC/sonar-project.properties" "$SRC/.sonarcloud.properties"
  docker rm -f "$SONAR_CTR" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  docker network create --label "$TOOLS_LABEL=$RUN_ID" "$net" >/dev/null
  tlog "sonarqube: starting server"
  docker run -d --name "$SONAR_CTR" --label "$TOOLS_LABEL=$RUN_ID" --network "$net" --network-alias sonarqube \
    -p 127.0.0.1::9000 --memory 3g --memory-swap 3g \
    -e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true -e SONAR_TELEMETRY_ENABLE=false \
    -e SONAR_SEARCH_JAVAOPTS="-Xms512m -Xmx512m" -e SONAR_WEB_JAVAOPTS="-Xmx512m" -e SONAR_CE_JAVAOPTS="-Xmx1g" \
    "$SONARQUBE_IMAGE" >/dev/null
  SONAR_PORT="$(docker port "$SONAR_CTR" 9000/tcp | head -1 | sed 's/.*://')"
  t1=$(now_epoch); st=""
  while (( $(now_epoch) - t1 < 420 )); do
    st="$(curl -fsS "http://127.0.0.1:$SONAR_PORT/api/system/status" 2>/dev/null | jq -r .status 2>/dev/null || true)"
    [[ "$st" == UP ]] && break
    sleep 5
  done
  [[ "$st" == UP ]] || { sonar_stop; emit failed "" '{}' "SonarQube server did not come up (status '$st'; see server.log)"; return; }
  local server_version; server_version="$(curl -fsS "http://127.0.0.1:$SONAR_PORT/api/server/version")"
  pw="Tools-$(openssl rand -hex 10)-Aa1!"
  curl -fsS -u admin:admin -X POST "http://127.0.0.1:$SONAR_PORT/api/users/change_password" \
    --data-urlencode login=admin --data-urlencode previousPassword=admin --data-urlencode "password=$pw" >/dev/null
  SONAR_AUTH="admin:$pw"
  sonar_api "settings/set" -X POST -d key=sonar.multi-quality-mode.enabled -d value=false >/dev/null || twarn "could not switch SonarQube to Standard Experience"
  token="$(sonar_api "user_tokens/generate" -X POST -d name=scan | jq -r .token)"
  local -a props=(-Dproject.settings=/config/sonar-project.properties "-Dsonar.projectKey=$key" "-Dsonar.projectName=$RUN_ID" "-Dsonar.projectVersion=${HEAD_SHA:0:12}")
  [[ -d "$SRC/tests" ]] && props+=(-Dsonar.tests=tests)
  tlog "sonarqube: scanning"
  docker_run --network "$net" -v "$SRC:/usr/src:ro" -v "$CONFIG_DIR:/config:ro" \
    -e SONAR_HOST_URL=http://sonarqube:9000 -e SONAR_TOKEN="$token" -e SONAR_SCANNER_OPTS="-Xmx1g" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$SONAR_SCANNER_IMAGE" "${props[@]}" > "$OUT/scanner.log" 2>&1 \
    || { sonar_stop; emit failed "sonarqube $server_version" '{}' "scanner failed (see scanner.log)"; return; }
  # Wait for the background task (Compute Engine) to finish.
  t1=$(now_epoch); st=""
  while (( $(now_epoch) - t1 < 600 )); do
    st="$(sonar_api "ce/component?component=$key" | jq -r 'if (.queue | length) > 0 then "PENDING" else (.current.status // "NONE") end')"
    [[ "$st" == SUCCESS || "$st" == FAILED || "$st" == CANCELED ]] && break
    sleep 3
  done
  [[ "$st" == SUCCESS ]] || { sonar_stop; emit failed "sonarqube $server_version" '{}' "analysis task status $st"; return; }
  sonar_api "measures/component?component=$key&metricKeys=$SONAR_METRICS" > "$OUT/measures.json"
  sonar_api "qualitygates/project_status?projectKey=$key" > "$OUT/quality-gate.json"
  sonar_api "hotspots/search?projectKey=$key&ps=1" > "$OUT/hotspots.json" || echo '{}' > "$OUT/hotspots.json"
  sonar_api "issues/search?componentKeys=$key&resolved=false&ps=1&facets=severities,types,rules" > "$OUT/issues-facets.json"
  local p=1 total=1 tmp="$OUT/.issues"; mkdir -p "$tmp"
  while (( (p - 1) * 500 < total && p <= 20 )); do
    sonar_api "issues/search?componentKeys=$key&resolved=false&ps=500&p=$p&additionalFields=rules" > "$tmp/$p.json"
    total="$(jq -r '.paging.total // .total // 0' "$tmp/$p.json")"; p=$((p + 1))
  done
  jq -s '{total: (.[0].paging.total // .[0].total), issues: (map(.issues) | add), rules: (map(.rules // []) | add | unique_by(.key))}' "$tmp"/*.json > "$OUT/issues.json"
  rm -rf "$tmp"
  sonar_stop
  local m
  m="$(jq -n --slurpfile ms "$OUT/measures.json" --slurpfile qg "$OUT/quality-gate.json" --slurpfile f "$OUT/issues-facets.json" \
             --slurpfile is "$OUT/issues.json" --slurpfile hs "$OUT/hotspots.json" '
    def rating: if . == null then null else (["A","B","C","D","E"][(tonumber | floor) - 1]) end;
    def num: if . == null then null else tonumber end;
    ($ms[0].component.measures | map({key: .metric, value: .value}) | from_entries) as $m
    | ($f[0].facets | map({key: .property, value: (.values | map({key: .val, value: .count}) | from_entries)}) | from_entries) as $fc
    | ($is[0].rules | map({key: .key, value: .name}) | from_entries) as $names
    | { qualityGate: $qg[0].projectStatus.status,
        measures: { bugs: ($m.bugs | num), vulnerabilities: ($m.vulnerabilities | num), codeSmells: ($m.code_smells | num),
                    securityHotspots: ($m.security_hotspots | num // $hs[0].paging.total), ncloc: ($m.ncloc | num),
                    duplicatedLinesDensity: ($m.duplicated_lines_density | num),
                    reliabilityRating: ($m.reliability_rating | rating), securityRating: ($m.security_rating | rating),
                    maintainabilityRating: ($m.sqale_rating | rating), securityReviewRating: ($m.security_review_rating | rating),
                    cognitiveComplexity: ($m.cognitive_complexity | num), cyclomaticComplexity: ($m.complexity | num),
                    duplicatedLines: ($m.duplicated_lines | num), duplicatedBlocks: ($m.duplicated_blocks | num),
                    debtRatio: ($m.sqale_debt_ratio | num), commentLinesDensity: ($m.comment_lines_density | num),
                    files: ($m.files | num), functions: ($m.functions | num), classes: ($m.classes | num),
                    nclocByLanguage: (($m.ncloc_language_distribution // "") | split(";") | map(select(. != "") | split("=") | {key: .[0], value: (.[1] | tonumber)}) | from_entries) },
        totalDebt: ($m.sqale_index | num),
        issuesBySeverity: ({blocker:0, critical:0, major:0, minor:0, info:0} + (($fc.severities // {}) | with_entries(.key |= ascii_downcase))),
        issuesByType: (($fc.types // {}) | with_entries(.key |= ascii_downcase)),
        totalIssues: ($is[0].total // null),
        qualityGateDetails: [ $qg[0].projectStatus.conditions[]? | {metric: .metricKey, status, value: .actualValue, threshold: .errorThreshold, comparator} ],
        topIssues: ([ $is[0].issues[] | {rule, severity, type} ] | group_by(.rule)
                    | map({rule: .[0].rule, key: ($names[.[0].rule] // .[0].rule), count: length, severity: .[0].severity, type: .[0].type})
                    | sort_by(-.count) | .[0:12]) }')"
  emit ok "sonarqube $server_version (community), scanner ${SONAR_SCANNER_IMAGE%%@*}" "$m"
}
