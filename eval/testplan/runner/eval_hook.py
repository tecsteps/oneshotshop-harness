#!/usr/bin/env python3
"""PreToolUse hook for the test-plan evaluator (wired by suite.py via `claude --settings`).

Blocks browser_evaluate scripts that act on the page or the network instead of reading it
(fetch, XMLHttpRequest, DOMParser, .click(), .value=, submit(), dispatchEvent, navigation, DOM writes, …).
Allowed: read-only expressions such as the plan's 0.7 JS-* snippets and innerText reads.
Every decision is appended to $EVAL_HOOK_LOG (JSON lines). Exit code 2 = block, stderr goes to the model.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grade import forbidden_js  # noqa: E402


def main():
    try:
        ev = json.load(sys.stdin)
    except ValueError:
        return 0
    name = ev.get("tool_name", "")
    src = (ev.get("tool_input") or {}).get("function") or (ev.get("tool_input") or {}).get("code") or ""
    bad = forbidden_js(src) if name.endswith("browser_evaluate") else (["run_code"] if "run_code" in name else [])
    log = os.environ.get("EVAL_HOOK_LOG")
    if log:
        with open(log, "a") as f:
            f.write(json.dumps({"tool": name, "blocked": bool(bad), "patterns": bad, "script": src[:500]}) + "\n")
    if bad:
        sys.stderr.write(
            "Blocked by the test harness: browser_evaluate may only READ the page (0.7 snippets, innerText, "
            f"attributes). Not allowed here: {', '.join(bad)}. Use the page's own controls with browser_click, "
            "browser_type, browser_select_option or browser_fill_form, and links instead of fetch/typed URLs.")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
