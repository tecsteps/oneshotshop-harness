// Rule catalogue: load + validate rules.yaml, compute its hash, render rules.md.
//   node lib/catalogue.mjs check|hash|render [--out rules.md]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const CQ_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RULES_FILE = join(CQ_DIR, "rules.yaml");

// Canonical JSON: keys sorted at every level, so the hash does not depend on YAML formatting/comments.
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const AI_FIELDS = ["id", "title", "category", "decided_by", "weight", "applies_to", "definition", "pass_example", "fail_example", "na_when", "evidence", "why_ai"];
const STATIC_FIELDS = ["id", "title", "category", "decided_by", "weight", "applies_to", "check", "definition", "score_by", "na_when"];
const UNIT_KINDS_EXTRA = new Set(["view", "test", "routes", "schema"]);

export function validateCatalogue(cat) {
  const errs = [];
  if (!cat?.catalogue?.version) errs.push("catalogue.version missing");
  const cats = cat.categories || {};
  const kinds = new Set(Object.keys(cat.unit_kinds || {}));
  const ids = new Set();
  for (const r of cat.rules || []) {
    const where = r.id || "(rule without id)";
    if (ids.has(r.id)) errs.push(`${where}: duplicate id`);
    ids.add(r.id);
    if (!cats[r.category]) errs.push(`${where}: unknown category ${r.category}`);
    if (!["ai", "static"].includes(r.decided_by)) errs.push(`${where}: decided_by must be ai|static`);
    for (const f of r.decided_by === "ai" ? AI_FIELDS : STATIC_FIELDS) {
      if (r[f] === undefined || r[f] === null || r[f] === "") errs.push(`${where}: missing ${f}`);
    }
    if (!(Number.isFinite(r.weight) && r.weight > 0)) errs.push(`${where}: weight must be > 0`);
    if (r.decided_by === "ai") {
      for (const k of r.applies_to || []) if (!kinds.has(k) && !UNIT_KINDS_EXTRA.has(k)) errs.push(`${where}: unknown unit kind ${k}`);
      if (!/^[A-Z]+-\d\d$/.test(r.id)) errs.push(`${where}: ai rule ids look like XX-01`);
    } else {
      if (!/^[A-Z]+-S\d\d$/.test(r.id)) errs.push(`${where}: static rule ids look like XX-S01`);
      if (!["pass_rate", "linear", "linear_ratio", "threshold"].includes(r.score_by?.type)) errs.push(`${where}: score_by.type invalid`);
    }
  }
  for (const k of Object.keys(cat.procedure?.sampling || {})) if (!kinds.has(k)) errs.push(`procedure.sampling: unknown kind ${k}`);
  return errs;
}

export function loadCatalogue(file = RULES_FILE) {
  const text = readFileSync(file, "utf8");
  const cat = YAML.parse(text);
  const errs = validateCatalogue(cat);
  if (errs.length) throw new Error("rules.yaml invalid:\n  " + errs.join("\n  "));
  const hash = sha256(canonical(cat));
  return { ...cat, hash, aiRules: cat.rules.filter((r) => r.decided_by === "ai"), staticRules: cat.rules.filter((r) => r.decided_by === "static") };
}

// Rules (ai) that apply to a unit kind, in catalogue order (stable prompt prefix).
export const rulesForKind = (cat, kind) => cat.aiRules.filter((r) => r.applies_to.includes(kind));

export function renderMarkdown(cat) {
  const L = [];
  const v = cat.catalogue;
  L.push(`# Code-quality rule catalogue ${v.version}`, "");
  L.push(`> GENERATED from \`rules.yaml\` by \`node eval/codequality/lib/catalogue.mjs render\` — edit the YAML, not this file.`, "");
  L.push(`- Catalogue: \`${v.id}\` version **${v.version}** — ${v.status}`);
  L.push(`- Hash (sha256 of canonical JSON): \`${cat.hash}\``);
  L.push(`- Rules: **${cat.rules.length}** — **${cat.aiRules.length} AI-judged**, **${cat.staticRules.length} static**`);
  L.push(`- Model for AI rules: \`${cat.procedure.model}\`, reasoning effort \`${cat.procedure.reasoning_effort}\`, ${cat.procedure.votes_per_judgement} vote per judgement`, "");
  L.push("## Categories", "", "| Category | Weight | AI rules (Σ weight) | Static rules (Σ weight) |", "|---|---:|---|---|");
  for (const [k, c] of Object.entries(cat.categories)) {
    const ai = cat.aiRules.filter((r) => r.category === k), st = cat.staticRules.filter((r) => r.category === k);
    const sum = (a) => a.reduce((s, r) => s + r.weight, 0);
    L.push(`| ${c.title} (\`${k}\`) | ${c.weight} | ${ai.length} (${sum(ai)}) | ${st.length} (${sum(st)}) |`);
  }
  L.push("", "## How scores are formed", "");
  L.push("- **AI rule score** = passes / (passes + fails) over the sampled units where the rule applied; `na` and `unverified` judgements do not count.");
  L.push("- **Static rule score** = 0..1 from its check (`pass_rate`: passing instances / all; `linear`: 1 at ≤ good, 0 at ≥ bad; `linear_ratio`: 1 at ≥ good, 0 at ≤ bad).");
  L.push("- **Category score** (0–100) = weighted mean of its rule scores (AI and static together, by rule weight; rules without data drop out).");
  L.push("- **Code Quality Index (CQI)** = weighted mean of the category scores (category weights above). AI-only and static-only indices are reported as well.");
  L.push("", "## Sampling (deterministic)", "", "Per kind: the `top` largest units (source characters, ties by id) plus `random` units ordered by `sha256(\"<catalogue version>:<unit id>\")` from the rest. The seed is the catalogue version, never the branch.", "");
  L.push("| Kind | Description | top | random |", "|---|---|---:|---:|");
  for (const [k, d] of Object.entries(cat.unit_kinds)) {
    const s = cat.procedure.sampling[k];
    L.push(`| \`${k}\` | ${d} | ${s ? s.top : "–"} | ${s ? s.random : "excluded"} |`);
  }
  L.push("", `Units smaller than ${cat.procedure.min_unit_chars} characters are not sampled. Cap: ${cat.procedure.max_units_total} units per build; a unit's source is cut at ${cat.procedure.unit_max_lines} lines / ${cat.procedure.unit_max_chars} characters.`);
  L.push("", "## Overview", "", "| ID | Title | Category | By | Weight | Applies to / check |", "|---|---|---|---|---:|---|");
  for (const r of cat.rules) L.push(`| [${r.id}](#${r.id.toLowerCase()}) | ${r.title} | ${r.category} | ${r.decided_by} | ${r.weight} | ${r.decided_by === "ai" ? r.applies_to.join(", ") : "`" + r.check + "`"} |`);
  const block = (t) => "```php\n" + String(t).trimEnd() + "\n```";
  L.push("", "## AI-judged rules", "");
  for (const r of cat.aiRules) {
    L.push(`### ${r.id}`, "", `**${r.title}** — ${cat.categories[r.category].title}, weight ${r.weight}, applies to: ${r.applies_to.map((k) => "`" + k + "`").join(", ")}`, "");
    L.push(r.definition.trim(), "", "**PASS example**", "", block(r.pass_example), "", "**FAIL example**", "", block(r.fail_example), "");
    L.push(`**N/A when:** ${r.na_when.trim()}`, "", `**Evidence required:** ${r.evidence.trim()}`, "", `**Why AI (not static):** ${r.why_ai.trim()}`, "");
  }
  L.push("## Static rules", "");
  for (const r of cat.staticRules) {
    const s = r.score_by;
    const how = s.type === "pass_rate" ? "pass rate" : `${s.type} (good ${s.good}, bad ${s.bad})`;
    L.push(`### ${r.id}`, "", `**${r.title}** — ${cat.categories[r.category].title}, weight ${r.weight}, check \`${r.check}\`, scored by ${how}`, "", r.definition.trim(), "", `Scope: ${r.applies_to.join(", ")}. N/A when: ${r.na_when}`, "");
  }
  return L.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || "check";
  const cat = loadCatalogue();
  if (cmd === "hash") console.log(cat.hash);
  else if (cmd === "render") {
    const i = process.argv.indexOf("--out");
    const out = i > 0 ? process.argv[i + 1] : join(CQ_DIR, "rules.md");
    writeFileSync(out, renderMarkdown(cat));
    console.log(`wrote ${out} (${cat.rules.length} rules: ${cat.aiRules.length} ai, ${cat.staticRules.length} static; hash ${cat.hash.slice(0, 12)})`);
  } else {
    const byCat = {};
    for (const r of cat.rules) { byCat[r.category] ??= { ai: 0, static: 0, ai_weight: 0, static_weight: 0 }; byCat[r.category][r.decided_by]++; byCat[r.category][r.decided_by + "_weight"] += r.weight; }
    console.log(JSON.stringify({ version: cat.catalogue.version, hash: cat.hash, rules: cat.rules.length, ai: cat.aiRules.length, static: cat.staticRules.length, byCategory: byCat }, null, 2));
  }
}
