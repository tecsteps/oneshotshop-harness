# shellcheck shell=bash
# The agent's own tests, in the run image + PCOV, on the prepared app (gate steps done).
run_tests() {
  local img; img="$(ensure_tool_image php)"
  app_ready || { emit skipped "" '{}' "$APP_REASON"; return; }
  docker_run -i --init "${HARDEN[@]}" --network none --cpus 8 --memory 4g --memory-swap 4g \
    -v "$APP_NAME:/workspace" -v "$OUT:/out" -v "$SCRIPTS_DIR:/scripts:ro" -e TEST_TIMEOUT=1800 \
    "$img" bash -s < "$SCRIPTS_DIR/tests.sh" > "$OUT/tool-container.log" 2>&1 || true
  [[ -f "$OUT/tests-run.json" ]] || { emit failed "" '{}' "test runner produced no result"; return; }
  if [[ "$(jq -r .runner "$OUT/tests-run.json")" == null ]]; then
    emit skipped "" '{}' "$(jq -r .reason "$OUT/tests-run.json")"; return
  fi
  local ver m
  ver="$(jq -r '.runner_version' "$OUT/tests-run.json") + pcov $PCOV_VERSION"
  m="$(jq -s '.[1] + {runner: .[0].runner, exit_code: .[0].exit_code, seconds: .[0].seconds, timed_out: .[0].timed_out, command: .[0].command}' \
       "$OUT/tests-run.json" "$OUT/tests-summary.json" 2>/dev/null)" || m="$(cat "$OUT/tests-run.json")"
  if [[ "$(jq -r '.tests // empty' <<<"$m")" == "" ]]; then
    local last; last="$(grep -v '^[[:space:]]*$' "$OUT/test-output.txt" 2>/dev/null | tail -n1 | cut -c1-200 || true)"
    emit failed "$ver" "$m" "suite did not run to completion (exit $(jq -r .exit_code <<<"$m")): ${last:-see test-output.txt}"; return
  fi
  m="$(jq '. + {network: "none", note: (if (.failed // 0) + (.errors // 0) > 0 then "tests run without network access; failures that only need network (external APIs, CDNs) count as legitimate findings - see test-output.txt" else null end)}' <<<"$m")"
  emit ok "$ver" "$m"
}
