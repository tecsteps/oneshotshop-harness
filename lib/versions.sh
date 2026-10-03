# shellcheck shell=bash
# Single source of truth for pinned versions. Sourced by ./oneshotshop, docker/build.sh and
# (on the host) by the evaluation runners. lib/playwright-mcp-install.sh receives the value
# via the environment, so agents in containers and the evaluator on the host use the same MCP.
# shellcheck disable=SC2034
PLAYWRIGHT_MCP_VERSION="0.0.83"
# Playwright release whose `install-deps chromium` provides the OS libraries in the image.
# shellcheck disable=SC2034
PLAYWRIGHT_DEPS_VERSION="1.63.0"
