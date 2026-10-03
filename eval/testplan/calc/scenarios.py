"""All numeric expectations used in testplan.md.  Each scenario has a name (cited in the plan as
[calc NAME.field]) and a short description.  Run print_scenarios.py to list everything."""
from decimal import Decimal as D
from collections import OrderedDict
from engine import compute, refund, r2, Line, invoices, early_payment_discount, rcur, bundle_split, bundle_availability, bundle_contents_value
from data import P, C

SCN = OrderedDict()   # name -> (description, OrderedDict(field -> value))


def scn(name, desc, values):
    assert name not in SCN, name
    SCN[name] = (desc, OrderedDict(values))


def cart(name, desc, customer, lines, code=None, method="pickup", extra=None, **kw):
    r = compute(customer, lines, code=code, method=method, **kw)
    v = OrderedDict()
    for i, l in enumerate(r["lines"], 1):
        v[f"L{i}_unit"] = l.unit_price
        v[f"L{i}_net"] = l.net
        v[f"L{i}_dep"] = l.deposit
    for k in ("goods", "auto", "code", "discounts", "merch_after", "deposits", "ship_fee", "surcharge",
              "shipping", "vat7", "vat19", "vat", "net_total", "gross"):
        v[k] = r[k]
    v["free_balsamic"] = r["free_balsamic"]
    v["code_applied"] = r["code_applied"]
    v["min_ok"] = r["min_ok"]
    v["currency"] = r.get("currency", "EUR")
    if extra:
        v.update(extra(r))
    lines_txt = ", ".join(f"{l.qty} x {l.sku} {l.unit}" for l in r["lines"] if not l.free)
    scn(name, f"{desc} | {customer} | {lines_txt}" + (f" | code {code}" if code else "") + f" | {method}", v)
    return r


# ------------------------------------------------------------------ plain catalog / account data
scn("D_CAT", "Catalog facts read directly from specs/products.md", dict(
    WAT001_bottle=P["WAT-001"].units["bottle"].price,
    WAT001_dep_bottle=P["WAT-001"].dep_base,
    WAT001_dep_crate=P["WAT-001"].units["crate"].crate_dep,
    JUI003_litre=P["JUI-003"].units["l"].price,
    WAT002_crate=P["WAT-002"].units["crate"].price,
    WAT002_crate_per_bottle=r2(P["WAT-002"].units["crate"].price / 18),
    SOFT001_tier10=P["SOFT-001"].units["tray"].tiers[1][1],
    SOFT001_tier50=P["SOFT-001"].units["tray"].tiers[2][1],
    SAU001=P["SAU-001"].units["carton"].price, SAU002=P["SAU-002"].units["bucket"].price,
    SAU003=P["SAU-003"].units["bucket"].price, SAU004=P["SAU-004"].units["bottle"].price,
))
scn("D_CUST", "Customer account facts from specs/customers.md", dict(
    C10003_limit=C["C-10003"].credit_limit, C10003_balance=C["C-10003"].open_balance,
    C10003_headroom=C["C-10003"].credit_limit - C["C-10003"].open_balance,
    C10004_balance=C["C-10004"].open_balance,
))
scn("D_STOCK", "Stock arithmetic in base units (specs/products.md, business-rules.md Stock)", dict(
    WAT001=137, WAT001_crate=24, WAT001_after_1crate=137 - 24, WAT001_after_6crates=6 * 24,
    WAT001_5crates_2boxes=5 * 24 + 2 * 6,
    SPI004_12c_3p=12 * 80 + 3 * 20, SPI004_stock=1000,
    COF003_sellable=120, COF003_try=10 * 12 + 1,
    DAI001_sellable=360,
    SOFT002_stock=36, SOFT002_2trays=48, SOFT002_backordered=48 - 36,
    BEER005_stock=8, BEER005_order=10, BEER005_backordered=10 - 8,
    FRZ006_order=3, FRZ006_received=50, FRZ006_free_after=50 - 3,
    WAT002_stock=2400, WAT002_threshold=2500, WAT002_4pallets=4 * 720,
))

# ------------------------------------------------------------------ S01 product page values (C-10007)
cart("PG_NEW", "Newly approved customer (group Standard) sees list price", "NEW", [("WAT-001", "bottle", 1)])
cart("PG_GASTRO", "C-10007 after staff moved it to group Gastronomy: 1.19 x 0.95 = 1.1305 -> 1.13", "C-10007-GASTRO",
     [("WAT-001", "bottle", 1)])
cart("PG_NEG", "Staff-added negotiated price is final", "C-10007-NEG", [("SAU-002", "bucket", 1)])

# ------------------------------------------------------------------ S03 pricing / packaging / deposits
cart("P01", "Nested packaging WAT-001: crate + box + bottle; deposits 24x0.15+1.50 + 6x0.15 + 0.15", "C-10007",
     [("WAT-001", "crate", 1), ("WAT-001", "box", 1), ("WAT-001", "bottle", 1)])
cart("P02", "Group discount on crate price, rounded: 28.56 x 0.95 = 27.132 -> 27.13; deposits not discounted",
     "C-10002", [("WAT-001", "crate", 2)])
cart("P03", "BEER-002 three nesting levels; six-pack carrier has no deposit", "C-10007",
     [("BEER-002", "crate", 1), ("BEER-002", "sixpack", 1), ("BEER-002", "bottle", 1)])
cart("P04", "SOFT-005 pack/case; case has no deposit, bottles 0.08 each", "C-10007",
     [("SOFT-005", "case", 1), ("SOFT-005", "pack", 1)])
cart("P05", "SPI-004 carton + pack, no deposit", "C-10007", [("SPI-004", "carton", 1), ("SPI-004", "pack", 1)])
cart("P07", "JUI-003 7.5 l -> 2 canisters", "C-10007", [("JUI-003", "l", "7.5")])
cart("P07b", "JUI-003 5.5 l -> 2 canisters (every started 5 l)", "C-10007", [("JUI-003", "l", "5.5")])
cart("P08", "CHE-001 2.5 kg", "C-10007", [("CHE-001", "kg", "2.5")])
cart("P08g", "CHE-001 2.5 kg for Gastronomy: 9.80x0.95=9.31/kg; 9.31x2.5=23.275 -> 23.28 (half-up)", "C-10002",
     [("CHE-001", "kg", "2.5")])
cart("P11", "SOFT-001 10 trays -> tier 13.92", "C-10007", [("SOFT-001", "tray", 10)])
cart("P13", "COF-001 3 cartons -> tier 99.00", "C-10007", [("COF-001", "carton", 3)])
cart("P14", "C-10001 negotiated COF-001 16.90/bag also inside cartons; no tier price", "C-10001",
     [("COF-001", "bag", 1), ("COF-001", "carton", 3)])
cart("P15", "C-10001 FRZ-001 single bag at normal pricing: 3.90x0.95=3.705 -> 3.71", "C-10001",
     [("FRZ-001", "bag", 1)])
cart("P16", "C-10001 negotiated keg (no group discount), keg deposit 30.00", "C-10001", [("BEER-004", "keg", 1)])
cart("P17", "C-10004 negotiated per-bottle / per-crate variants", "C-10004",
     [("WINE-005", "carton", 1), ("WAT-002", "crate", 1), ("WAT-002", "box", 1), ("SPI-005", "bottle", 1)])
cart("P18", "C-10003 negotiated CHE-002 22.00/kg x 1.5", "C-10003", [("CHE-002", "kg", "1.5")])
cart("P19", "Retail 3 %: 42.50 x 0.97 = 41.225 -> 41.23", "C-10006", [("OIL-001", "tin", 1)])
cart("P20", "Excluded product keeps list price for Key Account", "C-10004", [("SOFT-006", "tray", 1)])
cart("P22", "Mixed VAT rates, Gastronomy: OIL-001 2 tins (7 %) + WAT-001 crate (19 %)", "C-10002",
     [("OIL-001", "tin", 2), ("WAT-001", "crate", 1)])
cart("P23", "Milk 7 % vs oat drink 19 %", "C-10007", [("DAI-001", "case", 1), ("DAI-002", "case", 1)])
cart("P24", "Packaging switch: WAT-002 line changed from bottle to crate", "C-10007", [("WAT-002", "crate", 1)])

# ------------------------------------------------------------------ S04 promotions
cart("A01", "Beer 6-for-5: 6 crates, 1 free; deposits for all 6", "C-10007", [("BEER-001", "crate", 6)])
cart("A02", "Beer 6-for-5: 11 crates -> tier 15.20, 1 free", "C-10007", [("BEER-001", "crate", 11)])
cart("A05", "Prosecco Carton Deal, Gastronomy: 35.40x0.95=33.63; 2 cartons 67.26; 10 % = 6.726 -> 6.73", "C-10002",
     [("WINE-005", "carton", 2)])
cart("A07", "Negotiated WINE-005 (C-10004): no Prosecco deal", "C-10004", [("WINE-005", "carton", 2)])
cart("A08", "Free balsamic: goods value exactly 500.00", "C-10007",
     [("OIL-001", "carton", 3), ("SAU-001", "carton", 1), ("DRY-005", "pack", 1)])
cart("A10", "Same cart for Gastronomy: goods after group discount below 500 -> no free bottle", "C-10002",
     [("OIL-001", "carton", 3), ("SAU-001", "carton", 1), ("DRY-005", "pack", 1)])
cart("A11", "Beer 6-for-5 then BEER15 on the remaining 79.00", "C-10007", [("BEER-001", "crate", 6)], code="BEER15")
cart("C01", "WELCOME10 (Gastronomy): COF-002 2 cartons eligible, WINE-006 excluded", "C-10002",
     [("COF-002", "carton", 2), ("WINE-006", "bottle", 1)], code="WELCOME10")
cart("C03", "SAVE20 split across VAT rates: 90.30 @7 % / 119.70 @19 % -> 8.60 / 11.40", "C-10007",
     [("DRY-004", "carton", 7), ("WINE-004", "bib", 3)], code="SAVE20")
cart("C04", "SAVE20 cart after removing WINE-004: goods 90.30 < 200, code no longer applies", "C-10007",
     [("DRY-004", "carton", 7)], code="SAVE20")
cart("C05", "BEER15 Gastronomy: BEER-002 crate 19.68x0.95=18.696->18.70, x2 = 37.40 -> 15 % = 5.61", "C-10002",
     [("BEER-002", "crate", 2), ("WAT-001", "crate", 1)], code="BEER15")
cart("C06", "FROZEN10: FRZ-004 5 tubs (89.50) eligible, FIS-001 not", "C-10007",
     [("FRZ-004", "tub", 5), ("FIS-001", "pack", 1)], code="FROZEN10")
cart("C07", "FROZEN10: Frozen Foods goods 71.60 < 80 (fish does not count)", "C-10007",
     [("FRZ-004", "tub", 4), ("FIS-001", "pack", 2)], code="FROZEN10")
cart("C09", "ESPRESSO2 cap: 6 cartons = 36 bags, max 30 bags -> 60.00", "C-10007", [("COF-001", "carton", 6)],
     code="ESPRESSO2")
cart("C11", "KAESE1: 2.5 kg CHE-001 + 1.25 kg CHE-002", "C-10007",
     [("CHE-001", "kg", "2.5"), ("CHE-002", "kg", "1.25")], code="KAESE1")
cart("C12", "KAESE1 on negotiated CHE-002 (C-10003): not eligible", "C-10003", [("CHE-002", "kg", "2")], code="KAESE1")
cart("C13", "GASTRO25 (C-10002), goods 307.80", "C-10002", [("OIL-001", "carton", 2)], code="GASTRO25")
cart("C14", "KEYWINE12: WINE-001 carton 39.00x0.92=35.88 -> 12 % = 4.3056 -> 4.31; negotiated WINE-005 not eligible",
     "C-10004", [("WINE-001", "carton", 1), ("WINE-005", "carton", 1)], code="KEYWINE12")
cart("C15", "SHELF5 (Retail): SNK-001 box of 25 13.75x0.97=13.3375->13.34, x5 = 66.70 (>= 60) -> 5 % = 3.335 -> 3.34",
     "C-10006", [("SNK-001", "box", 5)], code="SHELF5")
cart("C17", "FIRST50 (C-10001): OIL-001 3 cartons, goods 461.70", "C-10001", [("OIL-001", "carton", 3)], code="FIRST50")
cart("C17b", "FIRST50 (C-10004): OIL-001 3 cartons", "C-10004", [("OIL-001", "carton", 3)], code="FIRST50")
cart("C17c", "FIRST50 (C-10007): OIL-001 3 cartons", "C-10007", [("OIL-001", "carton", 3)], code="FIRST50")
cart("C18", "B2B7 excludes Spirits: SPI-001 bottle + WINE-001 carton -> 7 % of 39.00 = 2.73", "C-10007",
     [("SPI-001", "bottle", 1), ("WINE-001", "carton", 1)], code="B2B7")
cart("C19", "TENOFF capped at Non-Food goods value 4.90", "C-10007", [("NF-001", "sleeve", 1)], code="TENOFF")
cart("C20", "Same cart as C03 with B2B7 instead of SAVE20 (one-code check)", "C-10007",
     [("DRY-004", "carton", 7), ("WINE-004", "bib", 3)], code="B2B7", strict=False)

# ------------------------------------------------------------------ S05 shipping / VAT
cart("SH02", "Truck fee charged: list 254.40 but goods after Gastronomy discount 241.68 < 250", "C-10002",
     [("OIL-001", "carton", 1), ("COF-002", "carton", 1)], method="truck")
cart("SH03", "Truck free: goods 254.40 >= 250", "C-10007", [("OIL-001", "carton", 1), ("COF-002", "carton", 1)],
     method="truck")
cart("SH04", "SAVE20 does not affect the free-shipping threshold (goods before promotions)", "C-10007",
     [("OIL-001", "carton", 1), ("COF-002", "carton", 1)], code="SAVE20", method="truck")
cart("SH01", "3 crates WAT-001: goods 85.68 < 100 although goods+deposits >= 100", "C-10007",
     [("WAT-001", "crate", 3)], method="truck")
cart("SH05", "Standard parcel bulky surcharge 3 x 8.50", "C-10007", [("DRY-002", "sack", 3), ("DRY-005", "pack", 1)],
     method="std")
cart("SH07", "FREESHIP on standard parcel: base fee waived, 6 bulky sacks still charged", "C-10007",
     [("DRY-002", "sack", 6), ("DRY-005", "pack", 1)], code="FREESHIP", method="std")
cart("SH09", "Express fee 19.90; FREESHIP not valid for express", "C-10007", [("OIL-001", "carton", 1)],
     code="FREESHIP", method="express")
cart("SH09b", "EXPRESSHALF: 19.90 -> 9.95", "C-10007", [("OIL-001", "carton", 1)], code="EXPRESSHALF",
     method="express")
cart("SH10", "Express never free: goods 486.00", "C-10007", [("OIL-001", "carton", 3)], method="express")
cart("SH11", "Reverse charge C-10005, EU Parcel", "C-10005", [("OIL-001", "carton", 2)], method="eu")
cart("SH12", "C-10006 (NL, no VAT ID, Retail 3 %): German VAT, EU Parcel", "C-10006", [("OIL-001", "carton", 2)],
     method="eu")
cart("SH14", "EU Parcel free from 750.00", "C-10005", [("OIL-001", "carton", 5)], method="eu")
cart("SH15", "Truck; 7 % goods + SOFT-002 tray (19 %, deposits); fee split across both rates", "C-10007",
     [("COF-002", "carton", 1), ("TEA-001", "box", 2), ("SOFT-002", "tray", 1)], method="truck")

# ------------------------------------------------------------------ S07 payments
cart("PA01", "C-10003 credit headroom 150.00: 12 x SAU-002 (11.90x0.97=11.543->11.54)", "C-10003",
     [("SAU-002", "bucket", 12)])
cart("PA02", "C-10003 13 x SAU-002 exceeds headroom", "C-10003", [("SAU-002", "bucket", 13)])

# ------------------------------------------------------------------ S08 orders
cart("O01", "First order C-10007", "C-10007", [("WAT-002", "crate", 1), ("OIL-001", "tin", 1)])
o03 = cart("O03", "C-10001 backorder BEER-005 10 kegs (8 in stock) + WAT-001 crate, WELCOME10, truck free >= 250",
           "C-10001", [("BEER-005", "keg", 10), ("WAT-001", "crate", 1)], code="WELCOME10", method="truck")
_inv = invoices(o03, [{0: 8, 1: 1, 2: 1}, {0: 2}])
scn("O03i1", "O03 first invoice: 8 kegs + WAT-001 crate + free OIL-004; discount share rounded per invoice", _inv[0])
scn("O03i2", "O03 second invoice: 2 kegs; takes the remaining discount", _inv[1])
cart("O04", "C-10004 order before staff cancels the WAT-001 line", "C-10004",
     [("OIL-001", "tin", 2), ("WAT-001", "crate", 1)])
cart("O04b", "C-10004 order after staff cancelled the WAT-001 line", "C-10004", [("OIL-001", "tin", 2)])
cart("O05", "Catch-weight CHE-006 at estimated 3.0 kg", "C-10007", [("CHE-006", "wheel", 1)])
cart("O05a", "Catch-weight CHE-006 invoiced at actual 3.2 kg: 12.90 x 3.2 = 41.28", "C-10007",
     [Line("CHE-006", "wheel", 1, actual_weight="3.2")], actual=True)
cart("O07", "Substitution: SOFT-002 tray, substitute SOFT-001 tray has the same price and deposits", "C-10007",
     [("SOFT-002", "tray", 1)])
cart("O07s", "Same order priced with SOFT-001 (must not exceed O07)", "C-10007", [("SOFT-001", "tray", 1)])

# ------------------------------------------------------------------ S10 returns
r01 = cart("R01", "WELCOME10 order for returns: 2 kegs BEER-004 + 2 tins OIL-001 + 1 WAT-001 crate, truck free", "C-10007",
           [("BEER-004", "keg", 2), ("OIL-001", "tin", 2), ("WAT-001", "crate", 1)], code="WELCOME10", method="truck")
rf = refund(r01, {0: 1, 1: 1})
scn("RF1", "Refund 1 keg + 1 tin of R01: paid net after 10 % share + keg deposit + VAT per rate", rf)
rf2 = refund(r01, {1: 1})
scn("RF2", "Partial approval: refund only 1 tin of R01", rf2)
r04 = cart("R04", "C-10001 invoice order: 2 tins OIL-001 (42.50x0.95=40.375->40.38)", "C-10001",
           [("OIL-001", "tin", 2)])
scn("RF4", "Refund 1 tin of R04", refund(r04, {0: 1}))
r05 = cart("R05", "C-10002 order of 1 tin OIL-001, fully returned", "C-10002", [("OIL-001", "tin", 1)])
scn("RF5", "Full refund of R05", refund(r05, {0: 1}))
_emp = r2(24 * P["WAT-001"].dep_base + P["WAT-001"].units["crate"].crate_dep)
scn("EMP", "Empties credit: 1 WAT-001 crate with 24 bottles", dict(net=_emp, gross=r2(_emp * D("1.19"))))

# ------------------------------------------------------------------ S11 admin
scn("AD", "Values typed by staff in S11 (inputs; listed so the plan has no bare numbers)", dict(
    test_price=D("2.00"), wat003_new=D("7.56"), nf003_tier=D("3.40"), neg_sau002=D("10.00"),
    testfive=D("5.00"), truck_fee_new=D("17.00"), c10002_limit=D("1000.00")))
import os as _os, re as _re
_names = _re.findall(r"^### (.+)$", open(_os.path.join(_os.environ.get("ONESHOTSHOP_SPECS",
                     "/Users/fabianwesner/Herd/oneshotshop/specs"), "products.md"), encoding="utf-8").read(), _re.M)
scn("D_ADM", "Admin back-office checks (S11): first product by name; staff-entered prices", dict(
    first_by_name=sorted(_names, key=str.lower)[0], products_total=len(_names),
    wat002_box_old=P["WAT-002"].units["box"].price, wat002_box_new=D("6.90"),
    sau003_neg=D("3.00"), sau003_group=r2(P["SAU-003"].units["bucket"].price * D("0.95"))))
scn("AD07t", "NF-003 10 packs at the staff-added tier price 3.40", dict(line=r2(D("3.40") * 10)))
cart("AD19", "C-10004 truck order below 250 after staff set the truck fee to 17.00", "C-10004",
     [("OIL-001", "carton", 1)], method="truck", ship_fee_override="17.00")
cart("AD16", "TESTFIVE on C-10007 cart", "C-10007", [("NF-003", "pack", 2)], code="TESTFIVE")

# ------------------------------------------------------------------ S12 reporting
ra = cart("RA", "Report order A (C-10007): WAT-001 2 crates + OIL-004 1 bottle", "C-10007",
          [("WAT-001", "crate", 2), ("OIL-004", "bottle", 1)])
rb = SCN["C05"]
rbr = compute("C-10002", [("BEER-002", "crate", 2), ("WAT-001", "crate", 1)], code="BEER15")
scn("REP", "Sales report after orders RA and C05 (both shipped, pickup, no shipping fees)", dict(
    net=ra["merch_after"] + rbr["merch_after"],
    net_incl_deposits=ra["merch_after"] + rbr["merch_after"] + ra["deposits"] + rbr["deposits"],
    vat=ra["vat"] + rbr["vat"],
    deposits=ra["deposits"] + rbr["deposits"],
    gross=ra["gross"] + rbr["gross"],
    c10007_net=ra["merch_after"], c10002_net=rbr["merch_after"],
    beer15_uses=1, beer15_discount=rbr["code"],
))

# ------------------------------------------------------------------ S13 variants, related, options, bundles,
# assortment, accessories, order lists
scn("D_VAR", "Variant facts (specs/products.md NF-005 / NF-007)", dict(
    NF007_26=P["NF-007-26"].units["pack"].price, NF007_33=P["NF-007-33"].units["pack"].price,
    NF007_33_stock=P["NF-007-33"].stock, NF007_30_stock=P["NF-007-30"].stock,
    NF007_26_stock=P["NF-007-26"].stock))
cart("V01", "Variant NF-007-30, 2 packs", "C-10007", [("NF-007-30", "pack", 2)])
cart("OPT1", "CTR-001 + extra cheese: 9.80 + 3.00", "C-10007", [Line("CTR-001", "pizza", 1, options=("cheese",))])
cart("OPT2", "CTR-001 + salami + gluten-free base: 9.80 + 2.00 + 4.00", "C-10007",
     [Line("CTR-001", "pizza", 1, options=("salami", "glutenfree"))])
cart("OPT3", "Gastronomy: (9.80 + 3.00) x 0.95 = 12.16", "C-10002", [Line("CTR-001", "pizza", 1, options=("cheese",))])
cart("OPT4", "Gastronomy: (9.80 + 2.00 + 4.00) x 0.95 = 15.01", "C-10002",
     [Line("CTR-001", "pizza", 1, options=("salami", "glutenfree"))])
cart("OPT5", "Separate lines for different option choices: 2 plain + 3 with extra cheese", "C-10007",
     [Line("CTR-001", "pizza", 2), Line("CTR-001", "pizza", 3, options=("cheese",))])
cart("B01", "Bundle BND-001 for Gastronomy: fixed price, contents' deposits, VAT split by content list prices",
     "C-10002", [("BND-001", "kit", 1)],
     extra=lambda r: dict(net19=bundle_split("BND-001")[D(19)], net7=bundle_split("BND-001")[D(7)]))
cart("B02", "Bundle BND-002 for Key Account: no group discount, VAT split", "C-10004", [("BND-002", "kit", 1)],
     extra=lambda r: dict(net19=bundle_split("BND-002")[D(19)], net7=bundle_split("BND-002")[D(7)]))
cart("B03", "WELCOME10 (C-10002, Gastronomy): bundle 62.00 counts toward the 100.00 minimum but is not discounted; tin 40.38", "C-10002",
     [("BND-002", "kit", 1), ("OIL-001", "tin", 1)], code="WELCOME10")
scn("D_BND", "Bundle facts: contents value, availability, content stock after one kit", dict(
    BND001_contents=bundle_contents_value("BND-001"), BND002_contents=bundle_contents_value("BND-002"),
    BND001_avail=bundle_availability("BND-001"), BND002_avail=bundle_availability("BND-002"),
    BND002_avail_plus1=bundle_availability("BND-002") + 1,
    CHE003_after_kit=P["CHE-003"].stock - 24, NF007_33_after_kit=P["NF-007-33"].stock - 1,
    BND002_avail_after_kit=bundle_availability("BND-002", {"CHE-003": P["CHE-003"].stock - 24,
                                                          "NF-007-33": P["NF-007-33"].stock - 1,
                                                          "FRZ-002": P["FRZ-002"].stock - 40,
                                                          "CAN-001": P["CAN-001"].stock - 2,
                                                          "VEG-007": P["VEG-007"].stock - 1}),
))
cart("EX1", "Exclusive WINE-008 for C-10004 (Key Account 8 %): 8.90 x 0.92 = 8.188 -> 8.19", "C-10004",
     [("WINE-008", "bottle", 1)])
cart("LIST1", "C-10001 order list 'Weekly bar order' added to the cart (JUI-005 skipped)", "C-10001",
     [("BEER-001", "crate", 5), ("SOFT-001", "tray", 2), ("BEER-004", "keg", 1), ("VEG-004", "lemon", 10)])

# ------------------------------------------------------------------ units, pallets, shipping VAT split
scn("D_OPT", "CTR-001 stock after an order of 2 + 3 pizzas", dict(stock=P["CTR-001"].stock,
    after=P["CTR-001"].stock - 5, try_=P["CTR-001"].stock - 5 + 1))
cart("U1", "CHE-001 3.15 kg (step 0.05 kg): 9.80 x 3.15", "C-10007", [("CHE-001", "kg", "3.15")])
cart("U2", "HERB-002 250 g = 0.25 kg at 12.00/kg", "C-10007", [("HERB-002", "kg", "0.25")])
cart("PAL1", "DAI-010 pallet: deposits 360x0.15 + 60x1.50 (7 %) + Euro pallet 15.00 (always 19 %)", "C-10007",
     [("DAI-010", "pallet", 1)])
cart("PAL2", "BEER-001 1 pallet + 6 single crates: only single crates count for the bonus", "C-10007",
     [("BEER-001", "pallet", 1), ("BEER-001", "crate", 6)])
cart("SHV", "Shipping split across rates: 15.00 x 92.40/131.40 = 10.55 (7 %), 4.45 (19 %)", "C-10007",
     [("COF-002", "carton", 1), ("WINE-001", "carton", 1)], method="truck",
     extra=lambda r: dict(ship7=r["ship7"], ship19=r["ship19"]))

cart("DS1", "B2B7 split across rates: 1.34 -> 0.335/1.005 -> 0.34 + 1.01 = 1.35; difference -0.01 to the larger 19 % share",
     "C-10007", [("VEG-004", "lemon", 15), ("NF-003", "pack", 4)], code="B2B7",
     extra=lambda r: dict(share7=sum(l.code for l in r["lines"] if l.p.vat == 7),
                          share19=sum(l.code for l in r["lines"] if l.p.vat == 19)))

# ------------------------------------------------------------------ S15 back-office, safety, storefront completeness
def _bev_visible_for_guests():
    import os, re
    t = open(os.path.join(os.environ.get("ONESHOTSHOP_SPECS", "/Users/fabianwesner/Herd/oneshotshop/specs"),
                          "products.md"), encoding="utf-8").read()
    n = 0
    for b in re.split(r"\n### ", t)[1:]:
        cat = re.search(r"^Category: (.+)$", b, re.M).group(1)
        if not (cat == "Beverages" or cat.startswith("Beverages › ")):
            continue
        if cat == "Beverages › Spirits" or "Restricted assortment" in b or "has been discontinued" in b:
            continue
        n += 1
    return n
scn("D_S15", "Storefront facts for S15", dict(beverages_for_guests=_bev_visible_for_guests()))
cart("RC", "Refund ceiling order: C-10007, 1 tin OIL-001, pickup, card", "C-10007", [("OIL-001", "tin", 1)])
cart("VU", "Austrian registrant, VAT ID not verified: German VAT; shipping follows the 7 % goods", "NEW-AT",
     [("OIL-001", "carton", 2)], method="eu")
cart("VV", "Same customer after staff verified the VAT ID: reverse charge", "NEW-AT-VERIFIED",
     [("OIL-001", "carton", 2)], method="eu")

# ================================================================== harder round: S16-S24
D_ = D
# ---- positive control for the restricted assortment (Gastronomy sees spirits)
cart("SPG", "C-10002 (Gastronomy) sees SPI-001: 18.90 x 0.95 = 17.955 -> 17.96", "C-10002", [("SPI-001", "bottle", 1)])
# ---- catch-weight capture vs authorisation (+15 % tolerance)
o05 = SCN["O05"][1]
cart("O05c", "Catch-weight CHE-006 actual 3.6 kg: 12.90 x 3.6 = 46.44 net", "C-10007",
     [Line("CHE-006", "wheel", 1, actual_weight="3.6")], actual=True)
scn("CAP", "Capture limits for the catch-weight card order (payments.md: authorised + 15 %)", dict(
    authorised=o05["gross"], limit=r2(o05["gross"] * D_("1.15")), capture_32=SCN["O05a"][1]["gross"],
    capture_36=SCN["O05c"][1]["gross"]))
# ---- credit-note discount share (audit): RF2 shows the tin's share only
scn("RF2D", "Credit note of RF2: discount share of the refunded tin vs. the whole order discount", dict(
    line_share=refund(r01, {1: 1})["discount"], whole=SCN["R01"][1]["code"]))
# ---- B2BW: approvals
cart("AP1", "Buyer Mehmet (budget 500.00): 4 OIL-001 cartons + 3 CAN-006 jars -> above budget", "C-10001",
     [("OIL-001", "carton", 4), ("CAN-006", "jar", 3)])
cart("AP2", "Buyer Mehmet within budget: 1 OIL-001 tin", "C-10001", [("OIL-001", "tin", 1)])
scn("BUD", "Budgets from customers.md", dict(mehmet=D_("500.00"), tobias=D_("1000.00")))
# ---- B2BW: quotes
from data import Customer as _Cu
C["C-10007-Q"] = _Cu("C-10007", "Spaetkauf am Kanal UG", "Standard", "0", neg={"SOFT-001": ("unit", "tray", D_("13.00"))})
cart("Q0", "Quote request: 10 SOFT-001 trays at the customer's own price (tier 13.92)", "C-10007", [("SOFT-001", "tray", 10)])
cart("Q1", "Accepted quote SQ-10001: 10 trays at the quoted 13.00, deposits as usual", "C-10007-Q", [("SOFT-001", "tray", 10)])
cart("Q1b", "Accepted quote + B2B7: the quoted line is not eligible", "C-10007-Q", [("SOFT-001", "tray", 10)], code="B2B7")
scn("QIN", "Quote inputs typed by staff", dict(price=D_("13.00")))
# ---- B2BW: standing order
cart("STO1", "Standing order occurrence: 7 BEER-001 crates, truck, at then-valid prices (1 free crate)", "C-10007",
     [("BEER-001", "crate", 7)], method="truck")
# ---- FIN: early-payment discount (C-10004, 2 % within 10 days)
ed1 = cart("ED1", "C-10004 invoice order: 2 OIL-001 tins (7 %) + 1 WINE-001 carton (19 %), pickup", "C-10004",
           [("OIL-001", "tin", 2), ("WINE-001", "carton", 1)])
scn("ED1d", "Early-payment discount 2 % of ED1 and VAT correction per rate", early_payment_discount(ed1, "0.02"))
# ---- FIN: partial payment, dunning
scn("PART", "Partial payment of 50.00 on the R04-type invoice (C-10001, 2 tins)", dict(
    gross=SCN["R04"][1]["gross"], paid=D_("50.00"), remaining=SCN["R04"][1]["gross"] - D_("50.00")))
scn("DUN", "Dunning run for C-10009 (customers.md legacy invoices; business-rules.md)", dict(
    fee1=D_("5.00"), fee2=D_("10.00"), balance_before=D_("1240.00"), balance_after=D_("1240.00") + D_("5.00") + D_("10.00")))
# ---- FIN: bank transfers and credit balance
pp = SCN["RC"][1]   # 1 tin OIL-001 for C-10007, gross 45.48
scn("BT", "Bank transfers for a prepayment order of 1 OIL-001 tin (C-10007)", dict(
    gross=pp["gross"], over_paid=pp["gross"] + D_("10.00"), credit=D_("10.00"),
    under_paid=pp["gross"] - D_("5.00"), remaining=D_("5.00"), two_orders=pp["gross"] * 2,
    dup_credit=D_("10.00") + pp["gross"], after_payout=D_("0.00")))
scn("SPLIT", "Order of 1 OIL-001 tin paid with 10.00 credit balance + card; full refund split back", dict(
    gross=pp["gross"], credit_used=D_("10.00"), card=pp["gross"] - D_("10.00"),
    refund_credit=D_("10.00"), refund_card=pp["gross"] - D_("10.00")))
# ---- INTL
cart("X1", "C-10010 (CH, Gastronomy): OIL-001 tin 40.38 EUR x 0.95 = 38.361 -> CHF 38.35", "C-10010", [("OIL-001", "tin", 1)])
x2 = cart("X2", "C-10010: 2 OIL-001 cartons, International Freight CHF 45.00, export 0 %", "C-10010",
          [("OIL-001", "carton", 2)], method="intl")
cart("X3", "C-10011 (UK, Retail): 2 OIL-001 cartons, 157.14 EUR x 0.86 = GBP 135.14, freight GBP 39.00", "C-10011",
     [("OIL-001", "carton", 2)], method="intl")
cart("X4", "C-10010: 1 OIL-001 carton = CHF 146.20 < minimum CHF 250.00", "C-10010", [("OIL-001", "carton", 1)], method="intl")
cart("X5", "C-10010 after the CHF rate changed to 0.97: OIL-001 tin 40.38 x 0.97 = 39.1686 -> 39.15", "C-10010",
     [("OIL-001", "tin", 1)], rate="0.97")
cart("X6", "C-10011: OIL-001 tin 41.23 EUR x 0.86 = 35.4578 -> GBP 35.46", "C-10011", [("OIL-001", "tin", 1)])
scn("FX", "Fixed rates and EUR equivalents (business-rules.md)", dict(
    chf=D_("0.95"), gbp=D_("0.86"), chf_new=D_("0.97"), x2_eur=r2(x2["gross"] / D_("0.95"))))
# ---- RET: partial cancellations and returns
cart("PC0", "C-10007 first order with WELCOME10: 2 OIL-001 tins + 3 TEA-001 boxes (goods 108.40)", "C-10007",
     [("OIL-001", "tin", 2), ("TEA-001", "box", 3)], code="WELCOME10")
cart("PC1", "After cancelling the TEA-001 line: goods 85.00 < 100 -> WELCOME10 removed", "C-10007",
     [("OIL-001", "tin", 2)], code="WELCOME10")
cart("PC2a", "C-10002: 1 OIL-001 tin + 2 FRZ-006 bags (backordered), pickup", "C-10002",
     [("OIL-001", "tin", 1), ("FRZ-006", "bag", 2)])
cart("PC2b", "Same order after staff cancelled the backordered FRZ-006 line", "C-10002", [("OIL-001", "tin", 1)])
rs = cart("RS0", "C-10007 order of 2 OIL-001 tins (card) for a mistaken-order return", "C-10007", [("OIL-001", "tin", 2)])
scn("RS1", "Return of 1 tin 'ordered by mistake': 10 % restocking fee before VAT", refund(rs, {0: 1}, restocking_pct="0.10"))
qa = cart("QA0", "C-10007 order of 1 WAT-001 crate for a quality-complaint return", "C-10007", [("WAT-001", "crate", 1)])
scn("QA1", "Quality complaint: full refund incl. deposits", refund(qa, {0: 1}))
cw = compute("C-10007", [Line("CHE-006", "wheel", 1, actual_weight="3.2")], actual=True)
scn("CW1", "Catch-weight return of 1.0 kg of the 3.2 kg wheel invoiced at 41.28 (12.90/kg)", refund(cw, {0: 1}, weight="1.0"))
# ---- FUL: warehouses (shipping.md, products.md)
scn("D_WH", "Warehouse stock and allocation (WH-BER first, then WH-BRB)", dict(
    beer_ber=1200, beer_brb=800, beer_order_crates=65, beer_alloc_ber_crates=1200 // 20,
    beer_alloc_brb_crates=65 - 1200 // 20, oil_ber=40, oil_brb=20, oil_transfer=20,
    oil_sellable_in_transit=40 + 20 - 20, oil_try=40 + 20 - 20 + 1, oil_sellable_after=60, oil_brb_after_restock=20 + 1,
    wine006_order=6))
cart("AL1", "C-10004: 65 BEER-001 crates, truck (tier 50+ = 14.60, Key Account 8 %)", "C-10004", [("BEER-001", "crate", 65)],
     method="truck")
