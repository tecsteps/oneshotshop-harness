#!/usr/bin/env python3
"""Re-score a finished pass OFFLINE with the hardened rules, in a scratch copy (never touches the run).

Usage: offline_rescore.py <runs/<id>/testplan/pass-N> <scratch-dir>

1. Copies suites/, transcripts/, pass-meta.json into <scratch-dir> and runs score.py there (--legacy-strict for
   suite files of the old runner).
2. Mechanical grading dry run for legacy passes: money expectations are extracted from testplan.md (bold € amounts
   in the Expect line of each check, a stand-in for expectations.json) and compared with the amounts in the
   evaluator's `observed` using grade.compare_value.
Prints a summary per rule."""
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.dirname(HERE)
sys.path.insert(0, RUNNER)
import grade  # noqa: E402
from plan import Plan, blocks  # noqa: E402


def legacy_money_expectations(plan):
    """{check id: [expected amount strings]} from the Expect lines of testplan.md."""
    out = {}
    for s, text in plan.suites.items():
        for k, cid, body in blocks(text):
            if k != "check":
                continue
            exp = " ".join(re.findall(r"^- \*\*Expect:\*\*(.*)$", body, re.M))
            vals = re.findall(r"\*\*€\s?([\d.,]+)\*\*", exp)
            if vals:
                out[cid] = vals
    return out


def main(src, dst):
    if os.path.abspath(src) == os.path.abspath(dst):
        sys.exit("refusing to write into the source pass")
    os.makedirs(dst, exist_ok=True)
    for d in ("suites", "transcripts"):
        shutil.rmtree(os.path.join(dst, d), ignore_errors=True)
        shutil.copytree(os.path.join(src, d), os.path.join(dst, d))
    shutil.copy(os.path.join(src, "pass-meta.json"), dst)
    if os.path.exists(os.path.join(src, "score.json")):
        shutil.copy(os.path.join(src, "score.json"), os.path.join(dst, "score.orig.json"))
    out = subprocess.run([sys.executable, os.path.join(RUNNER, "score.py"), dst, "--legacy-strict"],
                         capture_output=True, text=True)
    if out.returncode:
        sys.exit(out.stderr)
    score = json.load(open(os.path.join(dst, "score.json")))
    orig = json.load(open(os.path.join(dst, "score.orig.json"))) if os.path.exists(os.path.join(dst, "score.orig.json")) else {}
    res = json.load(open(os.path.join(dst, "results.json")))["results"]

    def rule(r):
        rs = " ".join(r.get("harness_reasons", []))
        if "never shown by the shop" in rs or "says '" in rs:
            return "arithmetic (money not shown / derived)"
        if "forbidden script" in rs:
            return "forbidden script (state-changing JS before the reading)"
        return "other: " + rs[:80]
    down = [r for r in res if r.get("evaluator_result") == "PASS" and r["result"] == "FAIL"]
    by_rule = {}
    for r in down:
        by_rule.setdefault(rule(r), []).append(r["id"])
    print(f"original: total {orig.get('total')}  passed {orig.get('passed')}/{orig.get('checks')}")
    print(f"hardened: total {score['total']}  passed {score['passed']}/{score['checks']}")
    for k, v in by_rule.items():
        print(f"  {k}: {len(v)} -> {', '.join(v)}")
    integ = score["integrity"]
    print("integrity:", json.dumps({k: v for k, v in integ.items() if k not in ("per_suite", "downgraded_by_harness")}))
    print("guessed URLs per suite:", {s: v["guessed_urls"] for s, v in integ["per_suite"].items()})
    print("batched action+navigate per suite:", {s: v["batched_action_navigate"] for s, v in integ["per_suite"].items()})
    lq = [(r["id"], u) for r in res if r.get("legacy_quotes") and (r.get("evaluator_result") or r["result"]) == "PASS"
          for u in r["legacy_quotes"]["unverified"]]
    nq = sum(r["legacy_quotes"]["total"] for r in res if r.get("legacy_quotes") and (r.get("evaluator_result") or r["result"]) == "PASS")
    print(f"quoted fragments in PASS observations: {nq}, not found literally: {len(lq)} {lq}")
    # how many money PASSes are verified (all amounts in observed shown by the shop)?
    m_pass = [r for r in res if (r.get("evaluator_result") or r["result"]) == "PASS" and grade.money_tokens(r["observed"], True)]
    m_bad = [r["id"] for r in m_pass if any("never shown" in x for x in r.get("harness_reasons", []))]
    print(f"PASS with money in observed: {len(m_pass)}, amounts not shown by the shop: {len(m_bad)} {m_bad}")

    # mechanical grading dry run (legacy stand-in for expectations.json)
    plan = Plan()
    exp = legacy_money_expectations(plan)
    n = ok = 0
    mism = []
    for r in res:
        ev = r.get("evaluator_result") or r["result"]
        if ev != "PASS" or r["id"] not in exp:
            continue
        n += 1
        toks = re.findall(r"[-−]?€\s?\d[\d.,]*\d|(?<![\w.,\-])\d[\d.,]*\d\s?€", r["observed"]) + \
            [m.group(0) for m in grade.MONEY_TOKEN.finditer(r["observed"])]
        # old observations often omit the currency (admin field values): bare numbers compare without currency
        hit = [e for e in exp[r["id"]] if any(grade.compare_value(
            {"kind": "money", "expected": e, **({} if grade.currencies_in(t) else {"currency": None})}, t)[0] for t in toks)]
        if hit:
            ok += 1
        else:
            mism.append((r["id"], exp[r["id"]], r["observed"][:90]))
    print(f"mechanical money comparison: {n} evaluator-PASS checks with € expectations, {ok} match an observed amount, "
          f"{len(mism)} do not:")
    for m in mism:
        print("   ", m)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
