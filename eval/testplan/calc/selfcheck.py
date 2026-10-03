#!/usr/bin/env python3
"""Hand-check the calculator against the spec.

1. Every price, tier price and deposit encoded in data.py appears in that product's block of
   specs/products.md (derived prices such as WAT-001 crates are checked as bottle price x content).
2. Every worked example stated in the spec text reproduces exactly.
3. The delivery-date rule gives the expected dates for known cases.
Exit code 0 = all good.
"""
import datetime as dt
import os
import re
import sys
from decimal import Decimal as D

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data import P, C  # noqa: E402
from engine import compute, r2, Line, ZERO  # noqa: E402
from delivery import expected, berlin_holidays  # noqa: E402

SPECS = os.environ.get("ONESHOTSHOP_SPECS", "/Users/fabianwesner/Herd/oneshotshop/specs")
fails = []


def ok(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


# ---- 1. prices against products.md
prod = open(os.path.join(SPECS, "products.md"), encoding="utf-8").read()
blocks = {re.search(r"^SKU: (\S+)", b, re.M).group(1): b for b in re.split(r"\n### ", prod)[1:] if "SKU: " in b}
DERIVED = {("WAT-001", "box"), ("WAT-001", "crate"), ("CHE-006", "wheel")}
for sku, p in P.items():
    if p.parent:   # variant: price and stock stated on the parent's variant line
        pb = blocks.get(p.parent, "")
        u = next(iter(p.units.values()))
        ok(re.search(r"SKU " + re.escape(sku) + r": €" + re.escape(f"{u.price:.2f}") + r" per .*Stock: " + str(p.stock) + " ", pb)
           is not None, f"{sku} variant price {u.price} and stock {p.stock} in spec")
        ok(f"VAT: {p.vat} %" in pb, f"{sku} VAT {p.vat} % (parent)")
        continue
    b = blocks.get(sku)
    ok(b is not None, f"{sku} exists in products.md")
    if not b:
        continue
    money = set(re.findall(r"€([\d,]+\.\d{2})", b))
    money = {m.replace(",", "") for m in money}
    for uname, u in p.units.items():
        if (sku, uname) in DERIVED:
            continue
        ok(f"{u.price:.2f}" in money, f"{sku} {uname} price {u.price} in spec")
        for _, tp in u.tiers:
            ok(f"{tp:.2f}" in money, f"{sku} {uname} tier {tp} in spec")
        if u.crate_dep:
            ok(f"{u.crate_dep:.2f}" in money, f"{sku} {uname} container deposit {u.crate_dep} in spec")
    if p.dep_base:
        ok(f"{p.dep_base:.2f}" in money, f"{sku} base-unit deposit {p.dep_base} in spec")
    if p.bundle:
        ok("VAT: mixed (see below)" in b and "This is a bundle with a fixed price" in b, f"{sku} is a bundle")
        for s_, u_, q_ in p.bundle:
            ok(f"{q_} × {s_} " in b, f"{sku} contains {q_} x {s_}")
        continue
    ok(f"VAT: {p.vat} %" in b, f"{sku} VAT {p.vat} %")
    ok(("excluded from all discounts" in b) == p.excluded, f"{sku} excluded flag")
    if p.stock is None:
        ok("Not stocked:" in b, f"{sku} not stocked (sourced on demand)")
    else:
        m_st = re.search(r"^(?:Current|Sellable) stock: ([\d,]+)", b, re.M)
        ok(m_st is not None and int(m_st.group(1).replace(",", "")) == p.stock, f"{sku} stock {p.stock}")
    for uname, u in p.units.items():
        if u.pallet_dep:
            ok("Each pallet has an additional €15.00 deposit" in b, f"{sku} pallet deposit")
    ok(f"Category: {p.cat}\n" in b, f"{sku} category {p.cat}")
ok(P["WAT-001"].units["crate"].price == 24 * P["WAT-001"].units["bottle"].price, "WAT-001 crate = 24 x bottle price")
ok(P["WAT-001"].units["box"].price == 6 * P["WAT-001"].units["bottle"].price, "WAT-001 box = 6 x bottle price")

# ---- 2. worked examples from the spec text
cust = open(os.path.join(SPECS, "customers.md"), encoding="utf-8").read()
disc = open(os.path.join(SPECS, "discounts.md"), encoding="utf-8").read()
ship = open(os.path.join(SPECS, "shipping.md"), encoding="utf-8").read()


def ex(desc, value, expect, text, needle):
    ok(value == D(expect) and needle in text, f"{desc}: {value} == {expect} (spec says '{needle}')")


ex("C-10001 COF-001 carton", compute("C-10001", [("COF-001", "carton", 1)])["goods"], "101.40", cust, "€101.40")
ex("C-10004 WINE-005 carton", compute("C-10004", [("WINE-005", "carton", 1)])["goods"], "32.40", cust, "€32.40")
ex("BEER-001 deposits per crate", compute("C-10007", [("BEER-001", "crate", 1)])["deposits"], "3.10",
   blocks["BEER-001"], "€3.10 in deposits")
ex("CHE-006 estimate", compute("C-10007", [("CHE-006", "wheel", 1)])["goods"], "38.70", blocks["CHE-006"], "€38.70")
ex("MEA-001 estimate 2.2 kg x 42.00", r2(D("2.2") * D("42.00")), "92.40", prod, "€92.40")
ex("JUI-003 7.5 l -> 2 canisters", compute("C-10007", [("JUI-003", "l", "7.5")])["deposits"], "6.00",
   blocks["JUI-003"], "7.5 litres are filled into 2 canisters")
ex("ESPRESSO2 cap", compute("C-10007", [("COF-001", "carton", 6)], code="ESPRESSO2")["code"], "60.00", disc,
   "maximum discount is €60.00")
ex("ESPRESSO2 one carton", compute("C-10007", [("COF-001", "carton", 1)], code="ESPRESSO2")["code"], "12.00", disc,
   "one carton gives €12.00 off")
ex("KAESE1 2.5 kg", compute("C-10007", [("CHE-001", "kg", "2.5")], code="KAESE1")["code"], "2.50", disc,
   "€2.50 off")
ex("TENOFF cap", compute("C-10007", [("NF-001", "sleeve", 1)], code="TENOFF")["code"], "4.90", disc, "gets €4.90 off")
ex("EXPRESSHALF", compute("C-10007", [("OIL-001", "carton", 1)], code="EXPRESSHALF", method="express")["ship_fee"],
   "9.95", disc, "€19.90 becomes €9.95")
ex("Std parcel 3 x 25 kg sacks surcharge", compute("C-10007", [("DRY-002", "sack", 3)], method="std")["surcharge"],
   "25.50", ship, "= €25.50")
ex("Beer 12 crates -> 2 free (tier 15.20)", compute("C-10007", [("BEER-001", "crate", 12)])["auto"], "30.40", disc,
   "12 crates means 2 free crates")
ex("Beer 11 crates -> 1 free (tier 15.20)", compute("C-10007", [("BEER-001", "crate", 11)])["auto"], "15.20", disc,
   "11 crates means 1 free crate")
ex("C-10003 headroom", C["C-10003"].credit_limit - C["C-10003"].open_balance, "150.00", cust,
   "gross total of €150.00 or less")
ok(compute("C-10007", [("OIL-001", "carton", 1)], code="FREESHIP", method="express")["shipping"] == D("19.90"),
   "FREESHIP not valid for express")
ok(compute("C-10005", [("OIL-001", "carton", 2)], method="eu")["vat"] == 0, "reverse charge 0 % for C-10005")
ok(compute("C-10006", [("OIL-001", "carton", 2)], method="eu")["vat"] > 0, "C-10006 pays German VAT")
from engine import bundle_contents_value, bundle_availability
ex("BND-001 contents", bundle_contents_value("BND-001"), "31.58", blocks["BND-001"], "€31.58")
ex("BND-002 contents", bundle_contents_value("BND-002"), "69.11", blocks["BND-002"], "€69.11")
ex("BND-001 deposits", compute("C-10002", [("BND-001", "kit", 1)])["deposits"], "0.96", blocks["BND-001"], "= €0.96")
ok(bundle_availability("BND-001") == 50 and "50 kits can be ordered" in blocks["BND-001"], "BND-001 availability 50")
ok(bundle_availability("BND-002") == 10 and "10 kits can be ordered" in blocks["BND-002"], "BND-002 availability 10")
ex("CTR-001 + extra cheese", compute("C-10007", [Line("CTR-001", "pizza", 1, options=("cheese",))])["goods"],
   "12.80", blocks["CTR-001"], "+€3.00")
ex("DAI-010 pallet deposits 360x0.15+60x1.50+15", compute("C-10007", [("DAI-010", "pallet", 1)])["deposits"],
   "159.00", blocks["DAI-010"], "€15.00 deposit")
ex("CHE-001 3.15 kg", compute("C-10007", [("CHE-001", "kg", "3.15")])["goods"], "30.87", blocks["CHE-001"],
   "3.15 kg, but not 3.17 kg")
from engine import invoices
_o = compute("C-10001", [("BEER-005", "keg", 10), ("WAT-001", "crate", 1)], code="WELCOME10", method="truck")
_iv = invoices(_o, [{0: 8, 1: 1, 2: 1}, {0: 2}])
ok(sum(i["gross"] for i in _iv) == _o["gross"] and sum(i["discount"] for i in _iv) == _o["code"],
   "invoices of a split shipment add up to the order (gross and discount)")
ok(sum(i["vat19"] for i in _iv) == _o["vat19"], "invoice VAT adds up to the order VAT")
_d = compute("C-10007", [("VEG-004", "lemon", 15), ("NF-003", "pack", 4)], code="B2B7")
ok(sum(l.code for l in _d["lines"]) == _d["code"] == D("1.34"), "split rounding keeps the discount total")
# ---- regression cases from the consistency review (transaction currency, VAT treatment, allocations)
from engine import refund as _rf, invoices as _inv, early_payment_discount as _epd, split_by_rates as _sbr
_x2 = compute("C-10010", [("OIL-001", "carton", 2)], method="intl")
ok(_inv(_x2, [{0: 2}])[0]["gross"] == D("337.40"), "CH export invoice: CHF 292.40 + 45.00 + 0 VAT = 337.40")
ok(_rf(_x2, {0: 1})["gross"] == D("146.20"), "CH return of one carton: CHF 146.20, no VAT")
_pal = compute("C-10007", [("DAI-010", "pallet", 1)])
ok(_rf(_pal, {0: 1})["gross"] == D("661.13"), "DAI-010 pallet full refund 661.13 (pallet deposit VAT 19 %)")
_at = _epd(compute("C-10005", [("OIL-001", "carton", 2)], method="eu"), "0.02")
ok(_at["discount"] == D("6.98") and _at["payable"] == D("341.92") and _at["vatcorr7"] == 0 and _at["vatcorr19"] == 0,
   "reverse-charge early discount: 6.98, payable 341.92, no VAT correction")
_s20 = compute("C-10010", [("OIL-001", "carton", 2)], code="SAVE20", method="intl")
ok(_s20["code"] == D("19.00"), "SAVE20 converted once: CHF 19.00")
_b7 = compute("C-10010", [("OIL-001", "carton", 2)], code="B2B7", method="intl")
ok(_b7["code"] == D("20.45") and _b7["gross"] == D("316.95"), "B2B7 in CHF: 20.45 (0.05 rounding), gross 316.95")
_bal = compute("C-10010", [("OIL-001", "carton", 3), ("OIL-001", "tin", 1)], method="intl")
ok(_bal["free_balsamic"] and _bal["goods"] == D("476.95"), "free balsamic threshold CHF 475.00: 476.95 qualifies")
_neg = compute("C-10004", [("WINE-005", "carton", 1), ("OIL-001", "tin", 1)], code="B2B7")
_i = _inv(_neg, [{0: 1}, {1: 1}])
ok(_neg["code"] == D("2.74") and _i[0]["discount"] == 0 and _i[1]["discount"] == D("2.74")
   and _i[0]["gross"] + _i[1]["gross"] == _neg["gross"], "invoice discount only on eligible lines; invoices sum to order")
_r04 = compute("C-10001", [("OIL-001", "tin", 2)])
_p1 = _rf(_r04, {0: 1}); _p2 = _rf(_r04, {0: 1}, previous={0: _p1["parts"][0]})
ok(_p1["gross"] + _p2["gross"] == _r04["gross"] == D("86.41"), "two one-tin refunds add up to the order (residual rule)")
_t = _sbr(D("0.03"), {D(7): D(1), D(19): D(1)}, "EUR")
ok(_t == {D(7): D("0.02"), D(19): D("0.01")}, "tie-breaker: equal shares, difference to the higher VAT rate")
ok(compute("C-10002", [("CHE-006", "wheel", 1)])["goods"] == D("36.78"),
   "catch-weight Gastronomy: 12.90 x 0.95 = 12.26/kg x 3.0 = 36.78 (per-kg rounding first)")
# ---- regression cases from the second review
from engine import credit_after_early_discount as _cad
_b7c = compute("C-10007", [("BEER-001", "crate", 7)])
_iv3 = _inv(_b7c, [{0: 1}, {0: 1}, {0: 5}])
ok(_iv3[2]["merch"] == D("67.72") and sum(x["gross"] for x in _iv3) == _b7c["gross"],
   "invoices 1/1/5 crates: last merchandise 67.72, invoices sum to the order")
_rs = compute("C-10007", [("OIL-001", "tin", 2)])
_m1 = _rf(_rs, {0: 1}, restocking_pct="0.10"); _m2 = _rf(_rs, {0: 1}, restocking_pct="0.10", previous={0: _m1["parts"][0]})
ok(_m1["gross"] == _m2["gross"] == D("40.93"), "both tins returned by mistake: 40.93 + 40.93 = 81.86 (fees kept)")
_j = compute("C-10007", [("JUI-003", "l", "7.5")])
ok(_rf(_j, {0: D("2.5")}, containers=1)["gross"] == D("16.07"), "JUI-003 return of 2.5 l with 1 canister: 16.07")
compute("C-10010", [("OIL-001", "carton", 1)], method="intl")      # a CHF calculation first ...
_e3 = _epd(compute("C-10004", [("OIL-001", "tin", 2), ("WINE-001", "carton", 1)]), "0.03")   # ... then EUR
ok(_e3["share7"] == D("2.51") and _e3["share19"] == D("1.28") and _e3["vatcorr19"] == D("0.20"),
   "EUR helper after a CHF calculation: shares 2.51/1.28, VAT correction 19 % 0.20")
_c = _cad(compute("C-10004", [("WAT-002", "crate", 1)]), "0.02")
ok(_c["discount"] == D("0.42") and _c["credit"] == D("25.46") == _epd(compute("C-10004", [("WAT-002", "crate", 1)]), "0.02")["payable"],
   "credit note after early-payment discount: deposits excluded from the discount, credit = collected 25.46")
# ---- contract generation: conditions and negations are never lost
import contract as _ct
from scenarios import SCN
_txt = """## S98 Contract test
### S98-01 [RET] Refusal kept
- **Pre:** x.
- **Expect:** The total refunded is {{RC.gross}}. The shop refused the second refund.
### S98-02 [FIN] Nothing captured kept
- **Pre:** x.
- **Expect:** The card authorisation is {{SPLIT.card}}. Nothing has been captured from the card yet.
### S98-03 [RET] Derived
- **Pre:** read **B2**.
- **Record-only:** `B1` — the open balance shown in the account before; `B2` — the open balance shown in the account now.
- **Expect:** B1 − B2 equals {{derive:B1 - B2=RF4.gross}}.
### S98-04 [PROMO] Alternatives
- **Pre:** pay {{>BT.gross}}.
- **Expect:** The discount is {{C03.code|C20.code}}.
"""
_cks = [{"id": f"S98-0{i}", "title": t} for i, t in enumerate(["Refusal kept", "Nothing captured kept", "Derived",
                                                                  "Alternatives"], 1)]
_exp, _meta = _ct.build(_txt, _cks, "x")
ok(_exp["checks"]["S98-01"]["mode"] == "mixed" and "refused" in " ".join(_meta["S98-01"]["judged"]),
   "contract: a negation next to a value stays a judged Expect statement")
ok(_exp["checks"]["S98-02"]["mode"] == "mixed" and "Nothing" in " ".join(_meta["S98-02"]["judged"]),
   "contract: 'nothing captured' stays judged")
_d = {v["key"]: v for v in _exp["checks"]["S98-03"]["values"]}
ok(_d["B1"].get("record_only") and _d["B2"].get("record_only") and
   [v for v in _d.values() if v.get("derive") == "B1 - B2" and v["expected"] == "43.21"],
   "contract: B1 − B2 becomes two record-only values and a derived value")
ok(_exp["checks"]["S98-04"]["values"][0]["expected"] == [str(SCN["C03"][1]["code"]), str(SCN["C20"][1]["code"])],
   "contract: alternatives only from explicit {{A|B}} metadata")
_ct.VIOLATIONS.clear()
try:
    _ct.build("## S97 T\n### S97-01 [X] T\n- **Expect:** The price {{RC.gross}} is shown and nothing else.\n",
              [{"id": "S97-01", "title": "T"}], "x")
    ok(False, "contract: a value sentence with a condition is refused")
except SystemExit:
    ok(True, "contract: a value sentence with a condition is refused")
_ct.VIOLATIONS.clear()
_ev = _ct.evaluator(_txt, _meta, "x", lambda n, f: "€" + str(SCN[n][1][f]))
ok("{{input:€" in _ev and "Record-only" not in _ev and "43.21" not in _ev,
   "contract: inputs are marked, record-only lines become Record lines, derived expectations stay hidden")
# ---- regression cases from the third review
_m1 = _rf(_rs, {0: 1}, restocking_pct="0.10")
_q2 = _rf(_rs, {0: 1}, previous={0: _m1["parts"][0]})
ok(_m1["gross"] == D("40.93") and _q2["gross"] == D("45.47"),
   "mixed reasons: mistake 40.93, then quality 45.47 (VAT on the accumulated credited base), total 86.40")
_j1 = _rf(_j, {0: D("2.5")}, containers=1)
_j2 = _rf(_j, {0: D("5")}, containers=0, previous={0: _j1["parts"][0]})
ok(_j1["gross"] == D("16.07") and _j2["gross"] == D("24.99"),
   "JUI-003: 2.5 l + 1 canister 16.07, then 5 l + 0 canisters 24.99 (unreturned canisters never refunded)")
_ed = compute("C-10004", [("OIL-001", "tin", 2), ("WINE-001", "carton", 1)], method="truck")
_cg = _cad(_ed, "0.02")
ok(_cg["goods_gross"] == D("126.37") and _cg["credit"] == D("123.84"),
   "early-discount credit on the goods only (shipping retained): 126.37 - 2.53 = 123.84")
def _auth_after_cancel(remaining_gross, credit_applied, card_captured):
    """payments.md: open card authorisation after a cancellation."""
    return max(ZERO, remaining_gross - credit_applied - card_captured)
_t3 = compute("C-10007", [("OIL-001", "tin", 3)])
_t2 = compute("C-10007", [("OIL-001", "tin", 2)])
_t1 = compute("C-10007", [("OIL-001", "tin", 1)])
ok(_auth_after_cancel(_t2["gross"], D("10.00"), _t1["gross"] - D("10.00")) == D("45.47")
   and _auth_after_cancel(_t1["gross"], D("10.00"), ZERO) == D("35.48"),
   "authorisation after cancellation: 3 tins, 10.00 credit, 1 shipped (10.00 credit + 35.48 card), 1 cancelled -> 45.47")
_r3 = _rf(_t3, {0: 1}); _r3b = _rf(_t3, {0: 1}, previous={0: _r3["parts"][0]})
_r3c = _rf(_t3, {0: 1}, previous={0: _r3b["parts"][0]})
ok(_r3["gross"] + _r3b["gross"] + _r3c["gross"] == _t3["gross"] == D("136.43"),
   "three one-tin returns of a three-tin line add up exactly to 136.43 (completion by exact quantity)")
ok(r2(D("0.005")) == D("0.01") and r2(D("23.275")) == D("23.28"), "half-cent rounds up")

# ---- 3. delivery dates
cases = [
    ("2026-10-02T10:00", "2026-10-05"),  # Friday before cut-off -> Monday
    ("2026-10-02T19:00", "2026-10-06"),  # Friday after cut-off -> Tuesday
    ("2026-10-03T19:00", "2026-10-06"),  # Saturday (holiday) after cut-off -> Monday is next, Tuesday after
    ("2026-10-05T18:00", "2026-10-06"),  # exactly 18:00 counts as 'by 18:00'
    ("2026-12-23T12:00", "2026-12-24"),
    ("2026-12-24T12:00", "2026-12-28"),  # 25th/26th holidays, weekend
    ("2027-03-05T19:00", "2027-03-10"),  # Mon 8 March is a Berlin holiday
    ("2027-03-25T10:00", "2027-03-30"),  # Good Friday 26th, Easter Monday 29th
]
for now, exp in cases:
    got = expected(dt.datetime.fromisoformat(now))["earliest"].isoformat()
    ok(got == exp, f"earliest truck date for {now}: {got} == {exp}")
ok(expected(dt.datetime.fromisoformat("2026-10-02T10:00"))["latest"].isoformat() == "2026-10-16",
   "latest date 2026-10-02 + 14 = Fri 2026-10-16")
ok(expected(dt.datetime.fromisoformat("2026-10-02T10:00"))["pickup_saturday"].isoformat() == "2026-10-10",
   "first pickup Saturday after 2026-10-02 skips German Unity Day (Sat 2026-10-03) -> 2026-10-10")
ok(dt.date(2027, 3, 26) in berlin_holidays(2027) and dt.date(2028, 4, 14) in berlin_holidays(2028),
   "Good Friday 2027/2028")

print()
print("ALL OK" if not fails else f"{len(fails)} FAILED")
sys.exit(1 if fails else 0)
