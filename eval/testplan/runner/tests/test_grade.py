#!/usr/bin/env python3
"""Unit tests for runner/grade.py and runner/plan.py (stdlib only, no shop, no claude).
Run: python3 eval/testplan/runner/tests/test_grade.py"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import grade  # noqa: E402
import plan as planmod  # noqa: E402

BASE = "http://127.0.0.1:8000"


def tool_use(i, name, inp, msg="m1"):
    return {"type": "assistant", "message": {"id": msg, "content": [
        {"type": "tool_use", "id": f"t{i}", "name": name, "input": inp}]}}


def tool_result(i, text, err=False):
    return {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": f"t{i}", "content": [{"type": "text", "text": text}], "is_error": err}]}}


def text(t, msg="mt"):
    return {"type": "assistant", "message": {"id": msg, "content": [{"type": "text", "text": t}]}}


def page(url, title="T"):
    return f"### Page\n- Page URL: {BASE}{url}\n- Page Title: {title}\n### Snapshot\n- [Snapshot](x.yml)"


def evaluate_result(value, fn):
    return "### Result\n" + json.dumps(value) + "\n### Ran Playwright code\n```js\nawait page.evaluate('" + fn + "');\n```"


PW = "mcp__playwright__"


def write_tx(events):
    f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    for e in events:
        f.write(json.dumps(e) + "\n")
    f.close()
    return f.name


class FakePlan:
    def __init__(self, exp=None, pages=None):
        self.meta = {"S04-21": {"area": "PROMO", "title": "t"}, "S04-01": {"area": "PROMO", "title": "t"}}
        self._exp, self._pages = exp or {}, pages or {}
        self.mode = "blind" if exp else "legacy"

    def check_exp(self, cid):
        return self._exp.get(cid)

    def pages(self):
        return self._pages


SUITE = """## S04 Promotions

Reset.

**Setup A01:** signed in as C-10007, ADD 6 × BEER-001 crate.

### S04-01 [PROMO] Beer
- **Pre:** Setup A01.
- **Expect:** The cart shows a discount.

### S04-21 [PROMO] Code removed
- **Pre:** previous check.
- **Do:** Remove the line, then REVIEW(Pickup).
- **Expect:** SAVE20 is no longer applied. **Record:** `gross` — the gross total in REVIEW(Pickup).
"""


def base_events():
    fn = "() => document.querySelector(\\'main\\').innerText"
    return [
        text("== Setup A01"),
        tool_use(1, PW + "browser_navigate", {"url": BASE + "/"}, "a1"),
        tool_result(1, page("/") + "\n- link: /cart"),
        text("== S04-01"),
        tool_use(2, PW + "browser_click", {"element": "Add"}, "a2"),
        tool_use(3, PW + "browser_navigate", {"url": BASE + "/cart"}, "a2"),   # batched action + navigate
        tool_result(2, page("/products/x")),
        tool_result(3, page("/cart", "Your cart")),
        tool_use(4, PW + "browser_evaluate", {"function": "() => document.querySelector('main').innerText"}, "a3"),
        tool_result(4, evaluate_result("Your cart\nBeer Crate Bonus — Buy 6, Pay 5\n−€15.80\nGross total\n€107.21", fn)),
        text("== S04-21"),
        tool_use(5, PW + "browser_navigate", {"url": BASE + "/checkout/review"}, "a4"),   # guessed URL
        tool_result(5, page("/checkout/review", "Review your order")),
        tool_use(6, PW + "browser_evaluate", {"function": "() => document.querySelector('main').innerText"}, "a5"),
        tool_result(6, evaluate_result("Review your order\nWarehouse Pickup\nTotal payable incl. VAT\n€96.62", fn)),
        tool_use(7, PW + "browser_evaluate", {"function": "() => 'Total payable incl. VAT €99.99'"}, "a6"),
        tool_result(7, evaluate_result("Total payable incl. VAT €99.99", "() => x")),
        {"type": "result", "result": "{}"},
    ]


class TestNormalisation(unittest.TestCase):
    def test_money_cents(self):
        for s, c in [("€1,234.56", 123456), ("1.234,56 €", 123456), ("EUR 1234.56", 123456), ("1234.56", 123456),
                     ("−€15.80", 1580), ("€0.00", 0), ("96,62", 9662)]:
            self.assertEqual(planmod.money_cents(s), c, s)

    def test_money_cents_one_or_two_decimals(self):
        for s, c in [("6.6", 660), ("6,6", 660), ("€6.6", 660), ("6.60", 660), ("1,234", 123400), ("1.234", 123400),
                     ("1.234,56", 123456), ("1,234.56", 123456), ("1 234,56", 123456), ("1 234,5 €", 123450),
                     ("CHF 1'234.50".replace("'", ","), 123450), ("12", 1200), ("0,5", 50), ("1.234.567,8", 123456780)]:
            self.assertEqual(planmod.money_cents(s), c, s)
        self.assertTrue(grade.compare_value({"kind": "money", "expected": "6.60", "currency": None}, "6,6")[0])
        self.assertTrue(grade.compare_value({"kind": "money", "expected": "6.60"}, "€6.6")[0])

    def test_mail_helper_identity(self):
        for cmd, ok in [("/x/bin/shop-mail-log --to a@b", True), ('"/path with space/bin/shop-mail-log" --to a', True),
                        ("EVAL_X=1 /x/bin/shop-mail-log", True), ("env A=1 shop-mail-log", True),
                        ("/x/bin/delivery", False), ("/x/bin/shop-queue-work", False),
                        ("/x/bin/delivery --note shop-mail-log", False), ("echo shop-mail-log", False), ("'unclosed", False)]:
            self.assertEqual(grade.is_mail_helper(cmd), ok, cmd)

    def test_money_tokens(self):
        self.assertEqual(grade.money_tokens("on 02.10.2026 €3.40 and 1.64.0"), {340})
        self.assertEqual(grade.money_tokens("3.17 kg rejected, €5.10", currency_only=True), {510})

    def test_compare_money(self):
        spec = {"kind": "money", "expected": "96.62"}
        self.assertTrue(grade.compare_value(spec, "€96.62")[0])
        self.assertTrue(grade.compare_value(spec, "96,62 €")[0])
        self.assertFalse(grade.compare_value(spec, "€96.61")[0])
        self.assertTrue(grade.compare_value({"kind": "money", "expected": "15.80"}, "−€15.80")[0])
        self.assertTrue(grade.compare_value({"kind": "money", "expected": ["11.85", "27.65"]}, "-€27.65")[0])
        self.assertFalse(grade.compare_value({"kind": "money", "expected": "-5.00", "signed": True}, "€5.00")[0])
        self.assertTrue(grade.compare_value({"kind": "money", "expected": "-5.00", "signed": True}, "−€5.00")[0])

    def test_compare_other(self):
        q = {"kind": "quantity", "expected": 2.5, "unit": "kg"}
        self.assertTrue(grade.compare_value(q, "2,50 kg")[0])
        self.assertFalse(grade.compare_value(q, "2.5")[0])
        self.assertTrue(grade.compare_value({"kind": "quantity", "expected": 3}, "3")[0])
        t = {"kind": "text", "expected": {"any": ["declined"], "none": ["approved"]}}
        self.assertTrue(grade.compare_value(t, "Card Declined")[0])
        st = {"kind": "state", "expected": "rejected", "states": ["applied", "rejected"]}
        self.assertTrue(grade.compare_value(st, "Rejected")[0])
        self.assertFalse(grade.compare_value(st, "applied")[0])
        self.assertFalse(grade.compare_value(st, "maybe")[0])
        self.assertTrue(grade.compare_value({"kind": "boolean", "expected": False}, "no")[0])

    def test_forbidden_js(self):
        self.assertEqual(grade.forbidden_js("() => document.querySelector('main').innerText"), [])
        self.assertIn("fetch(", grade.forbidden_js("async () => (await fetch('/cart')).text()"))
        self.assertTrue(grade.forbidden_js("() => { s.value='3'; b.click() }"))
        self.assertEqual(grade.forbidden_js("() => location.href"), [])
        self.assertEqual(grade.mutating_js("() => fetch('/x')", ["fetch("]), None)
        self.assertEqual(grade.mutating_js("() => fetch('/x',{method:'POST'})", ["fetch("]), "shop")
        self.assertEqual(grade.mutating_js("x.value='1'", ["property assignment (.value= …)"]), "page")

    def test_plan_snippets_allowed(self):
        tp = open(os.path.join(planmod.TP, "testplan.md"), encoding="utf-8").read()
        import re
        sn = re.findall(r"^- \*\*(JS-[A-Z]+)\*\*[^`]*`(.*?)`\s*(?:→|\.$|$)", tp, re.M)
        self.assertGreater(len(sn), 10)
        for name, src in sn:
            self.assertEqual(grade.forbidden_js(src), [], name)


class TestSnapshot(unittest.TestCase):
    def test_snapshot_quote(self):
        snap = (page("/cart", "Your cart").replace("- [Snapshot](x.yml)", "") +
                '```yaml\n- main [ref=e1]:\n  - heading "Your cart" [level=1] [ref=e2]\n'
                '  - generic [ref=e3]: Gross total\n  - generic [ref=e4]: €107.21\n```')
        p = write_tx([tool_use(1, PW + "browser_snapshot", {}), tool_result(1, snap), {"type": "result"}])
        try:
            tx = grade.Transcript(p, BASE)
            self.assertTrue(tx.find_quote("Gross total €107.21"))
            self.assertFalse(tx.find_quote("Gross total €107.22"))
        finally:
            os.unlink(p)


class TestTranscript(unittest.TestCase):
    def setUp(self):
        self.path = write_tx(base_events())
        self.tx = grade.Transcript(self.path, BASE)

    def tearDown(self):
        os.unlink(self.path)

    def test_quotes(self):
        tx = self.tx
        self.assertTrue(tx.find_quote("Beer Crate Bonus - Buy 6, Pay 5 −€15.80"))       # dash + line breaks
        self.assertTrue(tx.find_quote("Total payable incl. VAT: €96.62"))               # loose: colon added
        self.assertTrue(tx.find_quote("Review your order … €96.62"))                    # ellipsis pieces
        self.assertFalse(tx.find_quote("Gross total €96.62"))                           # not literally shown
        self.assertFalse(tx.find_quote("Total payable incl. VAT €99.99"))               # script returned a literal
        hits = tx.find_quote("Total payable incl. VAT €96.62")
        self.assertEqual(grade.path_of(hits[0]["url"]), "/checkout/review")

    def test_procedure(self):
        n, guessed = self.tx.url_discipline()
        self.assertEqual([g["url"] for g in guessed], ["/checkout/review"])
        self.assertEqual(guessed[0]["segment"], "S04-21")
        b = self.tx.batched_actions()
        self.assertEqual(len(b), 1)
        self.assertEqual(b[0]["segment"], "S04-01")
        self.assertEqual(self.tx.order_deviations(SUITE), [])

    def test_order_deviation(self):
        ev = base_events()
        ev.insert(-1, text("== S04-01"))
        p = write_tx(ev)
        try:
            self.assertEqual(len(grade.Transcript(p, BASE).order_deviations(SUITE)), 1)
        finally:
            os.unlink(p)

    def test_grade_blind(self):
        pl = FakePlan({"S04-21": {"mode": "mixed", "values": [
            {"key": "gross", "kind": "money", "expected": "96.62", "page": "review"}]}},
            {"review": {"reject_url": ["/cart"]}})
        good = {"id": "S04-21", "result": "PASS", "observed": "SAVE20 gone", "note": "",
                "evidence": [{"quote": "Total payable incl. VAT €96.62", "url": BASE + "/checkout/review",
                              "heading": "Review your order"}],
                "values": [{"key": "gross", "raw": "€96.62", "page": "review", "url": BASE + "/checkout/review",
                            "heading": "Review your order", "quote": "Total payable incl. VAT €96.62"}]}
        g, integ = grade.grade_suite(SUITE, [good], self.tx, pl, ["S04-21"])
        self.assertEqual(g[0]["result"], "PASS", g[0]["reasons"])
        self.assertIn("typed URL never seen before: /checkout/review", g[0]["deviations"])
        # value read in the cart instead of the review page
        bad = json.loads(json.dumps(good))
        bad["values"][0].update(raw="€107.21", page="cart", quote="Gross total €107.21", url=BASE + "/cart")
        g, _ = grade.grade_suite(SUITE, [bad], self.tx, pl, ["S04-21"])
        self.assertEqual(g[0]["result"], "FAIL")
        self.assertTrue(any("requires 'review'" in r for r in g[0]["reasons"]), g[0]["reasons"])
        self.assertTrue(any("expected 96.62" in r for r in g[0]["reasons"]), g[0]["reasons"])
        # computed value: not shown by the shop
        calc = json.loads(json.dumps(good))
        calc["values"][0].update(raw="€96.60", quote="€96.60")
        calc["note"] = "derived from goods + VAT"
        g, _ = grade.grade_suite(SUITE, [calc], self.tx, pl, ["S04-21"])
        rs = " ".join(g[0]["reasons"])
        self.assertEqual(g[0]["result"], "FAIL")
        self.assertIn("never shown by the shop: 96.60", rs)
        self.assertIn("note says 'derived'", rs)
        self.assertIn("unverified quote", rs)

    def test_grade_evidence_required(self):
        pl = FakePlan()
        r = {"id": "S04-01", "result": "PASS", "observed": "−€15.80", "note": "", "evidence": [], "values": []}
        g, _ = grade.grade_suite(SUITE, [r], self.tx, pl, ["S04-01"])
        self.assertEqual(g[0]["result"], "FAIL")
        r["evidence"] = [{"quote": "Beer Crate Bonus — Buy 6, Pay 5\n−€15.80", "url": BASE + "/cart", "heading": "Your cart"}]
        g, _ = grade.grade_suite(SUITE, [r], self.tx, pl, ["S04-01"])
        self.assertEqual(g[0]["result"], "PASS", g[0]["reasons"])
        self.assertIn("click and browser_navigate in the same turn", " ".join(g[0]["deviations"]).replace("browser_click", "click"))

    def test_forbidden_taint(self):
        ev = base_events()
        ev[4:4] = [tool_use(9, PW + "browser_evaluate", {"function": "() => { f.querySelector('button').click() }"}, "z"),
                   tool_result(9, evaluate_result("ok", "x"))]
        p = write_tx(ev)
        try:
            tx = grade.Transcript(p, BASE)
            r = {"id": "S04-01", "result": "PASS", "observed": "", "note": "", "values": [],
                 "evidence": [{"quote": "−€15.80", "url": BASE + "/cart", "heading": ""}]}
            g, integ = grade.grade_suite(SUITE, [r], tx, FakePlan(), ["S04-01"])
            self.assertEqual(g[0]["result"], "FAIL")
            self.assertEqual(integ["forbidden_scripts_executed"], 1)
        finally:
            os.unlink(p)


class TestCurrencyDeriveMixed(unittest.TestCase):
    def test_currency(self):
        cv = grade.compare_value
        self.assertTrue(cv({"kind": "money", "expected": "38.35", "currency": "CHF"}, "CHF 38.35")[0])
        self.assertTrue(cv({"kind": "money", "expected": "38.35", "currency": "CHF"}, "Fr. 38.35")[0])
        self.assertFalse(cv({"kind": "money", "expected": "38.35", "currency": "CHF"}, "€38.35")[0])
        self.assertIn("not shown", cv({"kind": "money", "expected": "38.35", "currency": "CHF"}, "38.35")[2])
        self.assertTrue(cv({"kind": "money", "expected": "35.46", "currency": "GBP"}, "£35.46")[0])
        self.assertFalse(cv({"kind": "money", "expected": "35.46", "currency": "GBP"}, "35.46 EUR")[0])
        self.assertTrue(cv({"kind": "money", "expected": "15.80"}, "−€15.80")[0])          # EUR default
        self.assertFalse(cv({"kind": "money", "expected": "15.80"}, "15.80")[0])            # EUR default: missing
        self.assertTrue(cv({"kind": "money", "expected": "6.60", "currency": None}, "6.60")[0])
        self.assertFalse(cv({"kind": "money", "expected": "1.00"}, "Free 1.00 €  CHF")[0])  # two currencies
        self.assertEqual(grade.signed_cents("−€15.80"), -1580)
        self.assertEqual(grade.signed_cents("€ -5.00"), -500)
        self.assertEqual(grade.signed_cents("€43.21"), 4321)

    def setUp(self):
        fn = "() => document.querySelector(\\'main\\').innerText"
        self.path = write_tx([
            text("== S04-21"),
            tool_use(1, PW + "browser_navigate", {"url": BASE + "/account"}, "a1"),
            tool_result(1, page("/account", "Your account")),
            tool_use(2, PW + "browser_evaluate", {"function": "() => document.body.innerText"}, "a2"),
            tool_result(2, evaluate_result("Your account\nOpen balance\n€100.00", fn)),
            tool_use(3, PW + "browser_navigate", {"url": BASE + "/account/invoices/7"}, "a3"),
            tool_result(3, page("/account/invoices/7", "Invoice INV-7")),
            tool_use(4, PW + "browser_evaluate", {"function": "() => document.body.innerText"}, "a4"),
            tool_result(4, evaluate_result("Invoice INV-7\nTotal CHF 38.35", fn)),
            tool_use(5, PW + "browser_navigate", {"url": BASE + "/account"}, "a5"),
            tool_result(5, page("/account", "Your account")),
            tool_use(6, PW + "browser_evaluate", {"function": "() => document.body.innerText"}, "a6"),
            tool_result(6, evaluate_result("Your account\nOpen balance\n€56.79\nNo refund possible", fn)),
            {"type": "result"}])
        self.tx = grade.Transcript(self.path, BASE)
        self.pages = {"account": {"label": "account"}, "invoice": {"label": "invoice", "require_url": ["invoice"]},
                      "mail": {"label": "mail log", "source": "mail"}}

    def tearDown(self):
        os.unlink(self.path)

    def val(self, key, raw, quote, url, page):
        return {"key": key, "raw": raw, "page": page, "url": BASE + url, "heading": "", "quote": quote}

    def run_check(self, exp, result, values, evidence=None):
        pl = FakePlan({"S04-21": exp}, self.pages)
        r = {"id": "S04-21", "result": result, "observed": "", "note": "" if result == "PASS" else "x",
             "evidence": evidence or [{"quote": "Your account", "url": BASE + "/account", "heading": ""}], "values": values}
        return grade.grade_suite(SUITE, [r], self.tx, pl, ["S04-21"])[0][0]

    def derive_exp(self, expected="43.21"):
        return {"mode": "mechanical", "values": [
            {"key": "B1", "kind": "money", "record_only": True, "page": "account", "currency": "EUR"},
            {"key": "B2", "kind": "money", "record_only": True, "page": "account", "currency": "EUR"},
            {"key": "balance_diff", "kind": "money", "derive": "B1 - B2", "inputs": ["B1", "B2"],
             "expected": expected, "currency": "EUR"}]}

    def test_derived(self):
        vals = [self.val("B1", "€100.00", "Open balance €100.00", "/account", "account"),
                self.val("B2", "€56.79", "Open balance €56.79", "/account", "account")]
        g = self.run_check(self.derive_exp(), "PASS", vals)
        self.assertEqual(g["result"], "PASS", g["reasons"])
        self.assertEqual([v["normalised"] for v in g["values"] if v["key"] == "balance_diff"], ["43.21"])
        g = self.run_check(self.derive_exp("43.20"), "PASS", vals)
        self.assertEqual(g["result"], "FAIL")
        self.assertTrue(any("B1 - B2 = 43.21" in r for r in g["reasons"]), g["reasons"])
        # an input with a quote the shop never showed -> derived value cannot be computed
        bad = [vals[0], self.val("B2", "€56.80", "Open balance €56.80", "/account", "account")]
        g = self.run_check(self.derive_exp(), "PASS", bad)
        self.assertEqual(g["result"], "FAIL")
        self.assertTrue(any("cannot derive" in r for r in g["reasons"]), g["reasons"])

    def test_strict_page_and_currency(self):
        exp = {"mode": "mechanical", "values": [
            {"key": "total", "kind": "money", "expected": "38.35", "currency": "CHF", "page": "invoice"}]}
        ok = [self.val("total", "CHF 38.35", "Total CHF 38.35", "/account/invoices/7", "invoice")]
        self.assertEqual(self.run_check(exp, "PASS", ok)["result"], "PASS")
        wrong_url = [self.val("total", "CHF 38.35", "Total CHF 38.35", "/account", "invoice")]
        g = self.run_check(exp, "PASS", wrong_url)
        self.assertEqual(g["result"], "FAIL")
        self.assertTrue(any("claimed URL /account" in r for r in g["reasons"]), g["reasons"])
        g = self.run_check(exp, "PASS", [self.val("total", "38.35", "Total CHF 38.35", "/account/invoices/7", "invoice")])
        self.assertTrue(any("currency CHF not shown" in r for r in g["reasons"]), g["reasons"])
        exp_mail = {"mode": "mechanical", "values": [
            {"key": "total", "kind": "money", "expected": "38.35", "currency": "CHF", "page": "mail"}]}
        g = self.run_check(exp_mail, "PASS", [self.val("total", "CHF 38.35", "Total CHF 38.35", "/account/invoices/7", "mail")])
        self.assertTrue(any("mail log" in r for r in g["reasons"]), g["reasons"])

    def test_mixed_needs_both(self):
        exp = {"mode": "mixed", "values": [{"key": "bal", "kind": "money", "expected": "56.79", "page": "account"}]}
        good = [self.val("bal", "€56.79", "Open balance €56.79", "/account", "account")]
        wrong = [self.val("bal", "€100.00", "Open balance €100.00", "/account", "account")]
        ev = [{"quote": "No refund possible", "url": BASE + "/account", "heading": ""}]
        self.assertEqual(self.run_check(exp, "PASS", good, ev)["result"], "PASS")
        self.assertEqual(self.run_check(exp, "FAIL", good, ev)["result"], "FAIL")     # judged statement failed
        self.assertEqual(self.run_check(exp, "PASS", wrong, ev)["result"], "FAIL")    # value wrong


class TestPagesRound3(unittest.TestCase):
    def setUp(self):
        fn = "() => document.body.innerText"
        self.path = write_tx([
            text("== S04-21"),
            tool_use(1, PW + "browser_navigate", {"url": BASE + "/cart?step=review"}, "a1"),
            tool_result(1, page("/cart?step=review", "Review your order · Shop")),
            tool_use(2, PW + "browser_evaluate", {"function": fn}, "a2"),
            tool_result(2, evaluate_result("Review your order\nPlace order\nTotal €96.62", fn)),
            tool_use(3, PW + "browser_navigate", {"url": BASE + "/account/orders/5"}, "a3"),
            tool_result(3, page("/account/orders/5", "Order SG-5 · Shop")),
            tool_use(4, PW + "browser_evaluate", {"function": fn}, "a4"),
            tool_result(4, evaluate_result("Order SG-5\nTotal €96.62", fn)),
            tool_use(5, PW + "browser_navigate", {"url": BASE + "/cart"}, "a5"),
            tool_result(5, page("/cart", "Your cart · Shop")),
            tool_use(6, PW + "browser_evaluate", {"function": fn}, "a6"),
            tool_result(6, evaluate_result("Your cart\nGross total €107.21", fn)),
            tool_use(7, "Bash", {"command": "/x/bin/delivery"}, "a7"),
            tool_result(7, "Mail total €12.00 earliest 2026-10-05"),
            tool_use(8, "Bash", {"command": "/x/bin/shop-mail-log --to a@b.example"}, "a8"),
            tool_result(8, "1 matching log entry\nSubject: Invoice total €13.00"),
            {"type": "result"}])
        self.tx = grade.Transcript(self.path, BASE)
        self.pages = {
            "review": {"label": "final review step", "heading_any": ["Review your order"], "content_any": ["Place order"]},
            "invoice": {"label": "invoice", "heading_any": ["Invoice"]},
            "order": {"label": "order detail", "heading_any": ["Order SG-"]},
            "cart": {"label": "cart", "heading_any": ["Your cart"]},
            "mail": {"label": "mail log", "source": "mail"}}

    def tearDown(self):
        os.unlink(self.path)

    def grade_value(self, spec, raw, quote, url, page):
        pl = FakePlan({"S04-21": {"mode": "mechanical", "values": [dict(spec, key="v")]}}, self.pages)
        r = {"id": "S04-21", "result": "PASS", "observed": "", "note": "", "evidence": [],
             "values": [{"key": "v", "raw": raw, "page": page, "url": BASE + url if url else "", "heading": "",
                         "quote": quote}]}
        return grade.grade_suite(SUITE, [r], self.tx, pl, ["S04-21"])[0][0]

    def test_review_by_markers_not_url(self):
        g = self.grade_value({"kind": "money", "expected": "96.62", "page": "review"}, "€96.62", "Total €96.62",
                             "/cart?step=review", "review")
        self.assertEqual(g["result"], "PASS", g["reasons"])          # no /cart URL veto
        g = self.grade_value({"kind": "money", "expected": "107.21", "page": "review"}, "€107.21",
                             "Gross total €107.21", "/cart", "review")
        self.assertEqual(g["result"], "FAIL")                         # cart visit lacks the review markers
        self.assertTrue(any("not seen on a 'review' page" in r for r in g["reasons"]), g["reasons"])

    def test_label_only_page(self):
        self.pages["account"] = {"label": "account page"}           # no rules: any visit, but must be named
        spec = {"kind": "money", "expected": "107.21", "page": "account"}
        g = self.grade_value(spec, "€107.21", "Gross total €107.21", "/cart", "account")
        self.assertEqual(g["result"], "PASS", g["reasons"])
        g = self.grade_value(spec, "€107.21", "Gross total €107.21", "/cart", "cart")
        self.assertTrue(any("requires 'account'" in r for r in g["reasons"]), g["reasons"])

    def test_page_alternatives(self):
        spec = {"kind": "money", "expected": "96.62", "page": ["invoice", "order"]}
        g = self.grade_value(spec, "€96.62", "Order SG-5 Total €96.62", "/account/orders/5", "order")
        self.assertEqual(g["result"], "PASS", g["reasons"])
        g = self.grade_value(spec, "€96.62", "Total €96.62", "/cart?step=review", "review")
        self.assertTrue(any("requires 'invoice' or 'order'" in r for r in g["reasons"]), g["reasons"])
        g = self.grade_value(spec, "€96.62", "Order SG-5 Total €96.62", "/account/orders/5", "invoice")
        self.assertEqual(g["result"], "FAIL")                         # claims invoice, page shows no invoice heading

    def test_mail_needs_shop_mail_log(self):
        spec = {"kind": "money", "expected": "12.00", "page": "mail"}
        g = self.grade_value(spec, "€12.00", "Mail total €12.00", "", "mail")
        self.assertTrue(any("shop-mail-log" in r for r in g["reasons"]), g["reasons"])   # came from `delivery`
        g = self.grade_value(dict(spec, expected="13.00"), "€13.00", "Invoice total €13.00", "", "mail")
        self.assertEqual(g["result"], "PASS", g["reasons"])


class TestPlan(unittest.TestCase):
    def test_closure(self):
        cl = planmod.closure(SUITE, "S04-21")
        self.assertEqual([(k, i) for k, i, _ in cl], [("intro", None), ("setup", "A01"), ("check", "S04-01"),
                                                     ("check", "S04-21")])

    def _bundle(self, d, ev_body, exp_checks):
        md = ("# Plan\n\n## 0. Evaluator instructions\n\nrules\n\n## S01 Suite\n\nReset.\n\n"
              "### S01-01 [PRICE] Price\n- **Expect:** The price is **€3.40** `[calc X]`.\n")
        open(os.path.join(d, "testplan.md"), "w").write(md)
        sha = planmod.sha256_file(os.path.join(d, "testplan.md"))
        json.dump({"results": [{"id": "S01-01", "area": "PRICE", "title": "Price"}]},
                  open(os.path.join(d, "results-template.json"), "w"))
        open(os.path.join(d, "testplan.evaluator.md"), "w").write(
            f"<!-- plan_sha256: {sha} -->\n# Plan\n\n## 0. Evaluator instructions\n\nrules\n\n## S01 Suite\n\nReset.\n\n"
            "### S01-01 [PRICE] Price\n" + ev_body)
        json.dump({"schema": planmod.SCHEMA_ID, "plan_sha256": sha,
                   "pages": {"product": {"label": "product page"}}, "checks": exp_checks},
                  open(os.path.join(d, "expectations.json"), "w"))

    def test_blind_bundle(self):
        exp = {"S01-01": {"mode": "mechanical", "values": [
            {"key": "price", "kind": "money", "expected": "3.40", "page": "product"}]}}
        with tempfile.TemporaryDirectory() as d:
            self._bundle(d, "- **Record:** `price` — the price on the product page.\n", exp)
            p = planmod.Plan(d)
            self.assertEqual(p.mode, "blind")
            self.assertEqual(p.check_exp("S01-01")["values"][0]["key"], "price")
            self.assertNotIn("3.40", p.ev_suites["S01"])
        with tempfile.TemporaryDirectory() as d:     # leaked expected value
            self._bundle(d, "- **Record:** `price` — the price (€3.40) on the product page.\n", exp)
            with self.assertRaises(planmod.PlanError) as cm:
                planmod.Plan(d)
            self.assertIn("leaks", str(cm.exception))
        with tempfile.TemporaryDirectory() as d:     # stale render
            self._bundle(d, "- **Record:** `price` — x.\n", exp)
            open(os.path.join(d, "testplan.md"), "a").write("\nchanged\n")
            with self.assertRaises(planmod.PlanError):
                planmod.Plan(d)

    def test_suite_wide_leak_and_inputs(self):
        exp = {"S01-01": {"mode": "mechanical", "values": [
            {"key": "price", "kind": "money", "expected": "3.40", "page": "product"}]}}
        with tempfile.TemporaryDirectory() as d:     # leak in the suite intro / setup text, not in the check
            self._bundle(d, "- **Record:** `price` — the price on the product page.\n", exp)
            p = os.path.join(d, "testplan.evaluator.md")
            t = open(p).read()
            open(p, "w").write(t.replace("Reset.\n", "Reset. **Setup X:** pay €3.40 by transfer.\n"))
            with self.assertRaises(planmod.PlanError) as cm:
                planmod.Plan(d)
            self.assertIn("leaks into the evaluator text of S01", str(cm.exception))
        with tempfile.TemporaryDirectory() as d:     # the same amount as a marked evaluator input is allowed
            self._bundle(d, "- **Record:** `price` — the price on the product page.\n", exp)
            p = os.path.join(d, "testplan.evaluator.md")
            t = open(p).read()
            open(p, "w").write(t.replace("Reset.\n", "Reset. **Setup X:** pay {{input:€3.40}} by transfer.\n"))
            pl = planmod.Plan(d)
            self.assertIn("pay €3.40 by transfer", pl.ev_suites["S01"])
            self.assertNotIn("{{input", pl.ev_suites["S01"])

    def test_contract_errors(self):
        with tempfile.TemporaryDirectory() as d:
            exp = {"S01-01": {"mode": "mixed", "values": [
                {"key": "B1", "kind": "money", "record_only": True, "page": "product"},
                {"key": "diff", "kind": "money", "derive": "B1 - B9", "inputs": ["B1"], "expected": "1.00"},
                {"key": "x", "kind": "money", "expected": "2.00", "currency": "USD", "page": "product"}]}}
            self._bundle(d, "- **Record:** `B1` and `x`.\n", exp)
            with self.assertRaises(planmod.PlanError) as cm:
                planmod.Plan(d)
            e = str(cm.exception)
            self.assertIn("derive uses ['B1', 'B9']", e)
            self.assertIn("currency must be one of", e)
            self.assertIn("mode mixed but no **Expect:**", e)
        with tempfile.TemporaryDirectory() as d:
            exp = {"S01-01": {"mode": "mechanical", "values": [
                {"key": "price", "kind": "money", "expected": "3.40", "page": "product"}]}}
            self._bundle(d, "- **Record:** `price`.\n- **Expect:** The price is labelled net.\n", exp)
            with self.assertRaises(planmod.PlanError) as cm:
                planmod.Plan(d)
            self.assertIn("mode mechanical but an **Expect:**", str(cm.exception))
        with tempfile.TemporaryDirectory() as d:     # round 3: derive inputs must be record_only and used
            exp = {"S01-01": {"mode": "mixed", "values": [
                {"key": "B1", "kind": "money", "expected": "1.00", "page": "product"},
                {"key": "B3", "kind": "money", "record_only": True, "page": ["product", "nope"]},
                {"key": "diff", "kind": "money", "derive": "B1 * 2", "inputs": ["B1"], "expected": "2.00"}]}}
            self._bundle(d, "- **Record:** `B1`, `B3`.\n- **Expect:** x.\n", exp)
            with self.assertRaises(planmod.PlanError) as cm:
                planmod.Plan(d)
            e = str(cm.exception)
            self.assertIn("input 'B1' must be a record_only value", e)
            self.assertIn("B3: record_only value is not an input of any derive", e)
            self.assertIn("page 'nope' not defined", e)
        with tempfile.TemporaryDirectory() as d:     # valid derive bundle
            exp = {"S01-01": {"mode": "mixed", "values": [
                {"key": "B1", "kind": "money", "record_only": True, "page": "product"},
                {"key": "B2", "kind": "money", "record_only": True, "page": "product"},
                {"key": "diff", "kind": "money", "derive": "B1 - B2", "inputs": ["B1", "B2"], "expected": "1.00"}]}}
            self._bundle(d, "- **Record:** `B1` before, `B2` after.\n- **Expect:** No refund is possible.\n", exp)
            self.assertEqual(planmod.Plan(d).mode, "blind")

    def test_live_plan_loads(self):
        p = planmod.Plan()
        self.assertIn(p.mode, ("legacy", "blind"))
        self.assertTrue(p.suites)


if __name__ == "__main__":
    unittest.main(verbosity=1)
