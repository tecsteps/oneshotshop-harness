#!/usr/bin/env bash
# Runs inside the container as `agent`: install the latest Codex CLI into ~/.local and switch off
# Codex features that reach outside the isolated run (via the CLI's own `codex features disable`,
# which writes [features] in ~/.codex/config.toml).
set -euo pipefail
npm install -g --no-audit --no-fund @openai/codex >/dev/null

# Disabled by default (see README "Agents and logins"):
#   apps, plugins, remote_plugin, plugin_sharing  - ChatGPT Apps/connectors and plugin marketplace
#                                                   (e.g. mcp__codex_apps__sites_* deploying via the
#                                                   owner's ChatGPT account)
#   browser_use, browser_use_external, computer_use - Codex's own browser/computer control; the
#                                                   benchmark's browser tool is the Playwright MCP,
#                                                   identical for every agent
DISABLE="apps plugins remote_plugin plugin_sharing browser_use browser_use_external computer_use"
known="$(codex features list 2>/dev/null | awk '{print $1}')"
for f in $DISABLE; do
  if grep -qx "$f" <<<"$known"; then codex features disable "$f" >/dev/null
  else echo "codex feature '$f' not known by this CLI version; skipped" >&2; fi
done
