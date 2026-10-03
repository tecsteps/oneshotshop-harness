// Secret redaction for anything that may be shown to an LLM or quoted publicly.
// Three layers: (1) exact values from known secret files (harness .env etc.),
// (2) regexes for known key formats and env-style assignments, (3) an entropy
// heuristic for long random-looking tokens. Over-redaction is acceptable; leaks are not.
import { readFileSync, existsSync } from "node:fs";

const R = (re, label, fn) => ({ re, label, fn });
const RULES = [
  R(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "private-key"),
  R(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{20,}/gi, "data-uri", () => "[data-uri omitted]"),
  R(/\bgAAAAA[A-Za-z0-9_\-=]{20,}/g, "encrypted-blob", () => "[encrypted]"),
  R(/\bsk-ant-[A-Za-z0-9_\-]{10,}/g, "anthropic-key"),
  R(/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{20,}/g, "openai-key"),
  R(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, "stripe-key"),
  R(/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "github-token"),
  R(/\bgithub_pat_[A-Za-z0-9_]{30,}/g, "github-token"),
  R(/\bglpat-[A-Za-z0-9_\-]{20,}/g, "gitlab-token"),
  R(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "slack-token"),
  R(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "aws-key"),
  R(/\bAIza[0-9A-Za-z_\-]{35}\b/g, "google-key"),
  R(/\b(?:xai|gsk|hf|r8|nvapi|pplx|fw|csk|or|sk-or-v1)[-_][A-Za-z0-9]{24,}/g, "vendor-key"),
  R(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "jwt"),
  R(/\bbase64:[A-Za-z0-9+/]{20,}={0,2}/g, "laravel-app-key"),
  R(/\b(Authorization|Proxy-Authorization|X-Api-Key|Api-Key|X-Auth-Token)(["']?\s*[:=]\s*["']?)((?:Bearer|Basic|Token)\s+)?[^\s"'\\,}]+/gi, "auth-header", (m, h, sep, scheme) => `${h}${sep}${scheme || ""}[REDACTED]`),
  R(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@'"]+):([^/\s@'"]+)@/gi, "url-credentials", (m, s, u) => `${s}${u}:[REDACTED]@`),
  // lowercase key=value in URLs / CLI flags: ?token=..., --password=..., api_key=...
  R(/((?:^|[?&;\s"'(])-{0,2}(?:token|access_token|refresh_token|api_?key|apikey|secret|client_secret|password|passwd|pass|pwd|auth|sig|signature)=)([^&\s"'#]{6,})/gi, "query-secret", (m, pre, val) => (safeValue(val) ? m : `${pre}[REDACTED]`)),
  // ENV_STYLE_SECRET=value (also inside JSON/escaped strings and `export X=`)
  R(/((?:^|[\s"'{,;(]|\\n|\\t)(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH|PRIVATE|SALT|DSN|COOKIE|SESSION_ID)[A-Z0-9_]*\s*[=:]\s*["']?)([^\s"'\\,}]+)/g, "env-assignment", (m, pre, val) => (safeValue(val) ? m : `${pre}[REDACTED]`)),
  // "password": "...", api_key: '...', client_secret = ...
  R(/((?:["']?)\b(?:password|passwd|pwd|secret|client_secret|api_?key|apikey|access_?key|auth_?token|access_?token|refresh_?token|private_?key|bearer)\b["']?\s*(?:=>|[:=])\s*)(["'])([^"'\n]{4,200})\2/gi, "keyed-secret", (m, pre, q, val) => (safeValue(val) ? m : `${pre}${q}[REDACTED]${q}`)),
];

function safeValue(v) {
  const s = String(v).trim().replace(/^["']|["']$/g, "");
  if (!s || s.length < 4) return true;
  if (/^(null|none|nil|true|false|undefined|empty|\*+|x+|\.\.\.|<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_]\w*|%[^%]+%|\{\{.*\}\}|your[-_].*|changeme|example|placeholder|redacted|\[REDACTED.*)$/i.test(s)) return true;
  if (/[()|]|->|::|=>/.test(s)) return true; // code / validation rules, not a literal secret
  if (/^(required|nullable|string|sometimes|confirmed|min:\d+|max:\d+|hashed|password)$/i.test(s)) return true;
  if (/^\d{1,6}$/.test(s)) return true; // ports, small numbers
  return false;
}

function entropy(s) {
  const f = {};
  for (const c of s) f[c] = (f[c] || 0) + 1;
  let e = 0;
  for (const c in f) {
    const p = f[c] / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

const SAFE_PREFIX = /^(call_|toolu_|msg_|req_|resp_|ctc_|ctco_|fc_|rs_|item-|exec-|chatcmpl-|run_|thread_|asst_|file-|srvtoolu_)/;

export function looksSecret(tok) {
  if (tok.length < 24) return false;
  if (SAFE_PREFIX.test(tok)) return false;
  if (/^[0-9a-f]+$/i.test(tok) && tok.length <= 64) return false; // git/sha hashes are evidence
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(tok)) return false; // contains a uuid (rollout file names, ids)
  if (/(19|20)\d\d-[01]\d-[0-3]\d/.test(tok)) return false; // contains a date (run ids, rollout names)
  if (/^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/.test(tok) && !/[0-9]{4,}[a-z]+[0-9]+[a-z]/.test(tok)) return false; // slugs / snake_case / kebab
  if (/^[A-Za-z]+$/.test(tok)) return false; // identifiers (CamelCase) without digits
  if (/^(?:[A-Z][a-z0-9]+)+$/.test(tok)) return false; // PascalCase with digits like Version2Migration
  if ((tok.match(/\//g) || []).length >= 2) return false; // paths
  // Random secrets have a long unbroken run; identifiers built from words/slugs do not.
  const run = tok.split(/[-_./=]+/).sort((a, b) => b.length - a.length)[0] || "";
  if (run.length < 20) return false;
  const hasD = /\d/.test(run);
  const hasU = /[A-Z]/.test(run);
  const hasL = /[a-z]/.test(run);
  if (!hasD || (!hasU && !hasL)) return false;
  if (!(hasU && hasL) && run.length < 32) return false;
  if (/^[0-9a-f]+$/i.test(run) && run.length <= 64) return false;
  return entropy(run) >= (run.length < 32 ? 3.7 : 4.0);
}

export class Redactor {
  constructor({ secretFiles = [], extraValues = [] } = {}) {
    this.counts = {};
    this.exact = [];
    for (const f of secretFiles) {
      if (!f || !existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (v.length >= 8 && !safeValue(v)) this.exact.push({ name: m[1], value: v });
      }
    }
    for (const v of extraValues) if (v && v.length >= 8) this.exact.push({ name: "VALUE", value: v });
    this.exact.sort((a, b) => b.value.length - a.value.length);
  }

  bump(label, n = 1) {
    this.counts[label] = (this.counts[label] || 0) + n;
  }

  redact(input) {
    if (input == null) return input;
    let s = String(input);
    for (const { name, value } of this.exact) {
      if (s.includes(value)) {
        const parts = s.split(value);
        this.bump(`exact:${name}`, parts.length - 1);
        s = parts.join(`[REDACTED:${name}]`);
      }
    }
    for (const r of RULES) {
      s = s.replace(r.re, (...args) => {
        const out = r.fn ? r.fn(...args) : `[REDACTED:${r.label}]`;
        if (out !== args[0]) this.bump(r.label);
        return out;
      });
    }
    s = s.replace(/[A-Za-z0-9+/_\-=]{24,}/g, (tok) => {
      if (tok.includes("REDACTED")) return tok;
      if (!looksSecret(tok)) return tok;
      this.bump("high-entropy");
      return "[REDACTED:high-entropy]";
    });
    return s;
  }

  /** Deep-redact every string in a JSON-able value. */
  deep(v) {
    if (typeof v === "string") return this.redact(v);
    if (Array.isArray(v)) return v.map((x) => this.deep(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.deep(x)]));
    return v;
  }
}
