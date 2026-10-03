#!/usr/bin/env node
// Post-check for the analyst's output: structural checks of insights.json (the subset of
// insights.schema.json that matters, no dependencies) and a numbers check: every
// numbers[].statsPath must exist in stats.json, and numeric values must match it.
//
//   node check-insights.mjs runs/<id>/insights
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check-insights.mjs <insights dir with stats.json, insights.json, insights.md>");
  process.exit(2);
}
const problems = [];
const warn = [];
const need = (c, m) => c || problems.push(m);
for (const f of ["stats.json", "insights.json", "insights.md"]) need(existsSync(join(dir, f)), `missing ${f}`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
const stats = JSON.parse(readFileSync(join(dir, "stats.json"), "utf8"));
let ins;
try {
  ins = JSON.parse(readFileSync(join(dir, "insights.json"), "utf8"));
} catch (e) {
  console.error(`insights.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

const CASES = ["packaging_and_deposits", "catch_weight_fractional", "negotiated_prices", "promotions", "vat_reverse_charge", "delivery_restrictions", "lots_expiry", "backorders_substitution", "refunds_returns"];
need(ins.schemaVersion === 1, "schemaVersion must be 1");
// integrity must mirror the deterministic scan, and be prominent when access was detected
const acc = !!stats.integrity?.harness_access;
need(ins.integrity && ins.integrity.harnessAccess === acc, `integrity.harnessAccess must be ${acc} (stats.json integrity.harness_access)`);
if (acc) need((ins.integrity?.evidence || []).length >= Math.min(stats.integrity.hits.length, 1), "integrity.evidence must cite the hits");
need(Array.isArray(ins.tldr) && ins.tldr.length === 3, "tldr must have exactly 3 sentences");
need(Array.isArray(ins.linkedinTakeaways) && ins.linkedinTakeaways.length === 5, "linkedinTakeaways must have exactly 5 entries");
for (const t of ins.linkedinTakeaways || []) need(String(t.text || "").length <= 280, `takeaway over 280 chars: ${String(t.text).slice(0, 60)}…`);
const cases = (ins.hardCases || []).map((c) => c.case);
need(CASES.every((c) => cases.includes(c)) && cases.length === 9, `hardCases must contain each of: ${CASES.join(", ")}`);
for (const c of ins.hardCases || []) need(["handled", "partial", "not_found", "unverified"].includes(c.status), `hardCases.${c.case}: bad status ${c.status}`);

// every evidence array non-empty, every file ref looks like path:line
const walk = (v, path) => {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "evidence") {
        need(Array.isArray(x) && x.length > 0, `${path}.evidence is empty`);
        for (const e of x || []) {
          need(["transcript", "commit", "file", "stats", "spec"].includes(e.type), `${path}.evidence: bad type ${e.type}`);
          if (e.type === "file" && !/:\d+/.test(e.ref || "")) warn.push(`${path}.evidence file ref without :line: ${e.ref}`);
          if (e.type === "commit") {
            const known = (stats.git?.commits?.list || []).some((c) => c.hash.startsWith(e.ref) || c.short === e.ref);
            if (!known) warn.push(`${path}.evidence commit ${e.ref} not in stats.json git.commits.list`);
          }
        }
      } else walk(x, `${path}.${k}`);
    }
  }
};
walk(ins, "$");

// numbers must come from stats.json
const get = (obj, p) => p.replace(/^stats[:.]\s*/, "").split(/\.|\[(\d+)\]/).filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
for (const n of ins.numbers || []) {
  const v = get(stats, n.statsPath || "");
  if (v === undefined) {
    problems.push(`numbers "${n.label}": statsPath ${n.statsPath} does not exist in stats.json`);
    continue;
  }
  const num = typeof n.value === "number" ? n.value : Number(String(n.value ?? "").replace(/[$,%\s]/g, ""));
  if (typeof v === "number" && Number.isFinite(num) && v !== 0) {
    const rel = Math.abs(num - v) / Math.abs(v);
    if (rel > 0.01 && !(Math.abs(v) < 1 && Math.abs(num - v * 100) / Math.abs(v * 100) <= 0.01)) problems.push(`numbers "${n.label}": ${n.value} differs from stats.json ${n.statsPath} = ${v}`);
  }
}
const md = readFileSync(join(dir, "insights.md"), "utf8");
const firstLines = md.split("\n").slice(0, 5).join("\n");
need(acc ? /HARNESS ACCESS DETECTED/i.test(firstLines) : /Integrity: no access detected/i.test(firstLines), `insights.md must start with the Integrity note (${acc ? "HARNESS ACCESS DETECTED" : "Integrity: no access detected"})`);
for (const h of ["TL;DR", "Key decisions", "Technology choices", "special", "Struggles", "hard B2B", "Spec interpretation", "Self-testing", "Numbers", "LinkedIn", "Open questions"])
  if (!md.toLowerCase().includes(h.toLowerCase())) warn.push(`insights.md: section containing "${h}" not found`);

for (const w of warn) console.log(`WARN ${w}`);
for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? `${problems.length} problem(s)` : "insights.json OK");
process.exit(problems.length ? 1 : 0);
