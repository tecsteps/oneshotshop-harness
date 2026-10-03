#!/usr/bin/env bash
# Runs inside the container as `agent`: user-level opencode config (~/.config/opencode/opencode.json).
set -euo pipefail
mkdir -p "$HOME/.config/opencode"
jq '{"$schema": "https://opencode.ai/config.json",
     mcp: {playwright: {type: "local", enabled: true,
                        command: ([.mcpServers.playwright.command] + .mcpServers.playwright.args)}}}' \
  "$HOME/.config/oneshotshop/mcp.json" > "$HOME/.config/opencode/opencode.json"
