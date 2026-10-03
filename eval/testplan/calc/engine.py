"""Reference pricing engine implementing specs/business-rules.md, discounts.md and shipping.md.

Rules implemented (spec reference in brackets):
  * effective unit price: negotiated price (final) > tier price for the packaging unit (tier chosen by the
    total quantity of that packaging unit of that product in the cart) > customer-group discount applied to
    that unit price and rounded to the cent, unless the product is excluded [business-rules: Effective Price]
  * line net = unit price x quantity, rounded once per line [Rounding]
  * deposits per base unit + per packaging unit (crate/keg), volume deposits per started container;
    never discounted [Deposits]
  * goods value = merchandise net after group discounts, before promotions [Totals]
  * automatic promotions first (beer 6-for-5, Prosecco carton deal, free balsamic >= 500), then at most
    one code; a percentage code works on the eligible amount left after automatic promotions [discounts.md]
  * excluded products and negotiated-price lines are never eligible for promotions [discounts.md]
  * shipping fee/threshold/minimum/bulky surcharge per method, FREESHIP / EXPRESSHALF [shipping.md]
  * VAT per rate on summed net amounts: goods after discounts; packaging deposits at the product's rate;
    Euro-pallet deposits always 19 %; shipping fees/surcharges follow the goods (single rate -> that rate,
    several rates -> split in proportion to merchandise net per rate, shares rounded, difference to the
    largest share); order-level discounts split in proportion to the discounted net amount; reverse charge 0 %
  * bundles: fixed price, never discounted, net split across contents by list price for VAT
  * options: surcharges added to the list unit price before the group discount
  * all money rounded half-up to the cent
Discount and shipping splits across VAT rates round each share to the cent and give the rounding difference to
the largest share (business-rules.md). The engine raises Ambiguous if that largest share is tied, and refunds and
invoice splits raise if a per-line share is not cent-exact, so no plan value depends on an unstated rule.
"""
from decimal import Decimal as D, ROUND_HALF_UP, ROUND_FLOOR, ROUND_CEILING
from data import P, C, SHIP, RATES

CENT = D("0.01")
ZERO = D("0.00")


def r2(x):
    return D(x).quantize(CENT, rounding=ROUND_HALF_UP)


class Ambiguous(Exception):
    pass


class Line:
    def __init__(self, sku, unit, qty, actual_weight=None, options=()):
        self.sku, self.unit, self.qty = sku, unit, D(str(qty))
        self.options = tuple(options)
        self.actual_weight = D(str(actual_weight)) if actual_weight is not None else None
        self.p = P[sku]
        self.u = self.p.units[unit]
        self.free = False
        self.pallet_deposit = ZERO
        unknown = [o for o in self.options if o not in self.p.options]
        if unknown:
            raise ValueError(f"{sku}: unknown options {unknown}")
        if len([o for o in self.options if o in self.p.exclusive]) > 1:
            raise ValueError(f"{sku}: at most one of {sorted(self.p.exclusive)}")

    @property
    def key(self):
        return f"{self.sku}:{self.unit}"


# ---------------------------------------------------------------- codes
def _cat_in(line, cat):
    return line.p.cat == cat or line.p.cat.startswith(cat + " › ")


CODES = {
    "WELCOME10": dict(kind="pct", pct=D("0.10"), min=D("100.00")),
    "SAVE20": dict(kind="fixed", amount=D("20.00"), min=D("200.00")),
    "BEER15": dict(kind="pct", pct=D("0.15"), filter=lambda l: _cat_in(l, "Beverages › Beer")),
    "FROZEN10": dict(kind="pct", pct=D("0.10"), filter=lambda l: _cat_in(l, "Frozen Foods"),
                     cat_min=("Frozen Foods", D("80.00"))),
    "ESPRESSO2": dict(kind="per_unit", skus={"COF-001"}, per=D("2.00"), cap=D("30")),
    "KAESE1": dict(kind="per_unit", skus={"CHE-001", "CHE-002"}, per=D("1.00"), cap=None),
    "FREESHIP": dict(kind="ship", methods={"truck", "std"}, min=D("150.00")),
    "EXPRESSHALF": dict(kind="ship", methods={"express"}, half=True),
    "GASTRO25": dict(kind="fixed", amount=D("25.00"), min=D("250.00"), groups={"Gastronomy"}),
    "KEYWINE12": dict(kind="pct", pct=D("0.12"), filter=lambda l: _cat_in(l, "Beverages › Wine & Sparkling Wine"),
                      groups={"Key Account"}),
    "SHELF5": dict(kind="pct", pct=D("0.05"), filter=lambda l: _cat_in(l, "Snacks & Sweets"), min=D("60.00"),
                   groups={"Retail"}),
    "LINDNER2026": dict(kind="pct", pct=D("0.04"), customers={"C-10003"}),
    "FIRST50": dict(kind="fixed", amount=D("50.00"), min=D("400.00")),
    "B2B7": dict(kind="pct", pct=D("0.07"), filter=lambda l: not _cat_in(l, "Beverages › Spirits")),
    "TENOFF": dict(kind="fixed", amount=D("10.00"), filter=lambda l: _cat_in(l, "Non-Food & Disposables")),
    "TESTFIVE": dict(kind="fixed", amount=D("5.00")),   # created by staff in suite S11
}


def rcur(x, currency):
    """Round a money amount in the given currency: CHF to 0.05 (half up), others to 0.01."""
    if currency == "CHF":
        return (D(x) / D("0.05")).quantize(D("1"), rounding=ROUND_HALF_UP) * D("0.05")
    return r2(x)


def rm(x, cur):
    """Round a money amount to the rounding unit of the given transaction currency (always explicit)."""
    return rcur(x, cur)


def compute(customer, lines, code=None, method="pickup", ship_fee_override=None, actual=False, strict=True,
            rate=None):
    """Return a dict of all observable money values for a cart / order.

    actual=True prices catch-weight lines at their recorded actual weight (invoice after packing).
    strict is kept for compatibility; splits now follow the defined rounding rule.
    """
    cust = C[customer]
    inexact = []
    cur = cust.currency
    fx = D(str(rate)) if rate is not None else RATES[cust.currency]

    def conv(eur):
        """Convert an EUR base-data amount once into the transaction currency (business-rules.md)."""
        return eur if cust.currency == "EUR" else rm(D(eur) * fx, cur)
    lines = [Line(*l) if isinstance(l, tuple) else l for l in lines]
    res = {"lines": []}

    # ---- unit prices and line nets
    for l in lines:
        neg = cust.neg.get(l.sku)
        l.negotiated = False
        if neg and (neg[0] == "base" or neg[1] == l.unit):
            l.negotiated = True
            l.unit_price = neg[1] * l.u.base if neg[0] == "base" else neg[2]
        else:
            price = l.u.price + sum((l.p.options[o] for o in l.options), ZERO)
            if l.u.tiers:
                tq = sum(x.qty for x in lines if x.sku == l.sku and x.unit == l.unit)
                price = [p for m, p in l.u.tiers if tq >= m][-1]
            if not l.p.excluded and cust.pct:
                price = r2(price * (1 - cust.pct))
            l.unit_price = price
        if l.p.catch and not l.negotiated:   # price unit = kg (business-rules.md, Catch-Weight Products)
            per_kg_eur = l.p.catch[1] if (l.p.excluded or not cust.pct) else r2(l.p.catch[1] * (1 - cust.pct))
            l.per_kg = conv(per_kg_eur)
            l.unit_price = rm(l.p.catch[0] * l.per_kg, cur)
        elif cust.currency != "EUR":   # convert the EUR unit price after customer pricing, then round per currency
            l.unit_price = rm(r2(l.unit_price) * fx, cur)
        if l.p.catch and actual:
            l.net = rm(l.per_kg * l.actual_weight, cur)
        else:
            l.net = rcur(l.unit_price * l.qty, cust.currency)
        # deposits
        if l.p.volume_dep:
            per, dep = l.p.volume_dep
            containers = (l.qty / per).to_integral_value(rounding=ROUND_CEILING)
            l.containers = containers
            l.deposit = conv(r2(containers * dep))
        elif l.p.bundle:
            per_kit = sum((P[s].dep_base * P[s].units[u].base * q + P[s].units[u].crate_dep * P[s].units[u].crates * q
                           for s, u, q in l.p.bundle), ZERO)
            l.deposit = conv(r2(per_kit * l.qty))
        else:
            l.deposit = conv(r2(l.p.dep_base * l.u.base * l.qty + l.u.crate_dep * l.u.crates * l.qty
                                + l.u.pallet_dep * l.qty))
        # Euro-pallet deposits are a separate supply: always 19 % (business-rules.md, VAT)
        l.pallet_deposit = conv(r2(l.u.pallet_dep * l.qty)) if not l.p.bundle else ZERO
        l.eligible = not l.p.excluded and not l.negotiated
        l.auto = ZERO
        l.code = ZERO

    goods = sum((l.net for l in lines), ZERO)
    res["goods"] = goods

    # ---- automatic promotions
    auto_names = []
    for l in lines:
        if l.sku == "BEER-001" and l.unit == "crate" and l.eligible:
            free = (l.qty / 6).to_integral_value(rounding=ROUND_FLOOR)
            if free:
                l.auto += rm(free * l.unit_price, cur)
                auto_names.append("Beer Crate Bonus")
    prosecco_cartons = sum(l.qty for l in lines if l.sku == "WINE-005" and l.unit == "carton" and l.eligible)
    if prosecco_cartons >= 2:
        for l in lines:
            if l.sku == "WINE-005" and l.unit == "carton" and l.eligible:
                l.auto += rm(l.net * D("0.10"), cur)
        auto_names.append("Prosecco Carton Deal")
    if goods >= conv(D("500.00")):
        fl = Line("OIL-004", "bottle", 1)
        fl.free, fl.negotiated, fl.eligible = True, False, False
        fl.unit_price = fl.net = fl.deposit = fl.auto = fl.code = ZERO
        lines.append(fl)
        auto_names.append("Free Balsamic Vinegar")
    res["auto"] = sum((l.auto for l in lines), ZERO)
    res["auto_names"] = auto_names
    res["free_balsamic"] = any(l.free for l in lines)

    # ---- promotion code
    code_disc = ZERO
    ship_code = None
    res["code_applied"] = False
    if code:
        spec = CODES[code]
        ok = True
        if "groups" in spec and cust.group not in spec["groups"]:
            ok = False
        if "customers" in spec and cust.no not in spec["customers"]:
            ok = False
        if "min" in spec and goods < conv(spec["min"]):
            ok = False
        if "cat_min" in spec:
            cat, mn = spec["cat_min"]
            if sum((l.net for l in lines if _cat_in(l, cat)), ZERO) < conv(mn):
                ok = False
        if spec["kind"] == "ship" and method not in spec["methods"]:
            ok = False
        if ok:
            res["code_applied"] = True
            flt = spec.get("filter", lambda l: True)
            elig = [l for l in lines if l.eligible and flt(l)]
            if spec["kind"] in ("pct", "fixed"):
                base = sum((l.net - l.auto for l in elig), ZERO)
                if spec["kind"] == "pct":
                    code_disc = rm(base * spec["pct"], cur)
                    shares = {l: l_net * spec["pct"] for l, l_net in ((l, l.net - l.auto) for l in elig)}
                else:
                    code_disc = min(conv(spec["amount"]), base)
                    shares = {l: code_disc * (l.net - l.auto) / base for l in elig} if base else {}
                _allocate(shares, code_disc, strict, inexact, cur)
            elif spec["kind"] == "per_unit":
                units = sum((l.u.base * l.qty for l in elig if l.sku in spec["skus"]), D(0))
                if spec["cap"] is not None:
                    units = min(units, spec["cap"])
                tgt = [l for l in elig if l.sku in spec["skus"]]
                base = sum((l.net - l.auto for l in tgt), ZERO)
                code_disc = min(rm(units * conv(spec["per"]), cur), base)
                shares = {l: code_disc * (l.net - l.auto) / base for l in tgt} if base else {}
                _allocate(shares, code_disc, strict, inexact, cur)
            elif spec["kind"] == "ship":
                ship_code = spec
    res["code"] = code_disc
    res["discounts"] = res["auto"] + code_disc
    merch = sum((l.net - l.auto - l.code for l in lines), ZERO)
    res["merch_after"] = merch
    deposits = sum((l.deposit for l in lines), ZERO)
    res["deposits"] = deposits

    # ---- shipping
    m = SHIP[method if method != "intl" else "intl-" + cust.currency]
    fee = m["fee"] if ship_fee_override is None else D(ship_fee_override)
    if m["free_at"] is not None and goods >= m["free_at"]:
        fee = ZERO
    if ship_code:
        if ship_code.get("half"):
            fee = rm(fee * D("0.5"), cur)
        else:
            fee = ZERO
    bulky_items = sum((l.qty for l in lines if l.u.bulky), D(0))
    surcharge = rm(bulky_items * m["bulky"], cur)
    res["ship_fee"], res["surcharge"] = fee, surcharge
    res["shipping"] = fee + surcharge
    res["min_ok"] = goods >= m["min"]
    res["ship_code_applied"] = bool(ship_code)

    # ---- VAT
    bases = {D(7): ZERO, D(19): ZERO}
    goods_by_rate = {D(7): ZERO, D(19): ZERO}     # merchandise net after discounts, without deposits
    for l in lines:
        if l.p.bundle:
            for rate, share in bundle_split(l.p.sku).items():
                bases[rate] += share * l.qty
                goods_by_rate[rate] += share * l.qty
            for s_, u_, q_ in l.p.bundle:     # deposits of the contents at the content's rate
                bases[P[s_].vat] += r2((P[s_].dep_base * P[s_].units[u_].base * q_
                                        + P[s_].units[u_].crate_dep * P[s_].units[u_].crates * q_) * l.qty)
            if l.auto or l.code:
                raise Ambiguous("bundles are never discounted")
            continue
        m_ = l.net - l.auto - l.code
        bases[l.p.vat] += m_ + l.deposit - l.pallet_deposit
        bases[D(19)] += l.pallet_deposit
        goods_by_rate[l.p.vat] += m_
    # shipping follows the goods: single rate -> that rate; several -> proportional split, each share rounded,
    # rounding difference to the largest share
    ship_split = split_by_rates(res["shipping"], goods_by_rate, cur)
    for rate, sh in ship_split.items():
        bases[rate] += sh
    res["ship7"], res["ship19"] = ship_split.get(D(7), ZERO), ship_split.get(D(19), ZERO)
    vat = {}
    for rate, b in bases.items():
        vat[rate] = ZERO if (cust.reverse_charge or cust.export) else rm(b * rate / 100, cur)
    res["net7"], res["net19"] = bases[D(7)], bases[D(19)]
    res["vat7"], res["vat19"] = vat[D(7)], vat[D(19)]
    res["vat"] = vat[D(7)] + vat[D(19)]
    res["net_total"] = merch + deposits + res["shipping"]
    res["gross"] = res["net_total"] + res["vat"]
    if inexact:
        for k in ("vat7", "vat19", "vat", "gross", "net7", "net19"):
            res[k] = None
    res["lines"] = lines
    res["customer"] = customer
    res["currency"] = cust.currency
    res["zero_vat"] = bool(cust.reverse_charge or cust.export)
    res["vat_bases"] = bases
    return res


def _allocate(shares, total, strict=True, inexact=None, cur="EUR"):
    """Split a code discount across lines (business-rules.md, VAT): first across VAT rates in proportion to the
    discounted net amount per rate (each share rounded, difference to the largest share), then within a rate
    across its lines the same way (only needed for refunds, which check exactness themselves)."""
    lines = list(shares)
    weights = {}
    for l in lines:
        weights.setdefault(l.p.vat, ZERO)
        weights[l.p.vat] += l.net - l.auto
    rate_shares = split_by_rates(total, weights, cur)
    for rate, rs in rate_shares.items():
        rl = [l for l in lines if l.p.vat == rate]
        lw = {l: l.net - l.auto for l in rl}
        tot = sum(lw.values())
        parts = {l: rm(rs * w / tot, cur) for l, w in lw.items()} if tot else {}
        diff = rs - sum(parts.values())
        if diff and parts:   # largest share; tie -> the line listed first (business-rules.md, Rounding)
            order = {l: n for n, l in enumerate(rl)}
            parts[max(parts, key=lambda x: (parts[x], -order[x]))] += diff
        for l, v in parts.items():
            l.code += v


def _rate_vat(order_res, rate, base):
    return ZERO if order_res.get("zero_vat") else rm(base * rate / 100, order_res.get("currency"))


def refund(order_res, returns, restocking_pct=None, weight=None, previous=None, containers=None):
    """Refund for returned quantities (business-rules.md, Refunds): net actually paid after the line's share of
    all discounts, minus a restocking fee, plus deposits (Euro-pallet deposits at 19 %), plus VAT per rate using the
    order's VAT treatment (0 % for reverse charge and export). weight = returned kg of a catch-weight line (refund in
    proportion to the invoiced weight). previous = {line_index: earlier refunds dict} for the residual rule: the part
    that completes a line refunds what was paid for it minus what was refunded before. returns = {line_index: qty}."""
    cur = order_res.get("currency", "EUR")
    out = {"net": ZERO, "deposits": ZERO, "discount": ZERO}
    bases = {D(7): ZERO, D(19): ZERO}
    fixed_vat = {D(7): ZERO, D(19): ZERO}   # VAT of residual parts: line VAT minus VAT refunded before
    for idx, qty in returns.items():
        l = order_res["lines"][idx]
        amount = D(str(weight)) if weight is not None else D(str(qty))
        total_amount = l.actual_weight if weight is not None else D(str(l.qty))
        frac = amount / total_amount
        line_paid = l.net - l.auto - l.code
        prev = (previous or {}).get(idx)     # cumulative record of all earlier refunds of this line
        before = prev["qty_cum"] if prev else ZERO
        residual = prev is not None and before + amount == total_amount     # exact quantities, no rounded fractions
        if residual:     # completes the line: the entitlement left (before fees) of the line
            paid, dep, pal = line_paid - prev["entitled"], l.deposit - prev["dep"], l.pallet_deposit - prev["pal"]
            disc = l.code - prev["disc"]
        else:
            paid, dep, pal = rm(line_paid * frac, cur), rm(l.deposit * frac, cur), rm(l.pallet_deposit * frac, cur)
            disc = rm(l.code * frac, cur)
        if containers is not None and l.p.volume_dep:   # deposits per returned container, not per volume
            per_container = l.deposit / l.containers
            dep = rm(per_container * containers, cur)
        entitled = paid
        out["discount"] += disc
        fee = ZERO
        if restocking_pct is not None:
            fee = rm(paid * D(str(restocking_pct)), cur)
            out["restocking_fee"] = out.get("restocking_fee", ZERO) + fee
            paid -= fee
        out["net"] += paid
        out["deposits"] += dep
        part_base = {l.p.vat: paid + dep - pal}
        part_base[D(19)] = part_base.get(D(19), ZERO) + pal
        cum_base = {r_: v + (prev or {}).get("cbase", {}).get(r_, ZERO) for r_, v in part_base.items()}
        if residual:
            # completes the line: VAT on everything actually credited for the line (after retained fees, only the
            # containers returned) minus the VAT refunded before
            part_vat = {r_: _rate_vat(order_res, r_, b) - prev["vat"].get(r_, ZERO) for r_, b in cum_base.items()}
            for r_, v in part_vat.items():
                fixed_vat[r_] += v
        else:
            bases[l.p.vat] += paid + dep - pal
            bases[D(19)] += pal
            part_vat = {l.p.vat: _rate_vat(order_res, l.p.vat, paid + dep - pal)}
            part_vat[D(19)] = part_vat.get(D(19), ZERO) + _rate_vat(order_res, D(19), pal)
        pv = (prev or {}).get("vat", {})
        cum_vat = {r_: pv.get(r_, ZERO) + part_vat.get(r_, ZERO) for r_ in set(pv) | set(part_vat)}
        # cumulative over all refunds of the line so far: pass it as previous= to the next refund
        out.setdefault("parts", {})[idx] = {
            "qty_cum": before + amount, "paid": paid, "fee": fee,
            "entitled": (prev or {}).get("entitled", ZERO) + entitled, "dep": (prev or {}).get("dep", ZERO) + dep,
            "pal": (prev or {}).get("pal", ZERO) + pal, "disc": (prev or {}).get("disc", ZERO) + disc,
            "vat": cum_vat, "cbase": cum_base}
    out["vat7"] = _rate_vat(order_res, D(7), bases[D(7)]) + fixed_vat[D(7)]
    out["vat19"] = _rate_vat(order_res, D(19), bases[D(19)]) + fixed_vat[D(19)]
    out["vat"] = out["vat7"] + out["vat19"]
    out["gross"] = out["net"] + out["deposits"] + out["vat"]
    return out


def bundle_split(sku):
    """Net bundle price per kit split by VAT rate: shares proportional to content list prices, each rounded
    to the cent, rounding difference to the content with the largest share (business-rules.md, Bundles)."""
    p = P[sku]
    price = p.units["kit"].price
    vals = [(s, P[s].units[u].price * q) for s, u, q in p.bundle]
    total = sum(v for _, v in vals)
    shares = [[s, r2(price * v / total)] for s, v in vals]
    diff = price - sum(x[1] for x in shares)
    if diff:
        max(shares, key=lambda x: x[1])[1] += diff
    out = {}
    for s, sh in shares:
        out[P[s].vat] = out.get(P[s].vat, ZERO) + sh
    return out


def bundle_contents_value(sku):
    return sum((P[s].units[u].price * q for s, u, q in P[sku].bundle), ZERO)


def bundle_availability(sku, stock=None):
    """Complete bundles the sellable stock of the contents allows. stock: optional overrides {sku: base units}."""
    stock = stock or {}
    return min(int(stock.get(s, P[s].stock) // (P[s].units[u].base * q)) for s, u, q in P[sku].bundle)


def split_by_rates(amount, weights, cur):
    """Split amount across VAT rates in proportion to weights (business-rules.md, VAT: shipping)."""
    w = {k: v for k, v in weights.items() if v > 0}
    if not amount or not w:
        return {}
    if len(w) == 1:
        return {next(iter(w)): amount}
    total = sum(w.values())
    shares = {k: rm(amount * v / total, cur) for k, v in w.items()}
    diff = amount - sum(shares.values())
    if diff:   # largest share; tie -> the higher VAT rate (business-rules.md, Rounding)
        shares[max(shares, key=lambda k: (shares[k], k))] += diff
    return shares


def invoices(order_res, shipments):
    """One invoice per shipment (business-rules.md, Order Numbers and Documents): each covers exactly the goods
    and deposits shipped; the first also carries shipping fees/surcharges. Code discounts come from each eligible
    line's frozen share for the invoiced quantity (the last invoice of a line takes the rest); VAT per invoice; the
    last invoice of the order is adjusted so that all invoices equal the order's VAT per rate.
    shipments = [{line_index: qty}, ...]."""
    cur = order_res.get("currency", "EUR")
    lines = order_res["lines"]
    shipped = {n: D(0) for n in range(len(lines))}
    alloc_disc = {n: ZERO for n in range(len(lines))}
    alloc_merch = {n: ZERO for n in range(len(lines))}
    out = []
    vat_sum = {D(7): ZERO, D(19): ZERO}
    for k, sh in enumerate(shipments):
        last = k == len(shipments) - 1
        merch, deps, disc_total = ZERO, ZERO, ZERO
        base = {D(7): ZERO, D(19): ZERO}
        goods_after = {}
        for idx, qty in sh.items():
            l = lines[idx]
            if l.p.bundle:
                raise Ambiguous("bundles not supported in invoice split")
            q = D(str(qty))
            shipped[idx] += q
            # the invoice that completes a line takes the line's merchandise minus what earlier invoices took
            m_ = rm((l.net - l.auto) * q / l.qty, cur) if shipped[idx] < l.qty else (l.net - l.auto) - alloc_merch[idx]
            alloc_merch[idx] += m_
            d_ = l.code - alloc_disc[idx] if shipped[idx] == l.qty else rm(l.code * q / l.qty, cur)
            alloc_disc[idx] += d_
            dep = rm(l.deposit * q / l.qty, cur)
            pal = rm(l.pallet_deposit * q / l.qty, cur)
            merch += m_
            disc_total += d_
            deps += dep
            base[l.p.vat] += m_ - d_ + dep - pal
            base[D(19)] += pal
            goods_after[l.p.vat] = goods_after.get(l.p.vat, ZERO) + m_ - d_
        ship = order_res["shipping"] if k == 0 else ZERO
        for r_, v in split_by_rates(ship, goods_after, cur).items():
            base[r_] += v
        vat = {r_: _rate_vat(order_res, r_, base[r_]) for r_ in (D(7), D(19))}
        if last:   # reconcile VAT rounding with the order's totals
            for r_ in vat:
                vat[r_] = (order_res["vat7"] if r_ == D(7) else order_res["vat19"]) - vat_sum[r_]
        for r_ in vat:
            vat_sum[r_] += vat[r_]
        inv = dict(merch=merch, discount=disc_total, deposits=deps, shipping=ship, vat7=vat[D(7)], vat19=vat[D(19)])
        inv["gross"] = merch - disc_total + deps + ship + vat[D(7)] + vat[D(19)]
        out.append(inv)
    return out


def early_payment_discount(order_res, pct):
    """business-rules.md, Payment Terms: discount on the gross total without deposits and their VAT; split per
    rate in proportion to the gross amounts per rate (without deposits); VAT correction = share x rate/(100+rate);
    no VAT correction for reverse-charge and export invoices."""
    cur = order_res.get("currency", "EUR")
    goods = {}
    for l in order_res["lines"]:
        goods[l.p.vat] = goods.get(l.p.vat, ZERO) + l.net - l.auto - l.code
    sh = split_by_rates(order_res["shipping"], goods, cur)
    gross = {}
    for r_ in (D(7), D(19)):
        net = goods.get(r_, ZERO) + sh.get(r_, ZERO)
        gross[r_] = net + _rate_vat(order_res, r_, net)
    base = sum(gross.values(), ZERO)
    disc = rm(base * D(str(pct)), cur)
    shares = split_by_rates(disc, gross, cur)
    corr = {r_: (ZERO if order_res.get("zero_vat") else rm(v * r_ / (100 + r_), cur)) for r_, v in shares.items()}
    return dict(base=base, discount=disc, payable=order_res["gross"] - disc,
                share7=shares.get(D(7), ZERO), share19=shares.get(D(19), ZERO),
                vatcorr7=corr.get(D(7), ZERO), vatcorr19=corr.get(D(19), ZERO))


def credit_after_early_discount(order_res, pct, returns=None):
    """Credit note for returned goods of an invoice settled with an early-payment discount (business-rules.md):
    only the credited goods part (net after discounts plus its VAT, without deposits and their VAT) is reduced by
    the discount percentage, rounded; deposits are credited in full; shipping is not part of the goods part (it is
    retained unless the whole order is returned because of a seller error)."""
    cur = order_res.get("currency", "EUR")
    if returns is None:
        returns = {i: l.qty for i, l in enumerate(order_res["lines"]) if not l.free}
    rf = refund(order_res, returns)
    goods = {}
    for idx, part in rf["parts"].items():
        r_ = order_res["lines"][idx].p.vat
        goods[r_] = goods.get(r_, ZERO) + part["paid"]
    goods_gross = sum((b + _rate_vat(order_res, r_, b) for r_, b in goods.items()), ZERO)
    disc = rm(goods_gross * D(str(pct)), cur)
    return dict(refund=rf["gross"], goods_gross=goods_gross, discount=disc, credit=rf["gross"] - disc,
                deposits_gross=rf["gross"] - goods_gross)
