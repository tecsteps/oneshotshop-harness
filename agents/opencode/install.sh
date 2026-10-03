#!/usr/bin/env bash
# Runs inside the container as `agent`: install the latest opencode into ~/.local.
set -euo pipefail
npm install -g --no-audit --no-fund opencode-ai >/dev/null
