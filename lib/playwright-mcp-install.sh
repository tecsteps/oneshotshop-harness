#!/usr/bin/env bash
# Installs the pinned Playwright MCP server and its Chromium into the agent's HOME and writes
# the shared MCP definition to ~/.config/oneshotshop/mcp.json (standard "mcpServers" JSON).
# Runs INSIDE the container as `agent` (piped in by ./oneshotshop; never stored in the
# container). Used for building runs and, later, for the evaluation side, so the testing
# agent gets an identical browser toolset. Progress goes to stderr; stdout is one JSON line
# with the installed versions.
set -euo pipefail

# Pinned in lib/versions.sh; passed in by the caller (docker exec -e / source lib/versions.sh).
PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:?set PLAYWRIGHT_MCP_VERSION (see lib/versions.sh)}"
MCP_ARGS='["--headless", "--browser", "chromium", "--isolated", "--output-dir", "/tmp/playwright-mcp"]'

npm install -g --no-audit --no-fund "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" >&2
playwright-mcp install-browser chromium >&2

mkdir -p "$HOME/.config/oneshotshop"
# Absolute path to the preinstalled binary: no npx/PATH resolution when a session starts.
MCP_BIN="$(npm prefix -g)/bin/playwright-mcp"
[[ -x "$MCP_BIN" ]] || { echo "playwright-mcp not found at $MCP_BIN" >&2; exit 1; }
jq -n --arg cmd "$MCP_BIN" --argjson args "$MCP_ARGS" \
  '{mcpServers: {playwright: {command: $cmd, args: $args}}}' \
  > "$HOME/.config/oneshotshop/mcp.json"

# Versions, measured by launching the MCP's own Chromium headless.
MCP_DIR="$(npm root -g)/@playwright/mcp"
node -e '
  const dir = process.argv[1];
  const core = require(require.resolve("playwright-core", { paths: [dir] }));
  const coreVersion = require(require.resolve("playwright-core/package.json", { paths: [dir] })).version;
  (async () => {
    const b = await core.chromium.launch({ headless: true });
    console.log(JSON.stringify({
      playwright_mcp: require(dir + "/package.json").version,
      playwright_core: coreVersion,
      chromium: b.version(),
    }));
    await b.close();
  })().catch((e) => { console.error(e); process.exit(1); });
' "$MCP_DIR"
