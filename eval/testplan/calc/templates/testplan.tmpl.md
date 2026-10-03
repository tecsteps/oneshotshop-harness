# #OneShotShop v2 — Functional Acceptance Test Plan (hidden)

Shop under test: a B2B webshop for **Spreegrund Food Service** built from the public spec repo.
This plan has **<<TOTAL>> checks** in <<SUITES>> suites. Every check is graded **PASS** or **FAIL**. There is no partial credit and no "not applicable".

> Generated file. Do not edit `testplan.md` by hand: edit `calc/templates/testplan.tmpl.md` and run
> `python3 calc/render.py`. Every money amount and every computed quantity in a check is taken from
> the reference calculator and cites its source as `[calc SCENARIO.field]`. Run
> `python3 calc/print_scenarios.py SCENARIO` to see how a value was derived.

---

## 0. Evaluator instructions

### 0.1 Ground rules

1. **Browser only.** Every check is performed through a web browser (Playwright or similar) at the shop's normal URL. You may use the shell for exactly four things:
   - (a) resetting the shop (0.2),
   - (b) reading sent emails from the shop's mail log `storage/logs/laravel.log` (the shop uses the `log` mail driver),
   - (c) optionally running `python3 eval/testplan/calc/delivery.py` from the harness repo to get the expected delivery dates (0.6). This tool never touches the shop.
   - (d) processing queued emails with `php artisan queue:work --stop-when-empty` in the shop directory, immediately before every email check (part of MAIL, 0.5).
   
   Do **not** inspect the database, the source code, the routes or any other file of the shop. Do not start any other processes for the shop (no long-running queue workers, no schedulers, no artisan commands other than the reset and the queue command in (d)).
2. **Do not help the shop.** Use the shop as a customer or staff member would: through visible links, buttons, menus, forms and search. Do not guess URLs, manipulate requests, edit HTML or call APIs. There are two exceptions:
   - The checks marked *(URL check)* ask you to open a URL that you recorded earlier in the run. This tests access control.
   - The admin area may be opened by typing its address. Use the address documented in the shop's README. If the README does not give one, try `/admin`.
3. **Effort budget.** If you cannot find or complete a function within **3 navigation attempts or 5 minutes**, the check is **FAIL** with the note `not found`. This applies to a single check or to a setup step. A function that exists but does not work (for example an error page or a form that cannot be submitted) is also **FAIL**.
4. **Use the page like a person.** Click, type and select with the browser tools. Never set field values, submit forms or click by running JavaScript, and never fetch pages with JavaScript; JavaScript is only for the read-only snippets in 0.7. Never combine an action (click, submit, key press) and a navigation in the same step: wait for the result of the action first.
5. **Blocked checks.** A check may depend on an earlier step that failed, for example because no order could be placed. Mark that check **FAIL** with the note `blocked by <ID or setup>`. Do not invent workarounds.
6. **One check = one assertion.** Grade only what the **Expect** line states. Do not let other observations affect it. Unrelated problems may be recorded in the note of the check where you saw them.
7. **Order of execution.** Run the suites in any order. Before each suite, **reset the shop** (0.2). Inside a suite, run setups and checks in the order written. Each check states its precondition (**Pre**). The state from the previous steps of the same suite is part of that precondition.
8. **Time zone.** All dates and times are Europe/Berlin. Record the Berlin time when you start suite S06.

### 0.2 Reset procedure (start of every suite)

```
cd <shop directory>
php artisan migrate:fresh --seed --force
wc -c storage/logs/laravel.log   # note the byte size = MAILMARK for this suite (0 if the file does not exist)
```
The shop keeps running; do not restart it. After a reset, sign out in every browser context, or use fresh browser contexts. A reset is complete when the storefront home page loads.

If the reset command fails, every check of that suite is **FAIL** with the note `reset failed`.

### 0.3 Accounts (from the spec)

| Who | Email | Password | Notes |
|---|---|---|---|
| Admin | admin@spreegrund.example | Spreegrund!Admin2026 | admin area only |
| C-10001 Osthafen Küche (Jana Petersen) | einkauf@osthafen-kueche.example | Hafen#2026 | Gastronomy, invoice allowed, negotiated prices |
| C-10001 Osthafen Küche (Mehmet Yilmaz) | kueche@osthafen-kueche.example | Kombuese!26 | second user of the same company |
| C-10002 Café Morgenrot | hallo@cafe-morgenrot.example | Morgen!2026 | Gastronomy, no invoice |
| C-10003 Feinkost Lindner | bestellung@feinkost-lindner.example | Lindner!80331 | Retail, Munich (no truck), invoice with little credit left |
| C-10004 Hotel Seeblick | purchasing@hotel-seeblick.example | Seeblick#Key8 | Key Account, two shipping addresses |
| C-10005 Wiener Genuss | office@wiener-genuss.example | Wien!1060 | Austria, verified VAT ID (reverse charge) |
| C-10006 De Kaasboer | inkoop@dekaasboer.example | Kaas!Amsterdam1 | Netherlands, Retail, no VAT ID |
| C-10007 Spätkauf am Kanal | kontakt@spaetkauf-kanal.example | Kanal!10999 | Standard group (list prices), Berlin 10999, no invoice |
| C-10008 Kantine Nordlicht | einkauf@kantine-nordlicht.example | Nordlicht!13353 | pending approval |
| C-10009 Imbiss Ecke | info@imbiss-ecke.example | Imbiss!2026 | blocked |

Payment test data: card `4242 4242 4242 4242` (approved), `5555 5555 5555 4444` (approved), `4000 0000 0000 0002` (declined: "Card declined"), `4000 0000 0000 9995` (declined: "Insufficient funds"). Unless a check says otherwise, use expiry **12/30** and security code **123**. Valid IBANs: `DE89 3704 0044 0532 0130 00`, `AT61 1904 3002 3457 3201`. Invalid IBAN: `DE00 1234 5678 9012 3456 78`.

### 0.4 Grading rules

- **Money.** PASS only if the observed amount equals the expected amount **to the cent**. Formatting does not matter: `€1,234.56`, `1.234,56 €`, `EUR 1234.56` and `1234.56` all match 1234.56. A difference of one cent is a FAIL. If a page shows the same quantity twice with different values, for example in the cart summary and in the line, grade the place the check names.
- **Quantities and units.** These must be numerically equal: `2.5 kg`, `2,5 kg` and `2.50 kg` all match 2.5 kg. Where a unit is named, it must be shown with the number.
- **Texts.** The check gives the exact words that must appear, matched case-insensitively. A word list such as "contains `declined`" is met if that word appears in the message shown to the user.
- **"Shows" / "visible".** The information must be readable on the named page, either as screen text or after opening a visible control on that page (tab, accordion, "details"). HTML source and hidden attributes do not count, unless the check asks for a DOM inspection (0.7).
- **Named amounts.** "Deposit total", "VAT 19 %", "gross total" and similar names refer to the figure that the shop labels that way. Equivalent labels are accepted:
  - "Deposit total": "Deposit", "Pfand", "Deposits".
  - "VAT 19 %": "19 % VAT", "MwSt. 19 %", "VAT (19%)".
  - "Gross total": "Total", "Grand total", "Amount payable", "Total incl. VAT".
  - "Merchandise total": "Subtotal", "Goods", "Net goods value".

  If the cart or order holds goods of only **one** VAT rate and all deposits and shipping fall under the same rate, a single unlabelled "VAT" amount counts as that rate. Never add up or recalculate values yourself to make a check pass.
- **Line total.** The net amount of one cart or order line before promotions. If the shop shows a line both before and after the customer-group discount, grade the amount after the group discount. The spec says a customer's own prices already include the group discount.
- **Discount amount.** The discount that the cart, review, order or invoice shows for the named promotion. If the shop shows only one combined discount figure, that figure must equal the expected total of all promotions active in that cart. The check states this total wherever it differs from the single amount.
- **Quantity accepted / rejected.** You enter a quantity, either when adding to the cart or when changing a cart line, and confirm it.
  - *Accepted:* the cart then holds a line with exactly that quantity and shows no error that blocks checkout.
  - *Rejected:* the cart does **not** hold a line with exactly that quantity, or the shop shows an error and checkout cannot be started with that line. A silent correction to a different quantity also counts as rejected. **Evidence:** quote the shop's message in `observed`, or, if the shop shows none, reload the cart in a separate step after the attempt and record what it holds. A result read in the same step as the attempt does not count.
- **Code applied / rejected.**
  - *Applied:* the cart or review shows the code as applied, together with a discount (or shipping reduction) attributed to it.
  - *Rejected:* after you submit the code, it is not shown as applied and no discount from it is included in the totals.
  - "No discount" means that the code (or automatic promotion) contributes €0.00 and the gross total equals the expected total without it.
- **Method offered / not offered.**
  - *Offered:* the method can be selected and checkout continues to the next step with it.
  - *Not offered:* the method is absent, disabled, or it can be selected but the shop refuses to continue with it.
- **"No price visible".** No monetary amount for the product is shown, neither for its packaging units nor for its deposits. A mini-cart showing €0.00 is ignored.

### 0.5 Standard procedures

- **CLEAR** — Empty the cart and remove any applied promotion code. If the shop cannot remove all lines, the current check FAILs (`blocked by CLEAR`).
- **ADD(qty × SKU unit)** — Open the product (via search or category) and add the given quantity of the given packaging unit to the cart. "Unit" names a packaging unit of the spec (bottle, box of 6, crate, tray, carton, …). For products sold by weight or volume, enter the quantity in kg or litres with a decimal point, unless the check says otherwise. Packaging units may be selected in the cart or on the product page, as the shop allows. For a product with variants, choose the variant named, for example "33 cm". For a product with options, choose exactly the options named; "plain" means no options. A bundle is added like any other product (unit "kit").
- **REVIEW(method)** — From a non-empty cart, start checkout and choose these options:
  1. The customer's default shipping address. For C-10004 this is the Wannsee address unless the check says otherwise.
  2. The shipping method named. **Pickup** means Warehouse Pickup, **Truck** means Spreegrund Truck Delivery, **Parcel** means Standard Parcel Germany, **Express** means Express Parcel Germany and **EU** means EU Parcel.
  3. For Truck, the earliest offered delivery date and the first offered slot. For Pickup, the earliest offered pickup date.
  4. Any offered payment method. Prefer, in this order, Purchase on invoice, Prepayment, SEPA, then credit card.

  Then go to the final review page and **do not place the order**. All "review" values are read on that page.
- **ORDER(method, payment)** — Run REVIEW(method), then select the payment method named and place the order. Payment details:
  - **Card:** 4242 4242 4242 4242, expiry 12/30, code 123.
  - **SEPA:** account holder = the contact person, IBAN DE89 3704 0044 0532 0130 00, accept the mandate.
  - **Invoice:** Purchase on invoice.
  - **Prepay:** Prepayment by bank transfer.
  - **Cash:** Cash on pickup.

  Note the order number shown on the confirmation page and the URL of the order's detail page in the customer account.
- **SHIP(order)** — As admin, create a shipment for **all** open quantities of the order and mark it shipped. If the shop asks for lots, accept its default suggestion. If it asks for a carrier or tracking number, enter `TEST`. If it asks for the actual weight of a catch-weight line, the check gives the value. This applies to **every** shipment in this plan, including partial shipments a check describes in its own words: before shipping, complete every readiness step the order's workflow requires (for example `cold-chain check`, `temperature log signed`, `export documents ready`) as staff would. Only the checks that test the refusal before such a step say otherwise, explicitly.
- **DELIVER(order)** — As admin, set the order to "delivered", or record the delivery.
- **MAIL(address, text)** — First run `php artisan queue:work --stop-when-empty` in the shop directory and wait until it exits. Then read the part of `storage/logs/laravel.log` written after MAILMARK. PASS if there is at least one logged email whose recipient (To) is `address` and whose subject or body contains `text`. You may decode quoted-printable or base64 parts. The text must be specific to the event being checked (an order number together with the event word the check names); an email that was already in the log before the event's action does not count, so note the latest matching email before the action when a check depends on a new email.

### 0.6 Truck delivery and pickup dates

The spec defines these rules (shipping.md):

- Truck deliveries run Monday to Friday, except Berlin public holidays ("delivery days").
- If the order is placed by 18:00, the earliest delivery date is the first delivery day after today. If it is placed after 18:00, the earliest date is the delivery day after that one. This holds on every day of the week.
- The latest selectable date is today + 14 calendar days. Concretely, it is the last delivery day on or before that date.
- Pickup is possible Monday to Saturday, except on Berlin public holidays, from the next day up to 14 days ahead.

Berlin public holidays 2026–2028:

| Holiday | 2026 | 2027 | 2028 |
|---|---|---|---|
| New Year's Day | Thu 01-01 | Fri 01-01 | Sat 01-01 |
| International Women's Day | Sun 03-08 | Mon 03-08 | Wed 03-08 |
| Good Friday | Fri 04-03 | Fri 03-26 | Fri 04-14 |
| Easter Monday | Mon 04-06 | Mon 03-29 | Mon 04-17 |
| Labour Day | Fri 05-01 | Sat 05-01 | Mon 05-01 |
| Ascension Day | Thu 05-14 | Thu 05-06 | Thu 05-25 |
| Whit Monday | Mon 05-25 | Mon 05-17 | Mon 06-05 |
| German Unity Day | Sat 10-03 | Sun 10-03 | Tue 10-03 |
| Christmas Day | Fri 12-25 | Sat 12-25 | Mon 12-25 |
| Second Day of Christmas | Sat 12-26 | Sun 12-26 | Tue 12-26 |

Compute **E** (the earliest truck date) and **L** (the latest truck date) from the Berlin time at which you run S06-01. You can do this by hand with the table, or by running `python3 eval/testplan/calc/delivery.py`. Avoid running S06 between 17:55 and 18:05 Berlin time.

### 0.7 DOM inspections (accessibility, layout and SEO checks only)

For the checks that say **DOM**, run the given read-only JavaScript in the page through the browser automation, for example `page.evaluate`. Record the returned value.

- **JS-H1** `[...document.querySelectorAll('h1')].filter(h => h.getClientRects().length > 0).length` → number of rendered `h1` elements.
- **JS-ALT** `[...document.images].filter(i => !i.hasAttribute('alt')).length` → number of images without an `alt` attribute.
- **JS-MAINIMG** `(() => { const i = [...document.images].filter(i => i.getClientRects().length).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return i ? i.getAttribute('alt') : null; })()` → `alt` of the largest rendered image.
- **JS-LABEL** `[...document.querySelectorAll('input, select, textarea')].filter(e => !['hidden','submit','button','reset','image'].includes(e.type) && e.getClientRects().length > 0).filter(e => !([...(e.labels || [])].some(l => l.textContent.trim()) || (e.getAttribute('aria-label') || '').trim() || e.getAttribute('aria-labelledby'))).map(e => e.name || e.id || e.type)` → list of visible form fields without a programmatic label. `placeholder` and `title` do not count as labels.
- **JS-LANG** `document.documentElement.getAttribute('lang') || ''`.
- **JS-OVERFLOW** (at the viewport the check names) `document.documentElement.scrollWidth - window.innerWidth` → horizontal overflow in px.
- **JS-MAIN** `!!document.querySelector('main, [role="main"]')` → whether a main landmark exists.
- **JS-FOCUS** (run while the control has keyboard focus) `(() => { const e = document.activeElement; if (!e || e === document.body) return 'no focus'; const st = (x) => { const s = getComputedStyle(x); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.textDecorationLine].join('|'); }; const f = st(e); e.blur(); const b = st(e); e.focus(); return f !== b; })()` → `true` if the focused control looks different from the unfocused one.
- **JS-TITLE** `document.title`.
- **JS-META** `(document.querySelector('meta[name="description"]')?.getAttribute('content') || '').trim().length` → length of the meta description.
- **JS-CANON** `document.querySelector('link[rel="canonical"]')?.href || ''` → canonical address.
- **JS-LDPRODUCT** (JSON-LD and microdata) `(() => { const out = [...document.querySelectorAll('[itemtype*="schema.org/Product"]')].map((e) => ({ name: (e.querySelector('[itemprop="name"]') || {}).textContent || (e.querySelector('[itemprop="name"]') || {}).content, sku: (e.querySelector('[itemprop="sku"]') || {}).textContent || (e.querySelector('[itemprop="sku"]') || {}).content })); const walk = (o) => { if (Array.isArray(o)) return o.forEach(walk); if (o && typeof o === 'object') { const t = o['@type']; if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) out.push({ name: o.name, sku: o.sku }); Object.values(o).forEach(walk); } }; document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { walk(JSON.parse(s.textContent)); } catch (e) {} }); return out; })()` → the Product objects in the page's structured data (JSON-LD or microdata).
- **JS-IMGFIT** `(() => { const i = [...document.images].filter((x) => x.getClientRects().length).sort((a, b) => b.width * b.height - a.width * a.height)[0]; if (!i) return 'no image'; const r = i.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; })()` → whether the largest image fits horizontally into the viewport.
- **JS-PATH** `location.pathname.toLowerCase()`.
- **JS-LINKPATHS** `[...document.querySelectorAll('a[href]')].filter((a) => a.getClientRects().length).map((a) => new URL(a.href, location.href).pathname.replace(/\/$/, '') || '/')` → paths of all visible links.
- **JS-MAINIMGSRC** `(() => { const i = [...document.images].filter((x) => x.getClientRects().length).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return i ? i.currentSrc || i.src : null; })()` → source of the largest rendered image.
- **JS-RAW** `(document.body.innerText.match(/@(else|endif|foreach|if)\b|\{\{|\}\}|\{!!|<\/?(p|div|br|span)\b[^>]*>|lorem ipsum|TODO|placeholder text/gi) || []).slice(0, 5)` → raw template or markup fragments visible as text.
- **JS-CATFIELD** `(() => { const l = [...document.querySelectorAll('label')].find((x) => /categor/i.test(x.textContent) && x.getClientRects().length); if (!l) return 'no visible category label'; const c = l.control || (l.htmlFor && document.getElementById(l.htmlFor)) || l.querySelector('input, select, textarea, [role]'); if (!c) return 'no control'; return [c.tagName.toLowerCase(), c.getAttribute('type') || '', c.getAttribute('role') || '', c.getAttribute('list') ? 'datalist' : ''].join(':'); })()` → kind of the category field on an admin product form.
- **JS-QTYINPUTS** `[...document.querySelectorAll('input, select')].filter((e) => e.getClientRects().length && !e.disabled && !e.readOnly && (e.type === 'number' || /qty|quantity|menge/i.test((e.name || '') + ' ' + (e.id || '')))).length` → editable quantity fields on the page.
- **JS-NOJSON** `[...document.querySelectorAll('textarea, input[type="text"], input:not([type])')].filter((t) => t.getClientRects().length && (() => { const v = (t.value || '').trim(); if (!/^[\[{]/.test(v)) return false; try { const o = JSON.parse(v); return o !== null && typeof o === 'object'; } catch (e) { return false; } })()).length` → number of visible fields whose content is a JSON object or array.

### 0.8 Recording results

Fill in `results-template.json`. It has one entry per check, in plan order: `result` is `"PASS"` or `"FAIL"`, `observed` is the value or text you saw (for money, the amount as shown), and `note` is one line, required for FAIL. Also fill in `shop`, `evaluator` (agent and model), `started_at`, `finished_at` and `berlin_time_at_S06`. If you also produce a Markdown summary, use this table:

```
| ID | Result | Observed | Note |
|---|---|---|---|
| S01-01 | PASS | no price shown | |
| S03-06 | FAIL | €51.21 | gross 1 cent low |
```

Scoring is described in `weights.md`. The evaluator does not compute the score.

---

## S01 Storefront, catalog and search

Reset. Use two browser contexts: **G** (guest, never signed in) and **K** (signed in as C-10007). No orders are placed in this suite.

### @ [ACC] Guests see no prices {R:4}
- **Pre:** context G.
- **Do:** Open the product page of WAT-001 (find it through search or the category Water & Soft Drinks).
- **Expect:** No price visible for WAT-001 (0.4).

### @ [ACC] Guests cannot order {R:4}
- **Pre:** context G, WAT-001 page.
- **Expect:** There is no add-to-cart or order control for WAT-001.

### @ [ACC] Guests are invited to sign in or register {R:4}
- **Pre:** context G, WAT-001 page.
- **Expect:** The page shows a link or button whose text contains `sign in`, `log in`, `login` or `register`.

### @ [CAT] Home page shows active promotions {R:2}
- **Pre:** context G.
- **Do:** Open the home page.
- **Expect:** At least one of these promotion names is visible on the home page: `Beer Crate Bonus`, `Prosecco Carton Deal`, `Free Balsamic`.

### @ [CAT] Product page shows the VAT rate {R:3,89}
- **Pre:** context G, WAT-001 page.
- **Expect:** The page shows a VAT rate of `19 %` for the product (also `19%` or `19 % VAT`).

### @ [CAT] Category pages include subcategory products {R:11,12}
- **Pre:** context G.
- **Do:** Open the main category **Beverages** (not a subcategory). If it is paginated, look through all pages.
- **Expect:** BEER-001 (Pilsner, 0.5 l Glass) is listed.

### @ [CAT] Breadcrumb shows the category path {R:12}
- **Pre:** context G.
- **Do:** Open the subcategory **Beer**.
- **Expect:** A breadcrumb shows `Beverages` and then `Beer`, in that order.

### @ [CAT] Discontinued product is not shown in its category {R:9}
- **Pre:** context G.
- **Do:** Open the subcategory **Oils & Vinegars** and look through all pages.
- **Expect:** OIL-004 (Balsamic Vinegar) is listed and OIL-005 (White Wine Vinegar) is **not** listed.

### @ [CAT] Search: partial word {R:14,15}
- **Pre:** context G.
- **Do:** Search for `pils`.
- **Expect:** BEER-001 is among the results.

### @ [CAT] Search: SKU in lower case {R:14,15}
- **Pre:** context G.
- **Do:** Search for `wat-001`.
- **Expect:** WAT-001 is among the results.

### @ [CAT] Search: category filter {R:16}
- **Pre:** context G.
- **Do:** Search for `orange`, then filter the results by the category **Juices**.
- **Expect:** The filtered results contain JUI-002 and JUI-003 and do **not** contain SOFT-004 (Orange Soda).

### @ [CAT] Search without results says so {R:16}
- **Pre:** context G.
- **Do:** Search for `xyzzyq`.
- **Expect:** The page states that nothing was found. The text contains `no` or `nothing`, together with one of `result`, `product`, `found` or `match`.

### @ [CAT] Search without results suggests alternatives {R:16}
- **Pre:** the result page from the previous check.
- **Expect:** Outside the site header, the main navigation and the footer, the page shows at least one link to a category page or a product page.

### @ [CAT] Category sorting by price {R:13}
- **Pre:** context K (C-10007, list prices). Sorting by price is graded as a signed-in customer, because guests see no prices.
- **Do:** Open the subcategory **Sauces & Condiments** and sort by price, lowest first.
- **Expect:** The order is SAU-003 ({{~D_CAT.SAU003}}), SAU-004 ({{~D_CAT.SAU004}}), SAU-001 ({{~D_CAT.SAU001}}), SAU-002 ({{~D_CAT.SAU002}}).

### @ [INV] Availability label "low stock" {R:8,64}
- **Pre:** context K.
- **Do:** Open CAN-006 (Pesto alla Genovese). Its stock is 3 jars, below the default threshold of 10.
- **Expect:** The availability shown contains `low stock`.

### @ [INV] Availability label "out of stock" {R:8}
- **Pre:** context K.
- **Do:** Open JUI-005 (Multivitamin Juice).
- **Expect:** The product page is reachable and shows availability containing `out of stock`.

### @ [INV] Out-of-stock product cannot be ordered {R:8,104}
- **Pre:** context K, JUI-005 page.
- **Do:** Try to add 1 carton of JUI-005 to the cart.
- **Expect:** The add-to-cart control is missing or disabled, or the attempt is rejected. Afterwards the cart contains no JUI-005 line.

### @ [INV] Availability label "backorder" {R:8,104}
- **Pre:** context K.
- **Do:** Open FRZ-006 (Mixed Berries, stock 0, backorderable).
- **Expect:** The availability shown contains `backorder`.

### @ [PRICE] Prices are labelled as net {R:6}
- **Pre:** context K, WAT-001 page.
- **Expect:** The product price is labelled with `excl. VAT`, `excl VAT` or `excluding VAT`.

### @ [DEP] Deposit shown separately on the product page {R:3,6,77}
- **Pre:** context K, WAT-001 page.
- **Expect:** The bottle deposit is {{D_CAT.WAT001_dep_bottle}}. The bottle price is {{D_CAT.WAT001_bottle}}. The deposit is labelled as deposit (`deposit` or `Pfand`) and shown separately from the price, not added into it.

### @ [FRAC] Price per litre for products sold by volume {R:7,72}
- **Pre:** context K.
- **Do:** Open JUI-003 (Freshly Pressed Orange Juice).
- **Expect:** The price is shown as {{D_CAT.JUI003_litre}} per litre (`/l`, `per l`, `per litre` or `per liter`).

### @ [PRICE] Comparison unit price for packaged goods {R:7}
- **Pre:** context K.
- **Do:** Open WAT-002 (Still Mineral Water). The crate costs {{D_CAT.WAT002_crate}} for 18 × 1 l.
- **Expect:** The page shows a comparison price of {{D_CAT.WAT002_crate_per_bottle}} per litre or per bottle for the crate.

### @ [PRICE] Quantity price tiers are shown on the product page {R:81}
- **Pre:** context K.
- **Do:** Open SOFT-001 (Cola).
- **Expect:** The tier price from 10 trays is {{D_CAT.SOFT001_tier10}}. The tier price from 50 trays is {{D_CAT.SOFT001_tier50}}. Both tiers are visible at the same time.

### @ [UIQ] Page language is declared {R:10}
- **Pre:** context G, home page.
- **Do:** DOM JS-LANG.
- **Expect:** A non-empty string.

### @ [UIQ] Home page has exactly one h1 {R:10}
- **Pre:** context G, home page.
- **Do:** DOM JS-H1.
- **Expect:** `1`.

### @ [UIQ] Images on the home page have alt attributes {R:10}
- **Pre:** context G, home page.
- **Do:** DOM JS-ALT.
- **Expect:** `0`.

### @ [UIQ] Product image has a text alternative {R:10,3}
- **Pre:** context G, WAT-001 page.
- **Do:** DOM JS-MAINIMG.
- **Expect:** A non-empty string.

### @ [UIQ] Sign-in form fields are labelled {R:10}
- **Pre:** context G, customer sign-in page.
- **Do:** DOM JS-LABEL.
- **Expect:** An empty list.

### @ [UIQ] Add to cart with the keyboard only {R:10}
- **Pre:** context K, cart emptied (CLEAR), WAT-001 page freshly loaded.
- **Do:** Without using the mouse, use at most 60 presses of Tab, Shift+Tab, arrow keys, Enter and Space to reach the add-to-cart control and add 1 bottle. Typing a quantity is allowed. Then open the cart.
- **Expect:** The cart contains WAT-001 as a single bottle with quantity 1.

---

## S02 Customer accounts and access control

Reset. Several browser contexts are used. Record the URLs mentioned.

### @ [ACC] Active customer can sign in and sees prices {R:5,20}
- **Pre:** fresh context.
- **Do:** Sign in as C-10007 and open WAT-001.
- **Expect:** The bottle price {{D_CAT.WAT001_bottle}} is visible.

### @ [ACC] Blocked customer cannot sign in {R:19}
- **Pre:** fresh context.
- **Do:** Try to sign in as C-10009 (Imbiss Ecke), then open WAT-001.
- **Expect:** No price visible on WAT-001, and no customer account page is accessible in this context.

### @ [ACC] Admin account cannot sign in to the storefront {R:49}
- **Pre:** fresh context.
- **Do:** Try to sign in on the **customer** sign-in form with the admin credentials, then open WAT-001.
- **Expect:** No price visible.

### @adminurl [ADM] Admin can sign in to the admin area {R:49}
- **Pre:** fresh context A.
- **Do:** Open the admin area (0.1 rule 2) and sign in as admin. Record the URL of the admin dashboard as **ADMINURL**.
- **Expect:** An admin dashboard or overview page is shown.

### @ [ACC] Customer cannot reach the admin area (URL check) {R:49}
- **Pre:** fresh context, signed in as C-10007.
- **Do:** Open ADMINURL.
- **Expect:** No admin content is shown (you see an error, a redirect, a sign-in form or the storefront).

### @ [ACC] Customer sees open balance {R:25}
- **Pre:** fresh context, signed in as C-10003; open the customer account page.
- **Expect:** The open balance {{D_CUST.C10003_balance}} is shown.

### @reg [ACC] Registration with all business fields {R:17}
- **Pre:** fresh context R (guest).
- **Do:** Register with these details:
  - company `Testküche Mitte GmbH`,
  - contact person `Paula Probe`,
  - email `einkauf@testkueche-mitte.example`,
  - password `Testkueche!2026` (repeat it if asked),
  - VAT ID `DE123456789`,
  - billing address and shipping address `Torstraße 1, 10119 Berlin, Germany`.

  Accept any terms the form requires.
- **Expect:** The shop confirms the registration. A success message or a signed-in account page is shown, and no validation error remains.

### @ [ACC] New registration starts without prices {R:18}
- **Pre:** context R. Sign in as the new user if you are not already signed in.
- **Do:** Open WAT-001.
- **Expect:** No price visible.

### @ [ADM] Staff see the new registration as pending {R:54,18}
- **Pre:** context A.
- **Do:** Find the customer `Testküche Mitte GmbH` in the admin area.
- **Expect:** It is shown with status pending (`pending`, `not approved` or `awaiting approval`).

### @ [ACC] After approval the customer sees prices {R:18,54}
- **Pre:** previous check.
- **Do:** As admin, approve `Testküche Mitte GmbH`. In context R, sign out, sign in again as the new user and open WAT-001.
- **Expect:** The bottle price {{PG_NEW.L1_unit}} is visible (group Standard).

### @ [ACC] Password reset email {R:20}
- **Pre:** fresh context (guest).
- **Do:** Use "forgot password" for `kontakt@spaetkauf-kanal.example`.
- **Expect:** MAIL(kontakt@spaetkauf-kanal.example, `http`) is met, and the mail contains a link.

### @ [ACC] Password can be reset through the link {R:20}
- **Pre:** previous check.
- **Do:** Open the link from that mail in the browser, set the new password `Kanal!Neu2026`, then sign in as C-10007 with the new password.
- **Expect:** Sign-in succeeds, and WAT-001 shows a price.

### @jana [ACC] Order of one company user … {R:21}
- **Pre:** fresh context J, signed in as Jana Petersen (C-10001).
- **Do:** ADD 1 × COF-001 carton and 3 × CAN-006 jar. Then ORDER(Pickup, Invoice). Record the order detail URL as **ORDERURL_J**.
- **Expect:** An order confirmation with an order number is shown.

### @ [ACC] … is visible to the other user of the same company {R:21,23}
- **Pre:** fresh context M, signed in as Mehmet Yilmaz (C-10001).
- **Do:** Open the order history.
- **Expect:** The order from @@jana is listed.

### @ [ACC] The other user gets the company's negotiated price {R:21,83}
- **Pre:** context M.
- **Do:** Open COF-001 or add 1 bag of it to the cart.
- **Expect:** The price per bag is {{P14.L1_unit}} (negotiated).

### @ [SHIP] Shipping to a country outside the delivery area is impossible {R:22,95}
- **Pre:** fresh context, signed in as C-10007. CLEAR, ADD 1 × WAT-002 crate.
- **Do:** Try to add the shipping address `1 Rue de Rivoli, 75001 Paris, France` and use it in checkout.
- **Expect:** No order can be placed to this address. Any of these counts: France cannot be selected, the address is refused, or checkout offers no shipping method for it.

### @ [ACC] Another customer cannot open a foreign order (URL check) {R:23,49}
- **Pre:** as admin, SHIP(the order of @@jana). Fresh context, signed in as C-10002.
- **Do:** Open ORDERURL_J.
- **Expect:** No data of that order is shown (you see an error, "not found", a redirect or an empty page). The order number and the lines of the @@jana order do **not** appear.

### @ [ACC] Another customer cannot open a foreign invoice (URL check) {R:23,48}
- **Pre:** context J. Open the order from @@jana and record the URL of its invoice (page or download) as **INVURL_J**. Then switch to the context signed in as C-10002.
- **Do:** Open INVURL_J.
- **Expect:** No invoice content is shown or downloaded. A file with the invoice data counts as FAIL.

### @ [SHIP] Cart persists across sessions {R:30}
- **Pre:** fresh context, signed in as C-10007. CLEAR, then ADD 1 × WAT-001 crate. Sign out.
- **Do:** In a **new** browser context, sign in as C-10007 and open the cart.
- **Expect:** The cart contains 1 crate of WAT-001.

### @reorder [ORD] Reorder in one step {R:24}
- **Pre:** context J (Jana). CLEAR. The order from @@jana is shipped, so its 3 CAN-006 jars have left stock.
- **Do:** Use the reorder function on that order.
- **Expect:** The cart contains 1 carton of COF-001.

### @ [ORD] Reorder reports unavailable items {R:24}
- **Pre:** right after @@reorder.
- **Expect:** The shop shows a message that names CAN-006 or "Pesto" as unavailable or not added.

---

## S03 Prices, packaging units, deposits and fractional quantities

Reset. Most values are read in the **cart**. Values marked "review" are read on the final review page of REVIEW(Pickup), which has no shipping costs. Run CLEAR before every setup. No orders are placed.

**Setup P01:** signed in as C-10007, ADD 1 × WAT-001 crate, 1 × WAT-001 box of 6, 1 × WAT-001 bottle.

### @ [PRICE] Crate priced at the bottle price per bottle {R:26,29,66,67}
- **Pre:** Setup P01.
- **Expect:** The line total of the crate line is {{P01.L1_net}}.

### @ [DEP] Nested deposits: bottles plus crate {R:29,69,70,76}
- **Pre:** Setup P01.
- **Expect:** The cart's deposit total is {{P01.deposits}}.

### @ [VAT] Review gross total with deposits {R:41,90,91}
- **Pre:** Setup P01, REVIEW(Pickup).
- **Expect:** The gross total is {{P01.gross}}.

**Setup P02:** signed in as C-10002 (Gastronomy, 5 %), ADD 2 × WAT-001 crate.

### @ [PRICE] Group discount on the packaging-unit price, rounded per unit {R:5,82}
- **Pre:** Setup P02.
- **Expect:** The line total is {{P02.L1_net}}.

### @ [DEP] Deposits are not discounted by the group discount {R:78}
- **Pre:** Setup P02.
- **Expect:** The deposit total is {{P02.deposits}}.

**Setup P03:** signed in as C-10007, ADD 1 × BEER-002 crate, 1 × BEER-002 six-pack, 1 × BEER-002 bottle.

### @ [DEP] No deposit for the six-pack carrier {R:70}
- **Pre:** Setup P03.
- **Expect:** The six-pack line shows a deposit of {{P03.L2_dep}}.

### @ [DEP] Three-level packaging deposit total {R:69,70}
- **Pre:** Setup P03.
- **Expect:** The deposit total is {{P03.deposits}}.

**Setup P04:** signed in as C-10007, ADD 1 × SOFT-005 case and 1 × SOFT-005 pack of 4.

### @ [PRICE] Product sold only in certain packaging units {R:68}
- **Pre:** Setup P04, on the SOFT-005 product page.
- **Expect:** The single bottle cannot be selected. Only the pack of 4 and the case are offered.

### @ [INV] Stock check across packaging levels {R:28,69}
- **Pre:** CLEAR, signed in as C-10002. Spirits are restricted to Gastronomy and Key Account.
- **Do:** ADD 12 × SPI-004 carton and 3 × SPI-004 pack. That makes {{D_STOCK.SPI004_12c_3p}} bottles, with {{D_STOCK.SPI004_stock}} in stock.
- **Expect:** The combination is rejected. The cart does not hold both lines at those quantities, or checkout is blocked.

**Setup P07:** signed in as C-10007, ADD 7.5 l of JUI-003.

### @ [FRAC] Fractional volume accepted and priced {R:73}
- **Pre:** Setup P07.
- **Expect:** The line total is {{P07.L1_net}}. The cart holds the quantity 7.5 l.

### @ [DEP] Volume deposit: one canister per started 5 litres {R:80}
- **Pre:** Setup P07.
- **Expect:** The deposit total is {{P07.deposits}}.

### @ [DEP] Volume deposit for 5.5 litres {R:80}
- **Pre:** change the JUI-003 quantity to 5.5 l.
- **Expect:** The deposit total is {{P07b.deposits}}.

### @ [FRAC] Below minimum quantity is rejected {R:74,28}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** Try 1.5 l of JUI-003 (the minimum is 2 l).
- **Expect:** Rejected.

**Setup P08:** signed in as C-10007, ADD 2.5 kg of CHE-001.

### @ [FRAC] Weight quantity priced per kg {R:73,72}
- **Pre:** Setup P08.
- **Expect:** The line total is {{P08.L1_net}}.

### @ [FRAC] Quantity is shown with its unit {R:71}
- **Pre:** Setup P08.
- **Expect:** The cart line shows the quantity 2.5 together with `kg`.

### @ [FRAC] Fine weight step accepted {R:74}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** ADD 3.15 kg of CHE-001 (steps of 0.05 kg).
- **Expect:** Accepted, with the line total {{U1.L1_net}}.

### @ [FRAC] Weight off the fine step is rejected {R:74}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** Try 3.17 kg of CHE-001.
- **Expect:** Rejected.

### @ [FRAC] Weight above the maximum per line is rejected {R:74}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** Try 20.5 kg of CHE-001 (maximum 20 kg per order line).
- **Expect:** Rejected.

### @ [FRAC] Decimal comma accepted {R:74}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** Enter the quantity for CHE-001 as `3,15`, with a comma.
- **Expect:** The line total is {{U1.L1_net}}. The cart holds CHE-001 with the quantity 3.15 kg.

### @ [FRAC] Order in grams at the per-kg price {R:71,72}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** ADD 250 g of HERB-002 (Sweet Paprika), choosing grams as the unit.
- **Expect:** The line total is {{U2.L1_net}}. It is the same amount as for 0.25 kg.

### @ [FRAC] Gram step enforced {R:74}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** Try 275 g of HERB-002 (steps of 50 g).
- **Expect:** Rejected.

### @ [PRICE] Half-cent rounding of a group price per kg {R:82}
- **Pre:** CLEAR, signed in as C-10002. ADD 2.5 kg of CHE-001.
- **Expect:** The line total is {{P08g.L1_net}}.

**Setup P11:** signed in as C-10007, ADD 10 × SOFT-001 tray.

### @ [PRICE] Quantity tier applied in the cart {R:81}
- **Pre:** Setup P11.
- **Expect:** The line total is {{P11.L1_net}}, which uses the tier unit price {{P11.L1_unit}}.

**Setup P14:** signed in as Jana (C-10001), ADD 1 × COF-001 bag and 3 × COF-001 carton.

### @ [PRICE] Negotiated per-bag price also inside cartons {R:83}
- **Pre:** Setup P14.
- **Expect:** The carton line total is {{P14.L2_net}}. That is 3 × {{~P14.L2_unit}}: the negotiated price is final, so no tier price and no group discount apply.

### @ [PRICE] Negotiated price only for one packaging unit {R:83}
- **Pre:** CLEAR, signed in as Jana (C-10001). ADD 1 × FRZ-001 bag.
- **Expect:** The line total is {{P15.L1_net}}: normal price with group discount, rounded half-up.

**Setup P17:** signed in as C-10004, ADD 1 × WINE-005 carton, 1 × WAT-002 crate, 1 × WAT-002 box of 6, 1 × SPI-005 bottle.

### @ [PRICE] Negotiated per-bottle price applied to a carton {R:83}
- **Pre:** Setup P17.
- **Expect:** The WINE-005 carton line total is {{P17.L1_net}}.

### @ [PRICE] Negotiated crate price {R:83}
- **Pre:** Setup P17.
- **Expect:** The WAT-002 crate line total is {{P17.L2_net}}.

### @ [PRICE] Box of the same product at normal pricing with group discount {R:83,82}
- **Pre:** Setup P17.
- **Expect:** The WAT-002 box line total is {{P17.L3_net}}.

### @ [INV] Maximum quantity per order {R:28}
- **Pre:** Setup P17.
- **Do:** Change the SPI-005 quantity to 3 bottles (maximum 2 per order).
- **Expect:** Rejected.

### @ [PRICE] Retail group discount with half-cent rounding {R:82}
- **Pre:** CLEAR, signed in as C-10006. ADD 1 × OIL-001 tin.
- **Expect:** The line total is {{P19.L1_net}}.

### @ [PRICE] Product excluded from discounts keeps its list price {R:87}
- **Pre:** CLEAR, signed in as C-10004 (Key Account, 8 %). ADD 1 × SOFT-006 tray.
- **Expect:** The line total is {{P20.L1_net}}.

### @ [SHIP] Switch the packaging unit of a cart line {R:27}
- **Pre:** CLEAR, signed in as C-10007. ADD 1 × WAT-002 bottle.
- **Do:** In the cart, change this line's packaging unit to crate, with quantity 1. Removing the line and adding a crate does not count.
- **Expect:** The cart has one WAT-002 line, the crate, with line total {{P24.L1_net}}.

### @ [SHIP] Quick order by SKU {R:33}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** Use the quick-order function (SKU plus quantity entry) to add `WAT-002` with quantity 2, in any packaging unit.
- **Expect:** The cart contains a WAT-002 line with quantity 2.

### @ [INV] Stock limit in base units {R:28,65,66}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** Try to add 6 × WAT-001 crate. That is {{D_STOCK.WAT001_after_6crates}} bottles, with {{D_STOCK.WAT001}} in stock.
- **Expect:** Rejected.

**Setup P22:** signed in as C-10002, ADD 2 × OIL-001 tin and 1 × WAT-001 crate, then REVIEW(Pickup).

### @ [VAT] VAT 7 % in a mixed cart {R:89,90}
- **Pre:** Setup P22.
- **Expect:** VAT 7 % is {{P22.vat7}}.

### @ [VAT] VAT 19 % including the deposit {R:90,91}
- **Pre:** Setup P22.
- **Expect:** VAT 19 % is {{P22.vat19}}.

### @ [VAT] Gross total of a mixed-rate cart {R:41,90}
- **Pre:** Setup P22.
- **Expect:** The gross total is {{P22.gross}}.

### @ [VAT] Product-specific VAT rate: dairy milk 7 %, oat drink 19 % {R:89}
- **Pre:** CLEAR, signed in as C-10007. ADD 1 × DAI-001 case and 1 × DAI-002 case, then REVIEW(Pickup).
- **Expect:** VAT 19 % is {{P23.vat19}}.

**Setup PAL1:** signed in as C-10007, ADD 1 × DAI-010 pallet (60 crates, 360 bottles), REVIEW(Pickup).

### @ [DEP] Deposits on three levels including the pallet {R:69,70}
- **Pre:** Setup PAL1.
- **Expect:** The deposit total is {{PAL1.deposits}}.

### @ [VAT] Pallet deposit always at 19 %, even on milk {R:91}
- **Pre:** Setup PAL1.
- **Expect:** VAT 19 % is {{PAL1.vat19}}.

### @ [VAT] Bottle and crate deposits on milk at 7 % {R:91}
- **Pre:** Setup PAL1.
- **Expect:** VAT 7 % is {{PAL1.vat7}}.

### @ [PROMO] Crates on a pallet do not count for the crate bonus {R:85,69}
- **Pre:** CLEAR, signed in as C-10007. ADD 1 × BEER-001 pallet and 6 × BEER-001 crate.
- **Expect:** The beer promotion discount is {{PAL2.auto}}. That is one free single crate; nothing for the pallet.

### @ [DEP] Pallet and crate deposits for beer {R:69,70}
- **Pre:** previous check.
- **Expect:** The deposit total is {{PAL2.deposits}}.

### @ [INV] Pallet quantities checked against stock in bottles {R:69,28}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** Try to add 4 × WAT-002 pallet ({{D_STOCK.WAT002_4pallets}} bottles, {{D_STOCK.WAT002_stock}} in stock).
- **Expect:** Rejected.

### @ [SHIP] Pallets only by truck or pickup {R:129}
- **Pre:** CLEAR, signed in as C-10007. ADD 1 × WAT-002 pallet. Start checkout.
- **Expect:** Parcel is not offered.

---

## S04 Promotions

Reset. Run CLEAR before every setup. Checks marked "review" use REVIEW(Pickup). Run the checks in the order written: some of them place orders that later checks depend on.

**Setup A01:** signed in as C-10007, ADD 6 × BEER-001 crate.

### @ [PROMO] Beer 6-for-5: one crate free {R:85,88}
- **Pre:** Setup A01.
- **Expect:** The cart shows a discount of {{A01.auto}} for the beer promotion.

### @ [PROMO] Automatic promotion shown by name {R:88}
- **Pre:** Setup A01.
- **Expect:** The cart shows the name `Beer Crate Bonus` (or the full name `Beer Crate Bonus — Buy 6, Pay 5`).

### @ [DEP] Deposits charged for free crates too {R:78}
- **Pre:** Setup A01.
- **Expect:** The deposit total is {{A01.deposits}}, which covers all 6 crates.

**Setup A05:** signed in as C-10002, ADD 2 × WINE-005 carton.

### @ [PROMO] Prosecco Carton Deal {R:85}
- **Pre:** Setup A05.
- **Expect:** The discount is {{A05.auto}}.

### @ [PROMO] Prosecco deal not applied to a negotiated-price line {R:84}
- **Pre:** CLEAR, signed in as C-10004. ADD 2 × WINE-005 carton.
- **Do:** REVIEW(Pickup).
- **Expect:** The gross total is {{A07.gross}}. This is the total without any Prosecco discount.

**Setup A08:** signed in as C-10007, ADD 3 × OIL-001 carton, 1 × SAU-001 carton, 1 × DRY-005 pack. The goods value is exactly {{A08.goods}}.

### @ [PROMO] Free balsamic bottle at a goods value of 500.00 {R:85}
- **Pre:** Setup A08.
- **Expect:** The cart contains a line with OIL-004 (Balsamic Vinegar) at no charge (a zero-amount line or a free-item line naming it).

### @ [PROMO] Free item threshold uses the goods value after group discount {R:86}
- **Pre:** CLEAR, signed in as C-10002. ADD the same lines as Setup A08. The goods value after the 5 % group discount is {{A10.goods}}.
- **Expect:** There is **no** free OIL-004 line.

### @ [PROMO] Automatic promotion then code on the remaining amount {R:85,88}
- **Pre:** CLEAR, signed in as C-10007. ADD 6 × BEER-001 crate, then apply code `BEER15`.
- **Expect:** The BEER15 discount (or the combined discount, if the shop shows only one discount figure) is {{A11.code|A11.discounts}}.

### @ [PROMO] Removing a code {R:31}
- **Pre:** previous check.
- **Do:** Remove the code BEER15.
- **Expect:** The gross total in REVIEW(Pickup) is {{A01.gross}}. BEER15 is no longer shown as applied.

**Setup C01:** signed in as C-10002, ADD 2 × COF-002 carton and 1 × WINE-006 bottle (excluded from discounts). Apply the code as `welcome10`, in lower case.

### @ [PROMO] Code entry is case-insensitive; percentage on eligible goods {R:85,87}
- **Pre:** Setup C01.
- **Expect:** The code is applied with a discount of {{C01.code}}.

### @c01order [PROMO] Order with WELCOME10 shows the code on the order {R:88}
- **Pre:** Setup C01. ORDER(Pickup, Card).
- **Expect:** The order detail page in the customer account shows `WELCOME10`.

### @ [PROMO] WELCOME10 only for the first order {R:86}
- **Pre:** after @@c01order, signed in as C-10002. ADD the lines of Setup C01 again.
- **Do:** Apply `WELCOME10`.
- **Expect:** Rejected.

### @ [PROMO] Group-restricted code for the wrong group {R:86}
- **Pre:** CLEAR, signed in as C-10007. ADD 2 × OIL-001 carton. Apply `GASTRO25`.
- **Expect:** Rejected.

**Setup C03:** signed in as C-10007, ADD 7 × DRY-004 carton (7 %) and 3 × WINE-004 bag-in-box (19 %). Apply `SAVE20`. Go to REVIEW(Pickup).

### @ [PROMO] Fixed discount {R:85}
- **Pre:** Setup C03.
- **Expect:** The SAVE20 discount is {{C03.code}}.

### @ [VAT] Fixed discount split across VAT rates: 7 % {R:91}
- **Pre:** Setup C03.
- **Expect:** VAT 7 % is {{C03.vat7}}.

### @ [VAT] Fixed discount split across VAT rates: 19 % {R:91}
- **Pre:** Setup C03.
- **Expect:** VAT 19 % is {{C03.vat19}}.

### @ [VAT] Discount split rounding: difference to the largest share {R:91}
- **Pre:** CLEAR, signed in as C-10007. ADD 15 × VEG-004 lemon (7 %) and 4 × NF-003 pack (19 %), apply `B2B7`, REVIEW(Pickup). [[Reviewer note: the discount {{~DS1.code}} splits by value into 0.335 and 1.005; both round up and overshoot by one cent, so the larger 19 % share is reduced: {{~DS1.share7}} (7 %) and {{~DS1.share19}} (19 %).]]
- **Expect:** VAT 19 % is {{DS1.vat19}}.

### @ [PROMO] Only one code per order {R:88}
- **Pre:** Setup C03, back in the cart with SAVE20 applied.
- **Do:** Also apply `B2B7`.
- **Expect:** Exactly one code is shown as applied. The total code discount (SAVE20 kept, or B2B7 instead) is {{C03.code|C20.code}}.

### @save20order [PROMO] Code usage per customer {R:86}
- **Pre:** Restore Setup C03 with only SAVE20 applied, then ORDER(Pickup, Card). Then CLEAR and ADD the lines of Setup C03 again.
- **Do:** Apply `SAVE20`.
- **Expect:** Rejected (once per customer).

### @ [PROMO] Cancelling the order gives the code use back {R:86,46}
- **Pre:** after @@save20order, signed in as C-10007. Cancel the SAVE20 order in the customer account.
- **Do:** With the Setup C03 lines in the cart, apply `SAVE20` again.
- **Expect:** Applied with a discount of {{C03.code}}.

### @ [PROMO] Code removed when the cart no longer qualifies {R:32}
- **Pre:** previous check (SAVE20 applied).
- **Do:** Remove the WINE-004 line. The goods value drops to {{C04.goods}}, below 200.00.
- **Expect:** SAVE20 is no longer applied. The gross total in REVIEW(Pickup) is {{C04.gross}}.

### @ [PROMO] Category code with a category minimum {R:85,86}
- **Pre:** CLEAR, signed in as C-10007. ADD 5 × FRZ-004 tub and 1 × FIS-001 pack. Apply `FROZEN10`.
- **Expect:** The discount is {{C06.code}}. Fish is not discounted.

### @ [PROMO] Category minimum not reached (fish does not count) {R:86}
- **Pre:** CLEAR, signed in as C-10007. ADD 4 × FRZ-004 tub and 2 × FIS-001 pack. Apply `FROZEN10`.
- **Expect:** No discount from FROZEN10. In REVIEW(Pickup) the gross total is {{C07.gross}}.

### @ [PROMO] Per-unit discount with a cap {R:85,86}
- **Pre:** CLEAR, signed in as C-10007. ADD 6 × COF-001 carton (36 bags). Apply `ESPRESSO2`. This cart also qualifies for the free balsamic bottle.
- **Expect:** The ESPRESSO2 discount is {{C09.code}}.

### @ [PROMO] No promotion on negotiated-price lines {R:84}
- **Pre:** CLEAR, signed in as C-10003. ADD 2 kg of CHE-002 (negotiated). Apply `KAESE1`.
- **Expect:** No discount from KAESE1. The gross total in REVIEW(Pickup) is {{C12.gross}}.

### @ [PROMO] Key Account wine code; negotiated line not eligible {R:86,84}
- **Pre:** CLEAR, signed in as C-10004. ADD 1 × WINE-001 carton and 1 × WINE-005 carton. Apply `KEYWINE12`.
- **Expect:** The discount is {{C14.code}}.

### @ [PROMO] Customer-specific code rejected for another customer {R:86}
- **Pre:** CLEAR, signed in as C-10002. ADD 1 × OIL-001 carton. Apply `LINDNER2026`.
- **Expect:** Rejected.

### @ [PROMO] Fixed discount capped at the eligible goods value {R:85}
- **Pre:** CLEAR, signed in as C-10007. ADD 1 × NF-001 sleeve. Apply `TENOFF`.
- **Expect:** The discount is {{C19.code}}.

**Setup INV:** signed in as C-10007, ADD 1 × OIL-001 carton and 1 × COF-002 carton (goods {{SH03.goods}}). Each of the following codes is entered on this cart, and a rejected code is removed before the next one is tried.

### @ [PROMO] Expired code rejected {R:86}
- **Pre:** Setup INV.
- **Do:** Apply `SUMMER25`.
- **Expect:** Rejected.

### @ [PROMO] Expired code: customer is told {R:86}
- **Pre:** previous check.
- **Expect:** A message is shown that contains one of `expired`, `invalid`, `not valid` or `no longer`.

### @ [PROMO] Not-yet-valid code rejected {R:86}
- **Pre:** Setup INV.
- **Do:** Apply `NEWYEAR2028`.
- **Expect:** Rejected.

### @ [PROMO] Deactivated code rejected {R:86}
- **Pre:** Setup INV.
- **Do:** Apply `OLDCODE`.
- **Expect:** Rejected.

### @first50 [PROMO] Code with a global usage limit: first use {R:86}
- **Pre:** CLEAR, signed in as Jana (C-10001). ADD 3 × OIL-001 carton. Apply `FIRST50`.
- **Expect:** The discount is {{C17.code}}.

### @ [PROMO] Global-limit code: once per customer {R:86}
- **Pre:** after @@first50, place that cart with FIRST50 applied: ORDER(Pickup, Invoice). Then, still signed in as Jana, ADD 3 × OIL-001 carton.
- **Do:** Apply `FIRST50`.
- **Expect:** Rejected.

### @ [PROMO] Global usage limit of 3 uses {R:86}
- **Pre:** Signed in as C-10004: CLEAR, ADD 3 × OIL-001 carton, apply `FIRST50` (expected discount {{C17b.code}}), ORDER(Pickup, Invoice). Then signed in as C-10007: CLEAR, ADD 3 × OIL-001 carton, apply `FIRST50` (expected {{C17c.code}}), ORDER(Pickup, Card). If either of these two orders cannot be placed with FIRST50 applied, this check is FAIL (`blocked`).
- **Do:** Signed in as C-10002: CLEAR, ADD 3 × OIL-001 carton, apply `FIRST50`.
- **Expect:** Rejected.

### @ [ADM] Staff can monitor promotion usage {R:56,119}
- **Pre:** previous check. Admin context.
- **Do:** Open the promotions or codes management in the admin area and look at FIRST50.
- **Expect:** It shows 3 uses (or 0 remaining of 3).

---

## S05 Shipping, VAT and checkout rules

Reset. Run CLEAR before every setup. "Methods" means the shipping methods offered at checkout for the default shipping address, unless another address is named.

**Setup SH03:** signed in as C-10007, ADD 1 × OIL-001 carton and 1 × COF-002 carton (goods {{SH03.goods}}). Start checkout.

### @ [SHIP] Truck offered for a Berlin address {R:95}
- **Pre:** Setup SH03.
- **Expect:** Truck is offered.

### @ [SHIP] Free truck delivery from 250.00 goods value {R:93}
- **Pre:** Setup SH03, REVIEW(Truck).
- **Expect:** The shipping amount is {{SH03.shipping}}.

### @ [SHIP] Free-shipping threshold uses goods value before promotions {R:78,93}
- **Pre:** Setup SH03, apply `SAVE20`, REVIEW(Truck).
- **Expect:** The shipping amount is {{SH04.shipping}}.

### @ [SHIP] Free-shipping threshold uses goods value after group discount {R:93}
- **Pre:** CLEAR, signed in as C-10002. ADD 1 × OIL-001 carton and 1 × COF-002 carton (goods after discount {{SH02.goods}}). REVIEW(Truck).
- **Expect:** The shipping amount is {{SH02.shipping}}.

### @ [VAT] Shipping takes the VAT rate of single-rate goods {R:91}
- **Pre:** previous check.
- **Expect:** VAT 7 % is {{SH02.vat7}}. This includes the shipping fee: all goods are 7 %, so the shipping fee is taxed at 7 %.

### @ [VAT] Shipping split across VAT rates: 7 % {R:91}
- **Pre:** CLEAR, signed in as C-10007. ADD 1 × COF-002 carton (7 %) and 1 × WINE-001 carton (19 %), goods {{SHV.goods}}. REVIEW(Truck). [[Reviewer note: the fee {{~SHV.shipping}} splits into {{~SHV.ship7}} at 7 % and {{~SHV.ship19}} at 19 %.]]
- **Expect:** VAT 7 % is {{SHV.vat7}}.

### @ [VAT] Shipping split across VAT rates: 19 % {R:91}
- **Pre:** previous check.
- **Expect:** VAT 19 % is {{SHV.vat19}}.

### @ [SHIP] Minimum order value excludes deposits {R:36,78}
- **Pre:** CLEAR, signed in as C-10007. ADD 3 × WAT-001 crate. Goods are {{SH01.goods}}; with deposits {{SH01.deposits}} the sum exceeds 100.00.
- **Expect:** Truck is not offered, or checkout refuses it because of the minimum order value.

### @ [SHIP] Chilled product blocks parcel shipping {R:35,96}
- **Pre:** Setup SH03, then also ADD 1 kg of CHE-001 (chilled).
- **Expect:** Parcel is not offered.

### @ [SHIP] Truck depends on the chosen shipping address: outside the area {R:22,95}
- **Pre:** CLEAR, signed in as C-10004. ADD 1 × OIL-001 carton. Start checkout and choose the address in Rostock (Seestraße 10, 18119).
- **Expect:** Truck is not offered.

**Setup SH05:** signed in as C-10007, ADD 3 × DRY-002 sack (bulky) and 1 × DRY-005 pack. REVIEW(Parcel).

### @ [SHIP] Bulky surcharge per bulky item on parcel {R:94}
- **Pre:** Setup SH05.
- **Expect:** The shipping amount (fee plus surcharge) is {{SH05.shipping}}.

### @ [SHIP] Express not offered with bulky items {R:35,94}
- **Pre:** Setup SH05, back to the shipping method step.
- **Expect:** Express is not offered.

### @ [SHIP] FREESHIP waives the base fee but not the bulky surcharge {R:85,94}
- **Pre:** CLEAR, signed in as C-10007. ADD 6 × DRY-002 sack and 1 × DRY-005 pack. Apply `FREESHIP`. REVIEW(Parcel).
- **Expect:** The shipping amount is {{SH07.shipping}}.

### @ [SHIP] EXPRESSHALF halves the express fee {R:85}
- **Pre:** CLEAR, signed in as C-10007. ADD 1 × OIL-001 carton. Apply `EXPRESSHALF`. REVIEW(Express).
- **Expect:** The shipping amount is {{SH09b.shipping}}.

**Setup SH11:** signed in as C-10005 (Vienna, verified VAT ID), ADD 2 × OIL-001 carton. REVIEW(EU).

### @ [SHIP] EU Parcel offered for an Austrian address {R:93,95}
- **Pre:** Setup SH11.
- **Expect:** The review with EU as the shipping method shows the shipping amount {{SH11.shipping}}.

### @ [VAT] Reverse charge: 0 % VAT {R:92}
- **Pre:** Setup SH11.
- **Expect:** Either the VAT total shown is zero, or no VAT amount is charged at all and the page refers to reverse charge or 0 %. Both forms pass.

### @ [VAT] Reverse charge gross total {R:92}
- **Pre:** Setup SH11.
- **Expect:** The gross total is {{SH11.gross}}.

### @ [SHIP] Deposit product blocks EU Parcel {R:97}
- **Pre:** Setup SH11, then also ADD 1 × WAT-001 crate. Back to the shipping method step.
- **Expect:** EU is not offered.

### @ [SHIP] Checkout names the deposit product that blocks the method {R:35,97}
- **Pre:** previous check.
- **Expect:** The checkout or cart names `WAT-001` or `Sparkling Mineral Water` in connection with the unavailable method.

**Setup SH12:** signed in as C-10006 (Amsterdam, no VAT ID), ADD 2 × OIL-001 carton. REVIEW(EU).

### @ [VAT] EU customer without VAT ID pays German VAT {R:92}
- **Pre:** Setup SH12.
- **Expect:** VAT 7 % is {{SH12.vat7}}.

**Setup SH15:** signed in as C-10007, ADD 1 × COF-002 carton, 2 × TEA-001 box and 1 × SOFT-002 tray.
- At checkout choose Truck (earliest date, first slot).
- Enter the purchase order reference `PO-4711` and the delivery note `Please use the rear entrance`.
- Mark the SOFT-002 line as "substitute acceptable" (SOFT-002 names SOFT-001 as its substitute).
- Pay by Card and place the order (ORDER).

### @ [VAT] Order gross total including truck fee {R:34,41,93}
- **Pre:** Setup SH15, order confirmation or order detail.
- **Expect:** The gross total is {{SH15.gross}}.

### @ [SHIP] Purchase order reference stored with the order {R:38}
- **Pre:** Setup SH15, customer order detail page.
- **Expect:** `PO-4711` is shown.

### @ [SHIP] Substitution permission per line visible to staff {R:39}
- **Pre:** Setup SH15, admin order view.
- **Expect:** The SOFT-002 line is marked as substitution allowed, and COF-002 is not.

### @rcorder [VAT] Reverse-charge invoice note {R:48,92}
- **Pre:** Signed in as C-10005, CLEAR, ADD 2 × OIL-001 carton, ORDER(EU, Invoice). As admin, SHIP the order. Open the invoice in the customer account (or in the admin area if the customer cannot open it).
- **Expect:** The invoice contains `reverse charge`.

### @ [VAT] Reverse-charge invoice total {R:48,92}
- **Pre:** the invoice from @@rcorder.
- **Expect:** The invoice gross total is {{SH11.gross}}.

---

## S06 Delivery dates and slots

Reset. Immediately before each check that uses E or L, note the Berlin time and compute E and L (0.6) for that moment. A date that a check has booked is a stored fixture value (**D1** below): later checks use D1, never a recomputed E. "Next Saturday" and "next Sunday" are the first Saturday and Sunday after today.

**Setup D:** signed in as C-10007, ADD 1 × OIL-001 carton, start checkout, choose Truck.

### @ [SHIP] Earliest delivery date follows the cut-off rule {R:37,98}
- **Pre:** Setup D.
- **Expect:** The earliest selectable delivery date is E.

### @ [SHIP] No truck delivery on Saturdays {R:98}
- **Pre:** Setup D.
- **Expect:** Next Saturday cannot be selected.

### @ [SHIP] Latest delivery date can be chosen {R:37}
- **Pre:** Setup D.
- **Expect:** L can be selected.

### @ [SHIP] No date beyond 14 days {R:37}
- **Pre:** Setup D.
- **Expect:** No date after today + 14 days can be selected.

### @ [SHIP] Delivery slots {R:37,98}
- **Pre:** Setup D, date E chosen.
- **Expect:** Exactly these three slots are offered: 06:00–09:00, 09:00–12:00 and 12:00–15:00 (any time notation).

### @ [SHIP] Pickup possible on Saturday {R:37}
- **Pre:** Setup D, switch to Pickup.
- **Expect:** The first Saturday after today that is not a Berlin public holiday (0.6) can be selected as the pickup date.

### @cap [ADM] Staff can limit slot capacity {R:57}
- **Pre:** admin context.
- **Do:** Set the capacity of the truck slot 06:00–09:00 to 1 order. If the shop only has one capacity setting for all slots, set that to 1.
- **Expect:** The new capacity is saved and shown as 1.

### @slotorder [SHIP] Order stores date and slot {R:37}
- **Pre:** after @@cap. Signed in as C-10007, CLEAR, ADD 1 × OIL-001 carton. ORDER(Truck, Card), choosing date E and slot 06:00–09:00. Note the chosen date as **D1**.
- **Expect:** The order detail shows delivery date D1 and the slot 06:00–09:00.

### @ [SHIP] Full slot cannot be chosen {R:98}
- **Pre:** after @@slotorder. Signed in as C-10002, CLEAR, ADD 1 × OIL-001 carton, start checkout, choose Truck and date D1. If D1 is no longer offered at all (the cut-off passed since @@slotorder), repeat the steps of @@slotorder with the current E, note that date as the new D1, and start this check again.
- **Expect:** The slot 06:00–09:00 cannot be selected for D1.

### @ [SHIP] Other slots remain available {R:98}
- **Pre:** previous check.
- **Expect:** The slot 09:00–12:00 can be selected for D1.

---

## S07 Payments

Reset. Run CLEAR before every setup. "Payment methods" are the ones offered at checkout after the shipping step.

### @ [PAY] No invoice payment without permission {R:40}
- **Pre:** signed in as C-10002. ADD 1 × OIL-001 tin, checkout with Pickup.
- **Expect:** Purchase on invoice is not offered.

### @ [PAY] Invoice payment for approved customers {R:40}
- **Pre:** signed in as Jana (C-10001). ADD 1 × OIL-001 tin, checkout with Pickup.
- **Expect:** Purchase on invoice is offered.

### @ [PAY] Invoice allowed within the remaining credit {R:40,25}
- **Pre:** signed in as C-10003. ADD 12 × SAU-002 bucket, checkout with Pickup. The gross total is {{PA01.gross}}; the headroom is {{D_CUST.C10003_headroom}}.
- **Expect:** Purchase on invoice is offered.

### @ [PAY] Invoice blocked above the remaining credit {R:40}
- **Pre:** signed in as C-10003. CLEAR, ADD 13 × SAU-002 bucket, checkout with Pickup. The gross total is {{PA02.gross}}.
- **Expect:** Purchase on invoice is not offered.

### @ [PAY] Cash on pickup offered with warehouse pickup {R:40}
- **Pre:** signed in as C-10007. ADD 1 × OIL-001 carton, checkout with Pickup.
- **Expect:** Cash on pickup is offered.

**Setup CARD:** signed in as C-10007, ADD 1 × OIL-001 tin and 1 × WAT-002 crate, REVIEW(Pickup), choose Credit card.

### @ [PAY] Declined card shows the reason {R:42}
- **Pre:** Setup CARD.
- **Do:** Pay with `4000 0000 0000 0002`.
- **Expect:** A message containing `declined` is shown.

### @ [PAY] Declined payment creates no confirmed order {R:42}
- **Pre:** previous check.
- **Do:** Open the order history.
- **Expect:** No order with the state confirmed (or paid) exists.

### @ [PAY] Cart kept after a declined payment {R:42}
- **Pre:** previous check.
- **Expect:** The cart, or the resumed checkout, still contains OIL-001 and WAT-002.

### @ [PAY] Insufficient funds message {R:42}
- **Pre:** Setup CARD, from the cart kept.
- **Do:** Pay with `4000 0000 0000 9995`.
- **Expect:** A message containing `insufficient funds` is shown.

### @cardok [PAY] Retry with another card succeeds {R:42}
- **Pre:** Setup CARD, from the cart kept.
- **Do:** Pay with `4242 4242 4242 4242`.
- **Expect:** The order is placed, and its state is confirmed.

### @ [PAY] Card payment is authorised at order placement {R:100,169}
- **Pre:** after @@cardok, customer order detail.
- **Expect:** The payment status is `authorised` (or `authorized`); nothing is captured yet.

### @ [PAY] Declined attempts are recorded {R:59}
- **Pre:** after @@cardok, admin context.
- **Do:** Open that order, or the payment records of C-10007.
- **Expect:** At least one declined card attempt is listed, with result declined or failed.

### @ [PAY] Invalid IBAN rejected {R:40}
- **Pre:** signed in as C-10006. ADD 1 × OIL-001 tin, REVIEW(Pickup), choose SEPA direct debit.
- **Do:** Enter holder `Pieter de Vries` and IBAN `DE00 1234 5678 9012 3456 78`, accept the mandate and place the order.
- **Expect:** The IBAN is refused, and no order is placed.

### @sepa [PAY] Valid IBAN confirms the order {R:40}
- **Pre:** previous check.
- **Do:** Enter IBAN `DE89 3704 0044 0532 0130 00` and place the order.
- **Expect:** The order state is confirmed.

### @ [PAY] SEPA order payment status open {R:100}
- **Pre:** after @@sepa, customer order detail.
- **Expect:** The payment status is `open`.

**Setup PRE:** signed in as C-10007, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Prepay).

### @ [PAY] Bank details shown for prepayment {R:43}
- **Pre:** Setup PRE, confirmation page or order detail.
- **Expect:** The IBAN `DE46 1005 0000 1234 5678 90` is shown (spacing may differ).

### @prepend [PAY] Prepayment order is pending payment {R:99,100}
- **Pre:** Setup PRE, customer order detail.
- **Expect:** The order state is `pending payment` (also `awaiting payment`).

### @ [ADM] Dashboard shows orders awaiting action {R:50}
- **Pre:** after @@prepend, admin dashboard.
- **Expect:** The prepayment order (by its order number) is shown on the dashboard in a list of orders awaiting action or payment. Alternatively, the dashboard shows a count of such orders, and opening it lists that order.

### @ [PAY] Staff record the prepayment; order becomes confirmed {R:59,99}
- **Pre:** after @@prepend, admin context.
- **Do:** Record the payment as received for that order.
- **Expect:** The customer's order detail now shows the state confirmed.

### @ [PAY] Invoice order confirmed with payment status open {R:100}
- **Pre:** signed in as Jana (C-10001), CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Invoice).
- **Expect:** The payment status is `open`.

---

## S08 Orders and fulfillment

Reset. Run the checks in order; the order numbers depend on it. Run CLEAR before every order.

**Setup O01:** signed in as C-10007, ADD 1 × WAT-002 crate and 1 × OIL-001 tin, ORDER(Pickup, Card).

### @ [ORD] First order number {R:44,43}
- **Pre:** Setup O01, confirmation page.
- **Expect:** The order number is `SG-10001`.

### @ [ORD] Confirmation email {R:43,47}
- **Pre:** Setup O01.
- **Expect:** MAIL(kontakt@spaetkauf-kanal.example, `SG-10001`) is met.

### @o02 [ORD] Sequential order number {R:44}
- **Pre:** signed in as C-10007, ADD 1 × OIL-001 tin, ORDER(Pickup, Card).
- **Expect:** The order number is `SG-10002`.

### @cancel [ORD] Customer cancels an unshipped order {R:46}
- **Pre:** signed in as C-10007.
- **Do:** Cancel SG-10002 in the customer account.
- **Expect:** SG-10002 shows the state `cancelled`.

### @ [ORD] Cancelled card order releases the authorisation {R:99,100,169}
- **Pre:** after @@cancel.
- **Expect:** The payment status of SG-10002 is `released` (the authorisation was released; nothing was charged).

### @ [ORD] Cancellation email {R:47}
- **Pre:** after @@cancel.
- **Expect:** MAIL(kontakt@spaetkauf-kanal.example, `SG-10002`) is met by an email other than the confirmation email. Its subject or body contains `cancel`.

### @ship1 [ORD] Shipped state visible to the customer {R:99,23}
- **Pre:** as admin, SHIP(SG-10001).
- **Expect:** In the customer account, SG-10001 shows the state `shipped`.

### @ [ORD] Shipping email {R:47}
- **Pre:** after @@ship1.
- **Expect:** MAIL(kontakt@spaetkauf-kanal.example, `SG-10001`) is met by an email whose subject or body contains `shipped` (or `dispatched`).

### @inv1 [ORD] Invoice number format {R:48}
- **Pre:** after @@ship1. Open the invoice of SG-10001 in the customer account.
- **Expect:** The invoice number is `INV-<current year>-00001`, for example `INV-2026-00001` in 2026.

### @ [VAT] Invoice gross total {R:48}
- **Pre:** invoice from @@inv1.
- **Expect:** The gross total is {{O01.gross}}.

### @ [DEP] Invoice shows deposits separately {R:48,77}
- **Pre:** invoice from @@inv1.
- **Expect:** The deposit amount is {{O01.deposits}}. It is shown separately from the goods.

### @ [ORD] Shipped order cannot be cancelled by the customer {R:46}
- **Pre:** after @@ship1, signed in as C-10007.
- **Do:** Try to cancel SG-10001.
- **Expect:** There is no cancel option, or the attempt is refused. SG-10001 is not cancelled.

### @ [ORD] Delivered state {R:99}
- **Pre:** as admin, DELIVER(SG-10001).
- **Expect:** In the customer account, SG-10001 shows `delivered` or `completed`.

### @ [ADM] Order history with time and staff member {R:60,58}
- **Pre:** admin context, order SG-10001.
- **Expect:** The order shows a history of at least two state changes. Each entry has a date and time, and the staff change is attributed to the admin (by name `Shop Administrator` or by email).

### @ [ORD] Order keeps its prices after a price change {R:45}
- **Pre:** As admin, change the crate price of WAT-002 to `20.25`.
- **Do:** As C-10007, open SG-10001.
- **Expect:** The WAT-002 line shows {{O01.L1_net}}.

**Setup O03:** signed in as Jana (C-10001), CLEAR, ADD 10 × BEER-005 keg (only {{D_STOCK.BEER005_stock}} in stock, backorderable) and 1 × WAT-001 crate, and apply `WELCOME10` (Jana's company has no earlier order in this suite). The goods value is above 500, so a free OIL-004 line may appear; that is expected. [[Reviewer note: the WELCOME10 discount is {{~O03.code}}.]]

### @ [INV] Backordered quantity marked in the cart {R:105}
- **Pre:** Setup O03, cart.
- **Expect:** The cart marks {{D_STOCK.BEER005_backordered}} kegs of BEER-005 as backordered (or "on backorder" / "delivered later").

### @o03 [VAT] Gross total of the backorder order {R:41}
- **Pre:** Setup O03, ORDER(Truck, Invoice). The order number should be SG-10003.
- **Expect:** The order's gross total is {{O03.gross}}.

### @partial [ORD] Partial shipment state {R:102,99}
- **Pre:** As admin, ship the order from @@o03 partly: {{D_STOCK.BEER005_stock}} kegs of BEER-005, the WAT-001 crate and the free OIL-004 line if there is one. Leave {{D_STOCK.BEER005_backordered}} kegs open.
- **Expect:** The order shows the state `partially shipped`.

### @inv31 [ORD] First shipment has its own invoice {R:48,102}
- **Pre:** after @@partial. Open the invoice created for this first shipment of the @@o03 order.
- **Expect:** The invoice gross total is {{O03i1.gross}}. It covers only the shipped goods and their deposits.

### @ [PROMO] Order discount allocated to the first invoice {R:48,88}
- **Pre:** invoice from @@inv31.
- **Expect:** The invoice shows the WELCOME10 discount share {{O03i1.discount}}.

### @ [ORD] Customer sees shipped and open quantities {R:102}
- **Pre:** after @@partial, Jana's order detail.
- **Expect:** The shipped quantity of BEER-005 is {{D_STOCK.BEER005_stock}}. The open quantity of BEER-005 is {{D_STOCK.BEER005_backordered}}.

### @ [ORD] Partial shipment email {R:47}
- **Pre:** after @@partial.
- **Expect:** MAIL(einkauf@osthafen-kueche.example, the order number of @@o03) is met by an email, other than the confirmation, whose subject or body contains `partial` or `shipped`.

### @ [INV] Staff see backorders that can now be fulfilled {R:106}
- **Pre:** after @@partial. As admin, receive 5 kegs of BEER-005 into stock, with the reason `supplier delivery`.
- **Expect:** The admin area shows the order of @@o03 as a backorder that can now be fulfilled: in a backorder list, a report, the dashboard, on the product or on the order.

### @ [ORD] Remaining quantity shipped completes the shipment {R:102}
- **Pre:** As admin, ship the remaining 2 kegs.
- **Expect:** The order shows the state `shipped`.

### @inv32 [ORD] Second shipment has its own invoice {R:48,102}
- **Pre:** previous check. Open the invoice created for the second shipment. The order now has two invoices.
- **Expect:** The second invoice's gross total is {{O03i2.gross}}.

### @ [PROMO] Remaining discount on the last invoice {R:48,88}
- **Pre:** invoice from @@inv32.
- **Expect:** The invoice shows the WELCOME10 discount share {{O03i2.discount}}.

**Setup O04:** signed in as C-10004, CLEAR, ADD 2 × OIL-001 tin and 1 × WAT-001 crate, ORDER(Pickup, Invoice). The order gross is {{O04.gross}}.

### @ [ORD] Staff cancel one unshipped line; totals adjusted {R:103}
- **Pre:** Setup O04. As admin, cancel the WAT-001 line of this order.
- **Expect:** The order's gross total is {{O04b.gross}}.

**Setup O05:** signed in as C-10007, CLEAR, ADD 1 × CHE-006 wheel (catch-weight, estimated 3.0 kg).

### @o05 [FRAC] Catch-weight order total at the estimate {R:75}
- **Pre:** Setup O05, ORDER(Pickup, Card).
- **Expect:** The order's gross total is {{O05.gross}}.

### @ [PAY] Catch-weight card payment is only authorised {R:75,100}
- **Pre:** after @@o05, customer order detail.
- **Expect:** The payment status is `authorised` (or `authorized`), not `paid`.

### @cw [FRAC] Invoice shows the actual weight {R:75}
- **Pre:** As admin, record the actual weight of the CHE-006 wheel as 3.2 kg and SHIP the order. Open its invoice.
- **Expect:** The invoice shows 3.2 kg for CHE-006.

### @ [FRAC] Invoice charges the actual weight {R:75}
- **Pre:** invoice from @@cw.
- **Expect:** The invoice gross total is {{O05a.gross}}.

### @ [INV] Lots picked by earliest best-before date, expired lot skipped {R:108,109,110}
- **Pre:** signed in as C-10007, CLEAR, ADD 1 × DAI-001 case of 12, ORDER(Pickup, Card). As admin, SHIP it; accept the shop's lot proposal if it offers one, otherwise let the shop allocate.
- **Expect:** The shipment (admin view) shows lot `M-2701` for DAI-001, and neither M-2603 nor M-2702.

### @subst [ORD] Substitute shipped and visible {R:111,112}
- **Pre:** As admin, correct the stock of SOFT-002 to 0 (reason `breakage`), so that the line becomes a backorder. Signed in as C-10007, CLEAR, ADD 1 × SOFT-002 tray (backordered). At checkout allow substitution for this line, then ORDER(Pickup, Card). As admin, ship SOFT-001 (1 tray) **instead of** SOFT-002 for this line, using the shop's substitution function, and complete the shipment.
- **Expect:** The customer's order detail or the invoice shows that SOFT-001 was delivered in place of SOFT-002.

### @ [ORD] Substitute not charged more than the original {R:112}
- **Pre:** after @@subst, the invoice of that order.
- **Expect:** The invoice gross total is {{O07.gross}}. The invoice names SOFT-001 on the substituted line.

### @beerinv [PROMO] Code shown on the invoice {R:88}
- **Pre:** signed in as C-10002, CLEAR, ADD 2 × BEER-002 crate and 1 × WAT-001 crate, apply `BEER15`, ORDER(Pickup, Card). As admin, SHIP it and open its invoice.
- **Expect:** The invoice shows `BEER15`.

### @ [PROMO] Invoice shows the discount amount {R:88,48}
- **Pre:** invoice from @@beerinv.
- **Expect:** The invoice shows a discount of {{C05.code}}.

---

## S09 Inventory, lots and backorders

Reset. Run CLEAR before every setup.

### @ [INV] Stock visible to staff in the base unit {R:61}
- **Pre:** admin context.
- **Do:** Open the stock of WAT-001.
- **Expect:** It shows {{D_STOCK.WAT001}} (bottles).

### @ [INV] Expired lot is not sellable {R:107,109}
- **Pre:** signed in as C-10007.
- **Do:** ADD 10 × COF-003 carton of 12 and 1 × COF-003 pack. That is {{D_STOCK.COF003_try}} packs, with {{D_STOCK.COF003_sellable}} sellable.
- **Expect:** The combination is rejected.

### @res [INV] Stock reserved at order placement {R:63}
- **Pre:** CLEAR, signed in as C-10007, ADD 1 × WAT-001 crate, ORDER(Pickup, Card). Admin context.
- **Do:** Open the stock of WAT-001.
- **Expect:** The available stock is {{D_STOCK.WAT001_after_1crate}}. Alternatively, the stock on hand is {{D_STOCK.WAT001}} and a reservation of {{D_STOCK.WAT001_crate}} is shown.

**Setup PESTO:** signed in as C-10002, ADD 3 × CAN-006 jar (all stock). In another context, signed in as C-10004, ADD 3 × CAN-006 jar. Then C-10002 runs ORDER(Pickup, Card) and remembers the order number.

### @ [INV] The last units cannot be sold twice {R:65,32}
- **Pre:** Setup PESTO. Context C-10004.
- **Do:** Try to complete checkout with the 3 jars (Pickup, Invoice).
- **Expect:** No order containing CAN-006 is created for C-10004. Checkout is refused, or the cart is reduced with a message.

### @ [INV] Reserved stock shown as out of stock {R:63,8}
- **Pre:** Setup PESTO. Signed in as C-10007.
- **Do:** Open CAN-006.
- **Expect:** Its availability contains `out of stock`.

### @ [INV] Cancellation releases the stock {R:63,46}
- **Pre:** Setup PESTO. C-10002 cancels its order.
- **Do:** Signed in as C-10007, ADD 3 × CAN-006 jar.
- **Expect:** Accepted.

### @ [INV] Backorder beyond stock accepted and marked {R:104,105}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** ADD 2 × SOFT-002 tray ({{D_STOCK.SOFT002_2trays}} cans, {{D_STOCK.SOFT002_stock}} in stock).
- **Expect:** The backordered quantity marked in the cart is {{D_STOCK.SOFT002_backordered}} cans. The cart accepted both trays.

### @bo [INV] Product with zero stock can be backordered {R:104,105}
- **Pre:** CLEAR, signed in as C-10007.
- **Do:** ADD 3 × FRZ-006 bag, then ORDER(Pickup, Card).
- **Expect:** The backordered quantity in the order detail is {{D_STOCK.FRZ006_order}} bags. The order was placed.

### @recv [INV] Goods receipt with a reason {R:62}
- **Pre:** after @@bo, admin context.
- **Do:** Receive {{D_STOCK.FRZ006_received}} bags of FRZ-006 with the reason `supplier delivery`.
- **Expect:** The stock movements of FRZ-006 list this receipt with the reason `supplier delivery`.

### @ [INV] Backorders that can now be fulfilled {R:106}
- **Pre:** after @@recv.
- **Expect:** The admin area shows the order from @@bo as a backorder that can now be fulfilled: in a backorder list, a report, the dashboard, on the product or on the order.

### @ [INV] Stock correction with a reason {R:62}
- **Pre:** admin context.
- **Do:** Correct the stock of WAT-002 by −5 with the reason `breakage`.
- **Expect:** The stock movements of WAT-002 list this correction with the reason `breakage`.

### @thr [INV] Low-stock threshold per product {R:64}
- **Pre:** admin context.
- **Do:** Set the low-stock threshold of WAT-002 to {{D_STOCK.WAT002_threshold}}.
- **Expect:** WAT-002 appears in the admin list (or dashboard panel) of low-stock products.

### @ [INV] Low-stock label follows the threshold {R:8,64}
- **Pre:** after @@thr. Signed in as C-10007, open WAT-002.
- **Expect:** The availability contains `low stock`.

### @lot [INV] Expiring lots are listed {R:109,120}
- **Pre:** admin context.
- **Do:** Receive 5 tins of CAN-002 as a new lot `F-TEST1` with best-before date today + 10 days.
- **Expect:** The admin list of expiring lots shows `F-TEST1`.

### @ [INV] Earliest best-before lot picked first {R:110,108}
- **Pre:** after @@lot. Signed in as C-10007, CLEAR, ADD 1 × CAN-002 tin, ORDER(Pickup, Card). As admin, SHIP it; accept the shop's lot proposal if it offers one, otherwise let the shop allocate.
- **Expect:** The shipment shows lot `F-TEST1`.

---

## S10 Returns and refunds

Reset.

**Setup R01:** signed in as C-10007, ADD 2 × BEER-004 keg, 2 × OIL-001 tin and 1 × WAT-001 crate, apply `WELCOME10`, ORDER(Truck, Card). This is SG-10001. As admin, SHIP and DELIVER it.

### @ [PROMO] Percentage code across rates on a deposit order {R:85}
- **Pre:** Setup R01, order detail.
- **Expect:** The WELCOME10 discount is {{R01.code}}.

### @ret1 [RET] Customer requests a return {R:113}
- **Pre:** Setup R01, signed in as C-10007.
- **Do:** Request a return for SG-10001: 1 keg of BEER-004 and 1 tin of OIL-001, reason `damaged in transit`.
- **Expect:** The request is confirmed and listed in the customer account with these items.

### @cn1 [RET] Approved return produces a credit note {R:114,115}
- **Pre:** As admin, approve the request from @@ret1 in full and refund it.
- **Expect:** A credit note with the number `CN-<current year>-00001` exists. Admin or customer view counts.

### @ [RET] Credit note gross amount {R:115}
- **Pre:** the credit note from @@cn1.
- **Expect:** The gross total is {{RF1.gross}}.

### @ [RET] Credit note refunds the deposit {R:77,115}
- **Pre:** the credit note from @@cn1.
- **Expect:** It shows a deposit amount of {{RF1.deposits}}.

### @ [RET] Credit note VAT 19 % {R:115}
- **Pre:** the credit note from @@cn1.
- **Expect:** VAT 19 % is {{RF1.vat19}}.

### @ [RET] Payment status after a partial refund {R:116,100}
- **Pre:** after @@cn1, customer order detail.
- **Expect:** The payment status is `partially refunded`.

### @ [RET] Refund email {R:47}
- **Pre:** after @@cn1.
- **Expect:** MAIL(kontakt@spaetkauf-kanal.example, `SG-10001`) is met by an email whose subject or body contains `refund` or `credit note`.

### @ret2 [RET] Partly approved return {R:114,115}
- **Pre:** Signed in as C-10007, request a second return for SG-10001: 1 keg of BEER-004 and 1 tin of OIL-001, reason `damaged in transit`. As admin, approve only the tin, reject the keg, and refund.
- **Expect:** A new credit note exists with the gross total {{RF2.gross}}.

### @ [RET] Rejected return creates no credit note {R:114}
- **Pre:** after @@ret2. Signed in as C-10007, request a return of 1 keg of BEER-004 from SG-10001 with the reason `damaged in transit`. As admin, reject it.
- **Expect:** The customer account still lists exactly 2 credit notes for SG-10001.

**Setup R04:** signed in as Jana (C-10001), CLEAR, ADD 2 × OIL-001 tin, ORDER(Pickup, Invoice). As admin, SHIP and DELIVER it. Then, before any return, as Jana note the open balance shown in the account as **B1**.

### @rf4 [RET] Refund on an invoice order {R:115}
- **Pre:** Setup R04. As Jana, request a return of 1 tin (reason `damaged in transit`). As admin, approve and refund it.
- **Expect:** The credit note gross total is {{RF4.gross}}.

### @ [RET] Refund reduces the open balance {R:116}
- **Pre:** after @@rf4, as Jana, read the open balance as **B2**.
- **Record-only:** `B1` — the open balance shown in the account, noted as B1 in Setup R04; `B2` — the open balance shown in the account, noted as B2 above.
- **Expect:** B1 − B2 equals {{derive:B1 - B2=RF4.gross}}.

### @ [RET] Full refund sets the payment status to refunded {R:116}
- **Pre:** Signed in as C-10002, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Card). As admin, SHIP and DELIVER it. As C-10002, request a return of 1 tin with the reason `damaged in transit`. As admin, approve and refund it (credit note gross {{RF5.gross}}).
- **Expect:** The order's payment status is `refunded`.

### @ [DEP] Returned empties credited {R:79}
- **Pre:** admin context.
- **Do:** Record for C-10007 the return of empty containers: 1 empty WAT-001 crate with 24 empty bottles (from order SG-10001 of Setup R01, if the shop records empties per order). If the shop asks for the containers separately, enter 24 bottles and 1 crate.
- **Expect:** The deposit credit for C-10007 (net or gross) is {{EMP.net|EMP.gross}}. The deposit credit is shown in the admin area or in the customer account.

---

## S11 Admin management

Reset. Admin context **A** and customer context **K** (C-10007).

### @ [ADM] Back-office without the storefront header {R:49}
- **Pre:** In context K, record the path of the storefront cart page as **CARTPATH** and the path of the category Beverages as **CATPATH**. In context A, open the admin dashboard.
- **Do:** DOM JS-LINKPATHS on the admin dashboard.
- **Expect:** Neither CARTPATH nor CATPATH is among the paths.

### @ [ADM] Back-office has its own main navigation {R:49}
- **Pre:** context A, admin dashboard.
- **Do:** Open each of the four links and record the heading of the page it opens.
- **Expect:** The admin navigation shows links whose texts contain `Products`, `Orders`, `Customers` and `Promotions` (or `Discounts`), and each opens an admin page whose heading names that section.

### @ [ADM] Admin product list: search by SKU {R:49,51}
- **Pre:** context A, admin product list.
- **Do:** Search the list for `WAT-002`.
- **Expect:** WAT-002 is listed and WAT-001 is not.

### @ [ADM] Admin product list: sort by name {R:49}
- **Pre:** context A, admin product list without search or filter.
- **Do:** Sort by name, A to Z.
- **Expect:** The first product listed is {{D_ADM.first_by_name}}, the alphabetically first of the {{~D_ADM.products_total}} catalog products.

### @ [ADM] Packaging data edited without raw JSON {R:51,53}
- **Pre:** context A, edit page of WAT-002 (with its packaging units and prices visible; open sections or tabs as needed).
- **Do:** DOM JS-NOJSON.
- **Expect:** `0`.

### @ [ADM] Customer data edited without raw JSON {R:51,54,55}
- **Pre:** context A, edit page of customer C-10004 (with its addresses and negotiated prices visible; open sections or tabs as needed).
- **Do:** DOM JS-NOJSON.
- **Expect:** `0`.

### @ [ADM] Negotiated prices are editable form fields {R:55,154}
- **Pre:** context A, edit page of customer C-10004 (negotiated prices visible).
- **Expect:** The negotiated price for the WAT-002 crate is shown in an editable field with the value {{P17.L2_unit}}.

### @ [ADM] Invalid price is rejected with a message {R:51,53}
- **Pre:** context A, edit page of WAT-002.
- **Do:** Enter `-1.00` as the price of the box of 6 and save.
- **Expect:** The box price on the reloaded edit page is {{D_ADM.wat002_box_old}}. A validation message was shown before reloading.

### @ [ADM] Packaging price changed through the form {R:53}
- **Pre:** context A, edit page of WAT-002.
- **Do:** In the field for the price of the box of 6, enter `6.90` ({{D_ADM.wat002_box_new}}) and save. In context K, CLEAR and ADD 1 × WAT-002 box of 6.
- **Expect:** The line total is {{D_ADM.wat002_box_new}}.

### @ [ADM] Negotiated price added through form fields {R:55}
- **Pre:** context A, customer C-10002.
- **Do:** Add a negotiated price for SAU-003 (bucket) of `3.00` using the form fields. Signed in as C-10002, CLEAR and ADD 1 × SAU-003.
- **Expect:** The line total is {{D_ADM.sau003_neg}}. Without the negotiated price it would be {{~D_ADM.sau003_group}}.

### @newprod [ADM] Create a product {R:51,52}
- **Pre:** context A.
- **Do:** Create a product with these details:
  - name `Spreegrund Test Lemonade`,
  - SKU `TEST-001`,
  - category Beverages › Juices,
  - VAT 19 %,
  - sold per bottle at {{>AD.test_price}},
  - temperature class ambient,
  - stock 50,
  - active.
- **Expect:** In context K, the subcategory Juices lists `Spreegrund Test Lemonade`.

### @ [ADM] New product priced for customers {R:51,53}
- **Pre:** after @@newprod, context K.
- **Do:** Open the new product.
- **Expect:** The price {{AD.test_price}} is visible.

### @ [ADM] Deactivated product disappears from the storefront {R:51}
- **Pre:** context A.
- **Do:** Deactivate TEA-003 (Herbal Tea Assortment).
- **Expect:** In context K, a search for `Herbal Tea` does not list TEA-003.

### @ [ADM] Staff-defined quantity price {R:53,81}
- **Pre:** context A.
- **Do:** For NF-003 (Paper Napkins, single pack), add a quantity price of {{>AD.nf003_tier}} per pack from 10 packs and save. Then switch to context K, CLEAR, open the NF-003 product page (reload it), ADD 10 × NF-003 pack and open the cart.
- **Expect:** The NF-003 line total in the cart is {{AD07t.line@cart}}.

### @pc [SHIP] Cart updates after a price change {R:32}
- **Pre:** context K, CLEAR, ADD 1 × WAT-003 tray. In context A, change the WAT-003 tray price to {{AD.wat003_new}}.
- **Do:** In context K, reload the cart.
- **Expect:** The WAT-003 line shows the unit price {{AD.wat003_new}}.

### @ [SHIP] Cart tells the customer what changed {R:32}
- **Pre:** after @@pc.
- **Expect:** A message is shown in the cart or at checkout that mentions WAT-003 or "Still Water" or a price change.

### @grp [ADM] Change a customer's group {R:54,82}
- **Pre:** context A.
- **Do:** Change the group of C-10007 to Gastronomy and save. Then switch to context K (sign in again if the shop requires it) and open the WAT-001 product page (reload it).
- **Expect:** The WAT-001 product page shows the bottle price {{PG_GASTRO.L1_unit@product}}.

### @ [ADM] Maintain a negotiated price {R:55}
- **Pre:** after @@grp, context A.
- **Do:** Add a negotiated price for C-10007 on SAU-002 (bucket) of {{AD.neg_sau002}}.
- **Expect:** In context K, SAU-002 shows {{PG_NEG.L1_unit}}. The negotiated price is final and has no group discount.

### @ [ADM] Grant invoice payment and credit limit {R:54}
- **Pre:** context A.
- **Do:** Allow purchase on invoice for C-10002 with a credit limit of {{AD.c10002_limit}}.
- **Expect:** Signed in as C-10002, with 1 × OIL-001 tin in the cart and Pickup, Purchase on invoice is offered.

### @ [ADM] Block a customer {R:54,19}
- **Pre:** context A.
- **Do:** Block C-10006.
- **Expect:** In a fresh context, signing in as C-10006 fails. Afterwards no price is visible on WAT-001.

### @code [ADM] Create a promotion code {R:56}
- **Pre:** context A.
- **Do:** Create the code `TESTFIVE`: {{AD.testfive}} off the order, no minimum, valid from today for one year, active.
- **Expect:** In context K, after CLEAR and ADD 2 × NF-003 pack, applying `TESTFIVE` gives a discount of {{AD16.code}}.

### @ [ADM] Deactivate a promotion code {R:56}
- **Pre:** after @@code. In context A, deactivate TESTFIVE.
- **Do:** In context K, remove the code if it is still applied, then apply `TESTFIVE` again.
- **Expect:** Rejected.

### @ [ADM] Change a shipping fee {R:57}
- **Pre:** context A.
- **Do:** Change the fee of Spreegrund Truck Delivery to {{AD.truck_fee_new}}.
- **Expect:** Signed in as C-10004, CLEAR, ADD 1 × OIL-001 carton, REVIEW(Truck): the shipping amount is {{AD19.shipping}}.

### @ [ADM] Dashboard counts today's orders {R:50}
- **Pre:** Signed in as C-10002, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Card). This is the only order placed in this suite.
- **Expect:** The admin dashboard shows 1 order for today.

---

## S12 Reporting

Reset. Do not place any orders other than those listed below.

**Setup REP:** Place two orders:
- Signed in as C-10007, ADD 2 × WAT-001 crate and 1 × OIL-004 bottle, ORDER(Pickup, Card).
- Signed in as C-10002, ADD 2 × BEER-002 crate and 1 × WAT-001 crate, apply `BEER15`, ORDER(Pickup, Card).

As admin, SHIP both orders. In every report, set the period to **today** before reading a value.

### @ [REP] Sales by day: net amount {R:117}
- **Pre:** Setup REP, admin sales report for today.
- **Expect:** The net amount (without or with deposits) is {{REP.net|REP.net_incl_deposits}}.

### @ [REP] Sales by day: VAT {R:117}
- **Pre:** Setup REP.
- **Expect:** The VAT amount is {{REP.vat}}.

### @ [REP] Sales by day: deposits {R:117}
- **Pre:** Setup REP.
- **Expect:** The deposit amount is {{REP.deposits}}.

### @ [REP] Top-selling product {R:118}
- **Pre:** Setup REP.
- **Expect:** WAT-001 is ranked first among the top-selling products. It leads by quantity and by revenue.

### @ [REP] Sales by customer {R:118}
- **Pre:** Setup REP.
- **Expect:** The sales for C-10007 show the net amount {{REP.c10007_net}}.

### @ [REP] Promotion usage count {R:119}
- **Pre:** Setup REP.
- **Expect:** BEER15 is shown with 1 use.

### @ [REP] Total discount per promotion {R:119}
- **Pre:** Setup REP.
- **Expect:** BEER15 is shown with a total discount of {{REP.beer15_discount}}.

### @ [REP] Open backorders report {R:120}
- **Pre:** Signed in as C-10007, CLEAR, ADD 2 × FRZ-006 bag, ORDER(Pickup, Card).
- **Expect:** The admin report or list of open backorders contains this order (or FRZ-006 with 2 bags).

---

## S13 Variants, related products, options, bundles, restricted assortment, accessories and order lists

Reset. This suite uses these contexts:

| Context | Signed in as |
|---|---|
| **G** | guest |
| **K** | C-10007 (Standard, list prices) |
| **F** | C-10002 (Gastronomy) |
| **H** | C-10004 (Key Account) |
| **R** | C-10003 (Retail) |
| **J** | Jana (C-10001) |
| **M** | Mehmet (C-10001) |
| **A** | admin |

Run CLEAR before every setup that adds goods.

### @ [CATX] A product with variants has one catalog entry {R:121}
- **Pre:** context K.
- **Do:** Open the category Non-Food & Disposables and look through all pages.
- **Expect:** Exactly one entry whose name contains `Nitrile Gloves` is listed. There are no separate entries per size.

### @ [CATX] Choosing a variant shows its SKU {R:121}
- **Pre:** context K, product page of the nitrile gloves (NF-005).
- **Do:** Choose size M.
- **Expect:** The SKU `NF-005-M` is shown.

### @ [CATX] An out-of-stock variant cannot be ordered {R:121,8}
- **Pre:** context K, the same page.
- **Do:** Choose size XL and try to add 1 box to the cart.
- **Expect:** Afterwards the cart contains no line for size XL (NF-005-XL).

### @ [CATX] Variant price follows the selection {R:121}
- **Pre:** context K, product page of the pizza boxes (NF-007).
- **Do:** Choose 33 cm.
- **Expect:** The price shown is {{D_VAR.NF007_33}}.

### @v30 [CATX] Cart shows the chosen variant {R:121}
- **Pre:** context K.
- **Do:** On the pizza boxes page, choose 30 cm and add 2 packs.
- **Expect:** The cart line shows `NF-007-30` or `30 cm`.

### @ [CATX] Variant line priced at the variant's price {R:121}
- **Pre:** after @@v30.
- **Expect:** The line total is {{V01.L1_net}}.

### @ [CATX] Stock is kept per variant {R:121,28}
- **Pre:** CLEAR, context K.
- **Do:** Try to add 13 packs of the 33 cm size ({{D_VAR.NF007_33_stock}} in stock).
- **Expect:** Rejected.

### @ [CATX] Search by variant SKU {R:123}
- **Pre:** context K.
- **Do:** Search for `NF-005-M` and open the result.
- **Expect:** The nitrile gloves product page opens with size M selected, or NF-005-M is clearly indicated as the found variant.

### @v33 [CATX] Order and invoice show the variant {R:121}
- **Pre:** CLEAR, context K. Add {{D_VAR.NF007_26_stock}} packs of 26 cm (all stock of that size), then ORDER(Pickup, Card). As admin, SHIP it and open its invoice. The 33 cm size is not touched, because it is part of BND-002.
- **Expect:** The invoice line shows `NF-007-26` or `26 cm`.

### @ [CATX] Stock decreases for the ordered variant only {R:121,63}
- **Pre:** after @@v33, context K, CLEAR.
- **Do:** Add 1 pack of 26 cm, then 1 pack of 30 cm.
- **Expect:** The 26 cm pack is rejected, and the cart holds the 30 cm pack.

### @ [CATX] Related product link {R:122}
- **Pre:** context K, WAT-001 product page.
- **Expect:** The page links to WAT-002 (Still Mineral Water), and following the link opens the WAT-002 product page.

### @ [CATX] Related product link in the other direction {R:122}
- **Pre:** context K, WAT-002 product page.
- **Expect:** The page links to WAT-001.

### @ [CATX] Several related products {R:122}
- **Pre:** context K, BEER-002 product page.
- **Expect:** The page links to both BEER-001 and BEER-004.

### @ [CATX] Related products remain separate catalog entries {R:122}
- **Pre:** context K, category Water & Soft Drinks (all pages).
- **Expect:** SOFT-001 (Cola) and SOFT-002 (Cola Zero) are listed as two separate entries.

### @ [CATX] An option adds to the price {R:124}
- **Pre:** CLEAR, context K.
- **Do:** On CTR-001 (Pizza Margherita), choose extra cheese and add 1 pizza.
- **Expect:** The line total is {{OPT1.L1_net}}.

### @ [CATX] Several options add up {R:124}
- **Pre:** CLEAR, context K.
- **Do:** On CTR-001, choose salami and gluten-free base, and add 1 pizza.
- **Expect:** The line total is {{OPT2.L1_net}}.

### @ [CATX] Group discount applies to the price including options {R:124,82}
- **Pre:** CLEAR, context F.
- **Do:** On CTR-001, choose extra cheese and add 1 pizza.
- **Expect:** The line total is {{OPT3.L1_net}}.

### @ [CATX] At most one extra topping {R:124}
- **Pre:** CLEAR, context K, CTR-001 page.
- **Do:** Try to choose salami and mushrooms for the same pizza and add it to the cart.
- **Expect:** Two toppings cannot be chosen together, or adding is refused. The cart contains no pizza line with two extra toppings.

### @opt5 [CATX] Different option choices form separate lines {R:124}
- **Pre:** CLEAR, context K.
- **Do:** Add 2 plain pizzas (CTR-001, no options), then 3 pizzas with extra cheese.
- **Expect:** The cart has two CTR-001 lines, one with quantity 2 and one with quantity 3 showing extra cheese.

### @optord [CATX] Options shown on the order {R:124}
- **Pre:** after @@opt5, ORDER(Pickup, Card).
- **Expect:** The customer's order detail shows `extra cheese` on the line with 3 pizzas.

### @ [CATX] Options shown on the invoice {R:124,48}
- **Pre:** after @@optord. As admin, SHIP the order and open its invoice.
- **Expect:** The invoice shows `extra cheese` on the pizza line with quantity 3.

### @ [CATX] Stock is counted per pizza across option lines {R:124,28}
- **Pre:** CLEAR, context F. After @@optord, {{D_OPT.after}} pizzas are left in stock.
- **Do:** Add 20 plain pizzas and 16 pizzas with extra cheese ({{D_OPT.try_}} in total).
- **Expect:** The combination is rejected. The cart does not hold both lines at these quantities, or checkout is blocked.

### @ [CATX] A bundle has its own catalog entry {R:125}
- **Pre:** context K.
- **Do:** Open the category Catering › Bundles.
- **Expect:** The Pizza Night Kit (BND-002) is listed.

### @ [CATX] Bundle availability follows its contents {R:125}
- **Pre:** CLEAR, context K.
- **Do:** Try to add {{D_BND.BND002_avail_plus1}} × BND-002 ({{D_BND.BND002_avail}} complete kits are possible).
- **Expect:** Rejected.

### @ [CATX] Bundle price is final: no group discount {R:125}
- **Pre:** CLEAR, context H. ADD 1 × BND-002.
- **Expect:** The line total is {{B02.L1_net}}.

### @ [CATX] Bundle VAT split: 7 % share {R:125,90}
- **Pre:** previous check, REVIEW(Pickup).
- **Expect:** VAT 7 % is {{B02.vat7}}.

### @ [CATX] Bundle VAT split: 19 % share {R:125,90}
- **Pre:** previous check.
- **Expect:** VAT 19 % is {{B02.vat19}}.

### @ [CATX] Bundle lists its contents in the cart {R:125}
- **Pre:** context H, cart with BND-002.
- **Expect:** The BND-002 line lists its contents. At least `Mozzarella` (or CHE-003) and `Pizza Boxes` (or NF-007-33) are named.

### @ [CATX] Contents' deposits charged on a bundle {R:125,76}
- **Pre:** CLEAR, context F. ADD 1 × BND-001.
- **Expect:** The deposit total is {{B01.deposits}}.

### @ [CATX] Bundle counts toward a code minimum but is not discounted {R:125,87}
- **Pre:** CLEAR, context F (C-10002 has placed no order in this suite). ADD 1 × BND-002 and 1 × OIL-001 tin (goods {{B03.goods}}). Apply `WELCOME10`.
- **Expect:** The code is applied with a discount of {{B03.code}}.

### @ [CATX] Selling a bundle reduces the stock of its contents {R:125,63}
- **Pre:** context H, cart from the previous bundle checks emptied. ADD 1 × BND-002, ORDER(Pickup, Invoice).
- **Do:** In context K, CLEAR and try to add {{D_BND.BND002_avail}} × BND-002.
- **Expect:** Rejected. Only {{~D_BND.BND002_avail_after_kit}} kits remain possible.

### @ [CATX] Bundle with frozen contents keeps the delivery restriction {R:125,96}
- **Pre:** CLEAR, context K. ADD 1 × BND-002 and 1 × OIL-001 carton. Start checkout.
- **Expect:** Parcel is not offered.

### @ [ACC] Restricted category hidden from guests {R:126}
- **Pre:** context G.
- **Do:** Search for `London Dry Gin`.
- **Expect:** SPI-001 is not among the results.

### @ [ACC] Restricted category hidden from a Standard customer {R:126}
- **Pre:** context K.
- **Do:** Open Beverages › Spirits if it exists, and search for `gin`.
- **Expect:** SPI-001 appears in neither place.

### @ [ACC] Restricted category hidden from a Retail customer {R:126}
- **Pre:** context R.
- **Do:** Search for `whisky`.
- **Expect:** SPI-005 is not among the results.

### @ [ACC] Restricted product page cannot be opened directly (URL check) {R:126}
- **Pre:** In context F, open SPI-001 (visible to Gastronomy) and record its URL as **SPIURL**.
- **Do:** In context K, open SPIURL.
- **Expect:** The product is not shown. No product name, price or add-to-cart for SPI-001 is visible.

### @ [ACC] Bundle inherits the restriction {R:126,125}
- **Pre:** context K, category Catering › Bundles.
- **Expect:** BND-001 (Gin & Tonic Bar Kit) is not listed.

### @ [ACC] Restricted quick order refused {R:126,33}
- **Pre:** CLEAR, context K.
- **Do:** Use quick order with SKU `SPI-001`, quantity 1.
- **Expect:** No SPI-001 line is added to the cart.

### @ [ACC] Restricted products are visible to the allowed group {R:126}
- **Pre:** context F (C-10002, Gastronomy), CLEAR.
- **Do:** Search for `London Dry Gin`, open SPI-001 and ADD 1 × SPI-001 bottle.
- **Expect:** The cart holds the SPI-001 bottle line with the line total {{SPG.L1_net}}.

### @wine8 [ACC] Customer-exclusive product for its customer {R:126}
- **Pre:** context H.
- **Do:** Search for `Seeblick` and open WINE-008. Record its URL as **WINEURL**.
- **Expect:** The single-bottle price is {{EX1.L1_unit}}.

### @ [ACC] Customer-exclusive product hidden from other customers {R:126}
- **Pre:** context F.
- **Do:** Search for `Seeblick`.
- **Expect:** WINE-008 is not among the results.

### @ [ACC] Customer-exclusive product URL not usable by others (URL check) {R:126}
- **Pre:** after @@wine8, context F.
- **Do:** Open WINEURL.
- **Expect:** The product is not shown. No WINE-008 name, price or add-to-cart is visible.

### @ [CATX] Accessories offered on the product page {R:127}
- **Pre:** CLEAR, context K, BEER-004 product page.
- **Do:** Add the suggested accessory NF-006 (CO2 Cylinder Refill) to the cart directly from the BEER-004 page.
- **Expect:** The cart contains NF-006.

### @ [SHIP] Saved order list available to its company {R:128}
- **Pre:** context J.
- **Do:** Open the order lists.
- **Expect:** A list named `Weekly bar order` exists.

### @ [SHIP] Order list shared by all users of the company {R:128,21}
- **Pre:** context M.
- **Do:** Open the order lists.
- **Expect:** The list `Weekly bar order` exists.

### @list [SHIP] Whole list added to the cart: totals {R:128}
- **Pre:** CLEAR, context J.
- **Do:** Add the list `Weekly bar order` to the cart in one step, then REVIEW(Pickup).
- **Expect:** The gross total is {{LIST1.gross}}.

### @ [SHIP] Unavailable list item reported and skipped {R:128}
- **Pre:** right after adding the list in @@list.
- **Expect:** A message names JUI-005 or "Multivitamin" as unavailable or not added, and the cart contains no JUI-005 line.

### @mylist [SHIP] Create an order list {R:128}
- **Pre:** CLEAR, context K.
- **Do:** Create a list named `Test list` with 2 × WAT-002 crate, then add it to the cart.
- **Expect:** The cart contains WAT-002 crates with quantity 2.

### @ [SHIP] Edit an order list {R:128}
- **Pre:** after @@mylist, CLEAR.
- **Do:** Change the WAT-002 quantity in `Test list` to 3 and add the list to the cart.
- **Expect:** The cart contains WAT-002 crates with quantity 3.

### @ [SHIP] Delete an order list {R:128}
- **Pre:** after the previous check.
- **Do:** Delete `Test list`.
- **Expect:** `Test list` no longer appears among C-10007's order lists.

---

## S14 UI quality: responsive layout, accessibility and SEO

Reset. Contexts: **G** (guest) and **K** (signed in as C-10007). Viewports: **phone** 390 × 844, **tablet** 768 × 1024, **desktop** 1280 × 800 (default). Set the viewport with the browser's resize function before each check and return to desktop at the end. No orders are placed.

### @ [UIQ] Phone: home page without horizontal scrolling {R:1}
- **Pre:** context G, phone viewport, home page.
- **Do:** DOM JS-OVERFLOW.
- **Expect:** A value ≤ 1.

### @ [UIQ] Phone: category page without horizontal scrolling {R:1}
- **Pre:** context G, phone viewport, category Beverages.
- **Do:** DOM JS-OVERFLOW.
- **Expect:** A value ≤ 1.

### @ [UIQ] Phone: product page without horizontal scrolling {R:1}
- **Pre:** context G, phone viewport, WAT-001 product page.
- **Do:** DOM JS-OVERFLOW.
- **Expect:** A value ≤ 1.

### @ [UIQ] Phone: cart without horizontal scrolling {R:1}
- **Pre:** context K, CLEAR, ADD 1 × WAT-001 crate, phone viewport, cart page.
- **Do:** DOM JS-OVERFLOW.
- **Expect:** A value ≤ 1.

### @ [UIQ] Phone: checkout without horizontal scrolling {R:1}
- **Pre:** previous check, start checkout (first checkout step), phone viewport.
- **Do:** DOM JS-OVERFLOW.
- **Expect:** A value ≤ 1.

### @ [UIQ] Tablet: no horizontal scrolling {R:1}
- **Pre:** context G, tablet viewport.
- **Do:** DOM JS-OVERFLOW on the home page, the category Beverages and the WAT-001 product page.
- **Expect:** All three values are ≤ 1.

### @ [UIQ] Phone: main navigation usable {R:1,11}
- **Pre:** context G, phone viewport, home page.
- **Do:** Using only the site's navigation (opening a menu button is allowed; no search, no typed URL), go to the subcategory Beer.
- **Expect:** The Beer category page is shown and lists BEER-001.

### @ [UIQ] Phone: add to cart {R:1,26}
- **Pre:** context K, CLEAR, phone viewport, WAT-001 product page.
- **Do:** Add 1 bottle to the cart, then open the cart.
- **Expect:** The cart contains WAT-001.

### @ [UIQ] Phone: product image fits the screen {R:1}
- **Pre:** context G, phone viewport, WAT-001 product page.
- **Do:** DOM JS-IMGFIT.
- **Expect:** `true`.

### @ [UIQ] Visible keyboard focus {R:10}
- **Pre:** context K, desktop viewport, WAT-001 product page freshly loaded.
- **Do:** Press Tab until the add-to-cart control has focus (at most 60 presses), then DOM JS-FOCUS.
- **Expect:** `true`.

### @ [UIQ] Checkout form fields are labelled {R:10,34}
- **Pre:** context K, ADD 1 × WAT-001 crate, start checkout and open the step where the shipping address is chosen or entered (choose "new address" if the shop offers it).
- **Do:** DOM JS-LABEL.
- **Expect:** An empty list.

### @ [UIQ] Address form fields are labelled {R:10,148}
- **Pre:** context K, account area, the form for adding a new shipping address (open it, do not submit).
- **Do:** DOM JS-LABEL.
- **Expect:** An empty list, and the form has at least four visible input fields.

### @ [UIQ] Main landmark {R:10}
- **Pre:** context G, home page.
- **Do:** DOM JS-MAIN.
- **Expect:** `true`.

### @ [UIQ] Page titles are unique {R:130}
- **Pre:** context G.
- **Do:** DOM JS-TITLE on the home page, the category Beverages and the WAT-001 product page.
- **Expect:** The three titles are pairwise different.

### @ [UIQ] Product page title names the product {R:130}
- **Pre:** context G, WAT-001 product page.
- **Do:** DOM JS-TITLE.
- **Expect:** The title contains `Sparkling Mineral Water` (case-insensitive).

### @ [UIQ] Meta description {R:130}
- **Pre:** context G, WAT-001 product page.
- **Do:** DOM JS-META.
- **Expect:** A value ≥ 1.

### @ [UIQ] Canonical address {R:130}
- **Pre:** context G, WAT-001 product page.
- **Do:** DOM JS-CANON.
- **Expect:** A non-empty address whose path equals the path of the current page (ignore protocol, host, query and a trailing slash).

### @ [UIQ] Structured product data {R:130}
- **Pre:** context G, WAT-001 product page.
- **Do:** DOM JS-LDPRODUCT.
- **Expect:** At least one object with `sku` equal to `WAT-001` and a `name` that contains `Sparkling Mineral Water` (case-insensitive).

### @ [UIQ] Readable product address {R:130}
- **Pre:** context G, WAT-001 product page.
- **Do:** DOM JS-PATH.
- **Expect:** The path contains `wat-001` or `sparkling-mineral-water`. A path whose only identifying part is a number (for example `/products/17`) is FAIL.

### @ [UIQ] Restricted products are not in the sitemap {R:130,126}
- **Pre:** context G.
- **Do:** Open `/robots.txt`. If it contains a `Sitemap:` line, open that address; otherwise open `/sitemap.xml`. If it is a sitemap index, open each sitemap it lists. Opening these addresses is allowed.
- **Expect:** A sitemap exists (XML with `urlset` or `sitemapindex`). No listed address contains `spi-001`, `spi-005`, `london-dry-gin`, `single-malt` or `wine-008` (case-insensitive).

---

## S15 Back-office pages, safety and storefront completeness

Reset. Contexts:

| Context | Signed in as |
|---|---|
| **G** | guest |
| **K** | C-10007 |
| **F** | C-10002 |
| **J** | Jana (C-10001) |
| **N** | C-10006 |
| **R** | the new registrant |
| **A** | admin |

In context K, record the storefront cart path as **CARTPATH**. Run CLEAR before every setup that adds goods.

**Setup PP:** context K, ADD 1 × OIL-001 tin, ORDER(Pickup, Prepay). Note the order number as **PP**.

### @ [ADM] Admin order page offers only state-allowed actions {R:58,131}
- **Pre:** Setup PP. Context A, open the admin page of order PP (state pending payment).
- **Expect:** The page offers no action to ship the order or create a shipment. Any such control is absent or disabled.

### @ [ORD] Payment-received email for prepayment {R:47}
- **Pre:** Setup PP. In context A, record the payment for PP as received.
- **Expect:** MAIL(kontakt@spaetkauf-kanal.example, PP) is met by an email other than the order confirmation whose subject or body contains `paid` or `payment received`.

**Setup CO:** context K, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Card). Note the order number as **CO** (gross {{RC.gross}}).

### @ [SAFE] Cancelling asks for confirmation; dismissing changes nothing {R:133}
- **Pre:** Setup CO, context K, order detail of CO.
- **Do:** Start the cancellation, and when the shop asks for confirmation, dismiss it (cancel or close the dialog).
- **Note:** A confirmation is a separate step or dialog that appears after the control is activated. A required checkbox next to the control counts only if activating the control without it shows a shop message.
- **Expect:** A confirmation was shown, and afterwards CO still shows the state confirmed.

### @ [SAFE] Only the last four card digits are shown {R:135}
- **Pre:** Setup CO, context K, order detail of CO.
- **Expect:** The page shows the card's last four digits `4242`, and the full number `4242 4242 4242 4242` (with or without spaces) appears nowhere on the page.

### @inv15 [ORD] Invoice as a printable or downloadable document {R:141,48}
- **Pre:** Setup CO. In context A, SHIP(CO). In context K, open the invoice of CO.
- **Expect:** The invoice opens as its own printable page or as a downloadable file, and it shows the seller's VAT ID `DE298765431`.

### @refall [RET] Full refund of a paid order {R:115,116}
- **Pre:** after @@inv15. In context A, DELIVER(CO), then refund CO in full (all lines) and confirm.
- **Expect:** The total refunded for CO is {{RC.gross}}.

### @ [RET] No refund beyond the amount paid {R:115,116}
- **Pre:** after @@refall. Context A, CO.
- **Do:** Try to refund CO again (any line or amount the shop lets you enter).
- **Expect:** The total refunded for CO is {{RC.gross}}. The shop refused the second refund (quote its message) or offered nothing more to refund.

### @ [ORD] Invoice for purchase on invoice shows the due date {R:141}
- **Pre:** context J, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Invoice). In context A, SHIP it. In context J, open its invoice.
- **Expect:** The invoice shows a due date that is 30 days after the invoice date.

### @ [SAFE] Placing an order twice by double click creates one order {R:140}
- **Pre:** context K, CLEAR, ADD 1 × TEA-001 box, REVIEW(Pickup) with Card, card data entered. Note how many orders the order history lists.
- **Do:** Double-click the place-order button (two clicks in quick succession).
- **Expect:** The order history lists exactly one more order than before.

### @ [ADM] Customer admin page shows the company's users {R:131,132}
- **Pre:** context A, admin page of customer C-10001.
- **Expect:** Both users are shown: `einkauf@osthafen-kueche.example` and `kueche@osthafen-kueche.example`.

### @ [ADM] Customer admin page shows negotiated prices {R:132,55}
- **Pre:** context A, admin page of customer C-10001.
- **Expect:** The negotiated price for COF-001 of {{P14.L1_unit}} per bag is shown.

### @ [SAFE] Blocking asks for confirmation; dismissing changes nothing {R:133}
- **Pre:** context A, customer C-10006.
- **Do:** Start blocking the customer and dismiss the confirmation.
- **Note:** A confirmation is a separate step or dialog that appears after the control is activated. A required checkbox next to the control counts only if activating the control without it shows a shop message.
- **Expect:** A confirmation was shown, and afterwards C-10006 can still sign in (check in a fresh context; WAT-001 shows a price).

### @ [SAFE] A block takes effect for a signed-in user {R:139}
- **Pre:** context N, signed in as C-10006, WAT-001 open with a price visible. In context A, block C-10006 and confirm.
- **Do:** In context N, reload the WAT-001 page.
- **Expect:** No price is visible: the user has been signed out or has lost access.

**Setup REG:** context R (guest), registration with company `Alpenküche GmbH`, contact `Anna Berger`, email `einkauf@alpenkueche.example`, VAT ID `ATU99999999`, billing and shipping address `Mariahilfer Straße 1, 1060 Wien, Austria`. Before that, one failed attempt with the already registered email `kontakt@spaetkauf-kanal.example` (first check below) and one with the 7-character password `Kurz7!x` (second check below).

### @ [SAFE] Field-level validation message {R:134}
- **Pre:** context R, the registration form submitted with all fields of Setup REG and the password `Alpen!Kueche26`, but with the email `kontakt@spaetkauf-kanal.example`, which is already registered. This input passes the browser's own validation, so only the shop can reject it.
- **Expect:** The shop shows an error message at the email field (next to or directly below it), not only as a general notice. Quote it in `observed`.

### @ [SAFE] Entries are kept after a validation error {R:134}
- **Pre:** previous check.
- **Expect:** After the shop's response to the previous submission, the company field still contains `Alpenküche GmbH`.

### @ [SAFE] Short password rejected {R:138}
- **Pre:** context R, the registration form with all fields of Setup REG and the 7-character password `Kurz7!x` (entered twice).
- **Do:** Submit the form.
- **Expect:** The registration is not accepted (no success message, no account), and a message about the password is shown. Quote it in `observed`.

### @ [ORD] Registration-received email {R:142}
- **Pre:** Setup REG completed with the password `Alpen!Kueche26`.
- **Expect:** MAIL(einkauf@alpenkueche.example, `Alpenk`) is met.

### @ [ORD] Staff are notified about the new registration {R:142}
- **Pre:** Setup REG completed.
- **Expect:** MAIL(admin@spreegrund.example, `Alpenk`) is met.

### @ [ORD] Approval email {R:142}
- **Pre:** In context A, approve `Alpenküche GmbH` (do not mark its VAT ID as verified).
- **Expect:** MAIL(einkauf@alpenkueche.example, `approved`) is met.

### @ [VAT] Unverified VAT ID: no reverse charge {R:92}
- **Pre:** context R, signed in as the new registrant, CLEAR, ADD 2 × OIL-001 carton, REVIEW(EU).
- **Expect:** VAT 7 % is {{VU.vat7}}.

### @ [VAT] Reverse charge after staff verify the VAT ID {R:92}
- **Pre:** In context A, mark the VAT ID of `Alpenküche GmbH` as verified. In context R, REVIEW(EU) again for the same cart.
- **Expect:** The gross total is {{VV.gross}}.

### @addr [ACC] New default shipping address used at checkout {R:148,22}
- **Pre:** context K, account area.
- **Do:** Add the shipping address `Paul-Lincke-Ufer 44, 10999 Berlin, Germany`, make it the default, then CLEAR, ADD 1 × WAT-002 crate and start checkout. Record the URL of the address's page or edit form (if it has one) as **ADDRURL**.
- **Expect:** `Paul-Lincke-Ufer 44` is preselected as the shipping address.

### @ [SAFE] Another company never sees the address {R:136}
- **Pre:** after @@addr, context F.
- **Do:** Open the account's address list and start a checkout. If @@addr produced an address URL (ADDRURL), also open it.
- **Expect:** `Paul-Lincke-Ufer 44` appears in none of these places.

### @ [SAFE] Another company cannot open an order list (URL check) {R:136,128}
- **Pre:** In context J, open the order list `Weekly bar order` and record its URL as **LISTURL**. Switch to context K.
- **Do:** Open LISTURL.
- **Expect:** The list name `Weekly bar order` and its items are not shown.

### @ [CAT] Footer with the seller's contact details {R:144}
- **Pre:** context G, home page.
- **Expect:** The footer shows `service@spreegrund.example` or `+49 30 5550 1234`.

### @ [CAT] Imprint page {R:145}
- **Pre:** context G, home page.
- **Do:** Open the imprint (or legal notice) through the footer.
- **Expect:** The page shows `HRB 234567 B` and `DE298765431`.

### @ [CAT] Category shows the number of products {R:13}
- **Pre:** context G, category Beverages.
- **Expect:** The page states the number of matching products as {{D_S15.beverages_for_guests}}.

### @ [CAT] Add to cart directly from a listing {R:146}
- **Pre:** context K, CLEAR, subcategory Water & Soft Drinks.
- **Do:** Without opening the product page, add 1 × WAT-002 crate from the listing, then open the cart.
- **Expect:** The cart holds a WAT-002 crate line with the line total {{D_CAT.WAT002_crate}}.

### @unit [CAT] Selecting a packaging unit shows its price {R:147}
- **Pre:** context K, WAT-002 product page.
- **Do:** Select the box of 6, then DOM JS-MAINIMGSRC (record as **SRC_BOX**). Select the crate.
- **Expect:** The price shown for the selection is {{D_CAT.WAT002_crate}}.

### @ [CAT] Selecting a packaging unit shows its image {R:147}
- **Pre:** after @@unit (crate selected).
- **Do:** DOM JS-MAINIMGSRC.
- **Expect:** The value differs from SRC_BOX.

### @ [UIQ] Restricted product page shown as a branded not-found page {R:149,126}
- **Pre:** In context F, open SPI-001 and record its URL as **SPIURL**. Switch to context K.
- **Do:** Open SPIURL, then DOM JS-LINKPATHS.
- **Expect:** No SPI-001 name, price or add-to-cart is shown, and the paths include CARTPATH (the page keeps the shop's header).

### @ [SAFE] Password reset does not reveal registered emails {R:137}
- **Pre:** fresh context G.
- **Do:** Request a password reset for `nobody@spreegrund-test.example` and note the message, then request one for `kontakt@spaetkauf-kanal.example` and note the message.
- **Expect:** Both messages are identical.

### @ [SAFE] Entered markup is shown as text, not executed {R:153,38}
- **Pre:** context K, CLEAR, ADD 1 × TEA-001 box, ORDER(Pickup, Card) with the delivery note `<i>NOTE-153</i>`.
- **Do:** In context A, open the admin page of that order.
- **Expect:** The delivery note shows the literal characters `<i>NOTE-153</i>` (angle brackets visible), not an italic `NOTE-153`.

### @ [ADM] Staff accounts {R:143}
- **Pre:** context A.
- **Do:** Create a staff account `Lager Team`, `lager@spreegrund.example`, password `Lager!Team2026` (or the password the shop's flow lets you set, for example via the invitation email in the mail log). In a fresh context, sign in to the admin area with it.
- **Expect:** The admin dashboard is shown for the new staff account.

### @ [ADM] Promotion list shows each promotion's status {R:151,56}
- **Pre:** context A, admin list of promotions or promotion codes.
- **Expect:** SUMMER25 is shown as expired, NEWYEAR2028 as scheduled (or not yet valid) and OLDCODE as deactivated (or inactive).

### @ [REP] Orders export as CSV {R:150}
- **Pre:** after Setup PP and Setup CO. Context A.
- **Do:** Export the orders (of today, or all) as a CSV file and open it.
- **Expect:** The file is CSV (comma- or semicolon-separated text with a header line), and it contains the order numbers PP and CO.

### @ [SAFE] Sign-in locked after five failed attempts {R:137}
- **Pre:** fresh context (guest).
- **Do:** Sign in five times as `bestellung@feinkost-lindner.example` with the wrong password `Falsch!123`, then once with the correct password `Lindner!80331`.
- **Expect:** The sixth attempt is refused although the password is correct (quote the message), and no price is visible on WAT-001 afterwards.

### @ [UIQ] Empty cart state {R:149}
- **Pre:** context K, CLEAR, open the cart.
- **Expect:** The cart page says that it is empty (the text contains `empty`) and offers a link to the home page or a category.

### @ [ADM] Staff sign-in independent of the customer session {R:49}
- **Pre:** context K (signed in as C-10007, with CARTPATH recorded). In the same browser session, open the admin sign-in page (0.1 rule 2).
- **Do:** DOM JS-LINKPATHS.
- **Expect:** CARTPATH is not among the paths, and the page does not show `Spätkauf am Kanal`.

### @ [ADM] Prices are entered in euros, not cents {R:6,53}
- **Pre:** context A, edit page of WAT-002 (packaging prices visible).
- **Expect:** The price field of the box of 6 shows the value {{D_ADM.wat002_box_old}}. The value is written in euros, not in cents.

### @ [ADM] Category chosen from existing records {R:154}
- **Pre:** context A, edit page of WAT-002.
- **Do:** Open the category control (DOM JS-CATFIELD may help to identify it).
- **Expect:** The category is chosen from the existing categories (a list, a searchable picker, checkboxes or radio buttons offering the category names); it is not typed as free text or as a path.

### @ [ADM] Seeded balances shown consistently in the admin {R:157,151}
- **Pre:** context A, admin customer list (or the customer page of C-10004 if the list shows no balances).
- **Expect:** C-10004 is shown with the open balance {{D_CUST.C10004_balance}}.

### @ [UIQ] No raw template code in the storefront {R:156}
- **Pre:** context G.
- **Do:** DOM JS-RAW on the home page, the category Beverages and the WAT-001 product page.
- **Expect:** All three results are empty lists.

### @ [UIQ] No raw template code in the admin area {R:156}
- **Pre:** context A, admin product list.
- **Do:** DOM JS-RAW.
- **Expect:** An empty list.

### @ [UIQ] Phone menu reaches every category {R:144,1}
- **Pre:** context G, phone viewport (390 × 844), home page.
- **Do:** Using only the site's menu (no search, no typed URL), open the subcategory Sauces & Condiments.
- **Expect:** The Sauces & Condiments category page is shown and lists SAU-002.

### @ [CAT] Packaging overview shows each unit's price {R:7,66}
- **Pre:** context K, WAT-002 product page, without changing any selection.
- **Expect:** The box of 6 is listed with {{D_ADM.wat002_box_old}}. The crate is listed with {{D_CAT.WAT002_crate}}. Both are shown at the same time.

### @ [SHIP] Checkout review is read-only {R:34}
- **Pre:** context K, CLEAR, ADD 1 × WAT-002 crate, REVIEW(Pickup).
- **Do:** DOM JS-QTYINPUTS on the final review page.
- **Expect:** `0`.

### @ [SHIP] Checkout review shows the order lines as text {R:34,41}
- **Pre:** the review page of the previous check.
- **Expect:** The WAT-002 crate line total is {{D_CAT.WAT002_crate}}. The line shows the quantity 1 as text.

### @ [ADM] No unsaved-changes warning without changes {R:155}
- **Pre:** context A, edit page of WAT-002, freshly loaded. Change nothing.
- **Do:** Navigate to the admin dashboard through the admin navigation.
- **Expect:** The dashboard opens without any "unsaved changes" or "leave page" warning or dialog.

---

## S16 Company roles and approvals

Reset. Contexts:

| Context | Signed in as |
|---|---|
| **J** | Jana Petersen, company admin of C-10001 |
| **M** | Mehmet Yilmaz, buyer of C-10001 with a per-order budget of {{BUD.mehmet}} |
| **K** | C-10007 |
| **A** | admin |

Run CLEAR before every setup that adds goods.

### @ [B2BW] Order within the budget is confirmed directly {R:159}
- **Pre:** context M, ADD 1 × OIL-001 tin, ORDER(Pickup, Invoice) (gross {{AP2.gross}}).
- **Expect:** The order's state is confirmed.

### @ap1 [B2BW] Order above the budget awaits approval {R:159}
- **Pre:** context M, CLEAR, ADD 4 × OIL-001 carton and 3 × CAN-006 jar, ORDER(Pickup, Invoice). The gross total {{AP1.gross}} is above the budget. Note the order number as **AP1**.
- **Expect:** The order's state is `awaiting approval` (or `pending approval` / `waiting for approval`).

### @ [B2BW] Stock is reserved while the order awaits approval {R:159,63}
- **Pre:** after @@ap1. Context K.
- **Do:** Open CAN-006.
- **Expect:** Its availability contains `out of stock`.

### @ [B2BW] Company admin is asked for approval {R:159,142}
- **Pre:** after @@ap1.
- **Expect:** MAIL(einkauf@osthafen-kueche.example, AP1) is met by an email whose subject or body contains `approv`.

### @apok [B2BW] Company admin approves the order {R:159}
- **Pre:** after @@ap1. Context J, the company's orders awaiting approval.
- **Do:** Approve AP1 (confirm if asked).
- **Expect:** AP1 shows the state confirmed.

### @ [B2BW] Buyer is told about the approval {R:159}
- **Pre:** after @@apok.
- **Expect:** MAIL(kueche@osthafen-kueche.example, AP1) is met by an email whose subject or body contains `approved`.

### @aprej [B2BW] Rejection with a reason cancels the order {R:159}
- **Pre:** context M, CLEAR, ADD 4 × OIL-001 carton, ORDER(Pickup, Invoice); note the order number as **AP3**. In context J, reject AP3 with the reason `Budget for this week used up`.
- **Expect:** In context M, AP3 shows the state cancelled together with the text `Budget for this week used up`.

### @ [B2BW] Buyer receives the rejection reason {R:159}
- **Pre:** after @@aprej.
- **Expect:** MAIL(kueche@osthafen-kueche.example, `Budget for this week used up`) is met.

### @invite [B2BW] Company admin invites a user {R:158}
- **Pre:** context J, the company's user management in the account area.
- **Do:** Invite `Ole Koch`, email `koch@osthafen-kueche.example`, role buyer, per-order budget `200.00`.
- **Expect:** MAIL(koch@osthafen-kueche.example, `http`) is met (an invitation with a link).

### @ole [B2BW] Invited user joins the company {R:158,21}
- **Pre:** after @@invite. In a fresh context, open the link from the invitation, set the password `Koch!Ole2026` and sign in as `koch@osthafen-kueche.example`.
- **Do:** Open COF-001.
- **Expect:** The negotiated price per bag {{P14.L1_unit}} of C-10001 is shown.

### @ [B2BW] Deactivated user cannot sign in {R:158}
- **Pre:** after @@ole. In context J, deactivate Ole Koch (confirm if asked).
- **Do:** In a fresh context, try to sign in as `koch@osthafen-kueche.example` with `Koch!Ole2026` and open WAT-001.
- **Expect:** No price is visible.

---

## S17 Quotes and standing orders

Reset. Contexts **K** (C-10007) and **A** (admin). E is the earliest truck delivery date (0.6) computed immediately before a standing order is created. The start date entered for a standing order is a stored fixture value (**SD1**, **SD2**, **SD3** below); later steps use it, never a recomputed E. If, when a generation step runs, the stored start date is earlier than the current E (the cut-off or midnight passed), the fixture is no longer valid: end or delete that standing order, create it again with the current E as its start date, note that date, and repeat the step.

### @q1 [B2BW] Customer requests a quote {R:161}
- **Pre:** context K, CLEAR, ADD 10 × SOFT-001 tray.
- **Do:** Request a quote for the cart with the comment `Event on Saturday`.
- **Expect:** The shop confirms the request with the quote number `SQ-10001`.

### @ [B2BW] Staff see the quote request {R:161}
- **Pre:** after @@q1, context A, quotes.
- **Expect:** SQ-10001 is listed with the state requested (or new), for C-10007, with the line 10 × SOFT-001 tray.

### @q2 [B2BW] Staff send a quote; the customer is notified {R:161,47}
- **Pre:** after @@q1. In context A, set the price of the SOFT-001 line to `13.00` ({{QIN.price}}) per tray, set the expiry date to today + 7 days and send the quote.
- **Expect:** MAIL(kontakt@spaetkauf-kanal.example, `SQ-10001`) is met.

### @q3 [B2BW] Accepting a quote fills the cart at the quoted price {R:161}
- **Pre:** after @@q2. Context K, CLEAR, open SQ-10001 in the account area.
- **Do:** Accept the quote and open the cart.
- **Expect:** The SOFT-001 line (10 trays) has the line total {{Q1.L1_net}}.

### @ [B2BW] Quoted lines are not discounted by a code {R:161,84}
- **Pre:** after @@q3. Apply `B2B7`, then REVIEW(Pickup).
- **Expect:** The gross total is {{Q1b.gross}}. No discount is applied to the quoted line.

### @ [B2BW] An accepted quote becomes an order {R:161}
- **Pre:** after the previous check, place the order (ORDER(Pickup, Card) from the review). In context A, open SQ-10001.
- **Expect:** SQ-10001 shows the state accepted (or ordered).

### @ [B2BW] A declined quote cannot be accepted {R:161}
- **Pre:** context K, CLEAR, ADD 1 × TEA-001 box, request a quote (SQ-10002). In context A, set the price `7.00`, expiry today + 7 days, and send it. In context K, decline SQ-10002.
- **Expect:** SQ-10002 shows the state declined, and no accept action is offered for it.

### @ [B2BW] Expiry dates in the past are refused {R:161}
- **Pre:** context K, CLEAR, ADD 1 × TEA-001 box, request a quote (SQ-10003). Context A, SQ-10003.
- **Do:** Set the expiry date to yesterday and try to send the quote.
- **Expect:** The shop refuses it with a message (quote it); the quote is not sent.

### @so1 [B2BW] Customer sets up a standing order {R:162}
- **Pre:** context K, standing orders in the account area.
- **Do:** Create a standing order: every week on the weekday of E, starting E, 7 × BEER-001 crate, Truck with slot 06:00–09:00, SEPA direct debit (holder `Aylin Demir`, IBAN DE89 3704 0044 0532 0130 00). Note the start date as **SD1**.
- **Expect:** The standing order is listed as active with the next date SD1.

### @sogen [B2BW] Staff generate the due occurrence {R:162}
- **Pre:** after @@so1. In context A, run "generate due standing orders now".
- **Expect:** In context K, the order history has a new order with the delivery date SD1.

### @ [B2BW] Generated order is priced at the then-valid prices {R:162}
- **Pre:** after @@sogen, the new order's detail page.
- **Expect:** The gross total is {{STO1.gross}}.

### @ [B2BW] An occurrence is generated only once {R:162}
- **Pre:** after @@sogen. In context A, run "generate due standing orders now" again.
- **Expect:** In context K, the order history still has exactly one order with the delivery date SD1 for this standing order.

### @ [B2BW] A skipped date is not generated {R:162}
- **Pre:** context K, create a second standing order: every week on the weekday of E, starting E, 1 × TEA-001 box, Pickup, SEPA direct debit as above; note the start date as **SD2**. Skip the date SD2. In context A, run "generate due standing orders now".
- **Expect:** No order with TEA-001 and the date SD2 has been created for C-10007.

### @ [B2BW] A paused standing order is not generated {R:162}
- **Pre:** context K, create a third standing order: every week on the weekday of E, starting E, 1 × SAU-003 bucket, Pickup, SEPA direct debit as above; note the start date as **SD3**. Pause it. In context A, run "generate due standing orders now".
- **Expect:** No order with SAU-003 has been created for C-10007.

---

## S18 Payment terms, dunning and e-invoices

Reset. Contexts **H** (C-10004, Sabine Hoffmann), **J** (Jana, C-10001), **W** (C-10005) and **A** (admin).

**Setup ED:** context H, ADD 2 × OIL-001 tin and 1 × WINE-001 carton, ORDER(Pickup, Invoice) (gross {{ED1.gross}}). In context A, SHIP it. Open its invoice in context H.

### @ [FIN] Invoice shows the early-payment discount {R:163}
- **Pre:** Setup ED.
- **Expect:** The invoice shows an early-payment discount of {{ED1d.discount}}.

### @edread [FIN] Invoice shows the discounted amount payable {R:163}
- **Pre:** Setup ED.
- **Expect:** The invoice's discounted amount payable is {{ED1d.payable}}. The invoice presents it as the amount payable within the discount period.

### @ [FIN] Invoice shows the last day of the discount period {R:163}
- **Pre:** Setup ED.
- **Expect:** The last day of the discount period shown is the invoice date + 10 days.

### @edpay [FIN] Paying the discounted amount settles the invoice {R:163}
- **Pre:** Setup ED. In context A, record a payment for this invoice, dated today, of exactly the discounted amount payable that the invoice showed in @@edread. [[Reviewer note: {{~ED1d.payable}}.]]
- **Expect:** The order's payment status is `paid`.

### @ [FIN] VAT correction of the discount: 7 % {R:163}
- **Pre:** after @@edpay, context A, the payment or invoice in the admin area.
- **Expect:** The VAT correction for 7 % is shown as {{ED1d.vatcorr7}}.

### @ [FIN] VAT correction of the discount: 19 % {R:163}
- **Pre:** after @@edpay.
- **Expect:** The VAT correction for 19 % is shown as {{ED1d.vatcorr19}}.

### @ [FIN] E-invoice with both VAT IDs {R:160}
- **Pre:** Setup ED, context H. Open the electronic invoice (XRechnung) of the invoice from its download link.
- **Expect:** The electronic invoice contains `DE298765431` and `DE188776655`.

### @ [FIN] E-invoice with the VAT breakdown {R:160}
- **Pre:** the electronic invoice of the previous check.
- **Expect:** The electronic invoice's VAT amount for 7 % is {{ED1.vat7@invoice}}. Its VAT amount for 19 % is {{ED1.vat19@invoice}}.

### @ [FIN] E-invoice of a reverse-charge invoice {R:160,92}
- **Pre:** context W, CLEAR, ADD 2 × OIL-001 carton, ORDER(EU, Invoice). In context A, SHIP it. In context W, open its electronic invoice.
- **Expect:** It contains the VAT category code `AE` (reverse charge).

### @part [FIN] Partial payment shows the remaining amount {R:163}
- **Pre:** context J, CLEAR, ADD 2 × OIL-001 tin, ORDER(Pickup, Invoice) (gross {{PART.gross}}). In context A, SHIP it and record a payment of `50.00` ({{PART.paid}}).
- **Expect:** The remaining amount is {{PART.remaining@invoice,order}}. It is shown on the invoice or on the order detail page.

### @ [FIN] Partial payment status {R:163,100}
- **Pre:** after @@part.
- **Expect:** The payment status is `partially paid`.

### @dun [FIN] Dunning run: first dunning notice with fee {R:164}
- **Pre:** context A. Start the dunning run. Open customer C-10009.
- **Expect:** LEG-0398 is at the first dunning level with a fee of {{DUN.fee1}}.

### @ [FIN] Dunning run: second dunning notice with fee {R:164}
- **Pre:** after @@dun.
- **Expect:** LEG-0377 is at the second dunning level with a fee of {{DUN.fee2}}.

### @ [FIN] Dunning run: payment reminder without fee {R:164}
- **Pre:** after @@dun.
- **Expect:** LEG-0412 has a payment reminder and no fee.

### @ [FIN] Dunning fees raise the open balance {R:164}
- **Pre:** after @@dun.
- **Expect:** The open balance of C-10009 is {{DUN.balance_after}}.

### @ [FIN] Dunning notice by email {R:164}
- **Pre:** after @@dun.
- **Expect:** MAIL(info@imbiss-ecke.example, `LEG-0377`) is met.

### @ [FIN] Second dunning level revokes purchase on invoice {R:164}
- **Pre:** after @@dun, context A, customer C-10009.
- **Expect:** Purchase on invoice is shown as not allowed.

### @ [FIN] A second run adds nothing {R:164}
- **Pre:** after @@dun. Start the dunning run again.
- **Expect:** The open balance of C-10009 is {{DUN.balance_after}}.

---

## S19 Countries and currencies

Reset. Contexts **CH** (C-10010, Reto Meier), **UK** (C-10011, Oliver Grant), **G** (guest) and **A** (admin). Run CLEAR before every setup that adds goods. "International Freight" is the method named in `shipping.md` section 6.

### @ [INTL] Swiss customer sees prices in CHF {R:166,165}
- **Pre:** context CH, OIL-001 product page.
- **Expect:** The single-tin price is {{X1.L1_unit}}, shown in CHF.

### @ [INTL] UK customer sees prices in GBP {R:166,165}
- **Pre:** context UK, OIL-001 product page.
- **Expect:** The single-tin price is {{X6.L1_unit}}, shown in GBP.

### @ [INTL] International Freight minimum in CHF {R:165}
- **Pre:** context CH, ADD 1 × OIL-001 carton (goods {{X4.goods}}), start checkout.
- **Expect:** International Freight is not offered, or refused because of the minimum order value.

### @ [INTL] Deposit products are not delivered to Switzerland {R:167}
- **Pre:** context CH, CLEAR, ADD 2 × OIL-001 carton and 1 × WAT-001 crate, start checkout.
- **Expect:** No shipping method is offered for this cart, and the shop names WAT-001 or Sparkling Mineral Water as the reason.

### @ [INTL] Chilled products are not delivered to the United Kingdom {R:167}
- **Pre:** context UK, CLEAR, ADD 2 × OIL-001 carton and 1 kg of CHE-001, start checkout.
- **Expect:** No shipping method is offered for this cart, and the shop names CHE-001 or Young Gouda as the reason.

**Setup X2:** context CH, CLEAR, ADD 2 × OIL-001 carton, REVIEW with International Freight.

### @ [INTL] International Freight fee in CHF {R:165,93}
- **Pre:** Setup X2.
- **Expect:** The shipping amount is {{X2.shipping}} in CHF.

### @ [INTL] Export delivery without VAT {R:167}
- **Pre:** Setup X2.
- **Expect:** The VAT total is {{X2.vat}}.

### @ [INTL] Swiss gross total in CHF {R:166}
- **Pre:** Setup X2.
- **Expect:** The gross total is {{X2.gross}} in CHF.

### @ [INTL] UK gross total in GBP {R:166}
- **Pre:** context UK, CLEAR, ADD 2 × OIL-001 carton, REVIEW with International Freight.
- **Expect:** The gross total is {{X3.gross}} in GBP.

### @x2inv [INTL] Export invoice wording {R:167,48}
- **Pre:** Setup X2, place the order with Card. In context A, SHIP it. Open its invoice.
- **Expect:** The invoice contains `Tax-free export delivery`.

### @ [INTL] Invoice in the order currency {R:166}
- **Pre:** the invoice from @@x2inv.
- **Expect:** The gross total is {{X2.gross}} in CHF.

### @ [INTL] Export e-invoice carries the export VAT category {R:160,167}
- **Pre:** the invoice from @@x2inv. Open its electronic invoice (XRechnung).
- **Expect:** The VAT category of the invoice is the one for tax-free export (category code `G`), with an exemption reason that mentions export.

### @ [INTL] Reports show the EUR equivalent {R:166,117}
- **Pre:** after @@x2inv. Context A, sales report with the period today.
- **Expect:** The Swiss order's amount is {{X2.gross}}. Its EUR equivalent is {{FX.x2_eur}}.

### @rate [INTL] A rate change does not alter placed orders {R:166}
- **Pre:** after @@x2inv. In context A, change the CHF exchange rate from {{FX.chf}} to `0.97` ({{FX.chf_new}}).
- **Expect:** The order from @@x2inv shows the gross total {{X2.gross}}.

### @ [INTL] A rate change applies to new carts {R:166}
- **Pre:** after @@rate. Context CH, CLEAR, ADD 1 × OIL-001 tin.
- **Expect:** The line total is {{X5.L1_net}} in CHF.

### @ [INTL] Country storefront for guests {R:165}
- **Pre:** context G.
- **Do:** Choose the storefront Switzerland and open the delivery and payment information page.
- **Expect:** The page names CHF as the currency and International Freight as the shipping method.

---

## S20 Order workflows and process diagrams

Reset. Contexts **K** (C-10007), **CH** (C-10010) and **A** (admin). Run CLEAR before every setup that adds goods.

### @ [WFL] Standard workflow diagram {R:168,180}
- **Pre:** context A, the order workflows, Standard workflow diagram.
- **Expect:** The diagram shows these eight states: awaiting approval, pending payment, confirmed, partially shipped, shipped, delivered, completed, cancelled.

### @ [WFL] Current state highlighted on an order {R:180}
- **Pre:** context K, ADD 1 × OIL-001 tin, ORDER(Pickup, Card). Context A, the admin page of that order.
- **Expect:** The order's workflow diagram marks `confirmed` as the current state, set apart from the other states (for example highlighted or labelled current).

### @chil [WFL] Chilled order follows the Chilled goods workflow {R:168}
- **Pre:** context K, CLEAR, ADD 1 kg of CHE-001 and 1 × OIL-001 carton, ORDER(Pickup, Card). Note the order number as **CHIL1**. Context A, the admin page of CHIL1.
- **Expect:** The order shows the workflow `Chilled goods`, and its states include `cold-chain check`.

### @ [WFL] A transition is blocked while its condition fails {R:168}
- **Pre:** after @@chil, the admin page of CHIL1, before the cold-chain check has been recorded.
- **Expect:** No action to ship the order is offered (absent or disabled).

### @ [WFL] The transition is offered once its condition holds {R:168}
- **Pre:** after the previous check. Record the cold-chain check as done.
- **Expect:** An action to ship the order is now offered.

### @expo [WFL] Export order follows the Export workflow {R:168,167}
- **Pre:** context CH, ADD 2 × OIL-001 carton, place the order with International Freight and Card. Note the order number as **EXP1**. Context A, the admin page of EXP1.
- **Expect:** The order shows the workflow `Export`, and its states include `export documents ready`.

### @ [WFL] Automatic action when a state is entered {R:168}
- **Pre:** after @@expo. Context A, move EXP1 into the state `export documents ready`.
- **Expect:** MAIL(admin@spreegrund.example, EXP1) is met by an email that is new since the state change and whose subject or body contains `export`.

### @wfv2 [WFL] Editing a workflow creates a new version {R:180}
- **Pre:** context A, the Chilled goods workflow in its diagram editor.
- **Do:** Add the step `Temperature log signed` between `cold-chain check` and shipping (with a transition into it and one out of it) and save.
- **Expect:** The version history of the Chilled goods workflow lists two versions.

### @ [WFL] New orders use the new version {R:180}
- **Pre:** after @@wfv2. Context K, CLEAR, ADD 1 kg of CHE-001 and 1 × OIL-001 carton, ORDER(Pickup, Card). Context A, the admin page of this order.
- **Expect:** Its workflow includes the step `Temperature log signed`.

### @ [WFL] Running orders keep their version {R:180}
- **Pre:** after @@wfv2. Context A, the admin page of CHIL1.
- **Expect:** Its workflow does not include `Temperature log signed`.

### @ [WFL] An invalid workflow is refused {R:180}
- **Pre:** context A, the Chilled goods workflow in its diagram editor.
- **Do:** Add a step `Orphan step` without any transition into it and save.
- **Expect:** The shop refuses to save it with a message (quote it), and the version history still lists two versions.

### @ [WFL] Versions can be compared {R:180}
- **Pre:** after @@wfv2. Context A, the version history of the Chilled goods workflow.
- **Do:** Compare version 1 with version 2.
- **Expect:** The comparison shows the step `Temperature log signed` as added.

### @ [WFL] Fulfillment processes are shown as diagrams {R:180,176}
- **Pre:** context A, process diagrams.
- **Expect:** A diagram of the cross-docking process is shown, and it contains a step for the supplier purchase order.

---

## S21 Payment flows and credit balance

Reset. Contexts **K** (C-10007) and **A** (admin). Run CLEAR before every setup that adds goods. "Record a transfer" means entering an incoming bank transfer in the admin area with the amount, the payer `Spätkauf am Kanal UG` and the reference text given.

### @bt1 [FIN] Exact transfer confirms a prepayment order {R:170}
- **Pre:** context K, ADD 1 × OIL-001 tin, ORDER(Pickup, Prepay); note the order number as **P1**. In context A, record a transfer of {{>BT.gross}} with the reference P1.
- **Expect:** P1 shows the state confirmed.

### @bt2 [FIN] Overpayment becomes credit balance {R:170,171}
- **Pre:** context K, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Prepay); note **P2**. In context A, record a transfer of {{>BT.over_paid}} with the reference P2.
- **Expect:** In context K, the account shows a credit balance of {{BT.credit}}.

### @bt3 [FIN] Underpayment leaves the order pending {R:170}
- **Pre:** context K, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Prepay); note **P3**. In context A, record a transfer of {{>BT.under_paid}} with the reference P3.
- **Expect:** The remaining amount of P3 is {{BT.remaining}}. P3 is still in the state pending payment.

### @ [FIN] Staff accept the difference {R:170}
- **Pre:** after @@bt3. In context A, accept the remaining difference for P3.
- **Expect:** P3 shows the state confirmed.

### @bt5 [FIN] Transfer without a usable reference is unmatched {R:170}
- **Pre:** context K, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Prepay); note **P4**. In context A, record a transfer of {{>BT.gross}} with the reference `Rechnung Spaetkauf`.
- **Expect:** The transfer appears in the list of unmatched payments, and P4 still shows pending payment.

### @ [FIN] Manual matching confirms the order {R:170}
- **Pre:** after @@bt5. In context A, match the unmatched transfer to P4.
- **Expect:** P4 shows the state confirmed.

### @split [FIN] Credit balance and card pay one order together {R:171,169}
- **Pre:** after @@bt2 (credit balance {{BT.credit}}). Context K, CLEAR, ADD 1 × OIL-001 tin, start checkout with Pickup, use the credit balance and pay the rest by Card; note **P5**.
- **Expect:** The amount paid from the credit balance is {{SPLIT.credit_used}}. The card authorisation is {{SPLIT.card}}. Nothing has been captured from the card yet.

### @ [FIN] A refund is split back across the methods {R:171}
- **Pre:** after @@split. In context A, SHIP and DELIVER P5. In context K, request a return of the tin (reason quality complaint). In context A, approve and refund it.
- **Expect:** In context K, the credit balance is {{SPLIT.refund_credit}}. In the payment history of P5, the card refund is {{SPLIT.refund_card}}.

### @dup [FIN] A duplicate payment becomes credit balance {R:170,171}
- **Pre:** after the previous check. In context A, record a second transfer of {{>BT.gross}} with the reference P1 (P1 is already paid).
- **Expect:** In context K, the credit balance is {{BT.dup_credit}}.

### @ [FIN] One transfer pays several named orders {R:170}
- **Pre:** context K, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Prepay); note **P9**. CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Prepay); note **P10**. In context A, record one transfer of {{>BT.two_orders}} with the reference `P9 P10` (both numbers).
- **Expect:** P9 and P10 both show the state confirmed.

### @ [FIN] Staff pay out a credit balance {R:171,172}
- **Pre:** after @@dup. In context A, pay out the whole credit balance of C-10007.
- **Expect:** In context K (account), the credit balance is {{BT.after_payout}}. In context A (payments ledger), the payout is {{BT.dup_credit}}.

### @cap1 [FIN] Card amount captured at shipment {R:169}
- **Pre:** context K, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Card) (gross {{RC.gross}}). In context A, SHIP it.
- **Expect:** The captured amount in the payment history is {{RC.gross}}. The payment status is `paid`.

### @cb [FIN] Chargeback flags the order {R:169}
- **Pre:** context K, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Card) with the card `4000 0000 0000 0259`; note **P7**. In context A, SHIP it.
- **Expect:** The payment status of P7 is `charged back`, and the order is flagged.

### @ [FIN] Staff are notified of a chargeback {R:169}
- **Pre:** after @@cb.
- **Expect:** MAIL(admin@spreegrund.example, P7) is met by an email that is new since @@cb's shipment and whose subject or body contains `chargeback`.

### @ [FIN] Expired authorisation holds the shipment {R:169}
- **Pre:** context K, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Card) with the card `4000 0000 0000 0069`; note **P8**. In context A, try to SHIP it.
- **Expect:** P8 is flagged `payment action required` (or equivalent wording), and its payment status is not `paid`. No shipment and no invoice exist for P8, and its OIL-001 quantity is still unshipped (open).

### @ [FIN] Catch-weight capture within the tolerance {R:169,75}
- **Pre:** context K, CLEAR, ADD 1 × CHE-006 wheel, ORDER(Pickup, Card) (authorised {{CAP.authorised}}). In context A, record the actual weight 3.2 kg and SHIP it.
- **Expect:** The captured amount in the payment history is {{CAP.capture_32}}. The capture is not above the limit {{~CAP.limit}}.

### @ [FIN] Catch-weight above the tolerance needs a new authorisation {R:169,75}
- **Pre:** context K, CLEAR, ADD 1 × CHE-006 wheel, ORDER(Pickup, Card). In context A, record the actual weight 3.6 kg (new total {{CAP.capture_36}}, above the limit {{CAP.limit}}) and try to SHIP it.
- **Expect:** The order is flagged `payment action required` (or equivalent), and no capture above {{~CAP.limit}} appears in its payment history.

### @ [FIN] Payments ledger {R:172}
- **Pre:** after @@cb, context A, payments ledger.
- **Expect:** The chargeback amount of P7 in the payments ledger is {{RC.gross@admin}}.

---

## S22 Warehouses and fulfillment

Reset. Contexts **K** (C-10007), **F** (C-10002), **H** (C-10004) and **A** (admin). Run CLEAR before every setup that adds goods.

### @ [FUL] Stock is shown per warehouse {R:173,61,120}
- **Pre:** context A, stock of BEER-001.
- **Expect:** The stock in WH-BER is {{D_WH.beer_ber}} bottles. The stock in WH-BRB is {{D_WH.beer_brb}} bottles.

### @alloc [FUL] Allocation takes WH-BER first {R:173}
- **Pre:** context H, ADD 65 × BEER-001 crate, ORDER(Truck, Invoice) (gross {{AL1.gross}}); note **AL**. Context A, admin page of AL.
- **Expect:** The quantity allocated from WH-BER is {{D_WH.beer_alloc_ber_crates}} crates. The quantity allocated from WH-BRB is {{D_WH.beer_alloc_brb_crates}} crates.

### @ [FUL] Pick list per warehouse {R:175}
- **Pre:** after @@alloc. Context A, the pick list of WH-BRB.
- **Expect:** It lists BEER-001 with {{D_WH.beer_alloc_brb_crates}} crates for AL.

### @ [FUL] Packing slip without prices {R:175}
- **Pre:** after @@alloc. Context A, ship the WH-BRB part of AL and open its packing slip.
- **Expect:** The packing slip quantity of BEER-001 is {{D_WH.beer_alloc_brb_crates}} crates. The packing slip shows no € amounts.

### @ [FUL] Two warehouses, two shipments, one shipping charge {R:173}
- **Pre:** after the previous check. Ship the WH-BER part of AL.
- **Expect:** The gross total of AL is {{AL1.gross}}. AL has two shipments.

### @tr1 [FUL] Stock in transit cannot be sold {R:174}
- **Pre:** context A. Transfer {{D_WH.oil_transfer}} tins of OIL-001 from WH-BRB to WH-BER and mark them dispatched, not yet received.
- **Do:** In context K, try to add {{D_WH.oil_try}} × OIL-001 tin.
- **Expect:** Rejected. Only {{~D_WH.oil_sellable_in_transit}} tins are sellable while the transfer is in transit.

### @ [FUL] Received transfer is sellable again {R:174}
- **Pre:** after @@tr1. In context A, record the transfer as received.
- **Do:** In context K, CLEAR and add {{D_WH.oil_sellable_after}} × OIL-001 tin.
- **Expect:** Accepted.

### @ [FUL] Cross-docked product shows its lead time {R:176,8}
- **Pre:** context K, WINE-006 product page.
- **Expect:** The availability contains `ships in 3 working days` (or `3 working days`).

### @ [FUL] Cross-docked order creates a supplier purchase order {R:176}
- **Pre:** context F, ADD {{D_WH.wine006_order}} × WINE-006 bottle, ORDER(Pickup, Card). Context A, supplier purchase orders.
- **Expect:** A purchase order `PUR-10001` to SUP-01 (Weinkontor Potsdam) lists WINE-006 with {{D_WH.wine006_order}} bottles.

### @drop [FUL] Drop-shipped product creates a drop-shipment purchase order {R:177}
- **Pre:** context K, CLEAR, ADD 1 × NF-006 and 1 × OIL-001 carton, ORDER(Truck, Card); note **DS**. Context A, supplier purchase orders.
- **Expect:** A purchase order to SUP-02 (Havelgas Versorgung) for NF-006 is marked as a drop-shipment.

### @ [FUL] Drop-shipment is a separate shipment {R:177}
- **Pre:** after @@drop. In context A, record the supplier's dispatch of NF-006 with the tracking reference `HG-4711`.
- **Expect:** In context K, DS shows a separate shipment for NF-006 with `HG-4711`.

---

## S23 Partial cancellations and returns

Reset. Contexts **K** (C-10007), **F** (C-10002), **H** (C-10004) and **A** (admin). Run CLEAR before every setup that adds goods.

### @pc0 [RET] Customer cancels one line before shipment {R:178,46}
- **Pre:** context K (no earlier order in this suite), ADD 2 × OIL-001 tin and 3 × TEA-001 box, apply `WELCOME10`, ORDER(Pickup, Card) (gross {{PC0.gross}}); note **PC**.
- **Do:** In the order detail, cancel the TEA-001 line (confirm if asked).
- **Expect:** The order's gross total is {{PC1.gross}}.

### @ [RET] Promotion re-checked after a cancellation {R:178,86}
- **Pre:** after @@pc0, order detail of PC.
- **Expect:** WELCOME10 is no longer applied, because the remaining goods value is below 100.00.

### @ [RET] Card authorisation reduced after a cancellation {R:178,169}
- **Pre:** after @@pc0, payment history of PC (customer or admin view).
- **Expect:** The open authorised amount is {{PC1.gross}}.

### @ [RET] Staff cancel the open rest after a partial shipment {R:178,103}
- **Pre:** context F, ADD 1 × OIL-001 tin and 2 × FRZ-006 bag (backordered), ORDER(Pickup, Card) (gross {{PC2a.gross}}). In context A, ship the tin only, then cancel the FRZ-006 line.
- **Expect:** The order's gross total is {{PC2b.gross}}. The order shows the state shipped.

### @rs [RET] Mistaken order: restocking fee {R:179}
- **Pre:** context K, CLEAR, ADD 2 × OIL-001 tin, ORDER(Pickup, Card). In context A, SHIP and DELIVER it. In context K, request a return of 1 tin with the reason `ordered by mistake`. In context A, approve and refund it.
- **Expect:** The credit note shows a restocking fee of {{RS1.restocking_fee}}.

### @ [RET] Credit note after the restocking fee {R:179,115}
- **Pre:** the credit note from @@rs.
- **Expect:** The gross total is {{RS1.gross}}.

### @qa [DEP] Quality complaint refunds the deposits {R:179,77}
- **Pre:** context K, CLEAR, ADD 1 × WAT-001 crate, ORDER(Pickup, Card). In context A, SHIP and DELIVER it. In context K, request a return of the crate with the reason `quality complaint`. In context A, approve and refund it.
- **Expect:** The credit note shows the deposit {{QA1.deposits}}.

### @ [RET] Quality complaint refund in full {R:179}
- **Pre:** the credit note from @@qa.
- **Expect:** The gross total is {{QA1.gross}}.

### @ [RET] Catch-weight return by weight {R:179,75}
- **Pre:** context K, CLEAR, ADD 1 × CHE-006 wheel, ORDER(Pickup, Card). In context A, record the actual weight 3.2 kg, SHIP and DELIVER it. In context K, request a return of 1.0 kg with the reason `quality complaint`. In context A, approve and refund it.
- **Expect:** The credit note's gross total is {{CW1.gross}}.

### @ [RET] Chilled goods can be returned only for quality complaints {R:113,179}
- **Pre:** context K, CLEAR, ADD 1 kg of CHE-001, ORDER(Pickup, Card). In context A, SHIP and DELIVER it. In context K, open the return request for this order.
- **Do:** Try to return the CHE-001 line with the reason `ordered by mistake`.
- **Expect:** The shop does not accept this reason for the chilled line (quote its message, or the reason is not offered for it).

### @ [RET] Bundles are returned as a whole {R:179,125}
- **Pre:** context H, CLEAR, ADD 1 × BND-002, ORDER(Pickup, Invoice). In context A, SHIP and DELIVER it. In context H, open the return request form for this order.
- **Expect:** The form offers the Pizza Night Kit as one line, and none of its contents can be selected on their own.

### @ [RET] Exchange instead of refund {R:115}
- **Pre:** context K, CLEAR, ADD 1 × OIL-001 tin, ORDER(Pickup, Card). In context A, SHIP and DELIVER it. In context K, request a return of the tin (reason `damaged in transit`). In context A, approve it and choose a replacement shipment instead of a refund.
- **Expect:** The order shows a second shipment with 1 × OIL-001 tin, and no credit note exists for it.

### @ [RET] Returned goods restocked to a chosen warehouse {R:115,173}
- **Pre:** after @@rs. In context A, inspect the returned tin and restock it to WH-BRB.
- **Expect:** The stock of OIL-001 in WH-BRB is {{D_WH.oil_brb_after_restock}} tins.

---

## S24 Back-office quality

Reset. Contexts **K** (C-10007) and **A** (admin).

### @ [ADM] Global search finds an order {R:49}
- **Pre:** context K, ADD 1 × OIL-001 tin, ORDER(Pickup, Card); note the order number **GS**. Context A, any admin page.
- **Do:** Enter GS in the global search.
- **Expect:** The order GS is found and can be opened from the result.

### @ [ADM] Global search finds a customer and a product {R:49}
- **Pre:** context A, any admin page.
- **Do:** Search for `Seeblick`, then for `WAT-002`.
- **Expect:** The first search finds customer C-10004 (Hotel Seeblick AG), and the second finds product WAT-002.

### @ [ADM] Bulk action on selected rows {R:49,51}
- **Pre:** context A, admin product list.
- **Do:** Select TEA-003 and SNK-004 and deactivate both in one bulk action (confirm if asked).
- **Expect:** In context K, a search for `Herbal Tea` finds no TEA-003 and a search for `Gummy` finds no SNK-004.

### @ [ADM] Saved view {R:49}
- **Pre:** context A, admin product list. Filter by the category Juices and save it as the view `Juices only`.
- **Do:** Sign out, sign in again and open the view `Juices only`.
- **Expect:** The list is filtered to Juices: it shows JUI-001 and no WAT-001.

### @ [ADM] Page size choice {R:49}
- **Pre:** context A, admin product list without filter.
- **Do:** Note the total number of products the list reports (or count them) as **T**. From the page sizes the list offers, choose the largest one. Then choose the smallest offered size, and note it as **N**.
- **Expect:** Both choices were possible. After the second choice the list shows exactly the smaller of N and T products. If T is larger than N, the list offers pagination to further pages.

### @ [ADM] Table export {R:49,150}
- **Pre:** context A, admin product list without filter.
- **Do:** Export the list as CSV and open the file.
- **Expect:** The file is CSV with a header line, and it contains a row for WAT-002.

### @ [ADM] Activity timeline shows a staff change {R:60}
- **Pre:** context A, edit page of WAT-002. Change the price of the box of 6 to `6.90` ({{D_ADM.wat002_box_new}}) and save.
- **Expect:** The activity timeline of WAT-002 shows this change with the old value {{D_ADM.wat002_box_old}}, the new value {{D_ADM.wat002_box_new}} and the staff member.

### @ [ADM] Dashboard with a period comparison {R:50}
- **Pre:** context A, admin dashboard.
- **Expect:** The dashboard shows at least one chart and a comparison with the previous period (for example "vs. last week").
