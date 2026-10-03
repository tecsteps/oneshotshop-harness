#!/usr/bin/env bash
# Fetches the Semgrep CE community rules into config/semgrep/rules/ (git-ignored, never
# committed: Semgrep Rules License v1.0) from semgrep/semgrep-rules at a PINNED commit and
# verifies a content checksum over the selected rule files. run.sh calls this automatically
# when the rules are missing or do not match the pin. Scans never use the live registry.
# Harness-owned rules live in config/semgrep/harness/ (committed).
#   vendor.sh            fetch if missing/mismatched, then verify
#   vendor.sh --check    verify only (exit 1 if missing or mismatched)
set -euo pipefail
COMMIT="a84ff9cc2453ca91d581380de4b8b3f272f6f4be"   # semgrep/semgrep-rules develop, 2026-09-22
SHA256="d358d54930aed722679d97970f63ab9c5fbfdf64a3eea10f713814edc2e7b0ae"  # sha256 of `shasum -a 256` over the sorted rule files
DIRS=(
  php/lang/security php/lang/correctness php/laravel/security php/doctrine/security
  javascript/lang/security javascript/lang/correctness javascript/browser/security javascript/vue/security
  generic/secrets
  generic/html-templates/security
)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULES="$HERE/rules"

checksum() { (cd "$1" && find . -type f \( -name '*.yaml' -o -name '*.yml' \) | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1); }
verify() { [[ -f "$RULES/SOURCE" ]] && [[ "$(head -1 "$RULES/SOURCE")" == "semgrep/semgrep-rules@$COMMIT" ]] && [[ "$(checksum "$RULES")" == "$SHA256" ]]; }

if verify; then exit 0; fi
[[ "${1:-}" == --check ]] && { echo "semgrep rules missing or not matching the pin" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "fetching semgrep-rules@$COMMIT" >&2
curl -fsSL "https://codeload.github.com/semgrep/semgrep-rules/tar.gz/${COMMIT}" | tar xz -C "$TMP" --strip-components=1
NEW="$TMP/out"; mkdir -p "$NEW"
for d in "${DIRS[@]}"; do
  (cd "$TMP" && find "$d" -type f \( -name '*.yaml' -o -name '*.yml' \) ! -name '*.test.yaml' ! -name '*.test.yml' -print0) |
    while IFS= read -r -d '' f; do mkdir -p "$NEW/$(dirname "$f")"; cp "$TMP/$f" "$NEW/$f"; done
done
got="$(checksum "$NEW")"
[[ "$got" == "$SHA256" ]] || { echo "semgrep rules checksum mismatch: got $got, want $SHA256" >&2; exit 1; }
cp "$TMP/LICENSE" "$NEW/LICENSE"
{ printf 'semgrep/semgrep-rules@%s\n' "$COMMIT"; printf '%s\n' "${DIRS[@]}"; } > "$NEW/SOURCE"
rm -rf "$RULES"; mv "$NEW" "$RULES"
echo "semgrep rules: $(find "$RULES" -name '*.yaml' | wc -l | tr -d ' ') files, checksum ok" >&2
