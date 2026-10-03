#!/usr/bin/env python3
"""Mechanical grading and transcript verification for the test-plan runner (used by suite.py and score.py).

The evaluator's verdict is not trusted on its own. For every check the harness verifies, against the
suite transcript (stream-json of `claude -p`):

* evidence  -- every `evidence[].quote` / `values[].quote` occurs literally (whitespace-, dash- and
               case-normalised) in a tool result the evaluator received from the browser or a helper.
               Results of browser_evaluate scripts that themselves contain the quoted text do not count
               (a script could otherwise return a fabricated string). A PASS without verifiable evidence
               becomes FAIL ("unverified").
* values    -- (blind mode) raw values are compared with expectations.json; the page they were read on
               must be the page the check requires.
* money     -- every money amount the evaluator writes (observed, note, raw, quotes) must occur as a money
               amount in a tool result; otherwise a PASS becomes FAIL ("arithmetic"). Notes/observations
               saying derived/computed/calculated make a PASS FAIL.
* scripts   -- browser_evaluate scripts with forbidden constructs (fetch, .click(), .value=, submit(),
               dispatchEvent, DOMParser, XMLHttpRequest, …) that were executed taint the browser until its
               next browser_close; checks resting on them become FAIL ("unverified: forbidden script").
* procedure -- typed URLs never seen before, action+navigate batched in one turn, checks out of plan
               order, checkout pages opened in checks that do not ask for one: listed as deviations,
               grade unchanged.
"""
import json
import os
import re
import unicodedata
from urllib.parse import urlparse

from plan import money_cents, plan_order, named_paths, blocks

FORBIDDEN_JS = [
    (r"\bfetch\s*\(", "fetch("),
    (r"XMLHttpRequest", "XMLHttpRequest"),
    (r"DOMParser", "DOMParser"),
    (r"\.click\s*\(", ".click()"),
    (r"\.(?:value|checked|selectedIndex|valueAsNumber|innerHTML|outerHTML|textContent|innerText)\s*=(?!=)",
     "property assignment (.value= …)"),
    (r"\b(?:request)?[sS]ubmit\s*\(", "submit("),
    (r"dispatchEvent", "dispatchEvent"),
    (r"\bsendBeacon\b|\bWebSocket\b|\bEventSource\b", "network API"),
    (r"\blocation\s*(?:\.\s*href\s*)?=(?!=)|\blocation\s*\.\s*(?:assign|replace|reload)\s*\(|\bwindow\.open\s*\(|"
     r"\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(",
     "navigation from script"),
    (r"\b(?:set|remove|toggle)Attribute\s*\(|\.remove\s*\(\s*\)|\bappendChild\b|\binsertAdjacent|\.append\s*\(",
     "DOM modification"),
    (r"document\.cookie\s*=|localStorage\.(?:set|remove|clear)|sessionStorage\.(?:set|remove|clear)",
     "storage write"),
    (r"\beval\s*\(|\bnew\s+Function\b|\bimport\s*\(", "dynamic code"),
]


SIDE_CHANNEL = {"fetch(", "XMLHttpRequest", "DOMParser", "network API", "dynamic code"}


def forbidden_js(src):
    s = src or ""
    return [label for rx, label in FORBIDDEN_JS if re.search(rx, s)]


PAGE_ONLY = {"property assignment (.value= …)", "DOM modification", "storage write"}


def mutating_js(src, labels):
    """None = read-only side channel (its own output is not evidence), "page" = changed the loaded page only
    (taints until the next typed navigation), "shop" = may have changed the shop's state (taints until the
    browser is closed)."""
    if re.search(r"method\s*:\s*['\"`](?:POST|PUT|PATCH|DELETE)", src or "", re.I):
        return "shop"
    rest = [lb for lb in labels if lb not in SIDE_CHANNEL]
    if not rest:
        return None
    return "page" if all(lb in PAGE_ONLY for lb in rest) else "shop"


ACTION_TOOLS = {"browser_click", "browser_press_key", "browser_handle_dialog", "browser_file_upload",
                "browser_drag", "browser_select_option"}
NAV_TOOLS = {"browser_navigate", "browser_navigate_back", "browser_close"}

DASHES = dict.fromkeys(map(ord, "‐‑‒–—―−﹣－"), "-")
QUOTES = {ord("‘"): "'", ord("’"): "'", ord("“"): '"', ord("”"): '"', ord("«"): '"',
          ord("»"): '"', ord(" "): " ", ord(" "): " ", ord(" "): " "}


def norm(s):
    s = unicodedata.normalize("NFKC", s or "")
    s = s.replace("\\n", " ").replace("\\t", " ").replace('\\"', '"').replace("\\'", "'")
    s = s.translate(DASHES).translate(QUOTES)
    return re.sub(r"\s+", " ", s).strip().casefold()


MONEY_TOKEN = re.compile(r"(?<![\w.,])(?:\d{1,3}(?:[.,\u202f\u00a0 ]\d{3})+|\d+)[.,]\d{2}(?!\d|[.,]\d)")


CUR_BEFORE = re.compile(r"(?:€|EUR)\s?[-−–]?\s?$", re.I)
CUR_AFTER = re.compile(r"\s?(?:€|EUR\b)", re.I)


def loose(s):
    """norm() without punctuation other than what carries meaning in amounts (digits, . , - €)."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w€.,\-]+", " ", s)).strip()


_MIME_WORD = re.compile(r"=\?([\w-]+)\?([QqBb])\?([^?]*)\?=")


def decode_mime_words(s):
    """'SG-1 =?utf-8?Q?=E2=80=94?= Order' -> 'SG-1 — Order' (mail subjects in the log)."""
    import base64
    import quopri

    def rep(m):
        cs, enc, data = m.group(1), m.group(2).upper(), m.group(3)
        if not data.isascii():          # already decoded by the mail-log helper
            return data.replace("_", " ")
        try:
            raw = base64.b64decode(data) if enc == "B" else quopri.decodestring(data.encode(), header=True)
            return raw.decode(cs, "replace")
        except Exception:
            return m.group(0)
    return _MIME_WORD.sub(rep, s)


def money_tokens(s, currency_only=False):
    """Money-like amounts (two decimals) in a string -> set of absolute cents. With currency_only, only
    amounts written with € / EUR directly before or after them (what the evaluator claims as money)."""
    out = set()
    s = unicodedata.normalize("NFKC", s or "")
    for m in MONEY_TOKEN.finditer(s):
        if currency_only and not (CUR_BEFORE.search(s[max(0, m.start() - 6):m.start()]) or CUR_AFTER.match(s, m.end())):
            continue
        c = money_cents(m.group(0))
        if c is not None:
            out.add(c)
    return out


def _strip_code(text):
    text = re.sub(r"### Ran Playwright code\n```\w*\n.*?```\n?", "", text, flags=re.S)
    return re.sub(r"- \[Snapshot\]\([^)]*\)", "", text)


def _decode_result(text):
    """browser_evaluate returns '### Result\\n<json>'; decode the JSON so innerText newlines are real."""
    m = re.search(r"### Result\n(.*?)(?=\n### |\Z)", text, re.S)
    if not m:
        return text
    payload = m.group(1).strip()
    try:
        v = json.loads(payload)
    except ValueError:
        return text
    flat = []

    def walk(o):
        if isinstance(o, str):
            flat.append(o)
        elif isinstance(o, dict):
            for x in o.values():
                walk(x)
        elif isinstance(o, list):
            for x in o:
                walk(x)
        else:
            flat.append(json.dumps(o))
    walk(v)
    return text.replace(m.group(0), "### Result\n" + "\n".join(flat) + "\n" + payload)


def flatten_snapshot(text):
    """Visible text of the aria snapshots (```yaml blocks) in a tool result, one line per node, without roles,
    refs and attributes: '- heading "Cart" [level=1] [ref=e5]' -> 'Cart'. Lets a quote that spans snapshot nodes
    ("Gross total €107.21") match."""
    out = []
    for block in re.findall(r"```yaml\n(.*?)```", text, re.S):
        for ln in block.split("\n"):
            ln = ln.strip()
            if not ln.startswith("- ") or ln.startswith("- /"):
                continue
            ln = re.sub(r"\[[^\]]*\]", "", ln[2:])
            m = re.match(r'^([\w-]+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*:?\s*(.*)$', ln)
            if not m:
                continue
            role, name, rest = m.groups()
            if role == "text":
                out.append((name or "") + " " + rest)
            else:
                out.append(" ".join(x for x in (name, rest) if x))
    return "\n".join(x.strip().strip('"') for x in out if x.strip())


def _server(name):
    m = re.match(r"mcp__(playwright\d*)__(\w+)", name or "")
    return (m.group(1), m.group(2)) if m else (None, name)


def path_of(url):
    try:
        u = urlparse(url)
    except ValueError:
        return url
    return (u.path.rstrip("/") or "/") + ("?" + u.query if u.query else "")


class Transcript:
    """Parsed stream-json transcript: tool results (evidence corpus), tool calls, markers, URLs."""

    def __init__(self, path, base_url=None, upto_line=None):
        self.path, self.base = path, (base_url or "").rstrip("/")
        self.entries, self.calls, self.texts = [], [], []
        self.final_seen = False
        cur_url, cur_title, pending, visit = {}, {}, {}, {}
        idx = 0
        try:
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError:
            fh = []
        for ln, line in enumerate(fh):
            if upto_line is not None and ln >= upto_line:
                break
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            t = ev.get("type")
            if t == "assistant":
                msg = ev.get("message") or {}
                for c in msg.get("content") or []:
                    idx += 1
                    if c.get("type") == "tool_use":
                        srv, tool = _server(c.get("name"))
                        call = {"idx": idx, "id": c.get("id"), "msg": msg.get("id"), "name": c.get("name"),
                                "server": srv, "tool": tool, "input": c.get("input") or {}, "error": None}
                        self.calls.append(call)
                        pending[c.get("id")] = call
                    elif c.get("type") == "text":
                        self.texts.append({"idx": idx, "msg": msg.get("id"), "text": c.get("text") or ""})
            elif t == "user":
                cs = (ev.get("message") or {}).get("content")
                if not isinstance(cs, list):
                    continue
                for c in cs:
                    if c.get("type") != "tool_result":
                        continue
                    idx += 1
                    call = pending.get(c.get("tool_use_id")) or {}
                    cc = c.get("content")
                    text = cc if isinstance(cc, str) else "\n".join(
                        x.get("text", "") for x in (cc or []) if isinstance(x, dict))
                    srv = call.get("server")
                    before = cur_url.get(srv)
                    page_lines = re.findall(r"- Page URL: (\S+)", text)
                    for u in page_lines:
                        cur_url[srv] = u
                    for u in re.findall(r"- Page Title: (.*)", text):
                        cur_title[srv] = u.strip()
                    m = re.search(r"- \d+: \(current\) \[([^\]]*)\]\((\S+)\)", text)
                    if m:
                        cur_title[srv], cur_url[srv] = m.group(1), m.group(2)
                    # a "visit" = one loaded page in one browser; content markers must be seen in the same visit
                    if (page_lines or m) and (cur_url.get(srv) != before or call.get("tool") in (
                            "browser_navigate", "browser_navigate_back", "browser_close")):
                        visit[srv] = visit.get(srv, 0) + 1
                    is_err = bool(c.get("is_error"))
                    call["error"] = is_err
                    call["result_idx"] = idx
                    if not (call.get("server") or call.get("tool") == "Bash"):
                        continue          # StructuredOutput etc.: not evidence
                    if call.get("tool") in ("browser_evaluate", "browser_run_code", "browser_run_code_unsafe") and \
                            forbidden_js(call.get("input", {}).get("function") or call.get("input", {}).get("code")):
                        is_err = True       # a forbidden script's output is never evidence
                    clean = decode_mime_words(_strip_code(_decode_result(text)))
                    if "```yaml" in clean:
                        clean += "\n### Snapshot text\n" + flatten_snapshot(clean)
                    self.entries.append({
                        "idx": idx, "call": call, "server": srv, "tool": call.get("tool"),
                        "url": cur_url.get(srv), "title": cur_title.get(srv), "error": is_err,
                        "visit": (srv, visit.get(srv, 0)),
                        "text": clean, "norm": norm(clean), "loose": loose(norm(clean)), "money": money_tokens(clean),
                        "src": norm(call.get("input", {}).get("function", "")) if call.get("tool") == "browser_evaluate" else "",
                    })
            elif t == "result":
                self.final_seen = True
        if hasattr(fh, "close"):
            fh.close()
        self.money = set()
        for e in self.entries:
            if not e["error"]:
                self.money |= e["money"]
        self._markers()
        self._taint()

    # ---------------------------------------------------------------- markers / segments
    def _markers(self):
        self.markers = []      # (idx, label)
        for t in self.texts:
            for m in re.finditer(r"(?m)^\s*==\s*(S\d\d-\d\d|Setup\s+[A-Za-z0-9-]+)\b", t["text"]):
                self.markers.append((t["idx"], re.sub(r"\s+", " ", m.group(1))))

    def segment_of(self, idx):
        lab = None
        for i, l in self.markers:
            if i <= idx:
                lab = l
            else:
                break
        return lab

    def segment_range(self, label):
        """[(start, end)) index ranges where `label` is the current marker."""
        out = []
        for n, (i, l) in enumerate(self.markers):
            if l == label:
                end = self.markers[n + 1][0] if n + 1 < len(self.markers) else 10 ** 9
                out.append((i, end))
        return out

    # ---------------------------------------------------------------- forbidden scripts
    def _taint(self):
        self.forbidden, self.taint = [], []      # taint: (server, start_idx, end_idx)
        closes = [(c["server"], c["idx"]) for c in self.calls if c["tool"] == "browser_close"]
        navs = [(c["server"], c["idx"]) for c in self.calls if c["tool"] in ("browser_navigate", "browser_close")]
        for c in self.calls:
            if c["tool"] in ("browser_evaluate", "browser_run_code_unsafe", "browser_run_code"):
                src = c["input"].get("function") or c["input"].get("code") or ""
                bad = forbidden_js(src)
                if c["tool"] != "browser_evaluate":
                    bad = bad or ["run_code"]
                if bad:
                    executed = c.get("error") is False
                    mut = mutating_js(src, bad)
                    self.forbidden.append({"idx": c["idx"], "server": c["server"], "patterns": bad,
                                           "executed": executed, "mutating": mut,
                                           "segment": self.segment_of(c["idx"]), "script": src[:300]})
                    if executed and mut:
                        ends = closes if mut == "shop" else navs
                        end = min([i for s, i in ends if s == c["server"] and i > c["idx"]] or [10 ** 9])
                        self.taint.append((c["server"], c["idx"], end))

    def tainted(self, entry):
        return any(entry["server"] == s and a < entry["idx"] < b for s, a, b in self.taint)

    # ---------------------------------------------------------------- evidence
    def find_quote(self, quote, before_idx=None):
        """Entries where the quote occurs. A quote with '…' / '...' matches if all its pieces occur in order
        in the same tool result. Returns list of entries (empty = unverified)."""
        pieces = [norm(p) for p in re.split(r"…|\.\.\.", quote or "")]
        pieces = [p for p in pieces if len(p) >= 2]
        if not pieces or sum(len(p) for p in pieces) < 3:
            return []
        hits = self._match(pieces, "norm", before_idx)
        if not hits:     # same words, different punctuation/line breaks ("Total: €5" vs "Total\n€5")
            lp = [loose(p) for p in pieces]
            if all(len(p) >= 2 for p in lp):
                hits = self._match(lp, "loose", before_idx)
        return hits

    def _match(self, pieces, field, before_idx):
        hits = []
        for e in self.entries:
            if e["error"] or (before_idx and e["idx"] > before_idx):
                continue
            pos, ok = 0, True
            for p in pieces:
                j = e[field].find(p, pos)
                if j < 0 or (e["src"] and p in (e["src"] if field == "norm" else loose(e["src"]))):
                    ok = False
                    break
                pos = j + len(p)
            if ok:
                hits.append(e)
        return hits

    def money_seen(self, cents):
        return cents in self.money

    # ---------------------------------------------------------------- procedure checks
    def url_discipline(self, exempt_paths=()):
        """Typed navigations to URLs never seen before in a tool result."""
        seen_text, out, n_typed = "", [], 0
        ex = {p.rstrip("/") or "/" for p in exempt_paths} | {"/"}
        ev_by_idx = sorted([(e["idx"], e["text"]) for e in self.entries])
        k = 0
        for c in self.calls:
            while k < len(ev_by_idx) and ev_by_idx[k][0] < c["idx"]:
                seen_text += "\n" + ev_by_idx[k][1].replace(self.base, "")
                k += 1
            if c["tool"] != "browser_navigate":
                continue
            url = c["input"].get("url", "")
            p = path_of(url)
            pth = p.split("?")[0]
            if pth in ex or p in ex or url.rstrip("/") == self.base:
                continue
            n_typed += 1
            if p in seen_text or url in seen_text:
                continue
            kind = "query_guessed" if ("?" in p and pth in seen_text) else "guessed"
            out.append({"idx": c["idx"], "server": c["server"], "url": p, "kind": kind,
                        "segment": self.segment_of(c["idx"])})
        self.guessed = out
        return n_typed, out

    def batched_actions(self):
        """Assistant turns with a state-changing action followed by a navigation/close (kind "navigate"), or with
        more than one state-changing action (kind "multi")."""
        by_msg, out = {}, []
        for c in self.calls:
            by_msg.setdefault(c["msg"], []).append(c)
        for msg, cs in by_msg.items():
            acted, n_act = None, 0
            for c in cs:
                is_action = c["tool"] in ACTION_TOOLS or (c["tool"] == "browser_type" and c["input"].get("submit")) \
                    or (c["tool"] == "browser_evaluate" and forbidden_js(c["input"].get("function")))
                if acted and c["tool"] in NAV_TOOLS and c["server"] == acted["server"]:
                    out.append({"idx": c["idx"], "kind": "navigate", "action": acted["tool"], "then": c["tool"],
                                "segment": self.segment_of(c["idx"])})
                    acted = None
                elif is_action:
                    if c["tool"] != "browser_select_option":
                        n_act += 1
                        if n_act == 2:
                            out.append({"idx": c["idx"], "kind": "multi", "action": c["tool"], "then": None,
                                        "segment": self.segment_of(c["idx"])})
                    acted = c
        return out

    def order_deviations(self, suite_text):
        pos, out, best, best_lab = plan_order(suite_text), [], -1, None
        for i, lab in self.markers:
            p = pos.get(lab)
            if p is None:
                continue
            if p < best:
                out.append({"idx": i, "segment": lab, "after": best_lab})
            elif p > best:
                best, best_lab = p, lab
        return out

    def checkout_deviations(self, suite_text):
        """Checkout pages visited inside a check whose text does not ask for a checkout/order."""
        texts = {i: t for k, i, t in blocks(suite_text) if k == "check"}
        out, flagged = [], set()
        for e in self.entries:
            lab = self.segment_of(e["idx"])
            if not lab or lab not in texts or lab in flagged:
                continue
            if e["url"] and re.search(r"checkout", path_of(e["url"]), re.I) and not re.search(
                    r"REVIEW|ORDER\(|checkout|check out|payment|place", texts[lab], re.I):
                out.append({"idx": e["idx"], "segment": lab, "url": path_of(e["url"])})
                flagged.add(lab)
        return out


# ====================================================================== grading
DERIVED = re.compile(r"\b(?:deriv|comput|calculat|recalculat)\w*", re.I)


def _outside_verified_quotes(s, tx):
    """Remove quoted fragments ('…', "…") of s that occur literally in tool results."""
    def rep(m):
        return " " if tx.find_quote(m.group(1)) else m.group(0)
    return re.sub(r"[\"'“‘](.{3,}?)[\"'”’]", rep, s or "")


def _num(s):
    m = re.search(r"-?\d+(?:[.,]\d+)?", (s or "").translate(DASHES))
    return float(m.group(0).replace(",", ".")) if m else None


TRUE_WORDS = {"yes", "true", "shown", "present", "visible", "listed", "offered", "y"}
FALSE_WORDS = {"no", "false", "not shown", "absent", "not visible", "not listed", "not offered", "n"}


CURRENCY_RX = {"EUR": r"€|\bEUR\b", "CHF": r"\bCHF\b|\bS?Fr\.(?!\w)|\bS?Fr(?=\s?\d)",
               "GBP": r"£|\bGBP\b"}


def currencies_in(raw):
    return {c for c, rx in CURRENCY_RX.items() if re.search(rx, raw or "")}


def currency_problem(spec, raw):
    """None if the raw money value carries the currency the spec requires (default EUR; "currency": null = any)."""
    want = spec["currency"] if "currency" in spec else "EUR"
    if not want:
        return None
    got = currencies_in(raw)
    if not got:
        return f"currency {want} not shown with the amount {raw!r}"
    if got != {want}:
        return f"wrong currency: {raw!r} shows {'/'.join(sorted(got))}, expected {want}"
    return None


def signed_cents(raw):
    """'−€15.80' -> -1580, '€ -5.00' -> -500, '(5.00)' -> -500, '€43.21' -> 4321; None without an amount."""
    if not re.search(r"\d", raw or ""):
        return None
    c = money_cents(raw)
    neg = bool(re.search(r"^\s*[-−–(]|[-−–]\s*(?:€|£|EUR|CHF|GBP|S?Fr\.?)?\s*\d", (raw or "").strip()))
    return -c if neg else c


def compare_value(spec, raw):
    """-> (ok: bool, observed_normalised, reason)"""
    kind, exp = spec["kind"], spec["expected"]
    alts = exp if isinstance(exp, list) else [exp]
    if kind == "money":
        got = money_cents(raw) if re.search(r"\d", raw or "") else None
        if got is None:
            return False, None, "no amount in raw value"
        cp = currency_problem(spec, raw)
        if cp:
            return False, None, cp
        signed = spec.get("signed")
        if signed:
            got = signed_cents(raw)
        want = [(money_cents(str(a)) * (-1 if signed and str(a).strip().startswith("-") else 1)) for a in alts]
        return got in want, f"{got / 100:.2f}", "" if got in want else f"observed {got / 100:.2f}, expected {' or '.join(f'{w / 100:.2f}' for w in want)}"
    if kind == "quantity":
        got = _num(raw)
        want = [float(a["value"] if isinstance(a, dict) else a) for a in alts]
        if got is None:
            return False, None, "no number in raw value"
        ok = any(abs(got - w) < 1e-9 for w in want)
        unit = spec.get("unit")
        if ok and unit:
            units = [unit] + spec.get("unit_aliases", [])
            if not any(re.search(r"(?<![a-z])" + re.escape(u.lower()) + r"(?![a-z])", (raw or "").lower()) for u in units):
                return False, raw, f"unit {unit!r} not shown with the number"
        return ok, str(got), "" if ok else f"observed {got:g}, expected {' or '.join(f'{w:g}' for w in want)}"
    if kind == "text":
        r = norm(raw)
        if isinstance(exp, dict):
            anyw, allw, nonew = exp.get("any", []), exp.get("all", []), exp.get("none", [])
        else:
            anyw, allw, nonew = alts, [], []
        ok = (not anyw or any(norm(w) in r for w in anyw)) and all(norm(w) in r for w in allw) and \
            not any(norm(w) in r for w in nonew)
        return ok, raw, "" if ok else f"text does not satisfy {exp!r}"
    if kind == "boolean":
        r = norm(raw)
        got = True if r in TRUE_WORDS else False if r in FALSE_WORDS else None
        if got is None:
            return False, raw, "raw must be yes or no"
        return got == bool(exp), str(got).lower(), "" if got == bool(exp) else f"observed {r}, expected {'yes' if exp else 'no'}"
    if kind == "state":
        r = norm(raw)
        states = [norm(s) for s in spec.get("states", [])]
        if r not in states:
            return False, raw, f"raw must be one of {spec.get('states')}"
        ok = r in [norm(a) for a in alts]
        return ok, r, "" if ok else f"observed {r}, expected {' or '.join(alts)}"
    return False, raw, f"unknown kind {kind}"


def verify_quote(tx, quote, url=None):
    hits = tx.find_quote(quote)
    out = {"quote": quote, "verified": bool(hits), "urls": sorted({path_of(h["url"]) for h in hits if h["url"]}),
           "tainted": bool(hits) and all(tx.tainted(h) for h in hits)}
    if url and hits:
        out["url_match"] = path_of(url).split("?")[0] in {u.split("?")[0] for u in out["urls"]} or not out["urls"]
    return out, hits


def is_mail_helper(command):
    """True if the Bash command runs the shop-mail-log helper: tokenised with shlex, leading VAR=value
    assignments (and `env`) skipped, basename of the executable compared."""
    import shlex
    try:
        toks = shlex.split(command or "")
    except ValueError:
        return False
    while toks and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]) or toks[0] == "env"):
        toks.pop(0)
    return bool(toks) and os.path.basename(toks[0]) == "shop-mail-log"


def page_rule_ok(name, spec, hits, tx, claimed_url):
    """One page kind: -> (ok, reason). Rules: source "mail" (quote from the shop-mail-log helper), or a browser page
    whose visit shows one of `heading_any` (page title or page text) and one of `content_any` (page text), and whose
    URL passes the optional `reject_url` / `require_url` regexes."""
    if spec.get("source") == "mail" or name == "mail":
        if not any(h.get("tool") == "Bash" and is_mail_helper(str(h["call"].get("input", {}).get("command", "")))
                   for h in hits):
            return False, "value not read from the mail log (shop-mail-log)"
        return True, ""
    hits = [h for h in hits if h.get("url") and h.get("server")]
    if not hits:
        return False, f"quote not seen on a browser page, the check requires the {name!r} page"
    rej, req = spec.get("reject_url", []), spec.get("require_url", [])
    heads = [norm(x) for x in spec.get("heading_any", [])]
    marks = [norm(x) for x in spec.get("content_any", [])]
    why = []
    good = []
    for h in hits:
        u = path_of(h["url"])
        if any(re.search(x, u) for x in rej) or (req and not any(re.search(x, u) for x in req)):
            why.append(f"URL {u} does not fit")
            continue
        visit_text = " ".join(e["norm"] for e in tx.entries if e.get("visit") == h["visit"] and not e["error"]) \
            if (heads or marks) else ""
        if heads and not any(x in norm(h.get("title") or "") or x in visit_text for x in heads):
            why.append(f"no heading of {spec.get('heading_any')} on {u}")
            continue
        if marks and not any(x in visit_text for x in marks):
            why.append(f"none of {spec.get('content_any')} on {u}")
            continue
        good.append(u)
    if not good:
        return False, f"quote not seen on a {name!r} page ({'; '.join(sorted(set(why)))})"
    if claimed_url:
        cp = path_of(claimed_url).split("?")[0]
        if cp not in {u.split("?")[0] for u in good}:
            return False, f"claimed URL {cp} is not where the quote was seen on a {name!r} page ({sorted(set(good))})"
    return True, ""


def page_ok(pages, hits, claimed_page, required, claimed_url=None, tx=None):
    """required: a page key or a list of allowed page keys. The evaluator names the page it used (one of them);
    that page's rules must hold for the quote."""
    allowed = required if isinstance(required, list) else [required]
    if "any" in allowed:
        return True, ""
    if claimed_page not in allowed:
        return False, f"read on page {claimed_page!r}, the check requires {' or '.join(map(repr, allowed))}"
    if not hits:
        return False, f"quote not found, so the {claimed_page!r} page cannot be confirmed"
    return page_rule_ok(claimed_page, pages.get(claimed_page, {}), hits, tx, claimed_url)


def evaluate_derive(expr, values):
    """Safe evaluation of + - * over Decimal inputs."""
    import ast
    from decimal import Decimal

    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Add, ast.Sub, ast.Mult)):
            a, b = ev(n.left), ev(n.right)
            return a + b if isinstance(n.op, ast.Add) else a - b if isinstance(n.op, ast.Sub) else a * b
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.USub, ast.UAdd)):
            return -ev(n.operand) if isinstance(n.op, ast.USub) else ev(n.operand)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return Decimal(str(n.value))
        if isinstance(n, ast.Name) and n.id in values:
            return values[n.id]
        raise ValueError(f"not allowed in derive: {ast.dump(n)[:60]}")
    return ev(ast.parse(expr, mode="eval"))


def grade_check(cid, raw, tx, plan, legacy_strict=True):
    """Grade one check from the evaluator's raw entry. Returns graded dict (result, reasons, details)."""
    meta = plan.meta.get(cid, {})
    g = {"id": cid, "area": meta.get("area"), "title": meta.get("title"), "result": "FAIL",
         "evaluator_result": None, "observed": "", "note": "", "reasons": [], "evidence": [], "values": [],
         "deviations": []}
    if not raw:
        g["reasons"].append("not reported by the evaluator")
        return g
    g.update(evaluator_result=raw.get("result"), observed=raw.get("observed", ""), note=raw.get("note", ""))
    passed = raw.get("result") == "PASS"
    reasons = []
    legacy_entry = "evidence" not in raw and "values" not in raw

    # -- evidence quotes
    ev_hits = []
    for ev in raw.get("evidence") or []:
        v, hits = verify_quote(tx, ev.get("quote", ""), ev.get("url"))
        v.update(url=ev.get("url", ""), heading=ev.get("heading", ""))
        g["evidence"].append(v)
        ev_hits += hits
        if not v["verified"]:
            reasons.append(f"unverified: quote not found in any tool result: {ev.get('quote', '')[:120]!r}")
        elif v["tainted"]:
            reasons.append("unverified: quote only seen after a forbidden script ran in that browser")
    if not legacy_entry and not raw.get("evidence") and not raw.get("values"):
        reasons.append("unverified: no evidence quote")

    # -- values (blind mode)
    cexp = plan.check_exp(cid)
    if cexp and not legacy_entry:
        from decimal import Decimal
        got = {v.get("key"): v for v in raw.get("values") or []}
        numeric = {}                                  # recorded inputs for derived values: key -> Decimal
        specs = cexp.get("values", [])
        for spec in [x for x in specs if not x.get("derive")]:
            k = spec["key"]
            rv = got.get(k)
            row = {"key": k, "kind": spec["kind"], "expected": spec.get("expected"), "page": spec.get("page"),
                   "record_only": bool(spec.get("record_only"))}
            if not rv or not (rv.get("raw") or "").strip():
                row.update(ok=False, reason="not recorded")
                reasons.append(f"{k}: value not recorded")
                g["values"].append(row)
                continue
            row.update(raw=rv.get("raw"), claimed_page=rv.get("page"), url=rv.get("url"), heading=rv.get("heading"),
                       quote=rv.get("quote"))
            v, hits = verify_quote(tx, rv.get("quote", ""), rv.get("url"))
            row["quote_verified"] = v["verified"]
            row["read_at"] = v["urls"]
            ok_all = True
            if not v["verified"]:
                reasons.append(f"{k}: unverified quote {rv.get('quote', '')[:100]!r}")
                ok_all = False
            elif v["tainted"]:
                reasons.append(f"{k}: unverified: read after a forbidden script")
                ok_all = False
            if spec["kind"] in ("money", "quantity", "text") and norm(rv.get("raw")) not in norm(rv.get("quote")):
                reasons.append(f"{k}: raw value {rv.get('raw')!r} is not part of its quote")
                ok_all = False
            if spec.get("page") and spec["page"] != "any":
                pok, why = page_ok(plan.pages(), hits, rv.get("page"), spec["page"], rv.get("url"), tx)
                if not pok:
                    reasons.append(f"{k}: {why}")
                    ok_all = False
            if spec.get("record_only"):
                why = currency_problem(spec, rv.get("raw")) if spec["kind"] == "money" else None
                n = signed_cents(rv.get("raw")) if spec["kind"] == "money" else _num(rv.get("raw"))
                if why or n is None:
                    reasons.append(f"{k}: {why or 'no number in raw value'}")
                    ok_all = False
                elif ok_all:
                    numeric[k] = Decimal(n) / 100 if spec["kind"] == "money" else Decimal(str(n))
                row.update(ok=ok_all and not why, normalised=None if n is None else str(n))
            else:
                ok, obs, why = compare_value(spec, rv.get("raw"))
                row.update(ok=ok, normalised=obs)
                if not ok:
                    reasons.append(f"{k}: {why}")
            g["values"].append(row)
        for spec in [x for x in specs if x.get("derive")]:
            k, ins = spec["key"], spec.get("inputs") or []
            row = {"key": k, "kind": spec["kind"], "expected": spec["expected"], "derive": spec["derive"], "inputs": ins}
            missing = [i for i in ins if i not in numeric]
            if missing:
                row.update(ok=False, reason=f"inputs not verified: {missing}")
                reasons.append(f"{k}: cannot derive {spec['derive']!r}: inputs {missing} not recorded with verified evidence")
                g["values"].append(row)
                continue
            val = evaluate_derive(spec["derive"], numeric)
            alts = spec["expected"] if isinstance(spec["expected"], list) else [spec["expected"]]
            from decimal import Decimal as D
            q = D("0.01") if spec["kind"] == "money" else D("0.001")
            want = [D(str(a)).quantize(q) for a in alts]
            got_v = val.quantize(q)
            if spec.get("signed", True) is False:
                got_v, want = abs(got_v), [abs(w) for w in want]
            ok = got_v in want
            row.update(ok=ok, normalised=str(got_v))
            if not ok:
                reasons.append(f"{k}: {spec['derive']} = {got_v}, expected {' or '.join(map(str, want))}")
            g["values"].append(row)

    # -- money / arithmetic ban (applies to everything the evaluator wrote)
    strings = [raw.get("observed", ""), raw.get("note", "")] + [e.get("quote", "") for e in raw.get("evidence") or []] \
        + [v.get(x, "") for v in raw.get("values") or [] for x in ("raw", "quote")]
    unseen = sorted({c for s in strings for c in money_tokens(s, currency_only=True) if not tx.money_seen(c)})
    if unseen:
        reasons.append("arithmetic: amount(s) never shown by the shop: " + ", ".join(f"{c / 100:.2f}" for c in unseen))
    for fld in ("observed", "note"):
        txt = _outside_verified_quotes(raw.get(fld, ""), tx)
        for m in DERIVED.finditer(txt):
            # shop wording ("Shipping is calculated at checkout") quoted without quotation marks is fine
            ctx = txt[max(0, m.start() - 25):m.end() + 25]
            if not any(tx.find_quote(w) for w in (ctx, txt[max(0, m.start() - 25):m.end()], txt[m.start():m.end() + 25])):
                reasons.append(f"arithmetic: {fld} says {m.group(0)!r}")
                break
    # legacy entries: quoted fragments in `observed` must be literal (informative unless strict)
    if legacy_entry:
        frags = re.findall(r"[\"'“‘]([^\"'”’]{4,}?)[\"'”’]", raw.get("observed", ""))
        bad = [f for f in frags if not tx.find_quote(f)]
        g["legacy_quotes"] = {"total": len(frags), "unverified": bad}
        # taint by money attribution: every observed amount only seen after forbidden scripts
        obs_m = money_tokens(raw.get("observed", ""))
        if obs_m and tx.taint:
            ents = [e for e in tx.entries if obs_m & e["money"] and not e["error"]]
            if ents and all(tx.tainted(e) for e in ents):
                reasons.append("unverified: amounts only seen after a forbidden script ran in that browser")

    # -- segment-based script taint (needs markers)
    for f in tx.forbidden:
        if f["executed"] and f["segment"] == cid:
            reasons.append("unverified: forbidden script executed during this check: " + ", ".join(f["patterns"]))

    # -- procedural deviations (listed, grade unchanged)
    for d in getattr(tx, "guessed", []):
        if d["segment"] == cid:
            g["deviations"].append(f"typed URL never seen before: {d['url']}")
    pages_used = {u for e in g["evidence"] for u in e.get("urls", [])} | \
                 {u for v in g["values"] for u in v.get("read_at", []) or []}
    for d in getattr(tx, "guessed", []):
        if d["url"] in pages_used and f"typed URL never seen before: {d['url']}" not in g["deviations"]:
            g["deviations"].append(f"evidence read on a page reached by a guessed URL: {d['url']}")
    for e in g["evidence"]:
        if e.get("verified") and (e.get("heading") or "").strip() and not tx.find_quote(e["heading"]):
            g["deviations"].append(f"evidence heading {e['heading'][:60]!r} never appeared in a tool result")
        if e.get("verified") and e.get("url_match") is False:
            g["deviations"].append(f"evidence URL {e.get('url')!r} differs from where the quote was seen {e['urls']}")

    if passed and reasons:
        g["result"] = "FAIL"
    else:
        g["result"] = "PASS" if passed else "FAIL"
    if not passed and not reasons:
        pass
    g["reasons"] = reasons
    if legacy_entry and not legacy_strict:
        g["result"] = raw.get("result")
    return g


def grade_suite(suite_text, raw_results, tx, plan, ids, admin_paths=(), legacy_strict=True):
    """Grade all `ids` of a suite against one transcript. Returns (graded list, integrity dict)."""
    n_typed, guessed = tx.url_discipline(named_paths(suite_text) | set(admin_paths))
    batched = tx.batched_actions()
    order = tx.order_deviations(suite_text)
    co = tx.checkout_deviations(suite_text)
    by_id = {r.get("id"): r for r in raw_results or [] if isinstance(r, dict)}
    texts = {i: t for k, i, t in blocks(suite_text) if k == "check"}
    graded = []
    for cid in ids:
        g = grade_check(cid, by_id.get(cid), tx, plan, legacy_strict)
        # REVIEW values must be read on the final review page (blind mode enforces this per value via pages)
        if re.search(r"REVIEW\(|\breview\b", texts.get(cid, "")) and g["evidence"] and \
                all(e.get("urls") and all(re.fullmatch(r"/cart", u) for u in e["urls"])
                    for e in g["evidence"] if e.get("verified")) and any(e.get("verified") for e in g["evidence"]):
            g["deviations"].append("check reads REVIEW values, but all evidence was seen on the cart page")
        for d in batched:
            if d["segment"] == cid:
                g["deviations"].append(f"{d['action']} and {d['then']} in the same turn" if d["kind"] == "navigate"
                                       else "several state-changing actions in one turn")
        for d in order:
            if d["segment"] == cid:
                g["deviations"].append(f"out of plan order (after {d['after']})")
        for d in co:
            if d["segment"] == cid:
                g["deviations"].append(f"checkout page {d['url']} opened, the check does not ask for one")
        graded.append(g)
    integrity = {
        "markers": len(tx.markers),
        "typed_navigations": n_typed, "guessed_urls": len(guessed),
        "guessed_url_list": [d["url"] for d in guessed][:50],
        "forbidden_scripts": len(tx.forbidden),
        "forbidden_scripts_executed": sum(f["executed"] for f in tx.forbidden),
        "forbidden_patterns": sorted({p for f in tx.forbidden for p in f["patterns"]}),
        "batched_action_navigate": sum(d["kind"] == "navigate" for d in batched),
        "multi_action_turns": sum(d["kind"] == "multi" for d in batched),
        "out_of_order": len(order), "checkout_outside_checks": len(co),
        "tool_results": len(tx.entries),
    }
    return graded, integrity
