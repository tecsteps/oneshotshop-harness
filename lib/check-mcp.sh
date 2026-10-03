#!/usr/bin/env bash
# check-mcp — installed into the run container as ~/.local/bin/check-mcp by ./oneshotshop.
# Asks the logged-in agent (one tiny non-interactive call, a few tokens on your login) to list its
# Playwright tools and to navigate to https://example.com with the Playwright MCP.
# PASS = the answer names browser_navigate AND reports the title "Example Domain".
set -uo pipefail
AGENT="__AGENT__"
HINT="__HINT__"
Q="List the exact names of all tools you have whose name contains playwright or browser. Then call the Playwright browser navigate tool on https://example.com and report the page title. Reply briefly."
OUT="$(mktemp)"
export Q OUT
echo "check-mcp: asking $AGENT for its Playwright tools (one short call on your login) ..."
cd /workspace 2>/dev/null || true
timeout 300 bash -c '__CMD__' </dev/null 2>/tmp/check-mcp.err
code=$?
names="$(grep -oiE '[A-Za-z0-9_.:-]*browser_[a-z_]+' "$OUT" | sort -u)"
if grep -qi 'browser_navigate' <<<"$names" && grep -q 'Example Domain' "$OUT"; then
  echo "PASS: $AGENT sees the Playwright MCP tools ($(wc -l <<<"$names" | tr -d ' ') browser tools) and navigated to example.com (title \"Example Domain\"), e.g.:"
  head -n 5 <<<"$names" | sed 's/^/  /'
  echo "You can paste the prompt now."
  rm -f "$OUT"; exit 0
fi
echo "FAIL: $AGENT did not list browser_navigate and/or did not report the title \"Example Domain\" (exit $code). Its answer:"
head -c 1500 "$OUT" | sed 's/^/  | /'; echo
[[ -s /tmp/check-mcp.err ]] && { echo "stderr:"; tail -n 5 /tmp/check-mcp.err | sed 's/^/  ! /'; }
echo "Likely fix: $HINT"
echo "Do not paste the prompt until check-mcp passes."
rm -f "$OUT"; exit 1
