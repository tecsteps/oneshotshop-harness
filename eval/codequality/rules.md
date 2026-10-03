# Code-quality rule catalogue 1.0.0

> GENERATED from `rules.yaml` by `node eval/codequality/lib/catalogue.mjs render` — edit the YAML, not this file.

- Catalogue: `oneshotshop-codequality` version **1.0.0** — approved by the owner 2026-10-03 (do not compare scores across catalogue versions)
- Hash (sha256 of canonical JSON): `7c806f0eccc222ee80fdb908287bca368845fdb5e94705159b98fe2df2ee11c7`
- Rules: **69** — **36 AI-judged**, **33 static**
- Model for AI rules: `gpt-6-luna`, reasoning effort `none`, 1 vote per judgement

## Categories

| Category | Weight | AI rules (Σ weight) | Static rules (Σ weight) |
|---|---:|---|---|
| Clean Code (`clean_code`) | 25 | 10 (22) | 14 (20) |
| SOLID / design (`solid`) | 20 | 5 (9) | 2 (2) |
| Laravel & PHP practices (`laravel`) | 20 | 8 (19) | 5 (8) |
| Data model (`data_model`) | 15 | 5 (11) | 5 (11) |
| Tests (`tests`) | 10 | 5 (11) | 3 (5) |
| Security basics in code (`security`) | 10 | 3 (8) | 4 (8) |

## How scores are formed

- **AI rule score** = passes / (passes + fails) over the sampled units where the rule applied; `na` and `unverified` judgements do not count.
- **Static rule score** = 0..1 from its check (`pass_rate`: passing instances / all; `linear`: 1 at ≤ good, 0 at ≥ bad; `linear_ratio`: 1 at ≥ good, 0 at ≤ bad).
- **Category score** (0–100) = weighted mean of its rule scores (AI and static together, by rule weight; rules without data drop out).
- **Code Quality Index (CQI)** = weighted mean of the category scores (category weights above). AI-only and static-only indices are reported as well.

## Sampling (deterministic)

Per kind: the `top` largest units (source characters, ties by id) plus `random` units ordered by `sha256("<catalogue version>:<unit id>")` from the rest. The seed is the catalogue version, never the branch.

| Kind | Description | top | random |
|---|---|---:|---:|
| `controller` | HTTP controllers (App\Http\Controllers\*, or extends a *Controller) | 6 | 6 |
| `livewire` | Livewire / Volt components, Filament resources/pages (UI component classes with actions) | 6 | 6 |
| `service` | services, actions, domain/support classes, value objects, repositories (everything in app/ not matched below) | 6 | 6 |
| `model` | Eloquent models (extends Model / Authenticatable / Pivot) | 4 | 6 |
| `form_request` | extends FormRequest | 0 | 3 |
| `policy` | authorization policies (*Policy) | 0 | 3 |
| `job` | queued jobs, listeners, events | 0 | 2 |
| `command` | Artisan console commands | 0 | 2 |
| `middleware` | HTTP middleware | 0 | 2 |
| `mail_notification` | Mailables and Notifications | 0 | 2 |
| `view` | one Blade template (resources/views/**/*.blade.php) | 6 | 6 |
| `test` | one test file (tests/**/*.php) | 4 | 4 |
| `routes` | one route file (routes/*.php) | 4 | 0 |
| `schema` | the whole database: SQLite schema dump after migrate --seed + the migration sources | 1 | 0 |

Units smaller than 200 characters are not sampled. Cap: 90 units per build; a unit's source is cut at 1500 lines / 120000 characters.

## Overview

| ID | Title | Category | By | Weight | Applies to / check |
|---|---|---|---|---:|---|
| [CC-01](#cc-01) | Names reveal intent | clean_code | ai | 3 | controller, livewire, service, model, form_request, policy, job, command, middleware, mail_notification |
| [CC-02](#cc-02) | One level of abstraction per method | clean_code | ai | 2 | controller, livewire, service, model, job, command |
| [CC-03](#cc-03) | Methods do one thing | clean_code | ai | 3 | controller, livewire, service, model, job, command, middleware |
| [CC-04](#cc-04) | Errors are not swallowed | clean_code | ai | 3 | controller, livewire, service, model, job, command, middleware, mail_notification |
| [CC-05](#cc-05) | Comments explain why, not what | clean_code | ai | 1 | controller, livewire, service, model, job, command |
| [CC-06](#cc-06) | A business rule lives in one place | clean_code | ai | 3 | controller, livewire, service, model, view |
| [CC-07](#cc-07) | No flag arguments that switch behaviour | clean_code | ai | 1 | controller, livewire, service, model, job |
| [CC-08](#cc-08) | Queries do not have hidden side effects | clean_code | ai | 2 | controller, livewire, service, model |
| [CC-09](#cc-09) | Domain states are explicit types, not scattered string literals | clean_code | ai | 2 | controller, livewire, service, model, view |
| [CC-10](#cc-10) | Business parameters are not hard-coded in logic | clean_code | ai | 2 | controller, livewire, service, model, view, job |
| [SO-01](#so-01) | Single responsibility (one reason to change) | solid | ai | 3 | controller, livewire, service, model, job, command |
| [SO-02](#so-02) | Open/closed for variants (no growing type switches) | solid | ai | 2 | controller, livewire, service, model, view |
| [SO-03](#so-03) | Substitutable subtypes (Liskov) | solid | ai | 1 | service, model, controller, livewire, job, policy |
| [SO-04](#so-04) | Focused interfaces (interface segregation) | solid | ai | 1 | service, model, controller, livewire, job, policy |
| [SO-05](#so-05) | Domain logic does not depend on concrete infrastructure | solid | ai | 2 | service, model, controller, livewire, job |
| [LV-01](#lv-01) | No business logic in controllers / UI components | laravel | ai | 3 | controller, livewire |
| [LV-02](#lv-02) | No business logic or data access in Blade views | laravel | ai | 2 | view |
| [LV-03](#lv-03) | Input is validated at the boundary | laravel | ai | 3 | controller, livewire, form_request, routes |
| [LV-04](#lv-04) | Authorization rules are centralised | laravel | ai | 2 | controller, livewire, policy, routes, service |
| [LV-05](#lv-05) | Multi-step money/stock writes are atomic | laravel | ai | 3 | controller, livewire, service, model, job, command |
| [LV-06](#lv-06) | Slow side effects are queued or deferred | laravel | ai | 1 | controller, livewire, service, job, mail_notification |
| [LV-07](#lv-07) | Money arithmetic is exact | laravel | ai | 3 | controller, livewire, service, model, view, job |
| [LV-08](#lv-08) | Models encapsulate relations and query rules | laravel | ai | 2 | model, service, controller, livewire |
| [DM-01](#dm-01) | Relational data is normalised (no lists/blobs) | data_model | ai | 3 | schema |
| [DM-02](#dm-02) | Orders snapshot the facts that must not change | data_model | ai | 3 | schema |
| [DM-03](#dm-03) | States and categorical values are constrained | data_model | ai | 1 | schema |
| [DM-04](#dm-04) | Many-to-many and ownership are modelled with proper keys | data_model | ai | 2 | schema |
| [DM-05](#dm-05) | No catch-all tables for structured domain data | data_model | ai | 2 | schema |
| [TS-01](#ts-01) | Tests assert behaviour, not implementation | tests | ai | 2 | test |
| [TS-02](#ts-02) | Domain and money logic is tested with edge cases | tests | ai | 3 | test |
| [TS-03](#ts-03) | No tests that cannot fail | tests | ai | 3 | test |
| [TS-04](#ts-04) | Tests are isolated and deterministic | tests | ai | 2 | test |
| [TS-05](#ts-05) | Test names describe the behaviour | tests | ai | 1 | test |
| [SEC-01](#sec-01) | State-changing actions check authorization | security | ai | 3 | controller, livewire, routes |
| [SEC-02](#sec-02) | Records are scoped to the acting customer | security | ai | 3 | controller, livewire, service, routes |
| [SEC-03](#sec-03) | Unescaped output only for trusted HTML | security | ai | 2 | view |
| [CC-S01](#cc-s01) | Methods are short | clean_code | static | 2 | `inventory.method_length` |
| [CC-S02](#cc-s02) | Classes are small | clean_code | static | 2 | `inventory.class_length` |
| [CC-S03](#cc-s03) | Low cyclomatic complexity | clean_code | static | 2 | `inventory.method_complexity` |
| [CC-S04](#cc-s04) | Shallow nesting | clean_code | static | 1 | `inventory.method_nesting` |
| [CC-S05](#cc-s05) | Few parameters | clean_code | static | 1 | `inventory.method_params` |
| [CC-S06](#cc-s06) | One statement per line | clean_code | static | 2 | `inventory.statement_density` |
| [CC-S07](#cc-s07) | No empty catch blocks / error suppression | clean_code | static | 1 | `inventory.empty_catch` |
| [CC-S08](#cc-s08) | Little duplicated code | clean_code | static | 2 | `tools.sonarqube.duplicated_lines_density` |
| [CC-S09](#cc-s09) | Few magic numbers in logic | clean_code | static | 1 | `inventory.magic_numbers` |
| [CC-S10](#cc-s10) | No dead private code | clean_code | static | 1 | `inventory.unused_private` |
| [CC-S11](#cc-s11) | Readable line lengths | clean_code | static | 1 | `tools.readability.lines_over_120_per_1000` |
| [CC-S12](#cc-s12) | Static analysis is clean (PHPStan level 5) | clean_code | static | 2 | `tools.phpstan.level_5_per_php_kloc` |
| [CC-S13](#cc-s13) | Consistent code style (Pint) | clean_code | static | 1 | `tools.pint.files_failing_per_php_kloc` |
| [CC-S14](#cc-s14) | Few maintainability issues (SonarQube code smells) | clean_code | static | 1 | `tools.sonarqube.code_smells_per_kloc` |
| [SO-S01](#so-s01) | Moderate class coupling | solid | static | 1 | `inventory.class_coupling` |
| [SO-S02](#so-s02) | Dependencies are injected, not located | solid | static | 1 | `inventory.service_location` |
| [LV-S01](#lv-s01) | env() only in config | laravel | static | 2 | `inventory.env_outside_config` |
| [LV-S02](#lv-s02) | Mass-assignment protection | laravel | static | 2 | `inventory.mass_assignment` |
| [LV-S03](#lv-s03) | No N+1 query patterns at runtime | laravel | static | 2 | `perf.n_plus_one` |
| [LV-S04](#lv-s04) | Route files hold no logic | laravel | static | 1 | `inventory.route_closures` |
| [LV-S05](#lv-s05) | Typed attributes are cast | laravel | static | 1 | `schema.model_casts` |
| [DM-S01](#dm-s01) | Foreign keys are declared | data_model | static | 3 | `schema.fk_declared` |
| [DM-S02](#dm-s02) | Foreign keys and lookup columns are indexed | data_model | static | 2 | `schema.fk_indexed` |
| [DM-S03](#dm-s03) | Money is not stored as float | data_model | static | 3 | `schema.money_not_float` |
| [DM-S04](#dm-s04) | Natural keys are unique | data_model | static | 2 | `schema.natural_keys_unique` |
| [DM-S05](#dm-s05) | Consistent naming | data_model | static | 1 | `schema.naming` |
| [TS-S01](#ts-s01) | The test suite passes | tests | static | 2 | `tools.tests.pass_ratio` |
| [TS-S02](#ts-s02) | Application code is covered | tests | static | 2 | `tools.tests.line_coverage` |
| [TS-S03](#ts-s03) | Tests assert | tests | static | 1 | `tools.tests.assertions_per_test` |
| [SEC-S01](#sec-s01) | No raw SQL built from variables | security | static | 3 | `inventory.raw_sql_interpolation` |
| [SEC-S02](#sec-s02) | Semgrep security findings | security | static | 2 | `tools.semgrep.error_findings_per_kloc` |
| [SEC-S03](#sec-s03) | SonarQube vulnerabilities and hotspots | security | static | 1 | `tools.sonarqube.vulns_hotspots_per_kloc` |
| [SEC-S04](#sec-s04) | Forms carry CSRF tokens; few unescaped outputs | security | static | 2 | `inventory.blade_csrf` |

## AI-judged rules

### CC-01

**Names reveal intent** — Clean Code, weight 3, applies to: `controller`, `livewire`, `service`, `model`, `form_request`, `policy`, `job`, `command`, `middleware`, `mail_notification`

Class, method, property, parameter and local-variable names in the unit say what the thing is or does in domain terms. FAIL when the unit relies on cryptic abbreviations or meaningless names for non-trivial values (e.g. $d, $x, $tmp, $data2, $arr, proc(), handle2(), doStuff()) outside of trivial loop counters / closures of one expression, or when a name says something different from what the code does (e.g. getTotal() that also persists, $net holding a gross amount).

**PASS example**

```php
public function applyVolumeDiscount(Money $netPrice, int $quantity): Money
{ $tier = $this->tiers->forQuantity($quantity); return $netPrice->percentOff($tier->discountPercent); }
```

**FAIL example**

```php
public function calc($p, $q) { $d = $this->x($q); $t = $p * (1 - $d / 100); return $t; }
```

**N/A when:** Never N/A for the listed kinds.

**Evidence required:** The declaration or use line(s) of up to 3 of the worst names, quoting the name in context.

**Why AI (not static):** Whether a name "reveals intent" depends on domain meaning; length or dictionary checks cannot tell `$qty` (fine) from `$x` (not) or detect misleading names.

### CC-02

**One level of abstraction per method** — Clean Code, weight 2, applies to: `controller`, `livewire`, `service`, `model`, `job`, `command`

Each method reads at one level of abstraction: high-level steps call well-named helpers, and low-level details (string building, array index juggling, raw arithmetic, query construction) are not interleaved with high-level orchestration in the same method. FAIL when at least one method of the unit mixes orchestration (e.g. "validate, price, persist, notify") with low-level detail of several of those steps inline.

**PASS example**

```php
public function place(Cart $cart): Order {
    $this->guardCreditLimit($cart); $order = $this->orders->createFrom($cart);
    $this->stock->reserve($order); $this->notifier->orderPlaced($order); return $order; }
```

**FAIL example**

```php
public function place(Request $r) { $total = 0; foreach ($r->session()->get('cart') as $i) { $total += $i['p'] * $i['q'] * (1 + 0.19); }
  DB::table('orders')->insert([...]); Mail::raw('Order '.$id.' placed', fn($m) => $m->to($u->email)); ... }
```

**N/A when:** The unit has no method longer than 5 statements.

**Evidence required:** Line range of the offending method with a quote of one high-level and one low-level statement.

**Why AI (not static):** Abstraction levels are a semantic property; no metric distinguishes "calls a helper" from "does the helper's work inline".

### CC-03

**Methods do one thing** — Clean Code, weight 3, applies to: `controller`, `livewire`, `service`, `model`, `job`, `command`, `middleware`

Every method has a single purpose that can be named without "and". FAIL when a method performs several independent tasks (e.g. validates input AND computes prices AND writes the order AND sends mail AND builds the response), typically visible as sections separated by comments or blank lines, or by a name like processAll()/handle() hiding several steps. Length alone is NOT the criterion (that is static rule CC-S01).

**PASS example**

```php
public function totals(Cart $cart): Totals { return new Totals($this->net($cart), $this->vat($cart), $this->shipping($cart)); }
```

**FAIL example**

```php
public function checkout(Request $r) { /* validate */ ... /* price */ ... /* save order */ ... /* email */ ... /* redirect */ ... }
```

**N/A when:** The unit has only trivial methods (accessors, one-statement methods, relation definitions).

**Evidence required:** Lines of the method showing at least two of the unrelated tasks.

**Why AI (not static):** Counting statements cannot tell one cohesive algorithm from several tasks glued together.

### CC-04

**Errors are not swallowed** — Clean Code, weight 3, applies to: `controller`, `livewire`, `service`, `model`, `job`, `command`, `middleware`, `mail_notification`

Failures are handled explicitly: a catch block either recovers in a way the caller can see (returns a result that encodes the failure, rethrows/wraps, reports AND reacts), or is clearly intentional with a reason. FAIL when an exception is caught and ignored, replaced by a silent default (null/false/[]/0) the caller cannot distinguish from success, only logged while the operation proceeds as if it succeeded, or suppressed with @. Empty catch blocks are also counted statically (CC-S07); this rule covers the non-empty but still swallowing cases.

**PASS example**

```php
try { $this->gateway->charge($order); } catch (PaymentDeclined $e) { $order->markPaymentFailed($e->reason); throw $e; }
```

**FAIL example**

```php
try { $this->gateway->charge($order); } catch (\Throwable $e) { Log::warning($e->getMessage()); } $order->update(['status' => 'paid']);
```

**N/A when:** The unit contains no try/catch, no @-suppression and no rescue()/report() calls.

**Evidence required:** The catch (or @ / rescue) line(s) and the line that continues as if successful, if any.

**Why AI (not static):** Whether a non-empty catch "handles" the error needs data-flow understanding of what the caller sees.

### CC-05

**Comments explain why, not what** — Clean Code, weight 1, applies to: `controller`, `livewire`, `service`, `model`, `job`, `command`

Comments (excluding PHPDoc type annotations) give reasons, constraints, business rules or references that the code cannot express. FAIL when the unit has comments that merely restate the next line(s) ("// increment i", "// save the order" above $order->save()), are outdated/contradict the code, or contain commented-out code blocks.

**PASS example**

```php
// Spec 4.2: key accounts are invoiced net 30, so the credit limit check uses open invoices, not orders.
```

**FAIL example**

```php
// get the user
$user = auth()->user();
```

**N/A when:** The unit has no comments other than PHPDoc type/param annotations.

**Evidence required:** Up to 3 comment lines with the code line they restate (or the commented-out code).

**Why AI (not static):** Telling a redundant comment from a reason requires reading comment and code together.

### CC-06

**A business rule lives in one place** — Clean Code, weight 3, applies to: `controller`, `livewire`, `service`, `model`, `view`

Each business rule or calculation (VAT, discounts, price tiers, shipping cost, stock availability, credit limit, order-number format, status transitions) is implemented once and reused. FAIL when the unit re-implements a rule that the unit itself or another class already implements (use the LSP tools: references/definition to check for an existing implementation), e.g. the same VAT computation in two methods, or a view recomputing a total that a service computes.

**PASS example**

```php
$gross = $this->vat->gross($net, $company);   // single VatCalculator used everywhere
```

**FAIL example**

```php
// CartController
$gross = round($net * ($company->country === 'DE' ? 1.19 : 1.0), 2);
// OrderService (same rule again)
$gross = $net + ($company->country === 'DE' ? $net * 0.19 : 0);
```

**N/A when:** The unit contains no business calculation or rule.

**Evidence required:** The duplicated rule in the unit plus (if found) the other location's file and lines.

**Why AI (not static):** Clone detectors find copied text; the same rule written differently ("knowledge duplication") needs semantic comparison.

### CC-07

**No flag arguments that switch behaviour** — Clean Code, weight 1, applies to: `controller`, `livewire`, `service`, `model`, `job`

Methods do not take boolean/"mode" parameters that select between substantially different behaviours (e.g. save($order, true) meaning "and send mail"; render($x, 'admin')). FAIL when such a parameter is declared in the unit and branches into different behaviour. Booleans that are plain data (e.g. $isActive written to a column) are fine.

**PASS example**

```php
public function placeOrder(Cart $c): Order {...}   public function placeOrderSilently(Cart $c): Order {...}
```

**FAIL example**

```php
public function place(Cart $c, bool $notify = true, bool $isAdmin = false) { if ($isAdmin) { ...different flow... } }
```

**N/A when:** No method of the unit has a bool/enum-like parameter.

**Evidence required:** The method signature and the branch on the flag.

**Why AI (not static):** A bool parameter is detectable, but whether it is data or a behaviour switch needs reading the body.

### CC-08

**Queries do not have hidden side effects** — Clean Code, weight 2, applies to: `controller`, `livewire`, `service`, `model`

Methods whose name/return value suggests a query (get*, find*, is*, has*, calculate*, total*, accessors, Blade-facing helpers) do not change state (DB writes, session writes, sending mail, incrementing counters, mutating arguments). FAIL when such a method writes state.

**PASS example**

```php
public function total(Cart $cart): int { return $cart->lines->sum(fn ($l) => $l->unit_price * $l->quantity); }
```

**FAIL example**

```php
public function getCart(User $u): Cart { $cart = Cart::firstOrCreate(['user_id' => $u->id]); $cart->touch(); session(['cart_id' => $cart->id]); return $cart; }
```

**N/A when:** The unit has no query-style method.

**Evidence required:** The method signature and the state-changing line.

**Why AI (not static):** Requires knowing intent from names and which calls write state (incl. through other classes via LSP).

### CC-09

**Domain states are explicit types, not scattered string literals** — Clean Code, weight 2, applies to: `controller`, `livewire`, `service`, `model`, `view`

Finite domain value sets (order/payment/shipment status, customer group, shipping method, payment method, role) are represented by enums or class constants referenced everywhere. FAIL when the unit compares or assigns such values as raw string/int literals ('paid', 'pending', 'truck', 3) in logic, especially the same literal in several places.

**PASS example**

```php
if ($order->status === OrderStatus::Paid) { ... }
```

**FAIL example**

```php
if ($order->status == 'paid' || $order->status == 'shipped') { ... } $order->status = 'cancelled';
```

**N/A when:** The unit does not handle any finite domain value set.

**Evidence required:** Up to 3 lines with the literal comparisons/assignments.

**Why AI (not static):** Static magic-string detection cannot know which literals denote domain states versus labels, keys or messages.

### CC-10

**Business parameters are not hard-coded in logic** — Clean Code, weight 2, applies to: `controller`, `livewire`, `service`, `model`, `view`, `job`

Business parameters that the shop owner may change (VAT rates, free-shipping thresholds, minimum order values, surcharges, discount percentages, credit limits, cut-off times, pack sizes) come from configuration, the database, or one named constant/enum — not literals inside calculations. FAIL when such a parameter appears as a literal inside logic (e.g. * 1.19, > 250.00, + 4.90). Technical constants (pagination size, 100 for percent, 2 decimals) are not business parameters.

**PASS example**

```php
if ($net->greaterThan(Money::cents(config('shop.free_shipping_threshold_cents')))) { ... }
```

**FAIL example**

```php
$shipping = $subtotal >= 250 ? 0 : 9.90; $vat = $subtotal * 0.19;
```

**N/A when:** The unit contains no business calculation.

**Evidence required:** Up to 3 lines with the hard-coded parameters.

**Why AI (not static):** Deciding that 0.19 is a VAT rate but 100 is a percent base requires domain judgement; Sonar's magic-number rule is the static complement (CC-S09).

### SO-01

**Single responsibility (one reason to change)** — SOLID / design, weight 3, applies to: `controller`, `livewire`, `service`, `model`, `job`, `command`

The class has one reason to change: one actor/feature area (e.g. "pricing", "checkout HTTP flow", "order persistence"). FAIL when the class combines responsibilities that change for different reasons, e.g. a controller that serves storefront, admin CRUD and PDF generation; a service "Commerce" that prices, ships, invoices and emails; a model that renders HTML or sends mail. Name the distinct responsibilities in the reason.

**PASS example**

```php
class InvoicePdfRenderer { public function render(Invoice $i): string {...} }
```

**FAIL example**

```php
class ShopController { public function catalogue(){...} public function cart(){...} public function adminProducts(){...} public function invoicePdf(){...} public function importCsv(){...} }
```

**N/A when:** Never N/A for the listed kinds.

**Evidence required:** 2–3 method declarations (lines) that belong to different responsibilities.

**Why AI (not static):** Class size/coupling metrics (static SO-S01, CC-S02) correlate with SRP violations but cannot name or count responsibilities.

### SO-02

**Open/closed for variants (no growing type switches)** — SOLID / design, weight 2, applies to: `controller`, `livewire`, `service`, `model`, `view`

Behaviour that varies by a type code (payment method, shipping method, customer group, product type, document type, country rule) is dispatched via polymorphism, a strategy map, or data (configuration/DB rows) — so adding a variant does not require editing several switch/if-chains. FAIL when the unit contains a switch/match/if-elseif chain over such a type code with variant-specific logic in each branch, especially when the same type code is switched on in more than one place (check with LSP references).

**PASS example**

```php
$method = $this->shippingMethods->get($order->shipping_method); $cost = $method->cost($order);   // one class per method
```

**FAIL example**

```php
if ($m === 'truck') { $cost = ...; $slots = ...; } elseif ($m === 'parcel') { $cost = ...; } elseif ($m === 'pickup') { $cost = 0; }
```

**N/A when:** The unit has no conditional dispatch over a domain type code.

**Evidence required:** The switch/match/if-chain lines (start line to last branch).

**Why AI (not static):** A switch is detectable, but whether it dispatches over a growing variant set (vs. a fixed mapping) is a design judgement.

### SO-03

**Substitutable subtypes (Liskov)** — SOLID / design, weight 1, applies to: `service`, `model`, `controller`, `livewire`, `job`, `policy`

Classes that extend an application class or implement an application interface honour its contract: no overridden method that throws "not supported", silently does nothing, narrows accepted input, widens thrown errors, or returns a different kind of value; callers do not need instanceof checks to use them. Framework base classes (Model, Controller, FormRequest, Command, Job) count only when a framework contract is broken (e.g. a FormRequest::authorize() that throws).

**PASS example**

```php
final class TruckDelivery implements DeliveryMethod { public function cost(Order $o): Money {...} }
```

**FAIL example**

```php
class PickupDelivery extends TruckDelivery { public function slots(Carbon $d): array { throw new LogicException('not supported'); } }
```

**N/A when:** The class neither extends an application class nor implements an application interface, and overrides no framework contract method.

**Evidence required:** The overriding method declaration and the violating line.

**Why AI (not static):** Contract compliance needs comparing behaviour of parent and child, not just signatures.

### SO-04

**Focused interfaces (interface segregation)** — SOLID / design, weight 1, applies to: `service`, `model`, `controller`, `livewire`, `job`, `policy`

Application interfaces/abstract classes the unit declares or implements are small and cohesive; implementers do not have to provide methods they do not need. FAIL when the unit implements an application interface with methods left empty/throwing because they do not apply, or declares a "fat" interface mixing unrelated capabilities.

**PASS example**

```php
interface PriceSource { public function priceFor(Product $p, Company $c): Money; }
```

**FAIL example**

```php
interface ShopModule { public function price(); public function ship(); public function invoice(); public function exportCsv(); }
```

**N/A when:** The unit neither declares nor implements an application interface or abstract class.

**Evidence required:** The interface declaration lines or the empty/throwing implementation.

**Why AI (not static):** Whether interface methods belong together is a cohesion judgement.

### SO-05

**Domain logic does not depend on concrete infrastructure** — SOLID / design, weight 2, applies to: `service`, `model`, `controller`, `livewire`, `job`

Business calculations and decisions (pricing, tax, stock, credit, order state) receive their collaborators through constructor/method injection or interfaces and stay free of infrastructure details. FAIL when domain logic directly calls infrastructure facades/statics/globals in the middle of the calculation (Http::, Mail::, Storage::, Cache::, Session/session(), request(), now() without an injected clock where results depend on it, DB::table raw queries) or instantiates collaborators with `new` (new PaymentGateway(), new PdfService()) instead of injecting them. Eloquent model use and Laravel validation in controllers are NOT violations; facades in controllers/jobs that only orchestrate are fine.

**PASS example**

```php
public function __construct(private TaxRates $rates, private Clock $clock) {}
```

**FAIL example**

```php
public function price(Product $p): float { $rate = Http::get('https://rates.example/vat')->json('de'); if (session('admin_preview')) {...} return $p->price * (1 + $rate); }
```

**N/A when:** The unit contains no business calculation or decision.

**Evidence required:** The infrastructure call or `new` line inside the domain logic.

**Why AI (not static):** Facade calls are countable, but whether they sit inside domain logic (violation) or orchestration (fine) needs judgement.

### LV-01

**No business logic in controllers / UI components** — Laravel & PHP practices, weight 3, applies to: `controller`, `livewire`

Controller actions and UI component actions are thin: they validate (or delegate validation), authorize, call a service/action/model method, and return a response. FAIL when an action computes business results itself: price/discount/VAT/shipping arithmetic, stock or credit decisions, order state transitions, multi-step persistence of an aggregate, document numbering.

**PASS example**

```php
public function store(PlaceOrderRequest $r, PlaceOrder $place) { $order = $place($r->user(), $r->validated()); return redirect()->route('orders.show', $order); }
```

**FAIL example**

```php
public function store(Request $r) { $total = 0; foreach ($cart->lines as $l) { $total += $l->price * $l->qty * (1 - $discount); } if ($company->credit_used + $total > $company->credit_limit) {...} Order::create([...]); }
```

**N/A when:** The class has no public action methods.

**Evidence required:** Lines of the business computation inside the action.

**Why AI (not static):** Distinguishing orchestration from business computation needs semantic reading; LOC of controllers is only a proxy.

### LV-02

**No business logic or data access in Blade views** — Laravel & PHP practices, weight 2, applies to: `view`

Views only present data prepared for them. FAIL when the template runs queries or model lookups (Model::where/find/all, ->relation()->get(), DB::), computes business values (prices, VAT, discounts, totals, stock decisions, permissions other than @can/@auth), or contains @php blocks with business logic. Formatting (number_format, date formatting), loops and simple conditionals on prepared data are fine.

**PASS example**

```php
<td>{{ $line->formattedTotal }}</td>   @can('update', $order) ... @endcan
```

**FAIL example**

```php
@php $total = 0; foreach (\App\Models\CartLine::where('cart_id', session('cart'))->get() as $l) { $total += $l->price * $l->qty * 1.19; } @endphp
```

**N/A when:** Never N/A for views.

**Evidence required:** The template line(s) with the query or computation (quote a short part of the line).

**Why AI (not static):** Simple pattern checks miss computations hidden in long expressions; deciding "formatting vs. business" needs judgement.

### LV-03

**Input is validated at the boundary** — Laravel & PHP practices, weight 3, applies to: `controller`, `livewire`, `form_request`, `routes`

Every action that accepts user input validates it before use with explicit rules (FormRequest, $request->validate(), Validator::make, Livewire #[Validate]/rules()). FAIL when input reaches persistence or business logic unvalidated ($request->all(), $request->input('x') written or used without rules), or when rules are clearly insufficient for the field (no type/size/exists rule for ids, quantities without integer|min:1, money without numeric bounds). For form_request units: FAIL when rules() are incomplete for the fields the request obviously carries, or authorize() returns true where authorization is needed and not done elsewhere.

**PASS example**

```php
$data = $request->validate(['quantity' => ['required', 'integer', 'min:1', 'max:9999'], 'variant_id' => ['required', 'exists:variants,id']]);
```

**FAIL example**

```php
CartLine::create(['variant_id' => $request->variant_id, 'quantity' => $request->quantity]);
```

**N/A when:** The unit accepts no user input.

**Evidence required:** The line where unvalidated input is used (and the missing/insufficient rule line if any).

**Why AI (not static):** Whether a given input is validated somewhere before use, and whether the rules fit the field, requires following data flow.

### LV-04

**Authorization rules are centralised** — Laravel & PHP practices, weight 2, applies to: `controller`, `livewire`, `policy`, `routes`, `service`

Who may do what is expressed in policies, gates, or middleware (and, for scoping, query scopes), not as ad-hoc inline checks copied across actions (if ($user->role !== 'admin') abort(403) in many places, private helpers re-implementing the same check in several controllers). FAIL when the unit contains repeated inline role/ownership conditions instead of a policy/gate/middleware. A single helper reused within one class is acceptable. (Whether an action is protected at all is SEC-01.)

**PASS example**

```php
$this->authorize('view', $order);   Route::middleware('can:manage-catalog')->group(...)
```

**FAIL example**

```php
if (! $request->user()->is_staff) abort(403); ... (same line in 12 actions)
```

**N/A when:** The unit performs no authorization decisions.

**Evidence required:** Two or more of the inline checks.

**Why AI (not static):** Whether checks are "the same rule duplicated" versus distinct needs judgement.

### LV-05

**Multi-step money/stock writes are atomic** — Laravel & PHP practices, weight 3, applies to: `controller`, `livewire`, `service`, `model`, `job`, `command`

Operations that write several related records or change money/stock/credit (place order, reserve/decrement stock, record payment, issue invoice/credit note, approve return) run inside a database transaction, and concurrent-sensitive reads use locking (lockForUpdate / atomic increment/decrement / unique constraints). FAIL when such an operation performs two or more writes without DB::transaction (or an equivalent wrapper that the LSP confirms), or decrements stock via read-modify-write without lock/atomic update.

**PASS example**

```php
return DB::transaction(function () use ($cart) { $order = Order::create([...]); foreach (...) { Variant::whereKey($id)->lockForUpdate()->first()->decrement('stock', $qty); } return $order; });
```

**FAIL example**

```php
$order = Order::create([...]); foreach ($lines as $l) { OrderLine::create([...]); $v->stock = $v->stock - $l->qty; $v->save(); } $company->update(['credit_used' => ...]);
```

**N/A when:** The unit performs no multi-write or money/stock/credit change.

**Evidence required:** The first and last write lines of the non-atomic operation (or the read-modify-write lines).

**Why AI (not static):** Whether writes belong to one business operation, and whether a caller already wraps them, needs semantic and cross-file reading.

### LV-06

**Slow side effects are queued or deferred** — Laravel & PHP practices, weight 1, applies to: `controller`, `livewire`, `service`, `job`, `mail_notification`

Side effects that are slow or may fail independently of the request (sending mail/notifications, PDF generation for email attachments, calls to external HTTP services, image processing) are dispatched to the queue (ShouldQueue, ->queue(), dispatch(), afterResponse) rather than executed synchronously inside the request, OR the code makes an explicit, commented choice to run them synchronously. FAIL when the unit sends mail / notifications / external calls inline in a request path. For mail_notification units: FAIL when the class does not implement ShouldQueue and is used from request paths.

**PASS example**

```php
$user->notify(new OrderConfirmed($order));   // class OrderConfirmed extends Notification implements ShouldQueue
```

**FAIL example**

```php
Mail::to($user)->send(new OrderConfirmation($order)); // inside the checkout controller, mailable not queued
```

**N/A when:** The unit triggers no mail, notification, external call or heavy processing.

**Evidence required:** The send/call line (and the class declaration lacking ShouldQueue if relevant).

**Why AI (not static):** Whether an effect runs in a request path and whether queueing is appropriate depends on context.

### LV-07

**Money arithmetic is exact** — Laravel & PHP practices, weight 3, applies to: `controller`, `livewire`, `service`, `model`, `view`, `job`

Monetary amounts are computed in integer minor units (cents), a decimal/BCMath/Money library, or with one explicit rounding rule applied at defined points (e.g. per line, then summed). FAIL when the unit multiplies/divides/sums money as PHP floats and rounds ad hoc in several places, mixes cents and euros, or rounds inconsistently (round() in one place, number_format() as rounding in another). Formatting for display is fine.

**PASS example**

```php
$lineNetCents = intdiv($unitPriceCents * $qty * (100 - $discountPct) + 50, 100);
```

**FAIL example**

```php
$total = $price * $qty * 0.9; $vat = round($total * 0.19, 2); $gross = $total + $vat; // floats
```

**N/A when:** The unit performs no arithmetic on money.

**Evidence required:** Lines with the float arithmetic or inconsistent rounding.

**Why AI (not static):** Whether a numeric variable is money and whether rounding is consistent needs semantic reading; the schema-side float check is static (DM-S03).

### LV-08

**Models encapsulate relations and query rules** — Laravel & PHP practices, weight 2, applies to: `model`, `service`, `controller`, `livewire`

Relationships between tables are declared as Eloquent relations and used; recurring query conditions (active products, visible to company X, open orders) live in named scopes/query objects. FAIL when the unit joins/filters by foreign-key ids manually where a relation exists or should exist (Order::where('company_id', $c->id) repeated, manual joins), or repeats the same multi-condition where-chain in several places. For model units: FAIL when obvious relations (FK columns of this table) are missing as relation methods.

**PASS example**

```php
$company->orders()->open()->latest()->paginate();
```

**FAIL example**

```php
Order::where('company_id', $user->company_id)->where('status', '!=', 'cancelled')->where('status', '!=', 'delivered')->get(); // same chain in 4 methods
```

**N/A when:** The unit runs no queries and (for models) has no foreign keys.

**Evidence required:** The repeated query lines or the FK column without relation (cite the model's attribute/casts/fillable line or migration line).

**Why AI (not static):** Recognising the same query rule written differently, and missing relations, requires semantic reading.

### DM-01

**Relational data is normalised (no lists/blobs)** — Data model, weight 3, applies to: `schema`

Data with its own identity or multiplicity (order lines, addresses, price tiers, pack sizes, tags, allowed categories, product images, customer users) is stored in its own tables with keys. FAIL for each case of repeating column groups (price_1, price_2, price_3), comma/pipe-separated lists in a column, or JSON/text columns that hold such relational data (e.g. orders.items JSON, companies.addresses JSON, products.tiers JSON). JSON for genuinely unstructured payloads (gateway responses, audit diffs, free attributes) is fine.

**PASS example**

```php
Schema::create('order_lines', fn (Blueprint $t) => [$t->id(), $t->foreignId('order_id')->constrained(), $t->string('sku'), $t->unsignedInteger('quantity')]);
```

**FAIL example**

```php
$table->json('items');   // on orders, holding the order lines
$table->text('allowed_category_ids');   // "1,4,7"
```

**N/A when:** Never N/A.

**Evidence required:** The migration line(s) defining each offending column.

**Why AI (not static):** Column types are static, but whether a JSON/text column holds relational data depends on its meaning and use.

### DM-02

**Orders snapshot the facts that must not change** — Data model, weight 3, applies to: `schema`

Business documents (orders, order lines, invoices, credit notes) store the values valid at the time of the transaction: unit price, quantity, product name/SKU, tax rate and amounts, discount, shipping cost, and the billing and delivery address (as columns or a dedicated snapshot table). FAIL when an order/order line/invoice only references mutable master data for these values (FK to products/addresses/price lists without copied values), so a later price or address change would rewrite history.

**PASS example**

```php
order_lines: sku, name, unit_price_net_cents, tax_rate_bp, quantity, line_total_net_cents; orders: billing_street, billing_city, ..., shipping_street, ...
```

**FAIL example**

```php
order_lines: id, order_id, product_id, quantity   // price/name read from products at display time
```

**N/A when:** The schema has no order/invoice-like tables.

**Evidence required:** The migration lines of the order/order-line/invoice tables showing the missing or present snapshot columns.

**Why AI (not static):** Which values must be historised depends on the business meaning of each column.

### DM-03

**States and categorical values are constrained** — Data model, weight 1, applies to: `schema`

Columns with a closed value set (status, type, role, group, method) use an enum/check constraint or a reference table with FK, and booleans are booleans. FAIL when such columns are free strings with no constraint anywhere in the schema and the value set is clearly closed, or when several booleans encode one state machine (is_paid, is_shipped, is_cancelled on one table).

**PASS example**

```php
$table->enum('status', ['pending', 'paid', 'shipped', 'cancelled']);   // or status_id FK to order_statuses
```

**FAIL example**

```php
$table->string('status'); $table->boolean('is_paid'); $table->boolean('is_cancelled'); $table->boolean('is_shipped');
```

**N/A when:** Never N/A.

**Evidence required:** The migration lines of up to 3 unconstrained/boolean-encoded state columns.

**Why AI (not static):** Whether a value set is closed and whether booleans encode one state needs domain judgement.

### DM-04

**Many-to-many and ownership are modelled with proper keys** — Data model, weight 2, applies to: `schema`

Many-to-many relations use pivot tables with a composite unique key (or primary key) on the two FKs; ownership (company→users, company→addresses, order→lines) uses FKs with deliberate onDelete behaviour; no table duplicates another table's master data except for snapshots (DM-02). FAIL when pivots lack the uniqueness constraint, ownership is implied without FK, or master data (e.g. company name/VAT id) is copied into unrelated tables without a snapshot reason.

**PASS example**

```php
$t->foreignId('company_id')->constrained()->cascadeOnDelete(); $t->foreignId('category_id')->constrained(); $t->unique(['company_id', 'category_id']);
```

**FAIL example**

```php
Schema::create('company_category', fn ($t) => [$t->unsignedBigInteger('company_id'), $t->unsignedBigInteger('category_id')]); // no unique, no FK
```

**N/A when:** Never N/A.

**Evidence required:** The migration lines of the offending table(s).

**Why AI (not static):** Recognising pivot/ownership semantics and justified denormalisation needs meaning; plain FK/index presence is static (DM-S01, DM-S02).

### DM-05

**No catch-all tables for structured domain data** — Data model, weight 2, applies to: `schema`

Each domain entity has its own table. FAIL when structured domain data is stored in generic key/value or entity-attribute-value tables (settings(key, value) holding shipping rates or price lists, a generic "records"/"data" table with type + JSON payload for several entities, a polymorphic "documents" table whose columns only make sense for one subtype).

**PASS example**

```php
shipping_methods(id, code, base_fee_cents, free_from_cents)   promotions(id, code, percent_off, starts_at, ends_at)
```

**FAIL example**

```php
settings(key, value) with key='shipping_rates' value='{"truck":...}'   records(type, payload json)
```

**N/A when:** Never N/A.

**Evidence required:** The migration line(s) creating the generic table and, if seeded/used, the seeder/usage line.

**Why AI (not static):** Whether a generic table holds structured domain data depends on what is stored in it.

### TS-01

**Tests assert behaviour, not implementation** — Tests, weight 2, applies to: `test`

Tests check observable outcomes (HTTP status + visible content, database state, returned values, dispatched events/mails) rather than internal implementation details (private method calls via reflection, exact SQL, mock call sequences on internal collaborators, view variable internals that no user sees). FAIL when the file's tests mostly verify how something is done instead of what happens.

**PASS example**

```php
$this->post('/cart', ['variant_id' => $v->id, 'quantity' => 2])->assertRedirect('/cart'); $this->assertDatabaseHas('cart_lines', ['variant_id' => $v->id, 'quantity' => 2]);
```

**FAIL example**

```php
$mock = Mockery::mock(PricingService::class); $mock->shouldReceive('net')->once()->with(10, 2); ... (the test only checks the call happened)
```

**N/A when:** Never N/A for test files with at least one test.

**Evidence required:** Up to 3 assertion lines that check implementation details.

**Why AI (not static):** What counts as observable behaviour versus internals is a semantic judgement.

### TS-02

**Domain and money logic is tested with edge cases** — Tests, weight 3, applies to: `test`

When the file tests domain logic (pricing, discounts, VAT, shipping, credit limit, stock, order state, returns), it covers boundaries and failure paths, not only the happy path: zero/one/max quantities, threshold equality (exactly at free-shipping limit), rounding, invalid input, forbidden state transitions, other customer's data. FAIL when domain logic is exercised only with one happy-path example.

**PASS example**

```php
test('free shipping applies exactly at the threshold') ... test('credit limit blocks an order one cent above the limit') ...
```

**FAIL example**

```php
test('can place order') { ... assertStatus(302) }  // the only test touching pricing/credit
```

**N/A when:** The file does not test domain/money logic (e.g. only page-render or auth smoke tests).

**Evidence required:** The test names/lines showing the only (happy-path) cases, or the missing boundary next to the tested rule.

**Why AI (not static):** Recognising which cases are boundaries of which rule needs domain understanding.

### TS-03

**No tests that cannot fail** — Tests, weight 3, applies to: `test`

Every test can fail when the behaviour it names breaks. FAIL when the file contains tests with no assertions, tautological assertions (assertTrue(true), assertSame($x, $x)), assertions only on values the test itself just set up, assertions wrapped in try/catch that swallow failures, or status-only assertions (assertOk()) for tests whose names promise a business outcome.

**PASS example**

```php
test('blocked customers cannot sign in') { $this->post('/login', [...])->assertSessionHasErrors('email'); $this->assertGuest(); }
```

**FAIL example**

```php
test('applies tier discount') { $this->get('/products/1')->assertOk(); }
```

**N/A when:** Never N/A for test files with at least one test.

**Evidence required:** The test declaration line and its (non-)assertion lines.

**Why AI (not static):** Assertion counts are static (TS-S03), but whether an assertion can detect the named behaviour breaking is a judgement.

### TS-04

**Tests are isolated and deterministic** — Tests, weight 2, applies to: `test`

Each test creates or explicitly selects the data it needs and controls time/randomness. FAIL when tests depend on the order of other tests, on seeded rows by id or position (User::find(3), Product::first()) without asserting what they are, on the real clock for date-dependent rules (cut-off times, expiries) without freezing time, or on the network.

**PASS example**

```php
$this->travelTo('2026-03-02 13:59'); $company = Company::factory()->keyAccount()->create();
```

**FAIL example**

```php
$p = Product::first(); // relies on seeder order; date rule tested with now()
```

**N/A when:** Never N/A for test files with at least one test.

**Evidence required:** The line(s) with the hidden dependency.

**Why AI (not static):** Whether a lookup relies on incidental seed state or a rule is time-dependent requires reading the test's intent.

### TS-05

**Test names describe the behaviour** — Tests, weight 1, applies to: `test`

Test names state the scenario and expected outcome in domain terms. FAIL when names are generic (test1, testCheckout, it works, test_admin) or several unrelated behaviours are packed into one test whose name covers only one of them.

**PASS example**

```php
test('pending companies see no prices until approved')
```

**FAIL example**

```php
public function test_it_works() {...}   test('checkout') { ...20 assertions about pricing, shipping and email... }
```

**N/A when:** Never N/A for test files with at least one test.

**Evidence required:** Up to 3 test declaration lines.

**Why AI (not static):** Whether a name describes behaviour is linguistic/semantic.

### SEC-01

**State-changing actions check authorization** — Security basics in code, weight 3, applies to: `controller`, `livewire`, `routes`

Every action that creates, changes or deletes data is protected by authentication AND an authorization check appropriate to the actor (policy/gate/middleware/explicit check), including admin-only actions. For routes units: FAIL when state-changing routes (POST/PUT/PATCH/DELETE) are registered outside any auth/role middleware group and the controller does not authorize. Use the LSP to look at middleware/route definitions when the unit does not show them.

**PASS example**

```php
Route::middleware(['auth', 'can:admin'])->group(fn () => Route::post('/admin/products', [ProductController::class, 'store']));
```

**FAIL example**

```php
Route::post('/admin/products/{p}/price', [AdminController::class, 'updatePrice']); // no middleware, no authorize() in the action
```

**N/A when:** The unit has no state-changing action/route.

**Evidence required:** The unprotected route or action declaration line.

**Why AI (not static):** Protection can come from middleware, route groups, constructors or helpers in other files; deciding coverage needs following them.

### SEC-02

**Records are scoped to the acting customer** — Security basics in code, weight 3, applies to: `controller`, `livewire`, `service`, `routes`

Customer-facing reads and writes of owned records (orders, invoices, addresses, carts, order lists, users of a company) are scoped to the current customer/company (relation query, policy, where company_id = current) — an id from the URL or form alone never grants access (no IDOR). FAIL when a customer-facing action loads an owned record by id without such scoping.

**PASS example**

```php
$order = $request->user()->company->orders()->findOrFail($id);
```

**FAIL example**

```php
$order = Order::findOrFail($request->route('id'));   // any customer can open any order
```

**N/A when:** The unit has no customer-facing access to owned records.

**Evidence required:** The unscoped lookup line.

**Why AI (not static):** Whether a lookup is customer-facing and whether scoping happens elsewhere (policy, middleware, route binding) needs cross-file reasoning.

### SEC-03

**Unescaped output only for trusted HTML** — Security basics in code, weight 2, applies to: `view`

Blade output uses {{ }} by default. {!! !!}, Js::from misuse, or HtmlString are used only for content that is generated by the application or sanitised. FAIL when unescaped output prints user-controlled data (product names/descriptions editable by admins without sanitising, customer notes, request parameters, addresses) or builds HTML from such data by string concatenation.

**PASS example**

```php
{{ $product->name }}   {!! $markdownRenderer->safe($product->description) !!}
```

**FAIL example**

```php
{!! $order->customer_note !!}   {!! '<a href="'.request('next').'">' !!}
```

**N/A when:** The view has no unescaped output.

**Evidence required:** The {!! !!} line(s) with user-controlled data.

**Why AI (not static):** The count of {!! is static (SEC-S04); whether the printed value is trusted needs data-flow judgement.

## Static rules

### CC-S01

**Methods are short** — Clean Code, weight 2, check `inventory.method_length`, scored by pass rate

Share of methods in app/ with <= 30 statements (AST statements counted recursively, so the measure does not depend on formatting).

Scope: methods in app/. N/A when: No methods in app/.

### CC-S02

**Classes are small** — Clean Code, weight 2, check `inventory.class_length`, scored by pass rate

Share of classes in app/ with <= 300 statements (AST, recursive) and <= 20 methods.

Scope: classes in app/. N/A when: No classes in app/.

### CC-S03

**Low cyclomatic complexity** — Clean Code, weight 2, check `inventory.method_complexity`, scored by pass rate

Share of methods in app/ with cyclomatic complexity <= 10 (computed from the AST).

Scope: methods in app/. N/A when: No methods in app/.

### CC-S04

**Shallow nesting** — Clean Code, weight 1, check `inventory.method_nesting`, scored by pass rate

Share of methods in app/ whose maximum block nesting depth is <= 3.

Scope: methods in app/. N/A when: No methods in app/.

### CC-S05

**Few parameters** — Clean Code, weight 1, check `inventory.method_params`, scored by pass rate

Share of methods in app/ (constructors excluded) with <= 4 parameters.

Scope: methods in app/. N/A when: No methods in app/.

### CC-S06

**One statement per line** — Clean Code, weight 2, check `inventory.statement_density`, scored by linear_ratio (good 0.98, bad 0.7)

Share of PHP statements that start on a line of their own (no other statement starts on the same line); catches code compressed into few very long lines.

Scope: PHP files in app/, routes/, database/. N/A when: No PHP statements.

### CC-S07

**No empty catch blocks / error suppression** — Clean Code, weight 1, check `inventory.empty_catch`, scored by linear (good 0, bad 3)

Empty catch blocks plus @-suppressed expressions per PHP KLOC; 0 is best.

Scope: PHP files in app/. N/A when: Never.

### CC-S08

**Little duplicated code** — Clean Code, weight 2, check `tools.sonarqube.duplicated_lines_density`, scored by linear (good 3, bad 20)

SonarQube duplicated_lines_density (%) from eval/tools.

Scope: app code. N/A when: SonarQube did not run.

### CC-S09

**Few magic numbers in logic** — Clean Code, weight 1, check `inventory.magic_numbers`, scored by linear (good 5, bad 40)

Numeric literals other than -1, 0, 1, 2, 10, 100, 1000 inside method bodies of app/ (not in const/property defaults, array keys, or validation rule strings), per PHP KLOC.

Scope: PHP files in app/. N/A when: Never.

### CC-S10

**No dead private code** — Clean Code, weight 1, check `inventory.unused_private`, scored by pass rate

Share of private methods/properties in app/ that are referenced inside their class.

Scope: classes in app/. N/A when: No private methods/properties.

### CC-S11

**Readable line lengths** — Clean Code, weight 1, check `tools.readability.lines_over_120_per_1000`, scored by linear (good 10, bad 150)

eval/tools readability — lines longer than 120 characters per 1,000 lines.

Scope: PHP + Blade + JS/CSS. N/A when: Readability tool did not run.

### CC-S12

**Static analysis is clean (PHPStan level 5)** — Clean Code, weight 2, check `tools.phpstan.level_5_per_php_kloc`, scored by linear (good 0, bad 40)

Larastan level-5 errors per PHP KLOC (eval/tools).

Scope: app/, routes/. N/A when: PHPStan did not run.

### CC-S13

**Consistent code style (Pint)** — Clean Code, weight 1, check `tools.pint.files_failing_per_php_kloc`, scored by linear (good 0, bad 20)

Files failing `pint --test` (Laravel preset) per PHP KLOC (eval/tools).

Scope: PHP files. N/A when: Pint did not run.

### CC-S14

**Few maintainability issues (SonarQube code smells)** — Clean Code, weight 1, check `tools.sonarqube.code_smells_per_kloc`, scored by linear (good 10, bad 150)

SonarQube code smells per app-code KLOC (eval/tools).

Scope: app code. N/A when: SonarQube did not run.

### SO-S01

**Moderate class coupling** — SOLID / design, weight 1, check `inventory.class_coupling`, scored by pass rate

Share of classes in app/ that depend on <= 12 distinct other classes (imports, type hints, new, static calls; framework included).

Scope: classes in app/. N/A when: No classes in app/.

### SO-S02

**Dependencies are injected, not located** — SOLID / design, weight 1, check `inventory.service_location`, scored by linear (good 0, bad 5)

app(), resolve(), App::make(), Container::getInstance() calls outside service providers, per PHP KLOC.

Scope: PHP files in app/ except providers. N/A when: Never.

### LV-S01

**env() only in config** — Laravel & PHP practices, weight 2, check `inventory.env_outside_config`, scored by linear (good 0, bad 3)

Number of env() calls outside config/ (they return null once config is cached).

Scope: PHP files outside config/. N/A when: Never.

### LV-S02

**Mass-assignment protection** — Laravel & PHP practices, weight 2, check `inventory.mass_assignment`, scored by pass rate

Share of models that declare non-empty $fillable or a non-empty $guarded (no `$guarded = []`, no Model::unguard()), and no create()/update()/fill() fed directly with $request->all()/input()/post() without a key list.

Scope: models, controllers. N/A when: No models.

### LV-S03

**No N+1 query patterns at runtime** — Laravel & PHP practices, weight 2, check `perf.n_plus_one`, scored by linear (good 0, bad 10)

eval/perf distinct N+1 statements on the customer journey (headline.journey_server.n_plus_one_distinct_statements).

Scope: running app. N/A when: eval/perf did not run (gate failed).

### LV-S04

**Route files hold no logic** — Laravel & PHP practices, weight 1, check `inventory.route_closures`, scored by pass rate

Share of route registrations that point to a controller/component (closures with more than one statement or returning anything other than view()/redirect() count as failures).

Scope: routes/*.php except console.php. N/A when: No routes.

### LV-S05

**Typed attributes are cast** — Laravel & PHP practices, weight 1, check `schema.model_casts`, scored by pass rate

Share of boolean, date/datetime and json columns (from the schema dump) of model-backed tables that the model casts (casts property/method or $dates), excluding created_at/updated_at/deleted_at.

Scope: models + schema. N/A when: Schema dump unavailable or no such columns.

### DM-S01

**Foreign keys are declared** — Data model, weight 3, check `schema.fk_declared`, scored by pass rate

Share of *_id columns that name an existing table (singular→plural, e.g. company_id→companies) and carry a FOREIGN KEY constraint. Framework tables (sessions, jobs, cache, password_reset_tokens, failed_jobs, job_batches) excluded.

Scope: schema. N/A when: No *_id columns.

### DM-S02

**Foreign keys and lookup columns are indexed** — Data model, weight 2, check `schema.fk_indexed`, scored by pass rate

Share of FK columns (declared or *_id) and lookup columns (sku, slug, email, code, number, status) that are the leading column of some index or primary key.

Scope: schema. N/A when: No such columns.

### DM-S03

**Money is not stored as float** — Data model, weight 3, check `schema.money_not_float`, scored by pass rate

Share of money-like columns (name contains price, amount, total, cost, fee, net, gross, vat, tax, discount, credit, balance, surcharge, limit and is numeric) whose declared type is integer or decimal/numeric — not float/double/real.

Scope: schema. N/A when: No money-like columns.

### DM-S04

**Natural keys are unique** — Data model, weight 2, check `schema.natural_keys_unique`, scored by pass rate

Share of natural-key columns (sku, slug, email on users/companies, order/invoice/credit-note number, promotion code) covered by a UNIQUE index (alone or as the last column of a composite unique).

Scope: schema. N/A when: No such columns.

### DM-S05

**Consistent naming** — Data model, weight 1, check `schema.naming`, scored by pass rate

Share of tables and columns in snake_case (tables plural or pivot singular_singular, columns lowercase with underscores).

Scope: schema. N/A when: Never.

### TS-S01

**The test suite passes** — Tests, weight 2, check `tools.tests.pass_ratio`, scored by linear_ratio (good 1, bad 0.8)

Passed tests / all tests (eval/tools "tests"; offline, after migrate --seed).

Scope: tests/. N/A when: Tests tool did not run; score 0 when there are no tests.

### TS-S02

**Application code is covered** — Tests, weight 2, check `tools.tests.line_coverage`, scored by linear_ratio (good 85, bad 30)

Line coverage of app/ in percent (PCOV, eval/tools).

Scope: app/. N/A when: Coverage not measured.

### TS-S03

**Tests assert** — Tests, weight 1, check `tools.tests.assertions_per_test`, scored by linear_ratio (good 3, bad 1)

Assertions per test (eval/tools tests).

Scope: tests/. N/A when: No tests.

### SEC-S01

**No raw SQL built from variables** — Security basics in code, weight 3, check `inventory.raw_sql_interpolation`, scored by linear (good 0, bad 2)

DB::raw/selectRaw/whereRaw/havingRaw/orderByRaw/DB::select/statement/unprepared calls whose SQL argument contains variable interpolation or concatenation (bindings are fine). 0 is required.

Scope: PHP files in app/, routes/. N/A when: Never.

### SEC-S02

**Semgrep security findings** — Security basics in code, weight 2, check `tools.semgrep.error_findings_per_kloc`, scored by linear (good 0, bad 10)

Semgrep ERROR-severity findings per app-code KLOC (eval/tools, community + harness rules).

Scope: app code. N/A when: Semgrep did not run.

### SEC-S03

**SonarQube vulnerabilities and hotspots** — Security basics in code, weight 1, check `tools.sonarqube.vulns_hotspots_per_kloc`, scored by linear (good 0, bad 3)

(vulnerabilities + security hotspots) per app-code KLOC.

Scope: app code. N/A when: SonarQube did not run.

### SEC-S04

**Forms carry CSRF tokens; few unescaped outputs** — Security basics in code, weight 2, check `inventory.blade_csrf`, scored by pass rate

Share of POST forms in Blade views (<form method="post">) that contain @csrf or csrf_field()/csrf_token() before </form>.

Scope: Blade views. N/A when: No POST forms.

