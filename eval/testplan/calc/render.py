#!/usr/bin/env python3
"""Render testplan.md, weights.md, traceability.md and results-template.json from the templates.

Template syntax (templates/testplan.tmpl.md):
  ## S03 ...                         starts suite S03 (check counter restarts)
  ### @label [AREA] Title {R:5,82}   a check; '@' alone = no label; {R:..} = requirement numbers covered
  @@label                            reference to the ID of a labelled check
  {{NAME.field}}                     value from calc/scenarios.py, rendered as '€12.34 [calc NAME.field]'
Rendering fails on unknown scenarios/fields/labels/areas, on None or boolean values, and if a
requirement number is neither covered nor listed in UNTESTABLE.
"""
import json
import os
import re
import sys
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from scenarios import SCN  # noqa: E402

AREAS = [  # code, name, weight  (final weights after the evaluator audit; rationale in weights.md)
    ("PRICE", "Pricing & packaging units (list, tier, group, negotiated prices, rounding)", 6),
    ("DEP", "Deposits", 5),
    ("FRAC", "Fractional quantities & catch-weight", 5),
    ("PROMO", "Promotions (automatic and codes)", 6),
    ("VAT", "VAT, totals & reverse charge", 6),
    ("SHIP", "Cart, checkout, shipping & delivery rules, order lists", 6),
    ("PAY", "Payment methods at checkout", 5),
    ("ORD", "Orders & fulfillment basics", 5),
    ("INV", "Inventory, lots, backorders & stock limits", 5),
    ("RET", "Returns, refunds & partial cancellations", 6),
    ("ACC", "Customer accounts, access control & restricted assortment", 5),
    ("ADM", "Back-office: pages, editing, tables, search, bulk actions, timeline", 7),
    ("CAT", "Storefront, catalog & search", 2),
    ("UIQ", "UI quality: responsive layout, accessibility & SEO", 4),
    ("REP", "Reporting", 1),
    ("CATX", "Variants, related products, options, bundles & accessories", 3),
    ("SAFE", "Safety: confirmations, validation, company isolation, session rules", 2),
    ("B2BW", "B2B workflows: company roles & approvals, quotes, standing orders", 5),
    ("FIN", "Finance: payment terms, dunning, e-invoices, payment flows, credit balance", 5),
    ("INTL", "Countries, currencies & export", 5),
    ("WFL", "Order workflows & process diagrams", 3),
    ("FUL", "Warehouses, transfers, cross-docking & drop-shipping", 3),
]
AREA_CODES = [a for a, _, _ in AREAS]

# Requirements from specs/requirements.md that have no deterministic browser check, with the reason.
UNTESTABLE = {
    152: "No deterministic, machine-independent threshold for 'respond quickly' exists in the browser; response work "
         "(queries, N+1, round trips) is measured by eval/perf instead, outside the functional score.",
    101: "Automatic cancellation of unpaid prepayment orders after 7 days needs time travel or a scheduler run "
         "that the evaluator may not trigger.",
}
# Requirements only partly covered (documented in traceability.md)
PARTIAL = {
    1: "Visual quality ('clean, professional') is subjective and not graded; the responsive part (390 px phone and "
       "768 px tablet without horizontal scrolling, usable navigation and add-to-cart on a phone) is checked.",
    10: "Contrast cannot be measured deterministically without an external tool; keyboard use, labels, alt texts, "
        "focus visibility and heading structure are checked.",
    28: "Explanatory wording is not graded; invalid quantities must be rejected with a quoted shop message.",
    50: "The revenue figure and chart content are not graded; counts, lists and the presence of a period comparison are.",
    65: "A true simultaneous race cannot be produced reliably in a browser; the sequential 'last unit' case is checked.",
    98: "Slot capacity is checked with a staff-lowered capacity instead of placing 8 orders.",
    109: "Only lots expiring within the defined window are checked; 'never shipped' is checked via sellable quantities "
         "and lot picking.",
    113: "The 14-day return window needs time travel and is not checked; the chilled-goods reason restriction is.",
    117: "Week and month views are not checked separately; the daily view is read for the period today.",
    120: "Stock quantities per warehouse, open backorders and expiring lots are checked; a dedicated low-stock "
         "list is checked only through the low-stock label (requirement 64).",
    133: "Confirmation dialogs are checked for cancelling an order and blocking a customer.",
    135: "Only one aspect is checked (card data masking). Enforcement after bypassing the user interface would require "
         "manipulated requests, which the evaluator may not send.",
    136: "Isolation is checked for orders, invoices, addresses and order lists; credit notes and return requests of "
         "other companies are not checked.",
    137: "The sign-in lock after five failed attempts is checked; the same limit for password-reset requests, "
         "registrations and promotion-code attempts is not triggered by the plan.",
    138: "Minimum length is checked; reset-link expiry (60 minutes) and admin inactivity (30 minutes) need waiting and "
         "are not checked.",
    160: "The electronic invoice is checked for its VAT IDs, VAT amounts and VAT category codes (AE, G); full EN 16931 "
         "schema validation and electronic credit notes are not checked.",
    162: "Weekly standing orders, generation, de-duplication, skipping and pausing are checked; the every-second-week "
         "rhythm and editing are not.",
    169: "The 7-day authorisation expiry is simulated by a test card; real expiry over time is not checked.",
    172: "The ledger is checked for chargeback and payout events; the other event types are covered by the payment "
         "history checks.",
    180: "Workflow diagrams, editing, validation, versions and comparison are checked; the payment-flow diagrams are not "
         "checked separately.",
}


MAX_POINTS_PER_CHECK = 0.41   # "about 0.4 points" per check at most
NO_CURRENCY = {"x2_eur"}       # fields that are EUR although their scenario is CHF/GBP
PH = re.compile(r"\{\{([~>]?)(\w+)\.(\w+)((?:\|\w+\.\w+)*)(?:@([\w,]+))?\}\}")   # {{A.x}}, {{~A.x}} informational, {{>A.x}} input, {{A.x|B.y}} alternatives
import contract  # noqa: E402
contract.NO_CURRENCY = NO_CURRENCY


def fmt_value(name, field, hidden=False):
    if name not in SCN:
        raise SystemExit(f"unknown scenario {name}")
    vals = SCN[name][1]
    if field not in vals:
        raise SystemExit(f"unknown field {name}.{field}")
    v = vals[field]
    if v is None or isinstance(v, bool):
        raise SystemExit(f"{name}.{field} is {v!r} and must not be cited")
    if hidden:
        return "`⟨record the value shown⟩`"
    cur = SCN[name][1].get("currency", "EUR") if field not in NO_CURRENCY else "EUR"
    if isinstance(v, Decimal) and v.as_tuple().exponent == -2:
        s = f"€{v:,.2f}" if cur == "EUR" else f"{cur} {v:,.2f}"
    elif isinstance(v, Decimal):
        s = f"{v.normalize():f}"
    else:
        s = str(v)
    return f"**{s}** `[calc {name}.{field}]`"


def render():
    src = open(os.path.join(HERE, "templates", "testplan.tmpl.md"), encoding="utf-8").read()
    out_lines, checks, labels = [], [], {}
    suite, n = None, 0
    for line in src.splitlines():
        m = re.match(r"^## (S\d\d) ", line)
        if m:
            suite, n = m.group(1), 0
        m = re.match(r"^### @(\w*) \[(\w+)\] (.*?)(?:\s*\{R:([\d, ]+)\})?\s*$", line)
        if m:
            label, area, title, reqs = m.groups()
            if area not in AREA_CODES:
                raise SystemExit(f"unknown area {area} in: {line}")
            n += 1
            cid = f"{suite}-{n:02d}"
            if label:
                if label in labels:
                    raise SystemExit(f"duplicate label {label}")
                labels[label] = cid
            rq = sorted({int(x) for x in reqs.split(",")}) if reqs else []
            checks.append(dict(id=cid, area=area, title=title, reqs=rq, suite=suite))
            line = f"### {cid} [{area}] {title}" + (f"\n*Covers requirement(s): {', '.join(map(str, rq))}*" if rq else "")
        out_lines.append(line)
    raw = "\n".join(out_lines) + "\n"

    def ref(m):
        if m.group(1) not in labels:
            raise SystemExit(f"unknown label reference @@{m.group(1)}")
        return labels[m.group(1)]
    raw = re.sub(r"@@(\w+)", ref, raw)
    counts = {a: sum(1 for c in checks if c["area"] == a) for a in AREA_CODES}
    total = len(checks)
    n_suites = len({c["suite"] for c in checks})
    raw = raw.replace("<<TOTAL>>", str(total)).replace("<<SUITES>>", str(n_suites))
    # [[...]] = reviewer note: shown in testplan.md, never in the evaluator's copy
    text_raw = re.sub(r"\[\[(.*?)\]\]", r"\1", raw)
    text_raw = contract.DERIVE.sub(lambda m: fmt_value(m.group(2), m.group(3)), text_raw)
    text_raw = text_raw.replace("- **Record-only:**", "- **Evaluator records:**")
    text = PH.sub(lambda m: " or ".join(fmt_value(*ref.split(".")) for ref in
                                        [m.group(2) + "." + m.group(3)] + [x for x in m.group(4).split("|") if x]), text_raw)
    for bad in ("{{", "@@", "<<"):
        if bad in text:
            raise SystemExit(f"unresolved marker {bad!r} in testplan")
    open(os.path.join(OUT, "testplan.md"), "w", encoding="utf-8").write(text)
    import hashlib
    plan_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    expectations, meta = contract.build(raw, checks, plan_sha)
    ev = contract.evaluator(raw, meta, plan_sha, lambda n, f: fmt_value(n, f).split(" `[calc")[0].replace("**", ""))
    ev = ev.replace("`[calc SCENARIO.field]`", "a calculator reference")
    leaks = contract.leak_report(ev, expectations)
    if leaks:
        raise SystemExit("answer leaks in testplan.evaluator.md:\n" + "\n".join(leaks[:40]))
    for bad in ("{{", "@@", "<<", "[calc "):
        if bad in re.sub(r"\{\{input:[^{}]*\}\}", "", ev):
            raise SystemExit(f"unresolved marker {bad!r} in testplan.evaluator.md")
    open(os.path.join(OUT, "testplan.evaluator.md"), "w", encoding="utf-8").write(ev)
    with open(os.path.join(OUT, "expectations.json"), "w", encoding="utf-8") as f:
        json.dump(expectations, f, ensure_ascii=False, indent=1)

    # ---- weights.md
    assert sum(w for _, _, w in AREAS) == 100
    heavy = {a: round(w / counts[a], 3) for a, _, w in AREAS if counts[a] and w / counts[a] > MAX_POINTS_PER_CHECK}
    if heavy:
        raise SystemExit(f"areas above {MAX_POINTS_PER_CHECK} points per check: {heavy}")
    empty = [a for a, _, w in AREAS if not counts[a]]
    if empty:
        raise SystemExit(f"areas without checks: {empty}")
    rows = "\n".join(f"| {a} | {name} | {w} | {counts[a]} | {w / counts[a]:.3f} |" for a, name, w in AREAS)
    wsrc = open(os.path.join(HERE, "templates", "weights.tmpl.md"), encoding="utf-8").read()
    hard = sum(w for a, _, w in AREAS if a in ("PRICE", "DEP", "FRAC", "PROMO", "VAT", "SHIP", "PAY", "INV", "CATX",
                                               "B2BW", "FIN", "INTL", "WFL", "FUL"))
    wsrc = wsrc.replace("<<AREA_ROWS>>", rows).replace("<<TOTAL>>", str(total)).replace("<<NAREAS>>", str(len(AREAS)))
    wsrc = wsrc.replace("<<HARD>>", str(hard)).replace("<<SOFT2>>", str(100 - hard))
    suites = sorted({c["suite"] for c in checks})
    srows = "\n".join(
        f"| {s} | " + " | ".join(str(sum(1 for c in checks if c['suite'] == s and c['area'] == a)) or "" for a in AREA_CODES)
        + f" | {sum(1 for c in checks if c['suite'] == s)} |" for s in suites)
    shead = "| Suite | " + " | ".join(AREA_CODES) + " | Total |\n|---|" + "---:|" * (len(AREA_CODES) + 1)
    wsrc = wsrc.replace("<<SUITE_TABLE>>", shead + "\n" + srows)
    open(os.path.join(OUT, "weights.md"), "w", encoding="utf-8").write(wsrc)

    # ---- traceability.md
    reqtxt = open(os.path.join(SPECS, "requirements.md"), encoding="utf-8").read()
    reqs = {int(m.group(1)): m.group(2) for m in re.finditer(r"^(\d+)\. (.+)$", reqtxt, re.M)}
    cov = {r: [] for r in reqs}
    for c in checks:
        for r in c["reqs"]:
            if r not in reqs:
                raise SystemExit(f"{c['id']} cites unknown requirement {r}")
            cov[r].append(c["id"])
    missing = [r for r in reqs if not cov[r] and r not in UNTESTABLE]
    if missing:
        raise SystemExit(f"requirements without checks and without reason: {missing}")
    lines = ["# Traceability — requirements → checks", "",
             "Generated by `calc/render.py` from the `{R:..}` tags in the test plan template. "
             f"{len(reqs)} requirements, {sum(1 for r in reqs if cov[r])} covered by at least one check, "
             f"{len(UNTESTABLE)} not graded.", "",
             "| # | Requirement (short) | Checks | Note |", "|---:|---|---|---|"]
    for r, t in reqs.items():
        short = (t[:90] + "…") if len(t) > 90 else t
        note = UNTESTABLE.get(r, PARTIAL.get(r, ""))
        if r in UNTESTABLE:
            note = "**Not graded.** " + note
        elif r in PARTIAL:
            note = "Partly covered: " + note
        lines.append(f"| {r} | {short.replace('|', '/')} | {', '.join(cov[r]) or '—'} | {note} |")
    lines += ["", "## Requirements not graded", ""]
    lines += [f"- **{r}** — {why}" for r, why in UNTESTABLE.items()]
    lines += ["", "## Other spec rules deliberately not checked", "",
              "- 7-day automatic cancellation of unpaid prepayment orders (payments.md) — needs time travel.",
              "- 14-day return window (business-rules.md) — needs time travel. (The chilled-goods return-reason "
              "restriction is checked.)",
              "- Express Parcel 14:00 order time (shipping.md) — describes carrier transit time, nothing selectable "
              "in the shop depends on it.",
              "- Time-dependent automation: the daily 06:00 standing-order run, the 7-day prepayment cancellation, "
              "the 7-day card authorisation validity, the 60-minute reset-link expiry, the 30-minute admin timeout and "
              "the 15-minute lock periods need waiting and are not checked (manual generation, test cards and the "
              "sign-in lock are). The reset, registration and promotion-code limits of requirement 137 are not "
              "triggered by the plan.",
              "- Holidays in the delivery calendar are exercised only when a Berlin public holiday falls inside the "
              "14-day window of the run (the earliest-date rule includes them; no separate check).",
              ""]
    open(os.path.join(OUT, "traceability.md"), "w", encoding="utf-8").write("\n".join(lines))

    # ---- results template
    res = [dict(id=c["id"], area=c["area"], title=c["title"], result="", observed="", note="") for c in checks]
    with open(os.path.join(OUT, "results-template.json"), "w", encoding="utf-8") as f:
        json.dump(dict(shop="", evaluator="", started_at="", finished_at="", berlin_time_at_S06="",
                       results=res), f, ensure_ascii=False, indent=1)
    print(f"rendered {total} checks into testplan.md")
    for a, name, w in AREAS:
        print(f"  {a:<6} weight {w:>3}  checks {counts[a]:>3}")
    return checks


SPECS = os.environ.get("ONESHOTSHOP_SPECS", "/Users/fabianwesner/Herd/oneshotshop/specs")

LITERAL_EXPECT = {  # literal expected values of the read-only DOM snippets
    "`0`.": ("quantity", [0]), "`1`.": ("quantity", [1]), "`true`.": ("boolean", [True]),
    "A value ≤ 1.": ("quantity", ["<=1"]), "An empty list.": ("text", ["[]"]),
    "A non-empty string.": ("text", ["non-empty"]), "Rejected.": ("state", ["rejected"]),
    "Accepted.": ("state", ["accepted"]),
}


def _blocks(text):
    """Split the template text into check blocks keyed by the rendered check id."""
    parts = re.split(r"^(### (S\d\d-\d\d) \[\w+\] .*)$", text, flags=re.M)
    out = {}
    for i in range(1, len(parts), 3):
        out[parts[i + 1]] = parts[i + 2].split("\n---\n")[0].split("\n**Setup")[0]
    return out


def _page(block):
    b = block.lower()
    exp = " ".join(l for l in block.splitlines() if l.startswith("- **Expect:**")).lower()
    if "review(" in b and ("gross total" in exp or "vat " in exp or "shipping amount" in exp or "discount" in exp):
        return "review"
    for key, words in (("credit_note", ("credit note",)), ("invoice", ("invoice",)), ("mail_log", ("mail(",)),
                       ("cart", ("cart", "line total")), ("order_detail", ("order's", "order detail", "payment status")),
                       ("admin", ("admin",))):
        if any(w in exp for w in words):
            return key
    return None


def build_expectations(text, checks):
    blocks = _blocks(text)
    out = {}
    for c in checks:
        blk = blocks.get(c["id"], "")
        exp_lines = [l for l in blk.splitlines() if l.startswith("- **Expect:**")]
        exp = " ".join(exp_lines)
        vals = []
        for m in re.finditer(r"\{\{(\w+)\.(\w+)\}\}", exp):
            v = SCN[m.group(1)][1][m.group(2)]
            if isinstance(v, Decimal) and v.as_tuple().exponent == -2:
                vals.append(("money", float(v)))
            elif isinstance(v, (int, Decimal)):
                vals.append(("quantity", float(v) if isinstance(v, Decimal) else v))
            else:
                vals.append(("text", str(v)))
        literal = next((LITERAL_EXPECT[k] for k in LITERAL_EXPECT if exp.replace("- **Expect:** ", "").strip() == k), None)
        if vals:
            kinds = {k for k, _ in vals}
            kind = "money" if "money" in kinds else ("quantity" if "quantity" in kinds else "text")
            expected = [v for _, v in vals]
            judged = kind == "text"
        elif literal:
            kind, expected = literal
            judged = kind in ("state", "text") and expected not in (["[]"],)
        else:
            kind, expected, judged = "text", [], True
        if "mail(" in exp.lower():
            kind, judged = "text", False if kind == "text" and not vals else judged
        out[c["id"]] = {"area": c["area"], "kind": kind, "expected": expected, "page": _page(blk),
                        "evaluator_judged": judged, "title": c["title"]}
    return out


def evaluator_variant(text, expectations):
    """Evaluator-facing plan: Expect lines of mechanically graded checks become Record lines without values."""
    blocks = re.split(r"^(### (S\d\d-\d\d) \[\w+\] .*)$", text, flags=re.M)
    out = [blocks[0]]
    for i in range(1, len(blocks), 3):
        head, cid, body = blocks[i], blocks[i + 1], blocks[i + 2]
        e = expectations.get(cid, {})
        if not e.get("evaluator_judged", True):
            lines = []
            for l in body.split("\n"):
                if l.startswith("- **Expect:**"):
                    l = re.sub(r"\{\{\w+\.\w+\}\}", "`⟨record the value shown⟩`", l)
                    for k in LITERAL_EXPECT:
                        if l.replace("- **Expect:** ", "").strip() == k:
                            l = "- **Expect:** `⟨record the returned value⟩`"
                    l = l.replace("- **Expect:**", "- **Record:**", 1)
                lines.append(l)
            body = "\n".join(lines)
        out += [head, body]
    return "".join(out)

if __name__ == "__main__":
    render()
