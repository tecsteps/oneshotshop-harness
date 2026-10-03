#!/usr/bin/env bash
# Runs inside the container as `agent`: register Playwright MCP at user scope (~/.claude.json).
set -euo pipefail
mapfile -t MCP_ARGS < <(jq -r '.mcpServers.playwright.args[]' "$HOME/.config/oneshotshop/mcp.json")
MCP_CMD="$(jq -r '.mcpServers.playwright.command' "$HOME/.config/oneshotshop/mcp.json")"
claude mcp add --scope user playwright -- "$MCP_CMD" "${MCP_ARGS[@]}" >/dev/null
