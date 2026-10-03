#!/usr/bin/env python3
"""Load the test plan for the runner (suite.py, score.py).

Two modes, feature-detected:

* blind  -- the plan directory has `expectations.json` + `testplan.evaluator.md` bound to the current
            testplan.md (same sha256). The evaluator sees testplan.evaluator.md (no expected values for
            mechanically graded checks); score.py compares the raw values it reports with
            expectations.json.
* legacy -- only testplan.md exists (the current plan). The evaluator sees testplan.md including the
            expected values and grades PASS/FAIL itself; the harness still verifies evidence quotes,
            money values, scripts and URLs.

Interface for the plan author: see runner/EXPECTATIONS.md.
"""
import hashlib
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TP = os.path.dirname(HERE)

SCHEMA_ID = "oneshotshop-expectations/1"
KINDS = ("money", "quantity", "text", "boolean", "state")


CURRENCIES = ("EUR", "CHF", "GBP")
INPUT_MARK = re.compile(r"\{\{input:(.*?)\}\}", re.S)


class PlanError(Exception):
    pass


def strip_input_markers(text):
    """`{{input:€123.84}}` -> `€123.84` (what the evaluator sees)."""
    return INPUT_MARK.sub(lambda m: m.group(1), text)


def amounts_in(text):
    """Money-like amounts in evaluator-facing text -> {cents: [snippet, …]}: numbers with two decimals and
    amounts written with a currency (€500, CHF 45, £39)."""
    out = {}
    unit = r"(?!\d|[.,]\d|\s?(?:kg|g|l|ml|cl|cm|mm|%)(?![a-z]))"
    pats = [r"(?<![\w.,])\d{1,3}(?:[.,]\d{3})*[.,]\d{2}" + unit, r"(?<![\w.,])\d+[.,]\d{2}" + unit,
            r"(?:€|£|\bCHF|\bEUR|\bGBP)\s?\d[\d.,]*\d|(?:€|£|\bCHF|\bEUR|\bGBP)\s?\d",
            r"\d[\d.,]*\s?(?:€|£|\bCHF\b|\bEUR\b|\bGBP\b)"]
    for rx in pats:
        for m in re.finditer(rx, text):
            c = money_cents(m.group(0))
            if c is not None:
                out.setdefault(c, {}).setdefault(m.end(), text[max(0, m.start() - 40):m.end() + 20].replace("\n", " "))
    return {c: list(v.values()) for c, v in out.items()}


def derive_names(expr):
    """Names used by a `derive` expression; raises ValueError for anything but + - * ( ) numbers and names."""
    import ast
    tree = ast.parse(expr, mode="eval")
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif not isinstance(node, (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Load, ast.Add, ast.Sub,
                                   ast.Mult, ast.USub, ast.UAdd)):
            raise ValueError(f"not allowed in derive: {type(node).__name__}")
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float)):
            raise ValueError("only numeric constants allowed in derive")
    return names


def sha256_file(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def split_plan(text):
    """-> (rules = section 0 text, {suite: section text})"""
    head = text.split("\n## S01 ", 1)[0]
    i = head.find("## 0. Evaluator instructions")
    rules = head[i:] if i >= 0 else head
    suites = {}
    for m in re.finditer(r"^## (S\d\d) .*?(?=^## S\d\d |\Z)", text, re.S | re.M):
        suites[m.group(1)] = m.group(0).rstrip().rstrip("-").rstrip()
    return rules, suites


def blocks(suite_text):
    """Split a suite section into ordered blocks: ('intro', None, text), ('setup', NAME, text),
    ('check', ID, text)."""
    out = []
    lines = suite_text.split("\n")
    cur_kind, cur_id, buf = "intro", None, []

    def flush():
        if buf and "".join(buf).strip():
            out.append((cur_kind, cur_id, "\n".join(buf).strip()))
    for ln in lines:
        m_check = re.match(r"^### (S\d\d-\d\d)\b", ln)
        m_setup = re.match(r"^\*\*Setup ([^:*]+):\*\*", ln)
        if m_check or m_setup:
            flush()
            buf = [ln]
            cur_kind, cur_id = ("check", m_check.group(1)) if m_check else ("setup", m_setup.group(1).strip())
        else:
            buf.append(ln)
    flush()
    return out


def closure(suite_text, check_id, depends_on=None):
    """Blocks a re-check of `check_id` needs: intro, the check, and (recursively) every setup / check its
    text references ("Setup X", "previous check", another check ID) or that `depends_on` (dict id -> list of
    "Sxx-yy" / "Setup X", from expectations.json) names. Returns ordered block list."""
    bl = blocks(suite_text)
    idx = {(k, i): n for n, (k, i, _) in enumerate(bl)}
    setups = {i for k, i, _ in bl if k == "setup"}
    depends_on = depends_on or {}
    need, todo = set(), [idx.get(("check", check_id))]
    if todo[0] is None:
        return [b for b in bl if b[0] == "intro"]
    while todo:
        n = todo.pop()
        if n is None or n in need:
            continue
        need.add(n)
        kind, _, text = bl[n]
        if kind == "intro":
            continue
        body = re.sub(r"^\*Covers requirement.*$", "", text, flags=re.M)
        if re.search(r"previous check|result page from the previous", body, re.I):
            prev = [m for m in range(n - 1, -1, -1) if bl[m][0] == "check"]
            if prev:
                todo.append(prev[0])
        for name in re.findall(r"Setup ([A-Z][A-Z0-9-]*)", body):
            if name in setups:
                todo.append(idx[("setup", name)])
        for cid in re.findall(r"\b(S\d\d-\d\d)\b", body):
            if cid != bl[n][1] and ("check", cid) in idx:
                todo.append(idx[("check", cid)])
        for dep in depends_on.get(bl[n][1] if kind == "check" else "Setup " + bl[n][1], []):
            key = ("setup", dep[6:].strip()) if dep.startswith("Setup ") else ("check", dep)
            if key in idx:
                todo.append(idx[key])
        # a check without explicit Pre reference but with a setup directly before it in the same group
        # is covered by the "Setup X" references in the plan; nothing implicit is added here.
    return [bl[n] for n in sorted(need | {n for n, b in enumerate(bl) if b[0] == "intro"})]


def plan_order(suite_text):
    """{block id: position} for checks and setups ("Setup NAME")."""
    pos = {}
    for n, (k, i, _) in enumerate(blocks(suite_text)):
        if k == "check":
            pos[i] = n
        elif k == "setup":
            pos["Setup " + i] = n
    return pos


def named_paths(suite_text):
    """URL paths a suite names explicitly (e.g. `/robots.txt`) -> may be typed."""
    return set(re.findall(r"`(/[A-Za-z0-9_\-./?=&]*)`", suite_text)) | set(
        re.findall(r"(?<![\w/.])(/(?:robots\.txt|sitemap\.xml|admin[\w\-/]*))", suite_text))


def money_cents(s):
    """Amount -> absolute cents, or None. One or two fractional digits after the LAST separator are decimals
    ('6.6' / '6,6' -> 660, '1.234,56' / '1,234.56' / '1 234,56' -> 123456); a last group of three digits is a
    thousands group ('1,234' / '1.234' -> 123400)."""
    m = re.search(r"\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d[\d.,]*", s or "")
    if not m:
        return None
    t = re.sub(r"[ \u00a0\u202f]", "", m.group(0)).rstrip(".,")
    mm = re.match(r"^(.*?)[.,](\d{1,2})$", t)
    if mm:
        whole, frac = re.sub(r"[.,]", "", mm.group(1)), mm.group(2).ljust(2, "0")
    else:
        whole, frac = re.sub(r"[.,]", "", t), "00"
    if not whole:
        whole = "0"
    return int(whole) * 100 + int(frac)


class Plan:
    def __init__(self, tp_dir=TP):
        self.dir = tp_dir
        self.md_path = os.path.join(tp_dir, "testplan.md")
        self.text = open(self.md_path, encoding="utf-8").read()
        self.sha = sha256_file(self.md_path)
        self.rules, self.suites = split_plan(self.text)
        self.template = json.load(open(os.path.join(tp_dir, "results-template.json"), encoding="utf-8"))
        self.meta = {c["id"]: c for c in self.template["results"]}
        self.exp_path = os.path.join(tp_dir, "expectations.json")
        self.ev_path = os.path.join(tp_dir, "testplan.evaluator.md")
        self.mode, self.expectations, self.ev_rules, self.ev_suites = "legacy", None, self.rules, self.suites
        self.ev_raw_rules, self.ev_raw_suites = self.rules, {}
        self.exp_sha = self.ev_sha = None
        if os.path.exists(self.exp_path) or os.path.exists(self.ev_path):
            if not (os.path.exists(self.exp_path) and os.path.exists(self.ev_path)):
                raise PlanError("expectations.json and testplan.evaluator.md must exist together")
            exp = json.load(open(self.exp_path, encoding="utf-8"))
            if exp.get("schema") != SCHEMA_ID:
                raise PlanError(f"expectations.json: schema must be {SCHEMA_ID!r}")
            if exp.get("plan_sha256") != self.sha:
                raise PlanError("expectations.json was rendered for another testplan.md "
                                f"({exp.get('plan_sha256')} != {self.sha}); run render.py again")
            ev_text = open(self.ev_path, encoding="utf-8").read()
            m = re.search(r"plan_sha256:\s*([0-9a-f]{64})", ev_text[:2000])
            if not m or m.group(1) != self.sha:
                raise PlanError("testplan.evaluator.md lacks the matching '<!-- plan_sha256: … -->' header")
            self.mode, self.expectations = "blind", exp
            self.ev_raw_rules, self.ev_raw_suites = split_plan(ev_text)       # with {{input:…}} markers
            self.ev_rules, self.ev_suites = split_plan(strip_input_markers(ev_text))
            self.exp_sha, self.ev_sha = sha256_file(self.exp_path), sha256_file(self.ev_path)
            errs = self.validate_expectations()
            if errs:
                raise PlanError("expectations.json invalid:\n- " + "\n- ".join(errs[:30]))

    # ------------------------------------------------------------------ expectations
    def check_exp(self, cid):
        if not self.expectations:
            return None
        return self.expectations.get("checks", {}).get(cid)

    def pages(self):
        return (self.expectations or {}).get("pages") or {}

    @staticmethod
    def expected_amounts(v):
        if v.get("kind") != "money" or "expected" not in v:
            return []
        e = v["expected"]
        return [money_cents(str(x)) for x in (e if isinstance(e, list) else [e])]

    def validate_expectations(self):
        errs, exp = [], self.expectations
        pages = exp.get("pages") or {}
        for k, p in pages.items():
            extra = set(p) - {"label", "reject_url", "require_url", "heading_any", "content_any", "source"}
            if extra:
                errs.append(f"pages.{k}: unknown fields {sorted(extra)}")
            if p.get("source") not in (None, "mail"):
                errs.append(f"pages.{k}: source must be \"mail\" or absent")
            for f in ("heading_any", "content_any"):
                if f in p and (not isinstance(p[f], list) or not all(isinstance(x, str) and x.strip() for x in p[f])):
                    errs.append(f"pages.{k}.{f}: must be a non-empty list of strings")
            for rx in p.get("reject_url", []) + p.get("require_url", []):
                try:
                    re.compile(rx)
                except re.error as e:
                    errs.append(f"pages.{k}: bad regex {rx!r}: {e}")
        for cid, c in (exp.get("checks") or {}).items():
            if cid not in self.meta:
                errs.append(f"{cid}: not in results-template.json")
                continue
            mode = c.get("mode")
            if mode not in ("mechanical", "mixed", "judged"):
                errs.append(f"{cid}: mode must be mechanical|mixed|judged")
            body = self.ev_check_text(cid) or ""
            if not body:
                errs.append(f"{cid}: not found in testplan.evaluator.md")
            has_expect = bool(re.search(r"^- \*\*Expect:\*\*\s*\S", body, re.M))
            if mode in ("mixed", "judged") and not has_expect:
                errs.append(f"{cid}: mode {mode} but no **Expect:** statement is left for the evaluator to judge")
            if mode == "mechanical" and has_expect:
                errs.append(f"{cid}: mode mechanical but an **Expect:** statement is left (use mode mixed)")
            vals = c.get("values", [])
            keys = [v.get("key") for v in vals]
            for v in vals:
                k = v.get("key")
                if not k or not re.fullmatch(r"[A-Za-z0-9_]+", k) or keys.count(k) > 1:
                    errs.append(f"{cid}: bad or duplicate value key {k!r}")
                if v.get("kind") not in KINDS:
                    errs.append(f"{cid}.{k}: kind must be one of {KINDS}")
                pl = v.get("page")
                for pg in (pl if isinstance(pl, list) else [pl] if pl else []):
                    if pg != "any" and pg not in pages:
                        errs.append(f"{cid}.{k}: page {pg!r} not defined in pages")
                if isinstance(pl, list) and (not pl or "any" in pl):
                    errs.append(f"{cid}.{k}: page list must be non-empty and must not contain 'any'")
                if v.get("kind") == "money" and "currency" in v and v["currency"] not in CURRENCIES + (None,):
                    errs.append(f"{cid}.{k}: currency must be one of {CURRENCIES} or null")
                if v.get("kind") == "state" and not v.get("states"):
                    errs.append(f"{cid}.{k}: kind state needs states")
                if v.get("derive"):
                    if v.get("kind") not in ("money", "quantity"):
                        errs.append(f"{cid}.{k}: derive needs kind money or quantity")
                    if "expected" not in v:
                        errs.append(f"{cid}.{k}: expected missing")
                    ins = v.get("inputs") or []
                    try:
                        names = derive_names(v["derive"])
                    except (SyntaxError, ValueError) as e:
                        errs.append(f"{cid}.{k}: bad derive {v['derive']!r}: {e}")
                        names = set()
                    if names != set(ins):
                        errs.append(f"{cid}.{k}: derive uses {sorted(names)}, inputs lists {sorted(ins)}")
                    for i in ins:
                        src = next((x for x in vals if x.get("key") == i), None)
                        if not src or src.get("derive") or not src.get("record_only"):
                            errs.append(f"{cid}.{k}: input {i!r} must be a record_only value of the same check")
                        elif src.get("kind") != v.get("kind"):
                            errs.append(f"{cid}.{k}: input {i!r} has kind {src.get('kind')}, derive has {v.get('kind')}")
                        elif v.get("kind") == "money" and src.get("currency", "EUR") != v.get("currency", "EUR"):
                            errs.append(f"{cid}.{k}: input {i!r} has another currency")
                    continue           # derived values are computed by the harness, never recorded
                if v.get("record_only"):
                    if "expected" in v:
                        errs.append(f"{cid}.{k}: record_only value must not have expected")
                    if not any(k in (x.get("inputs") or []) for x in vals if x.get("derive")):
                        errs.append(f"{cid}.{k}: record_only value is not an input of any derive value of the check")
                elif "expected" not in v:
                    errs.append(f"{cid}.{k}: expected missing (or mark it record_only as a derive input)")
                if f"`{k}`" not in body and f"{cid}.{k}" not in body:
                    errs.append(f"{cid}.{k}: not named as a Record item in testplan.evaluator.md")
            if mode != "judged" and not [v for v in vals if not v.get("record_only")]:
                errs.append(f"{cid}: mode {mode} needs values with an expectation")
        errs += self.leaks()
        return errs

    def leaks(self):
        """Suite-wide leak check: no expected amount of any check may appear anywhere in that suite's
        evaluator-facing text (setups, other checks), except inside {{input:…}} markers."""
        errs = []
        for suite, raw in (self.ev_raw_suites or {}).items():
            found = amounts_in(INPUT_MARK.sub(" ", raw))
            for cid, c in (self.expectations.get("checks") or {}).items():
                if not cid.startswith(suite + "-"):
                    continue
                for v in c.get("values", []):
                    for cents in self.expected_amounts(v):
                        for snip in found.get(cents, [])[:2]:
                            errs.append(f"{cid}.{v['key']}: expected {cents / 100:.2f} leaks into the evaluator text of "
                                        f"{suite}: …{snip.strip()}… (mark evaluator inputs as {{{{input:…}}}})")
        return errs

    def ev_check_text(self, cid):
        s = self.ev_suites.get(cid[:3], "")
        for k, i, t in blocks(s):
            if k == "check" and i == cid:
                return t
        return None

    def depends_on(self):
        """{check id or "Setup X": [ids]} from expectations.json (optional, blind mode)."""
        out = {}
        for cid, c in ((self.expectations or {}).get("checks") or {}).items():
            if c.get("depends_on"):
                out[cid] = list(c["depends_on"])
        out.update((self.expectations or {}).get("setup_depends_on") or {})
        return out

    def suite_checks(self, suite):
        return [c for c in self.template["results"] if c["id"].startswith(suite + "-")]
