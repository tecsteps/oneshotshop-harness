#!/usr/bin/env bash
# Runs inside the container as `agent`: install the latest Claude Code into ~/.local.
set -euo pipefail
npm install -g --no-audit --no-fund @anthropic-ai/claude-code >/dev/null
