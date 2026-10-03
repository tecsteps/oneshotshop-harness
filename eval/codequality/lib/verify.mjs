// Response schema per unit kind + structural validation + mechanical evidence verification.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { rulesForKind } from "./catalogue.mjs";

// Strict JSON schema (Structured Outputs: every property required, no additional properties).
export function responseSchema(cat, kind) {
  const ids = rulesForKind(cat, kind).map((r) => r.id);
  const evidence = { type: "object", additionalProperties: false, required: ["file", "line_start", "line_end", "quote"],
    properties: { file: { type: "string" }, line_start: { type: "integer" }, line_end: { type: "integer" }, quote: { type: "string" } } };
  return {
    type: "object", additionalProperties: false, required: ["unit_id", "judgements"],
    properties: {
      unit_id: { type: "string" },
      judgements: { type: "array", items: { type: "object", additionalProperties: false, required: ["rule_id", "verdict", "reason", "evidence"],
        properties: { rule_id: { type: "string", enum: ids }, verdict: { type: "string", enum: ["pass", "fail", "na"] }, reason: { type: "string" },
          evidence: { type: "array", items: evidence } } } },
    },
  };
}

// Parse the final message; returns {ok, data|error}.
export function parseResponse(text) {
  if (!text || !text.trim()) return { ok: false, error: "empty response" };
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t); if (fence) t = fence[1];
  try {
    const d = JSON.parse(t);
    if (!d || !Array.isArray(d.judgements)) return { ok: false, error: "no judgements array" };
    for (const j of d.judgements) {
      if (typeof j.rule_id !== "string" || !["pass", "fail", "na"].includes(j.verdict) || typeof j.reason !== "string" || !Array.isArray(j.evidence)) return { ok: false, error: `malformed judgement ${JSON.stringify(j).slice(0, 120)}` };
      for (const e of j.evidence) if (typeof e?.file !== "string" || !Number.isInteger(e.line_start) || !Number.isInteger(e.line_end) || typeof e.quote !== "string") return { ok: false, error: `malformed evidence in ${j.rule_id}` };
    }
    return { ok: true, data: d };
  } catch (e) { return { ok: false, error: "invalid JSON: " + e.message }; }
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
const cache = new Map();
function fileLines(root, rel) {
  const k = root + "\0" + rel;
  if (!cache.has(k)) cache.set(k, readFileSync(join(root, rel), "utf8").split("\n"));
  return cache.get(k);
}

// Verify one evidence item against the pristine build copy. Returns null when valid, else the problem.
export function checkEvidence(root, e, { maxQuote = 200, maxSpan = 40 } = {}) {
  const rel0 = String(e.file || "").replace(/^\.\//, "");
  const abs = isAbsolute(rel0) ? rel0 : resolve(root, rel0);
  let rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    // absolute path inside the root through a symlinked prefix (e.g. /private/tmp vs /tmp)
    try { rel = relative(realpathSync(root), realpathSync(abs)); } catch { return "file outside the build"; }
    if (rel.startsWith("..")) return "file outside the build";
  }
  if (!existsSync(join(root, rel))) return `file does not exist: ${rel}`;
  const lines = fileLines(root, rel);
  if (e.line_start < 1 || e.line_end < e.line_start) return `bad line range ${e.line_start}-${e.line_end}`;
  if (e.line_start > lines.length) return `line ${e.line_start} beyond end of file (${lines.length} lines)`;
  if (e.line_end - e.line_start > maxSpan) return `line range wider than ${maxSpan} lines`;
  const q = norm(e.quote || "");
  if (q.length < 3) return "quote empty or too short";
  if (q.length > maxQuote + 20) return `quote longer than ${maxQuote} characters`;
  if (/(\.\.\.|…)/.test(q) && !norm(lines.join("\n")).includes(q)) return "quote contains an ellipsis";
  const span = norm(lines.slice(e.line_start - 1, Math.min(lines.length, e.line_end)).join("\n"));
  if (span.includes(q)) return null;
  // tolerate an off-by-one line window (common LLM slip) but record it
  const wide = norm(lines.slice(Math.max(0, e.line_start - 2), Math.min(lines.length, e.line_end + 1)).join("\n"));
  if (wide.includes(q)) return null;
  return "quote not found in the cited lines";
}

// Check a parsed response against the expected rule list. Returns per-rule {judgement, problems[]}.
export function checkJudgements(cat, kind, root, data) {
  const expected = rulesForKind(cat, kind).map((r) => r.id);
  const ev = cat.procedure.evidence;
  const out = {};
  for (const id of expected) out[id] = { judgement: null, problems: ["missing judgement"] };
  const seen = new Set();
  for (const j of data.judgements) {
    if (!expected.includes(j.rule_id) || seen.has(j.rule_id)) continue;
    seen.add(j.rule_id);
    const problems = [];
    if (j.verdict === "fail" && j.evidence.length === 0) problems.push("fail without evidence");
    if (j.evidence.length > ev.max_items_per_judgement) problems.push(`more than ${ev.max_items_per_judgement} evidence items`);
    const checks = j.evidence.map((e) => checkEvidence(root, e, { maxQuote: ev.max_quote_chars }));
    checks.forEach((c, i) => { if (c) problems.push(`evidence ${i + 1}: ${c}`); });
    out[j.rule_id] = { judgement: { ...j, reason: j.reason.slice(0, 600) }, problems };
  }
  return out;
}
