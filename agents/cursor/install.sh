#!/usr/bin/env bash
# Runs inside the container as `agent`: official installer, puts cursor-agent into ~/.local/bin.
set -euo pipefail
curl -fsSL https://cursor.com/install | bash >/dev/null
