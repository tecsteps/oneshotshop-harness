"""Blind-grading bundle for the runner (eval/testplan/runner/EXPECTATIONS.md, schema oneshotshop-expectations/1).

Input: the plan text with check IDs assigned and labels resolved, but placeholders still unresolved:
  {{NAME.field}}   a value from calc/scenarios.py. In an **Expect** line it is an expectation (a recorded value);
                   in Pre/Do/Setup text it is an input or context.
  {{~NAME.field}}  informational (a limit, a threshold); never an expectation.
Output: expectations.json (dict) and testplan.evaluator.md (text).
"""
import re
from decimal import Decimal

from scenarios import SCN

SCHEMA = "oneshotshop-expectations/1"
PH = re.compile(r"\{\{([~>]?)(\w+)\.(\w+)((?:\|\w+\.\w+)*)(?:@([\w,]+))?\}\}")   # {{A.x}} {{~A.x}} {{>A.x}} {{A.x|B.y}} {{A.x@page}}
# {{derive:B1 - B2=NAME.field}}: the harness computes the expression from record-only values of the same check
DERIVE = re.compile(r"\{\{derive:([A-Za-z0-9_ +\-*()]+)=(\w+)\.(\w+)\}\}")
RECORD_ONLY = re.compile(r"`([A-Za-z0-9_]+)` — ([^;]+)")
NO_CURRENCY = set()     # set by render.py: fields that are EUR although their scenario is CHF/GBP
CONDITION = re.compile(r"\b(and|not|no|nothing|none|only|both|still|neither|nor|but|without|refus\w*|again|exactly|"
                       r"unchanged|never|also|while|after|before|if|either|separate\w*|label\w*|other|whose|instead|unless|"
                       r"except|least|most|more|less|than|same|different|until|within|hidden|flagged)\b", re.I)


class ContractError(SystemExit):
    pass
# Page kinds. The evaluator names the page it read; evidence quotes are still required. No UI vocabulary is
# prescribed by the spec, so no page is identified by keywords, except documents by their prescribed numbering
# (INV-<year>-…, CN-<year>-…, business-rules.md) or their document name.
PAGES = {
    "review": {"label": "final checkout review step (REVIEW, 0.5): the read-only last step before the order is placed"},
    "cart": {"label": "cart page"},
    "product": {"label": "product detail page"},
    "order": {"label": "order detail page in the customer account"},
    "invoice": {"label": "invoice, credit note or electronic invoice document",
                "heading_any": ["inv-20", "cn-20", "invoice", "credit note"]},
    "admin": {"label": "a page of the admin area (back office)"},
    "account": {"label": "a page of the customer account (overview, balance, orders list)"},
    "mail": {"label": "the mail log (shop-mail-log)", "source": "mail"},
    "any": {"label": "any page"},
}
# Expect lines that are a bare literal (DOM snippets, rejections)
LITERALS = {
    "`0`.": ("value", "quantity", 0, "the number the snippet returned"),
    "`1`.": ("value", "quantity", 1, "the number the snippet returned"),
    "`true`.": ("value", "boolean", True, "what the snippet returned: yes (true) | no (false)"),
    "An empty list.": ("value", "text", {"all": ["[]"]}, "the list the snippet returned, verbatim"),
    "Rejected.": ("result", "state", "rejected", "the shop's response to the attempt: accepted | rejected"),
    "Accepted.": ("result", "state", "accepted", "the shop's response to the attempt: accepted | rejected"),
}
STATES = ["accepted", "rejected"]
# Checks graded by the evaluator only (no mechanical value), e.g. several alternative observations
JUDGED_TITLES = {
    "Stock reserved at order placement",
    # the staff input typed in the check equals the value to observe: evaluator-judged (cannot be hidden)
    "Packaging price changed through the form",
    "Negotiated price added through form fields",
    "Cart updates after a price change",
    "Maintain a negotiated price",
    "Create a promotion code",
    "Change a shipping fee",
    "Activity timeline shows a staff change",
}


def _value(name, field):
    return SCN[name][1][field]


def _money_str(v):
    return f"{v:.2f}"


def _kind(v):
    if isinstance(v, bool):
        raise SystemExit("boolean scenario value cannot be cited")
    if isinstance(v, Decimal) and v.as_tuple().exponent == -2:
        return "money"
    if isinstance(v, (int, Decimal)):
        return "quantity"
    return "text"


def _key(field, used):
    k = re.sub(r"[^a-z0-9_]", "_", field.lower()).strip("_") or "value"
    base, n = k, 2
    while k in used:
        k, n = f"{base}_{n}", n + 1
    used.add(k)
    return k


def _currency(name, field, sentence):
    """Currency the raw value must show; None where the shop shows a bare number by design (form fields)."""
    if re.search(r"\bfield\b|edit page|input", sentence, re.I):
        return None
    if field in NO_CURRENCY:
        return "EUR"
    return SCN[name][1].get("currency", "EUR")


def _page(block, sentence):
    """Required page of a value: from the value's sentence first, else inherited from the check's own Pre/Do
    context (the source the procedure opens). Explicit {{A.x@page}} metadata overrides both."""
    b, s = block.lower(), sentence.lower()
    ctx = "\n".join(l for l in b.split("\n") if l.startswith(("- **pre", "- **do")))
    if re.search(r"\bor (the )?order\b|or on the order|order confirmation or", s + " " + ctx):
        return "any"
    if re.search(r"invoice|credit note", s):
        return "invoice"
    if re.search(r"\breview\b", s) or ("review(" in b and re.search(r"gross total|vat |shipping amount|discount|"
                                                                     r"line total", s)):
        return "review"
    if re.search(r"payments ledger|in context a\b|admin|edit page|price field", s):
        return "admin"
    if re.search(r"\(account\)|\bin the account\b|the account shows", s):
        return "account"
    if re.search(r"\bin the cart\b|\bcart (holds|marks|shows|has)|marked in the cart|the cart's", s):
        return "cart"
    # inherited from the procedure
    if re.search(r"invoice from|electronic invoice|open (its|the) (electronic )?invoice|the credit note", ctx):
        return "invoice"
    if re.search(r"review page|\breview\(|\breview with", ctx):
        return "review"
    if re.search(r"in the admin area|payments ledger", ctx):
        return "admin"
    if re.search(r"order detail", ctx):
        return "order"
    if re.search(r"customer account page", ctx):
        return "account"
    if re.search(r"product page", ctx) and not re.search(r"\badd\b|\bcart\b", ctx):
        return "product"
    return "any"


def _blocks(text):
    """[(kind, id, text)] like runner/plan.py blocks(): intro, setups and checks in order."""
    out, kind, cid, buf = [], "intro", None, []
    for ln in text.split("\n"):
        mc = re.match(r"^### (S\d\d-\d\d)\b", ln)
        ms = re.match(r"^\*\*Setup ([^:*]+):\*\*", ln)
        mh = re.match(r"^## ", ln)
        if mc or ms or mh:
            out.append((kind, cid, buf))
            buf = [ln]
            kind, cid = ("check", mc.group(1)) if mc else (("setup", ms.group(1).strip()) if ms else ("intro", None))
        else:
            buf.append(ln)
    out.append((kind, cid, buf))
    return out


VIOLATIONS = []


def build(text, checks, plan_sha):
    titles = {c["id"]: c["title"] for c in checks}
    meta = {}
    for kind, cid, buf in _blocks(text):
        if kind != "check":
            continue
        blk = "\n".join(buf)
        exp_lines = [l for l in buf if l.startswith("- **Expect:**")]
        values, used, simple = [], set(), False
        title = titles[cid]
        if title in JUDGED_TITLES:
            meta[cid] = {"mode": "judged", "values": [], "records": []}
            continue
        for line in exp_lines:
            body = line[len("- **Expect:**"):].strip()
            lit = next((k for k in LITERALS if body == k or (body.startswith(k + " ") and not
                        [m for m in PH.finditer(body) if not m.group(1)])), None)
            if lit:
                body = lit
            if body in LITERALS:
                key, kind_, exp, desc = LITERALS[body]
                v = {"key": key, "kind": kind_, "expected": exp, "page": "any"}
                if kind_ == "state":
                    v["states"] = STATES
                values.append((v, desc))
                simple = True
                continue
            for dm in DERIVE.finditer(body):
                expr, name, field = dm.group(1).strip(), dm.group(2), dm.group(3)
                inputs = sorted(set(re.findall(r"[A-Za-z_]\w*", expr)), key=expr.index)
                ro = {}
                for l in buf:
                    if l.startswith("- **Record-only:**"):
                        ro.update(dict(RECORD_ONLY.findall(l)))
                missing = [i for i in inputs if i not in ro]
                if missing:
                    raise ContractError(f"{cid}: derive inputs {missing} lack a '- **Record-only:**' description")
                sent = next(s for s in _sentences(body) if dm.group(0) in s)
                cur = _currency(name, field, sent)
                for i in inputs:
                    used.add(i)
                    values.append(({"key": i, "kind": "money", "record_only": True, "currency": cur,
                                    "page": "account" if "account" in ro[i] else "any"}, ro[i].strip().rstrip(".")))
                values.append(({"key": _key("derived_" + field, used), "kind": "money", "derive": expr, "inputs": inputs,
                                "expected": _money_str(_value(name, field)), "currency": cur,
                                "calc": f"{name}.{field}"}, None))
            body_nd = DERIVE.sub("X", body)
            phs = [m for m in PH.finditer(body_nd) if not m.group(1)]
            if not phs:
                continue
            # a sentence that carries a value must not also carry a condition: split it in the template
            for sent in _sentences(body):
                vs = _expect_placeholders(sent)
                plain = PH.sub("X", sent)
                if any("|" in m.group(0) for m in vs):      # alternatives: the parenthesis names them
                    plain = re.sub(r"\([^()]*\)", "", plain)
                if vs and CONDITION.search(plain):
                    VIOLATIONS.append(f"{cid}: {sent}")
            for m in phs:
                refs = [(m.group(2), m.group(3))] + [tuple(x.split(".")) for x in m.group(4).split("|") if x]
                val = _value(*refs[0])
                k = _kind(val)
                sent = next(s for s in _sentences(body) if m.group(0) in s)
                pg = m.group(5).split(",") if m.group(5) else None
                if pg and any(p not in PAGES for p in pg):
                    raise ContractError(f"{cid}: unknown page {m.group(5)!r}")
                pg = (pg[0] if len(pg) == 1 else pg) if pg else _page(blk, sent)
                v = {"key": _key(m.group(3), used), "kind": k, "page": pg,
                     "calc": " | ".join(f"{a}.{b}" for a, b in refs)}
                if k == "money":
                    v["currency"] = _currency(refs[0][0], refs[0][1], sent)
                    if v["currency"] is None and not m.group(5) and re.search(r"\bcontext a\b|admin", blk, re.I):
                        v["page"] = "admin"      # a bare number in a back-office form field
                if k == "money" and len(refs) > 1:
                    v["expected"] = [_money_str(_value(a, b)) for a, b in refs]
                elif k == "money":
                    v["expected"] = _money_str(val)
                elif k == "quantity":
                    v["expected"] = float(val) if isinstance(val, Decimal) else val
                else:
                    v["expected"] = {"all": [str(val)]}
                values.append((v, ("ONE", body)))
            words = len(re.sub(PH, "", body_nd).split())
            simple = (len(exp_lines) == 1 and len(phs) == 1 and words <= 14
                      and not re.search(r"\b(and|or|also|both|not|no|none|neither)\b", PH.sub("", body), re.I))
        if not values:
            meta[cid] = {"mode": "judged", "values": [], "records": []}
            continue
        key_of = {}
        for v, _ in values:
            for x in v.get("calc", "").split(" | "):
                if x:
                    key_of[x] = v["key"]
        records = []
        for v, d in values:
            if d is None:          # derived: never recorded
                continue
            if isinstance(d, tuple):
                ids = set(v.get("calc", "").split(" | "))
                d = _describe_key(d[1], ids, key_of)
            records.append((v["key"], d, v))
        # statements that remain for the evaluator: Expect sentences without an expectation value
        judged = []
        for line in exp_lines:
            body = line[len("- **Expect:**"):].strip()
            if body in LITERALS or any(body.startswith(k + " ") for k in LITERALS):
                rest = body.split(" ", 1)[1] if " " in body and body not in LITERALS else ""
                if rest and not [m for m in PH.finditer(rest) if not m.group(1)]:
                    judged.append(rest)
                continue
            judged += [s for s in _sentences(body) if not _expect_placeholders(s) and not DERIVE.search(s)]
        mode = "mixed" if judged else "mechanical"
        meta[cid] = {"mode": mode, "values": [v for v, _ in values], "records": records, "judged": judged}
    if VIOLATIONS:
        raise ContractError("value sentences that also state a condition (split them):\n" + "\n".join(VIOLATIONS))
    exp = {"schema": SCHEMA, "plan_sha256": plan_sha, "pages": PAGES, "checks": {}, "setup_depends_on": {}}
    for cid, m in meta.items():
        if m["mode"] == "judged":
            continue
        exp["checks"][cid] = {"mode": m["mode"], "values": m["values"]}
    return exp, meta


SENT = re.compile(r"(?<=[.)])\s+(?=[A-Z])")


def _sentences(body):
    return [x for x in SENT.split(body.strip()) if x.strip()]


def _expect_placeholders(sentence):
    return [m for m in PH.finditer(sentence) if not m.group(1)]


def _describe_key(body, calc_ids, key_of):
    """The sentence(s) that contain this value, with this value as '…' and other values as their keys."""
    sents = [s for s in _sentences(body) if any(f"{m.group(2)}.{m.group(3)}" in calc_ids for m in _expect_placeholders(s))]
    text = " ".join(sents) or body

    def sub(m):
        if m.group(1):
            return m.group(0)
        cid = f"{m.group(2)}.{m.group(3)}"
        return "…" if cid in calc_ids else f"`{key_of.get(cid, '…')}`"
    return PH.sub(sub, text).rstrip(".")


def _describe(body):
    """Record description: the Expect sentence with every expectation placeholder replaced by '…'."""
    d = PH.sub(lambda m: "…" if not m.group(1) else m.group(0), body)
    return d.rstrip(".")


def _choices(v, desc=""):
    if v["kind"] == "state" and " | ".join(v["states"]) in desc:
        return ""
    if v["kind"] == "state":
        return " (" + " | ".join(v["states"]) + ")"
    if v["kind"] == "boolean":
        return " (yes | no)"
    return ""


def evaluator(text, meta, plan_sha, fmt):
    """Evaluator-facing plan. fmt(name, field) renders an input/context value without a calc tag."""
    out = []
    for kind, cid, buf in _blocks(text):
        if kind != "check" or cid not in meta or meta[cid]["mode"] == "judged":
            out.append(_mask_context("\n".join(buf), fmt))
            continue
        m = meta[cid]
        keys_by_calc = {}
        for v in m["values"]:
            for c in v.get("calc", "").split(" | "):
                if c:
                    keys_by_calc[c] = v["key"]
        lines = []
        for l in buf:
            if l.startswith("- **Record-only:**"):
                continue
            if l.startswith("- **Expect:**"):
                if m.get("judged") and not any(x.startswith("- **Expect:**") for x in lines):
                    lines.append("- **Expect:** " + " ".join(m["judged"]))
                continue
            lines.append(l)
        rec = []
        seen = set()
        for key, desc, v in m["records"]:
            if key in seen:
                continue
            seen.add(key)
            unit = ""
            if v["kind"] == "money":
                unit = (" — copy the number exactly as shown in the field" if v.get("currency", "EUR") is None
                        else " — copy the amount as shown, including its currency")
            desc = PH.sub(lambda x: fmt(x.group(2), x.group(3)), desc)
            rec.append(f"- **Record:** `{key}` — {desc}{_choices(v, desc)}{unit}.")
        tail = []
        while lines and lines[-1].strip() in ("", "---"):
            tail.insert(0, lines.pop())
        block = "\n".join(lines).rstrip("\n")
        out.append(_mask_context(block, fmt) + "\n" + "\n".join(rec) + "\n" + "\n".join(tail))
    body = "\n".join(out)
    return f"<!-- plan_sha256: {plan_sha} -->\n" + body


def leak_report(ev_text, exp):
    """Expected money amounts of a suite that appear anywhere else in that suite's evaluator text (outside the
    Record lines). Returns a list of messages."""
    from decimal import Decimal as _D
    msgs = []
    suites = re.split(r"^(## S\d\d .*)$", ev_text, flags=re.M)
    for i in range(1, len(suites), 2):
        sid = suites[i][3:6]
        body = "\n".join(l for l in suites[i + 1].split("\n") if not l.startswith("- **Record:**"))
        body = re.sub(r"\{\{input:[^}]*\}\}", "", body)
        amounts = {m.group(0).replace(",", "") for m in re.finditer(r"\b\d{1,3}(?:,\d{3})*\.\d{2}\b", body)}
        for cid, c in exp["checks"].items():
            if not cid.startswith(sid):
                continue
            for v in c["values"]:
                if v["kind"] != "money":
                    continue
                if "expected" not in v:
                    continue
                for e in (v["expected"] if isinstance(v["expected"], list) else [v["expected"]]):
                    if e in amounts:
                        msgs.append(f"{cid}.{v['key']}: expected {e} appears elsewhere in suite {sid}")
    return msgs


def _mask_context(block, fmt):
    """Pre/Do/Setup text: parenthesised context amounts are dropped (they could give answers away); everything
    else (inputs the evaluator types or quantities it adds) is shown without calc tags."""
    def paren(m):
        inner = m.group(0)
        return "" if PH.search(inner) else inner
    block = re.sub(r" ?\[\[.*?\]\]", "", block)          # reviewer notes never reach the evaluator
    block = re.sub(r" ?\((?:[^()]*?)\{\{~?\w+\.\w+(?:\|\w+\.\w+)*(?:@[\w,]+)?\}\}(?:[^()]*?)\)", paren, block)
    return PH.sub(lambda x: ("{{input:" + fmt(x.group(2), x.group(3)) + "}}") if x.group(1) == ">"
                  else fmt(x.group(2), x.group(3)), block)
