#!/usr/bin/env bash
# Runs inside the container as `agent`: Playwright MCP in ~/.codex/config.toml, written directly
# (absolute binary path, explicit timeouts) after install.sh's [features] table.
set -euo pipefail
CFG="$HOME/.config/oneshotshop/mcp.json"
mkdir -p "$HOME/.codex"
{
  echo
  echo '[mcp_servers.playwright]'
  jq -r '.mcpServers.playwright | "command = \(.command | tojson)\nargs = \(.args | tojson)"' "$CFG"
  echo 'startup_timeout_sec = 60'
  echo 'tool_timeout_sec = 120'
} >> "$HOME/.codex/config.toml"
