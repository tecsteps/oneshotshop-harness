#!/usr/bin/env python3
"""Merge suites/*.json of a pass into results.json and compute score.json (formula in weights.md).

Usage: score.py <pass-dir> [--legacy-strict] [--allow-plan-mismatch]

The grade of every check is decided here, from the evaluator's raw output and its transcript (runner/grade.py):
evidence quotes must occur literally in the tool results, money amounts must have been shown by the shop,
forbidden scripts void what they touched, and in blind mode (expectations.json) raw values are compared
mechanically. A failed first-pass check that was re-checked (suite.py, second pass) is PASS only if the second
pass is PASS with verifiable evidence; both verdicts are recorded.

Suite files written by the old runner (no "format": 2) are taken as they are, unless --legacy-strict:
then their results are re-graded against their transcripts (money / arithmetic / script rules; the old
format has no evidence quotes, so quoted fragments are only reported).
Checks without a suite result count as FAIL ("suite not run"); nothing is dropped from the denominator."""
import argparse
import datetime as dt
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from plan import Plan, TP  # noqa: E402
from grade import Transcript, grade_suite  # noqa: E402

sys.path.insert(0, os.path.join(TP, "calc"))
from render import AREAS  # noqa: E402  (single source of the weights)

DEFAULT_ADMIN = ("/admin", "/admin/login")


def regrade(pass_dir, s, plan, meta, legacy_strict):
    """-> (graded results list, integrity dict or None, mode)"""
    suite = s["suite"]
    base = meta.get("url")
    admin = tuple(s.get("admin_paths") or meta.get("admin_paths") or DEFAULT_ADMIN)
    stext = plan.ev_suites.get(suite) or plan.suites.get(suite, "")
    if s.get("status") in ("reset_failed", "failed_no_browser"):
        return [dict(r, reasons=[r.get("note", "")], deviations=[]) for r in s["results"]], None, "harness"
    if s.get("format") == 2:
        tx = Transcript(os.path.join(pass_dir, s["transcript"]), base)
        graded, integ = grade_suite(stext, s.get("raw_results") or [], tx, plan, s["checks"], admin)
        integ["rechecked"] = integ["recheck_flipped"] = 0
        for g in graded:
            g["first_pass"] = {k: g.get(k) for k in ("result", "evaluator_result", "observed", "note", "reasons")}
            rc = (s.get("rechecks") or {}).get(g["id"])
            if g["result"] == "PASS" or not rc:
                continue
            if not rc.get("transcript"):
                g["second_pass"] = {"result": "FAIL", "reasons": [f"second pass not run: {rc.get('status')}"]}
                continue
            integ["rechecked"] += 1
            tx2 = Transcript(os.path.join(pass_dir, rc["transcript"]), base)
            raw2 = [r for r in rc.get("raw_results") or [] if r.get("id") == g["id"]]
            g2, integ2 = grade_suite(stext, raw2, tx2, plan, [g["id"]], admin)
            g2 = g2[0]
            g["second_pass"] = {k: g2.get(k) for k in ("result", "evaluator_result", "observed", "note", "reasons",
                                                       "evidence", "values", "deviations")}
            g["second_pass"]["integrity"] = integ2
            if g2["result"] == "PASS":
                integ["recheck_flipped"] += 1
                for k in ("result", "observed", "note", "evidence", "values"):
                    g[k] = g2[k]
                g["reasons"] = ["first pass FAIL; second pass PASS with verified evidence"]
                g["deviations"] = g["deviations"] + [f"2nd pass: {d}" for d in g2["deviations"]]
        return graded, integ, "blind" if plan.mode == "blind" else "evidence"
    # suite file of the old runner
    if not legacy_strict:
        return [dict(r, reasons=[], deviations=[]) for r in s["results"]], None, "legacy"
    tx = Transcript(os.path.join(pass_dir, "transcripts", f"{suite}.jsonl"), base)
    graded, integ = grade_suite(stext, s["results"], tx, plan, s["checks"], admin, legacy_strict=True)
    return graded, integ, "legacy-strict"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pass_dir")
    ap.add_argument("--legacy-strict", action="store_true")
    ap.add_argument("--allow-plan-mismatch", action="store_true", help="offline analysis only")
    a = ap.parse_args()
    pass_dir = a.pass_dir
    plan = Plan()
    tpl = plan.template
    meta = json.load(open(os.path.join(pass_dir, "pass-meta.json"))) if os.path.exists(
        os.path.join(pass_dir, "pass-meta.json")) else {}
    if meta.get("plan_sha256") and meta["plan_sha256"] != plan.sha and not a.allow_plan_mismatch:
        sys.exit(f"score.py: {pass_dir} was graded with another testplan.md ({meta['plan_sha256']}); refusing to mix")
    for k, cur in (("expectations_sha256", plan.exp_sha), ("evaluator_md_sha256", plan.ev_sha)):
        if k in meta and meta[k] != cur and not a.allow_plan_mismatch:
            sys.exit(f"score.py: {pass_dir} was graded with another {k.split('_sha')[0]} "
                     f"({meta[k]} != {cur}); refusing to mixrefusing to mix")

    suites, graded_by, integrity, modes = {}, {}, {}, set()
    for f in sorted(glob.glob(os.path.join(pass_dir, "suites", "S*.json"))):
        s = json.load(open(f, encoding="utf-8"))
        suites[s["suite"]] = s
        graded, integ, mode = regrade(pass_dir, s, plan, meta, a.legacy_strict)
        modes.add(mode)
        for g in graded:
            graded_by[g["id"]] = g
        if integ is not None:
            integ.update(evaluator_pass=sum(g.get("evaluator_result") == "PASS" for g in graded),
                         passed=sum(g["result"] == "PASS" for g in graded),
                         downgraded=[g["id"] for g in graded if g.get("evaluator_result") == "PASS"
                                     and g["result"] == "FAIL"])
            integrity[s["suite"]] = integ

    results = []
    for c in tpl["results"]:
        g = graded_by.get(c["id"])
        if g is None:
            g = {"result": "FAIL", "observed": "", "note": "harness: suite not run / check not evaluated",
                 "reasons": ["suite not run"], "deviations": []}
        row = {"id": c["id"], "area": c["area"], "title": c["title"], "result": g["result"],
               "observed": g.get("observed", ""), "note": g.get("note", "")}
        if g.get("evaluator_result") and g["evaluator_result"] != g["result"]:
            row["evaluator_result"] = g["evaluator_result"]
        if g.get("reasons"):
            row["harness_reasons"] = g["reasons"]
        for k in ("evidence", "values", "first_pass", "second_pass", "legacy_quotes"):
            if g.get(k):
                row[k] = g[k]
        if g.get("deviations"):
            row["procedural_deviations"] = g["deviations"]
        results.append(row)

    out_results = {k: meta.get(k) for k in ("run", "branch", "commit", "image_id", "pass", "plan_sha256",
                                            "expectations_sha256", "evaluator_md_sha256")} | {
        "grading": sorted(modes),
        "evaluator": {"model_alias": meta.get("model_alias"),
                      "model_ids": sorted({s.get("model_id") for s in suites.values() if s.get("model_id")}),
                      "claude_version": next((s.get("claude_version") for s in suites.values()), None)},
        "playwright": meta.get("playwright"),
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "results": results,
    }
    json.dump(out_results, open(os.path.join(pass_dir, "results.json"), "w"), indent=1, ensure_ascii=False)

    per_area, total = [], 0.0
    for code, name, weight in AREAS:
        rs = [r for r in results if r["area"] == code]
        passed = sum(r["result"] == "PASS" for r in rs)
        sc = passed / len(rs) if rs else 0.0
        total += weight * sc
        per_area.append({"area": code, "name": name, "weight": weight, "checks": len(rs), "passed": passed,
                         "score": round(sc, 4), "points": round(weight * sc, 2)})

    def ssum(key):
        vals = [(s.get("usage") or {}).get(key) for s in suites.values()]
        vals = [v for v in vals if isinstance(v, (int, float))]
        return round(sum(vals), 4) if vals else None
    all_suites = sorted({c["id"][:3] for c in tpl["results"]})
    res_by = {r["id"]: r for r in results}
    suite_rows = [{"suite": k, "status": s["status"], "partial": s.get("partial", False), "checks": len(s["checks"]),
                   "passed": sum(res_by.get(i, {}).get("result") == "PASS" for i in s["checks"]),
                   "model_id": s.get("model_id"),
                   "cost_usd": (s.get("usage") or {}).get("cost_usd"),
                   "recheck_cost_usd": (s.get("usage_rechecks") or {}).get("cost_usd"),
                   "wall_seconds": s.get("wall_seconds"),
                   "playwright_tool_calls": s.get("playwright_tool_calls"), "reasked": s.get("reasked")}
                  for k, s in sorted(suites.items())]
    complete = (set(suites) == set(all_suites) and all(s["status"] == "done" and not s.get("partial")
                                                      for s in suites.values()))

    def isum(key):
        return sum(v.get(key, 0) for v in integrity.values() if isinstance(v.get(key, 0), int))
    score = {
        "total": round(total, 1), "max": 100, "formula": "sum over areas of weight x passed/checks (weights.md)",
        "passed": sum(r["result"] == "PASS" for r in results), "checks": len(results),
        "complete": complete,
        "grading": sorted(modes),
        "suites_missing": [s for s in all_suites if s not in suites],
        "suites_failed": [k for k, s in suites.items() if s["status"] != "done"],
        "per_area": per_area, "suites": suite_rows,
        "integrity": {
            "evaluator_pass": isum("evaluator_pass"),
            "downgraded_by_harness": sorted(i for v in integrity.values() for i in v.get("downgraded", [])),
            "rechecked": isum("rechecked"), "recheck_flipped_to_pass": isum("recheck_flipped"),
            "typed_navigations": isum("typed_navigations"), "guessed_urls": isum("guessed_urls"),
            "forbidden_scripts": isum("forbidden_scripts"),
            "forbidden_scripts_executed": isum("forbidden_scripts_executed"),
            "batched_action_navigate": isum("batched_action_navigate"), "multi_action_turns": isum("multi_action_turns"),
            "out_of_order": isum("out_of_order"), "checkout_outside_checks": isum("checkout_outside_checks"),
            "per_suite": integrity,
        },
        "procedural_deviations": [{"id": r["id"], "result": r["result"], "deviations": r["procedural_deviations"]}
                                  for r in results if r.get("procedural_deviations")],
        "cost_usd": ssum("cost_usd"),
        "tokens": {k: ssum(k) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens",
                                         "cache_creation_input_tokens")},
        "evaluator_seconds": round(sum(s.get("wall_seconds") or 0 for s in suites.values()), 1),
        "model_alias": meta.get("model_alias"),
        "model_ids": out_results["evaluator"]["model_ids"],
        "perf_probe": meta.get("perf_probe"),
        "generated_at": out_results["generated_at"],
    }
    json.dump(score, open(os.path.join(pass_dir, "score.json"), "w"), indent=1)
    print(json.dumps({k: score[k] for k in ("total", "passed", "checks", "complete", "suites_missing",
                                             "suites_failed", "cost_usd")}
                     | {"downgraded": score["integrity"]["downgraded_by_harness"],
                        "rechecked": score["integrity"]["rechecked"],
                        "recheck_flipped": score["integrity"]["recheck_flipped_to_pass"]}))


if __name__ == "__main__":
    main()
