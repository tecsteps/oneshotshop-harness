# Blind grading: interface between the plan renderer and the runner

The runner (`runner/plan.py`) switches to **blind grading** when `eval/testplan/` contains both
`expectations.json` and `testplan.evaluator.md`, rendered by `calc/render.py` in the same run that wrote
`testplan.md`. Without them it grades in **legacy** mode: the evaluator sees `testplan.md` with the expected
values, and the harness still verifies evidence quotes, money amounts, scripts and URLs. If only one of the two
files exists, or either belongs to another `testplan.md`, `run.sh` refuses to start.

In blind mode the evaluator never sees an expected value of a mechanically graded check. It reports the raw value
verbatim, with the page, URL, heading and a verbatim quote. `score.py` decides PASS/FAIL.

## `expectations.json`

```json
{
  "schema": "oneshotshop-expectations/1",
  "plan_sha256": "<sha256 of the testplan.md written by the same render run>",
  "pages": {
    "review":  {"label": "final checkout review step (REVIEW, 0.5): the last page before the order is placed",
                "content_any": ["Place order", "Submit order", "Buy now", "Order with obligation to pay"]},
    "cart":    {"label": "cart page"},
    "product": {"label": "product detail page"},
    "order":   {"label": "order detail page in the customer account"},
    "invoice": {"label": "invoice or credit note document", "heading_any": ["Invoice", "Credit note", "Rechnung"]},
    "admin":   {"label": "a page of the admin area"},
    "mail":    {"label": "the mail log (shop-mail-log)", "source": "mail"},
    "any":     {"label": "any page"}
  },
  "checks": {
    "S04-21": {
      "mode": "mixed",
      "values": [{"key": "gross", "kind": "money", "expected": "96.62", "page": "review", "calc": "C04.gross"}],
      "depends_on": ["S04-20"]
    },
    "S04-08": {"mode": "mechanical",
               "values": [{"key": "discount", "kind": "money", "expected": ["11.85", "27.65"], "page": "cart"}]},
    "S04-23": {"mode": "mechanical", "values": [
      {"key": "code", "kind": "state", "states": ["applied", "rejected"], "expected": "rejected", "page": "cart"},
      {"key": "gross", "kind": "money", "expected": "119.20", "page": "review"}]},
    "S03-10": {"mode": "mechanical", "values": [
      {"key": "qty", "kind": "quantity", "expected": 7.5, "unit": "l", "unit_aliases": ["litre", "liter"], "page": "cart"}]},
    "S01-04": {"mode": "mechanical", "values": [
      {"key": "promo", "kind": "text", "expected": {"any": ["Beer Crate Bonus", "Prosecco Carton Deal", "Free Balsamic"]},
       "page": "any"}]},
    "S04-07": {"mode": "mechanical", "values": [
      {"key": "free_line", "kind": "boolean", "expected": false, "page": "cart"}]},
    "S19-11": {"mode": "mechanical", "values": [
      {"key": "total", "kind": "money", "expected": "337.40", "currency": "CHF", "page": "invoice"}]},
    "S18-10": {"mode": "mechanical", "values": [
      {"key": "outstanding", "kind": "money", "expected": "36.41", "page": ["invoice", "order"]}]},
    "S11-07": {"mode": "mixed", "values": [
      {"key": "box_price", "kind": "money", "expected": "6.60", "currency": null, "page": "admin"}]},
    "S10-12": {"mode": "mixed", "values": [
      {"key": "B1", "kind": "money", "record_only": true, "currency": "EUR", "page": "account"},
      {"key": "B2", "kind": "money", "record_only": true, "currency": "EUR", "page": "account"},
      {"key": "balance_diff", "kind": "money", "derive": "B1 - B2", "inputs": ["B1", "B2"],
       "expected": "43.21", "currency": "EUR"}]}
  },
  "setup_depends_on": {"Setup C03": ["S04-14"]}
}
```

| Field | Meaning |
|---|---|
| `pages.<key>` | A page kind. The evaluator names it in `values[].page`, and `label` is shown to the evaluator. The optional rules below must **all** hold for at least one tool result in which the quote was found. Allowed fields: `label`, `heading_any`, `content_any`, `source`, `reject_url`, `require_url`; any other field is a validation error. |
| `pages.<key>.heading_any` | List of strings. One of them (case-insensitive substring) must occur in the page title or in the page text of the same **visit** (one loaded page in one browser, from its navigation until the URL changes or the page is navigated again). Use it to identify the page by what the spec prescribes (for example "Invoice"), not by its URL. |
| `pages.<key>.content_any` | List of strings. One of them must occur in the page text of the same visit, for example the place-order control of the review step. |
| `pages.<key>.source` | `"mail"`: the quote must come from a tool result of the `shop-mail-log` helper. Other helpers such as `delivery` or `shop-queue-work` do not count. The page key `mail` implies this. |
| `pages.<key>.reject_url` / `require_url` | Optional regexes on the URL path (with query) where the quote was seen. Use them only where the spec prescribes a URL; the spec prescribes none for the checkout steps, so the `review` page must not veto `/cart…` URLs. |
| `checks.<id>.mode` | `mechanical`: no evaluator-judged statement is left, and the evaluator text must have **no** `**Expect:**` line. `mixed`: values plus judged Expect statements; the evaluator text **must** keep an `**Expect:**` line. `judged`: no values, but an Expect line. A check that is not listed is judged. Conditions and negations of the original Expect that are not covered by a value (for example "no further refund is possible", "nothing captured yet", "status `shipped`") must stay as judged Expect statements, or become `boolean`/`state` values; they must never just disappear. |
| `values[].key` | `[A-Za-z0-9_]+`, unique within the check. Every recorded key (everything except `derive` values) is named in backticks in the check's `**Record:**` line. |
| `values[].kind` | `money`: `expected` is a decimal string or a list of alternatives. The comparison uses the absolute amount (`−€15.80` matches `"15.80"`). Add `"signed": true` when the sign matters. Formatting follows 0.4: `€1,234.56`, `1.234,56 €` and `1234.56` are equal. `quantity`: a number (or a list), optional `unit` + `unit_aliases`, and the unit must appear in `raw`. `text`: `{"any":[…], "all":[…], "none":[…]}` or a list (= any), case-insensitive substring of `raw`. `boolean`: `true`/`false`; the evaluator answers `yes`/`no`. `state`: `states` lists the words offered to the evaluator, `expected` is one of them (or a list). |
| `values[].currency` | Money only: `"EUR"` (the default when the field is missing), `"CHF"`, `"GBP"`, or `null`. `raw` must carry exactly that currency: `€`/`EUR`, `CHF`/`Fr.`/`SFr.`, `£`/`GBP`. A missing currency, a different one, or two currencies make the value FAIL. Use `null` only where the shop shows a bare number by design, such as an admin form input like `6.60`. |
| `values[].page` | A page key, a **list of allowed page keys** (for example `["invoice", "order"]` when the check says "on the invoice or the order"), or `"any"`. When it is not `any`, the rule is strict. The evaluator must name one of the allowed keys. That page's rules (`heading_any`, `content_any`, `source`, URL regexes) must hold for a tool result containing the quote. The reported `url` must be the URL where the quote was seen (path match). A list must not be empty and must not contain `any`. |
| `values[].record_only` | `true` = the evaluator records the value with evidence, but it has no `expected`. It must not carry `expected`, and it **must** be listed in the `inputs` of at least one `derive` value of the same check (validation error otherwise). |
| `values[].derive` / `inputs` | A value the harness computes from `record_only` inputs **of the same check**, for example `"derive": "B1 - B2", "inputs": ["B1", "B2"]`. The expression may use `+ - *`, parentheses, numeric constants and exactly the names in `inputs`. Every input **must** be a `record_only` value (validation error otherwise), with the same kind and currency. `kind` must be `money` or `quantity`, and `expected` is required. It is never recorded and never named in a Record line; the evaluator records B1 and B2 and never subtracts. The comparison is **signed** (money: inputs are parsed with their sign, e.g. `−€5.00`; the result is rounded to 0.01) unless `"signed": false`. If an input is missing or its evidence/page/currency fails, the derived value FAILs. |
| `values[].calc` | Optional: the calculator reference (for traceability; not shown to the evaluator). |
| `depends_on` | Optional: check IDs / `"Setup X"` that a **second-pass re-check** of this check must run first. The text references `Setup X`, `previous check`, `Sxx-yy` are found automatically. List only implicit dependencies, e.g. S04-35 on S04-33/S04-34 (earlier uses of FIRST50). |
| `setup_depends_on` | The same for setups. |

A check is PASS only if **all** of these hold (this is also how `mixed` works):
- the evaluator's `result` is PASS. The evaluator sets it from the judged Expect statements alone, plus whether the
  steps were done and every value was recorded. The prompt tells it that values never decide `result`;
- every value equals `expected`, in the right currency, read on the required page;
- every derived value computes to `expected`;
- every evidence quote and value quote occurs literally in the tool results;
- no amount was invented or computed;
- no forbidden script touched the evidence.

## `testplan.evaluator.md` (what the evaluator sees)

1. The first line is `<!-- plan_sha256: <sha256 of testplan.md> -->`.
2. It has the same skeleton, IDs and order as `testplan.md`, because the runner parses it the same way:
   `## 0. Evaluator instructions` (the section 0 rules, including 0.4 formats and 0.7 snippets), `## Sxx Title`,
   `**Setup NAME:**` paragraphs, and `### Sxx-yy [AREA] Title` blocks with `- **Pre:**`, `- **Do:**`, `- **Expect:**`.
3. For each check with `values`, its expected values are removed: from the Expect line, from Pre/Do, from its
   setups, and every `[calc …]` tag. Each key gets a line
   ``- **Record:** `gross` — the gross total in REVIEW(Pickup).``
   (one bullet per key, or one bullet that lists several keys). For `state` and `boolean`, offer the allowed words
   in a fixed order that does not depend on the expectation, for example ``- **Record:** `code` — after you submit the code: applied | rejected.``
4. **Expect:** stays only for the evaluator-judged statements of `mixed` / `judged` checks. If none remain, drop the
   line.
5. **Suite-wide leak rule.** No expected amount of any check of a suite (money `expected`, including alternatives
   and derived expectations) may appear anywhere in that suite's evaluator text: intro, setups, other checks.
   The runner scans for two-decimal numbers that are not followed by a unit, and for amounts written with
   €/£/CHF/EUR/GBP. It reports every hit as `<check>.<key>: expected X leaks into the evaluator text of Sxx: …context…`
   and refuses the bundle.
   - **Evaluator inputs:** an amount the evaluator must type or use (for example "record a payment of €123.84") is
     written as `{{input:€123.84}}` in `testplan.evaluator.md`. The runner shows it as plain `€123.84` and exempts it
     from the leak rule.
   - Use the marker only for genuine inputs, never for amounts that only inform. Where possible, prefer
     "the amount you read in Sxx-yy".
   - Informational amounts that are not an expectation of the suite may stay unmarked.
6. Rules in section 0 that mention expected values (0.4 "Never add up …") stay. The runner adds the automated-run
   rules (two browsers, step markers, evidence, no arithmetic, self-check).

`results-template.json` stays as it is (`results[].id/area/title`), and `## Sxx` headings remain the suite list.
