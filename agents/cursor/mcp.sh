#!/usr/bin/env bash
# Runs inside the container as `agent`: global Cursor MCP config (~/.cursor/mcp.json).
set -euo pipefail
mkdir -p "$HOME/.cursor"
cp "$HOME/.config/oneshotshop/mcp.json" "$HOME/.cursor/mcp.json"
