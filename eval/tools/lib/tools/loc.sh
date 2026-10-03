# shellcheck shell=bash
# LOC per language (cloc over the committed files, excluding dependencies/build output).
CODE_LANGS='["PHP","Blade","JavaScript","TypeScript","Vuejs Component","JSX","TSX","CSS","SCSS","Sass","LESS","HTML"]'
run_loc() {
  local img; img="$(ensure_tool_image php)"
  docker_run "${HARDEN[@]}" --network none -v "$SRC:/src:ro" -w /src "$img" \
    cloc --vcs=git --json --quiet --fullpath \
      --not-match-d='(^|/)(vendor|node_modules|storage|public/build|public/vendor|bootstrap/cache|lang/vendor)(/|$)' \
      --not-match-f='(^|/)(composer\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$' . > "$OUT/cloc.json" 2>"$OUT/cloc.stderr"
  local m
  m="$(jq --argjson code "$CODE_LANGS" '
    (to_entries | map(select(.key != "header" and .key != "SUM"))) as $l
    | { by_language: ($l | map({key, value: {files: .value.nFiles, code: .value.code, comment: .value.comment, blank: .value.blank}}) | from_entries),
        total_code: (.SUM.code // 0), total_files: (.SUM.nFiles // 0),
        app_code_loc: ([ $l[] | select(.key as $k | $code | index($k)) | .value.code ] | add // 0),
        php_loc: (.PHP.code // 0), blade_loc: (.Blade.code // 0),
        app_code_languages: $code }' "$OUT/cloc.json")"
  emit ok "cloc $(jq -r '.header.cloc_version' "$OUT/cloc.json")" "$m"
}
