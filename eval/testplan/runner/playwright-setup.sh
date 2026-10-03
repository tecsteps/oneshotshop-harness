#!/usr/bin/env bash
# Ensure the pinned Playwright MCP (same version the harness installs for building agents, read from
# lib/versions.sh, as used by lib/playwright-mcp-install.sh) and its Chromium are installed in the harness-owned cache
# eval/testplan/.playwright/ (git-ignored). No global installs. Idempotent.
# stdout: one JSON line {playwright_mcp, playwright_core, chromium, mcp_bin, browsers_path}.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../../lib/versions.sh
source "$HARNESS/lib/versions.sh"
VERSION="${PLAYWRIGHT_MCP_VERSION:?PLAYWRIGHT_MCP_VERSION missing in lib/versions.sh}"
CACHE="$HERE/.playwright"
export PLAYWRIGHT_BROWSERS_PATH="$CACHE/browsers"
mkdir -p "$CACHE"
have="$(node -p "try{require('$CACHE/node_modules/@playwright/mcp/package.json').version}catch(e){''}" 2>/dev/null || true)"
if [[ "$have" != "$VERSION" ]]; then
  echo "[testplan] installing @playwright/mcp@$VERSION into $CACHE" >&2
  [[ -f "$CACHE/package.json" ]] || echo '{"private":true}' > "$CACHE/package.json"
  npm install --prefix "$CACHE" --no-audit --no-fund --save-exact "@playwright/mcp@$VERSION" >&2
fi
MCP_BIN="$CACHE/node_modules/.bin/playwright-mcp"
# Installs Chromium into PLAYWRIGHT_BROWSERS_PATH (no-op if present).
"$MCP_BIN" install-browser chromium >&2
MCP_DIR="$CACHE/node_modules/@playwright/mcp"
node -e '
  const [dir, bin, bp] = process.argv.slice(1);
  const core = require(require.resolve("playwright-core", { paths: [dir] }));
  const coreVersion = require(require.resolve("playwright-core/package.json", { paths: [dir] })).version;
  (async () => {
    const b = await core.chromium.launch({ headless: true });
    console.log(JSON.stringify({ playwright_mcp: require(dir + "/package.json").version,
      playwright_core: coreVersion, chromium: b.version(), mcp_bin: bin, browsers_path: bp }));
    await b.close();
  })().catch((e) => { console.error(e); process.exit(1); });
' "$MCP_DIR" "$MCP_BIN" "$PLAYWRIGHT_BROWSERS_PATH"
