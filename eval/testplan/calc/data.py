"""Business data from the #OneShotShop v2 spec (specs/*.md), restricted to what the test plan uses.

Every price here is cross-checked against specs/products.md by selfcheck.py.
"""
from decimal import Decimal as D


class Unit:
    def __init__(self, base, price, tiers=None, crate_dep="0.00", bulky=False, crates=1, pallet_dep="0.00"):
        self.base = D(str(base))          # base units contained in one of this packaging unit
        self.price = D(price)             # list price for one of this packaging unit
        self.tiers = [(D(str(m)), D(p)) for m, p in (tiers or [])]  # (min qty of this unit, price)
        self.crate_dep = D(crate_dep)     # deposit per crate/keg container on top of base-unit deposits
        self.crates = crates              # number of such containers in one of this packaging unit
        self.pallet_dep = D(pallet_dep)   # Euro-pallet deposit per unit (transport aid, always 19 % VAT)
        self.bulky = bulky


class Product:
    def __init__(self, sku, name, vat, cat, units, dep_base="0.00", excluded=False,
                 temp="ambient", volume_dep=None, catch=None, stock=None):
        self.sku, self.name, self.vat, self.cat = sku, name, D(vat), cat
        self.units = units
        self.dep_base = D(dep_base)       # deposit per base unit (bottle/can)
        self.excluded = excluded          # excluded from all discounts
        self.temp = temp
        self.volume_dep = volume_dep      # (litres per container, deposit) – started containers
        self.catch = catch                # (estimated kg per piece, price per kg)
        self.stock = stock
        self.parent = None    # variant SKU -> parent product SKU
        self.options = {}     # option name -> net surcharge per unit
        self.exclusive = set()
        self.bundle = None    # list of (sku, unit, qty) contents


BEV_WATER = "Beverages › Water & Soft Drinks"
P = {}


def add(p):
    P[p.sku] = p


# ---- Beverages ----
add(Product("WAT-001", "Sparkling Mineral Water, 1 l Glass", 19, BEV_WATER, {
    "bottle": Unit(1, "1.19"), "box": Unit(6, "7.14"), "crate": Unit(24, "28.56", crate_dep="1.50")},
    dep_base="0.15", stock=137))
add(Product("WAT-002", "Still Mineral Water, 1 l Glass", 19, BEV_WATER, {
    "bottle": Unit(1, "1.15"), "box": Unit(6, "6.60"), "crate": Unit(18, "18.90", crate_dep="1.50"),
    "pallet": Unit(720, "705.60", crate_dep="1.50", crates=40, pallet_dep="15.00", bulky=True)},
    dep_base="0.15", stock=2400))
add(Product("WAT-003", "Still Water, 0.5 l PET", 19, BEV_WATER, {"tray": Unit(18, "7.02")},
            dep_base="0.25", stock=960))
add(Product("SOFT-001", "Cola, 0.33 l Can", 19, BEV_WATER, {
    "can": Unit(1, "0.62"),
    "tray": Unit(24, "14.40", tiers=[(1, "14.40"), (10, "13.92"), (50, "13.44")])},
    dep_base="0.25", stock=2400))
add(Product("SOFT-002", "Cola Zero, 0.33 l Can", 19, BEV_WATER, {
    "can": Unit(1, "0.62"), "tray": Unit(24, "14.40")}, dep_base="0.25", stock=36))
add(Product("SOFT-005", "Tonic Water, 0.2 l Glass", 19, BEV_WATER, {
    "pack": Unit(4, "3.16"), "case": Unit(24, "18.00")}, dep_base="0.08", stock=600))
add(Product("SOFT-006", "Energy Drink, 0.25 l Can", 19, BEV_WATER, {"tray": Unit(20, "19.80")},
            dep_base="0.25", excluded=True, stock=480))
add(Product("JUI-003", "Freshly Pressed Orange Juice", 19, "Beverages › Juices", {"l": Unit(1, "4.20")},
            volume_dep=(D("5"), D("3.00")), temp="chilled", stock=60))
add(Product("BEER-001", "Pilsner, 0.5 l Glass", 19, "Beverages › Beer", {
    "crate": Unit(20, "15.80", tiers=[(1, "15.80"), (10, "15.20"), (50, "14.60")], crate_dep="1.50"),
    "pallet": Unit(800, "560.00", crate_dep="1.50", crates=40, pallet_dep="15.00", bulky=True)},
    dep_base="0.08", stock=2000))
add(Product("BEER-002", "Pilsner, 0.33 l Glass", 19, "Beverages › Beer", {
    "bottle": Unit(1, "0.89"), "sixpack": Unit(6, "5.10"), "crate": Unit(24, "19.68", crate_dep="1.50")},
    dep_base="0.08", stock=960))
add(Product("BEER-004", "Pilsner Keg, 30 l", 19, "Beverages › Beer", {
    "keg": Unit(1, "119.00", crate_dep="30.00", bulky=True)}, stock=25))
add(Product("BEER-005", "Wheat Beer Keg, 50 l", 19, "Beverages › Beer", {
    "keg": Unit(1, "189.00", crate_dep="30.00", bulky=True)}, stock=8))
add(Product("WINE-001", "Riesling Dry 2025, 0.75 l", 19, "Beverages › Wine & Sparkling Wine", {
    "bottle": Unit(1, "6.90"), "carton": Unit(6, "39.00")}, stock=180))
add(Product("WINE-004", "House Red Wine, 10 l Bag-in-Box", 19, "Beverages › Wine & Sparkling Wine", {
    "bib": Unit(1, "39.90")}, stock=30))
add(Product("WINE-005", "Prosecco DOC Extra Dry, 0.75 l", 19, "Beverages › Wine & Sparkling Wine", {
    "bottle": Unit(1, "6.20"), "carton": Unit(6, "35.40")}, stock=240))
add(Product("WINE-006", "Champagne Brut, 0.75 l", 19, "Beverages › Wine & Sparkling Wine", {
    "bottle": Unit(1, "29.50"), "carton": Unit(6, "171.00")}, excluded=True, stock=None))
add(Product("WINE-008", "Seeblick Cuvée Brut, Private Label, 0.75 l", 19, "Beverages › Wine & Sparkling Wine", {
    "bottle": Unit(1, "8.90"), "carton": Unit(6, "51.00")}, stock=120))
add(Product("SPI-001", "London Dry Gin, 0.7 l", 19, "Beverages › Spirits", {
    "bottle": Unit(1, "18.90"), "carton": Unit(6, "107.40")}, stock=60))
add(Product("SPI-004", "Herbal Liqueur Miniatures, 0.02 l", 19, "Beverages › Spirits", {
    "pack": Unit(20, "9.40"), "carton": Unit(80, "35.20")}, stock=1000))
add(Product("SPI-005", "Single Malt Whisky 12 Years, 0.7 l", 19, "Beverages › Spirits", {
    "bottle": Unit(1, "32.90")}, stock=None))   # not stocked: cross-docking from SUP-01
add(Product("COF-001", "Espresso Beans, 1 kg", 7, "Beverages › Coffee & Tea", {
    "bag": Unit(1, "18.40"), "carton": Unit(6, "104.40", tiers=[(1, "104.40"), (3, "99.00")])}, stock=150))
add(Product("COF-002", "Caffè Crema Beans, 1 kg", 7, "Beverages › Coffee & Tea", {
    "bag": Unit(1, "16.20"), "carton": Unit(6, "92.40")}, stock=90))
add(Product("TEA-001", "English Breakfast Tea, 100 Bags", 7, "Beverages › Coffee & Tea", {
    "box": Unit(1, "7.80")}, stock=60))
add(Product("TEA-002", "Sencha Green Tea, Loose", 7, "Beverages › Coffee & Tea", {"kg": Unit(1, "35.00")}, stock=8))
# ---- Dairy / Cheese / Meat ----
add(Product("DAI-001", "UHT Whole Milk 3.5 %, 1 l", 7, "Dairy & Eggs", {
    "carton": Unit(1, "0.98"), "case": Unit(12, "11.16")}, stock=360))
add(Product("DAI-002", "Barista Oat Drink, 1 l", 19, "Dairy & Eggs", {
    "carton": Unit(1, "1.79"), "case": Unit(6, "10.14")}, stock=180))
add(Product("DAI-010", "Fresh Whole Milk 3.8 %, 1 l Returnable Glass Bottle", 7, "Dairy & Eggs", {
    "bottle": Unit(1, "1.39"), "crate": Unit(6, "7.98", crate_dep="1.50"),
    "pallet": Unit(360, "457.20", crate_dep="1.50", crates=60, pallet_dep="15.00", bulky=True)},
    dep_base="0.15", temp="chilled", stock=720))
add(Product("HERB-002", "Sweet Paprika Powder, Loose", 7, "Dry Goods › Spices & Seasonings", {
    "kg": Unit(1, "12.00")}, stock=25))
add(Product("CHE-001", "Young Gouda, Cut to Order", 7, "Cheese", {"kg": Unit(1, "9.80")}, temp="chilled", stock=36))
add(Product("CHE-002", "Parmigiano Reggiano 24 Months", 7, "Cheese", {"kg": Unit(1, "24.50")}, temp="chilled", stock=18))
add(Product("CHE-006", "Brie de Meaux, Whole Wheel", 7, "Cheese", {"wheel": Unit(1, "38.70")},
            temp="chilled", catch=(D("3.0"), D("12.90")), stock=20))
# ---- Frozen / Fish / Veg ----
add(Product("FRZ-001", "French Fries, Frozen, 2.5 kg", 7, "Frozen Foods", {
    "bag": Unit(1, "3.90"),
    "carton": Unit(4, "14.80", tiers=[(1, "14.80"), (10, "14.20"), (30, "13.60")])}, temp="frozen", stock=400))
add(Product("FRZ-004", "Vanilla Ice Cream, 5 l", 7, "Frozen Foods", {"tub": Unit(1, "17.90")}, temp="frozen", stock=40))
add(Product("FRZ-006", "Mixed Berries, Frozen, 1 kg", 7, "Frozen Foods", {"bag": Unit(1, "6.40")}, temp="frozen", stock=0))
add(Product("FIS-001", "Salmon Fillet, Frozen, 1 kg", 7, "Fish & Seafood", {
    "pack": Unit(1, "19.90"), "carton": Unit(10, "189.00")}, temp="frozen", stock=80))
add(Product("VEG-001", "Vine Tomatoes", 7, "Fruit & Vegetables", {
    "kg": Unit(1, "3.20"), "crate": Unit(6, "17.40")}, temp="fresh", stock=150))
# ---- Dry goods ----
add(Product("DRY-002", "Pizza Flour Tipo 00, 25 kg", 7, "Dry Goods › Flour, Sugar & Baking", {
    "sack": Unit(1, "24.90", bulky=True)}, stock=40))
add(Product("DRY-004", "Sugar Sticks, 1,000 × 4 g", 7, "Dry Goods › Flour, Sugar & Baking", {
    "carton": Unit(1, "12.90")}, stock=50))
add(Product("DRY-005", "Instant Dry Yeast, 500 g", 7, "Dry Goods › Flour, Sugar & Baking", {
    "pack": Unit(1, "4.20")}, stock=60))
add(Product("OIL-001", "Extra Virgin Olive Oil, 5 l Tin", 7, "Dry Goods › Oils & Vinegars", {
    "tin": Unit(1, "42.50"), "carton": Unit(4, "162.00")}, stock=60))
add(Product("OIL-004", "Balsamic Vinegar of Modena, 500 ml", 7, "Dry Goods › Oils & Vinegars", {
    "bottle": Unit(1, "3.40"), "carton": Unit(6, "19.20")}, stock=120))
add(Product("CAN-006", "Pesto alla Genovese, 1 kg Jar", 7, "Dry Goods › Canned & Jarred Goods", {
    "jar": Unit(1, "12.40")}, stock=3))
add(Product("HERB-004", "Saffron Threads", 7, "Dry Goods › Spices & Seasonings", {
    "tin1g": Unit(1, "8.90"), "tin10g": Unit(10, "79.00")}, excluded=True, stock=50))
add(Product("SAU-001", "Ketchup Sachets, 200 × 20 g", 7, "Dry Goods › Sauces & Condiments", {"carton": Unit(1, "9.80")}, stock=60))
add(Product("SAU-002", "Mayonnaise, 5 l Bucket", 7, "Dry Goods › Sauces & Condiments", {"bucket": Unit(1, "11.90")}, stock=50))
add(Product("SAU-003", "Medium-Hot Mustard, 1 kg", 7, "Dry Goods › Sauces & Condiments", {"bucket": Unit(1, "3.40")}, stock=40))
add(Product("SAU-004", "Soy Sauce, 1 l", 7, "Dry Goods › Sauces & Condiments", {"bottle": Unit(1, "4.60")}, stock=60))
add(Product("SNK-001", "Salted Potato Crisps, 40 g", 7, "Snacks & Sweets", {
    "bag": Unit(1, "0.62"), "box": Unit(25, "13.75")}, stock=600))
add(Product("NF-001", "Coffee To-Go Cups, 300 ml", 19, "Non-Food & Disposables", {
    "sleeve": Unit(50, "4.90"), "carton": Unit(750, "66.75", tiers=[(1, "66.75"), (5, "63.00")])}, stock=6000))
add(Product("NF-003", "Paper Napkins 33 x 33 cm", 19, "Non-Food & Disposables", {
    "pack": Unit(1, "3.60"), "carton": Unit(12, "39.60")}, stock=120))
# ---- variants (own SKU, price, stock; parent = product page)
for _sku, _p, _st in (("NF-005-S", "6.90", 40), ("NF-005-M", "6.90", 120), ("NF-005-L", "6.90", 80), ("NF-005-XL", "6.90", 0)):
    add(Product(_sku, "Nitrile Gloves, 100 Pieces", 19, "Non-Food & Disposables", {"box": Unit(1, _p)}, stock=_st))
    P[_sku].parent = "NF-005"
for _sku, _p, _st in (("NF-007-26", "18.50", 30), ("NF-007-30", "21.90", 50), ("NF-007-33", "24.90", 12)):
    add(Product(_sku, "Pizza Boxes, Pack of 100", 19, "Non-Food & Disposables", {"pack": Unit(1, _p)}, stock=_st))
    P[_sku].parent = "NF-007"
# ---- bundle contents
add(Product("VEG-004", "Lemons", 7, "Fruit & Vegetables", {
    "lemon": Unit(1, "0.32"), "box": Unit(100, "27.00")}, temp="fresh", stock=600))
add(Product("FRZ-002", "Pizza Dough Balls, Frozen, 250 g", 7, "Frozen Foods", {"box": Unit(40, "16.00")},
            temp="frozen", stock=800))
add(Product("CAN-001", "Peeled Tomatoes, 2.5 kg Tin", 7, "Dry Goods › Canned & Jarred Goods", {
    "tin": Unit(1, "3.40"), "carton": Unit(6, "19.20")}, stock=180))
add(Product("CHE-003", "Mozzarella Fior di Latte, 125 g", 7, "Cheese", {
    "ball": Unit(1, "0.89"), "tray": Unit(12, "9.96")}, temp="chilled", stock=240))
add(Product("VEG-007", "Basil, Potted", 7, "Fruit & Vegetables", {
    "pot": Unit(1, "1.49"), "tray": Unit(8, "10.40")}, temp="fresh", stock=48))
# ---- options (no SKU, no stock; added to the net unit price before the group discount)
add(Product("CTR-001", "Pizza Margherita, Baked to Order, 33 cm", 7, "Catering", {"pizza": Unit(1, "9.80")},
            temp="chilled", stock=40))
P["CTR-001"].options = {"cheese": D("3.00"), "salami": D("2.00"), "mushrooms": D("1.50"), "veg": D("2.50"),
                        "glutenfree": D("4.00")}
P["CTR-001"].exclusive = {"salami", "mushrooms", "veg"}   # at most one extra topping
# ---- bundles: fixed price, excluded from all discounts, VAT split by content list prices
add(Product("BND-001", "Gin & Tonic Bar Kit", 19, "Catering › Bundles", {"kit": Unit(1, "28.90")},
            excluded=True))
P["BND-001"].bundle = [("SPI-001", "bottle", 1), ("SOFT-005", "pack", 3), ("VEG-004", "lemon", 10)]
add(Product("BND-002", "Pizza Night Kit", 19, "Catering › Bundles", {"kit": Unit(1, "62.00")}, excluded=True))
P["BND-002"].bundle = [("FRZ-002", "box", 1), ("CAN-001", "tin", 2), ("CHE-003", "tray", 2), ("VEG-007", "pot", 1),
                       ("NF-007-33", "pack", 1)]

# ---- Customers ----
RATES = {"EUR": D("1"), "CHF": D("0.95"), "GBP": D("0.86")}   # business-rules.md, Countries and Currencies


class Customer:
    def __init__(self, no, name, group, pct, neg=None, country="DE", reverse_charge=False,
                 credit_limit=None, open_balance=None, currency="EUR", export=False):
        self.no, self.name, self.group, self.pct = no, name, group, D(pct)
        self.neg = neg or {}   # sku -> ("base", price) | ("unit", unit, price)
        self.country, self.reverse_charge = country, reverse_charge
        self.credit_limit = D(credit_limit) if credit_limit else None
        self.open_balance = D(open_balance) if open_balance else None
        self.currency, self.export = currency, export


C = {
    "C-10001": Customer("C-10001", "Osthafen Küche GmbH", "Gastronomy", "0.05", neg={
        "BEER-004": ("unit", "keg", D("109.00")),
        "COF-001": ("base", D("16.90")),
        "FRZ-001": ("unit", "carton", D("13.20"))}, credit_limit="5000.00", open_balance="0.00"),
    "C-10002": Customer("C-10002", "Café Morgenrot", "Gastronomy", "0.05"),
    "C-10003": Customer("C-10003", "Feinkost Lindner KG", "Retail", "0.03", neg={
        "CHE-002": ("base", D("22.00"))}, credit_limit="2000.00", open_balance="1850.00"),
    "C-10004": Customer("C-10004", "Hotel Seeblick AG", "Key Account", "0.08", neg={
        "WINE-005": ("base", D("5.40")),
        "SPI-005": ("base", D("29.90")),
        "WAT-002": ("unit", "crate", D("17.55"))}, credit_limit="20000.00", open_balance="3200.00"),
    "C-10005": Customer("C-10005", "Wiener Genuss GmbH", "Standard", "0", country="AT", reverse_charge=True,
                        credit_limit="3000.00", open_balance="0.00"),
    "C-10006": Customer("C-10006", "De Kaasboer B.V.", "Retail", "0.03", country="NL"),
    "C-10007": Customer("C-10007", "Spätkauf am Kanal UG", "Standard", "0"),
    "C-10010": Customer("C-10010", "Hotel Alpenblick AG", "Gastronomy", "0.05", country="CH", currency="CHF", export=True),
    "C-10011": Customer("C-10011", "Thames Deli Ltd", "Retail", "0.03", country="GB", currency="GBP", export=True),
    # C-10010 after staff changed the CHF rate to 0.97 (suite S19)
    "C-10010-R97": Customer("C-10010", "Hotel Alpenblick AG", "Gastronomy", "0.05", country="CH", currency="CHF",
                            export=True),
    # Austrian registrant of suite S15: VAT ID not yet verified -> German VAT; after staff verify it -> reverse charge
    "NEW-AT": Customer("NEW-AT", "Alpenküche GmbH", "Standard", "0", country="AT"),
    "NEW-AT-VERIFIED": Customer("NEW-AT", "Alpenküche GmbH", "Standard", "0", country="AT", reverse_charge=True),
    # Fictitious customer registered during the test (group Standard after approval)
    "NEW": Customer("NEW", "Testküche Mitte GmbH", "Standard", "0"),
    # C-10007 after staff moved it to the group Gastronomy (suite S11)
    "C-10007-GASTRO": Customer("C-10007", "Spätkauf am Kanal UG", "Gastronomy", "0.05"),
    # C-10007 after staff added a negotiated price (suite S11)
    "C-10007-NEG": Customer("C-10007", "Spätkauf am Kanal UG", "Standard", "0", neg={
        "SAU-002": ("unit", "bucket", D("10.00"))}),
}

# ---- Shipping ----
SHIP = {
    "truck":   dict(fee=D("15.00"), free_at=D("250.00"), min=D("100.00"), bulky=D("0")),
    "std":     dict(fee=D("9.90"), free_at=D("300.00"), min=D("75.00"), bulky=D("8.50")),
    "express": dict(fee=D("19.90"), free_at=None, min=D("75.00"), bulky=D("0")),
    "eu":      dict(fee=D("24.90"), free_at=D("750.00"), min=D("150.00"), bulky=D("0")),
    "pickup":  dict(fee=D("0.00"), free_at=None, min=D("0.00"), bulky=D("0")),
    # International Freight, local currency (shipping.md section 6)
    "intl-CHF": dict(fee=D("45.00"), free_at=D("1000.00"), min=D("250.00"), bulky=D("0")),
    "intl-GBP": dict(fee=D("39.00"), free_at=D("900.00"), min=D("200.00"), bulky=D("0")),
}
SHIP_NAMES = {"truck": "Spreegrund Truck Delivery", "std": "Standard Parcel Germany",
              "express": "Express Parcel Germany", "eu": "EU Parcel", "pickup": "Warehouse Pickup"}
