// Units: inventory -> unit list -> deterministic sample -> per-call prompts (no AI here).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { rulesForKind, sha256 } from "./catalogue.mjs";

const FRAMEWORK_TABLES = new Set(["cache", "cache_locks", "failed_jobs", "job_batches", "jobs", "migrations", "password_reset_tokens", "sessions"]);

export function buildUnits(cat, inv, src) {
  const units = [];
  const fileText = (f) => readFileSync(join(src, f), "utf8");
  const sampled = new Set(Object.keys(cat.procedure.sampling));
  // classes: one unit per class of a sampled kind
  for (const c of inv.classes) {
    if (!sampled.has(c.kind)) continue;
    const lines = fileText(c.file).split("\n");
    const chars = lines.slice(c.line_start - 1, c.line_end).join("\n").length;
    units.push({ id: c.id, kind: c.kind, file: c.file, size: chars, lines: c.lines, label: c.fqcn });
  }
  for (const v of inv.views) units.push({ id: `view:${v.file}`, kind: "view", file: v.file, size: v.bytes, lines: v.lines, label: v.file });
  for (const t of inv.tests) if (t.tests > 0) units.push({ id: `test:${t.file}`, kind: "test", file: t.file, size: fileText(t.file).length, lines: t.nonblank_lines, label: t.file });
  for (const r of inv.routes) if (!r.console) units.push({ id: `routes:${r.file}`, kind: "routes", file: r.file, size: fileText(r.file).length, lines: r.nonblank_lines, label: r.file });
  units.push({ id: "schema:database", kind: "schema", file: null, size: 0, lines: 0, label: "database schema + migrations" });
  return units.sort((a, b) => a.id.localeCompare(b.id));
}

// Deterministic sample: per kind the `top` largest (size desc, id asc) + `random` by sha256(version:id).
export function sampleUnits(cat, units) {
  const seed = cat.catalogue.version;
  const out = [];
  for (const [kind, { top, random }] of Object.entries(cat.procedure.sampling)) {
    const pool = units.filter((u) => u.kind === kind && (u.kind === "schema" || u.size >= (cat.procedure.min_unit_chars ?? 0)));
    const bySize = [...pool].sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
    const chosen = bySize.slice(0, top).map((u) => ({ ...u, selected_by: "top" }));
    const rest = pool.filter((u) => !chosen.some((c) => c.id === u.id))
      .map((u) => ({ u, h: sha256(`${seed}:${u.id}`) })).sort((a, b) => a.h.localeCompare(b.h)).slice(0, random)
      .map(({ u }) => ({ ...u, selected_by: "hash" }));
    out.push(...chosen, ...rest);
  }
  // global cap: keep kind order of the catalogue, drop from the end of the hash picks first
  const cap = cat.procedure.max_units_total;
  if (out.length > cap) {
    const hashPicks = out.filter((u) => u.selected_by === "hash").reverse();
    const drop = new Set(hashPicks.slice(0, out.length - cap).map((u) => u.id));
    return out.filter((u) => !drop.has(u.id));
  }
  return out;
}

// ------------------------------------------------------------------ prompt text
const numbered = (lines, from) => lines.map((l, i) => `${String(from + i).padStart(5)}| ${l}`).join("\n");

function cut(lines, from, cat) {
  const maxL = cat.procedure.unit_max_lines, maxC = cat.procedure.unit_max_chars;
  let take = Math.min(lines.length, maxL), chars = 0, i = 0;
  for (; i < take; i++) { chars += lines[i].length + 1; if (chars > maxC) break; }
  const shown = lines.slice(0, i);
  const note = i < lines.length ? `\n[… unit cut after line ${from + i - 1}: only the lines above were shown; the remaining ${lines.length - i} lines are not part of this evaluation …]` : "";
  return numbered(shown, from) + note;
}

export function renderRules(cat, kind) {
  const rules = rulesForKind(cat, kind);
  const parts = [`# Checklist for unit kind \`${kind}\` (${rules.length} rules, catalogue ${cat.catalogue.version})`, ""];
  for (const r of rules) {
    parts.push(`## ${r.id} — ${r.title}`, r.definition.trim(), "", "PASS example:", "```php", r.pass_example.trimEnd(), "```", "FAIL example:", "```php", r.fail_example.trimEnd(), "```",
      `N/A when: ${r.na_when.trim()}`, `Evidence for a fail: ${r.evidence.trim()}`, "");
  }
  return parts.join("\n");
}

export function renderRepoMap(inv, schema) {
  const L = ["# Repository map of the evaluated build (for orientation; use the code-navigation tools for details)", ""];
  const byKind = {};
  for (const c of inv.classes) if (c.file.startsWith("app/")) (byKind[c.kind] ??= []).push(c);
  for (const k of Object.keys(byKind).sort()) {
    L.push(`${k}:`);
    for (const c of byKind[k]) L.push(`  ${c.fqcn}  ${c.file}  (${c.methods.length} methods, ${c.statements} statements)`);
  }
  L.push(`views: ${inv.views.length} Blade files; tests: ${inv.tests.length} files; route files: ${inv.routes.map((r) => r.file).join(", ")}; migrations: ${inv.migrations.length}`);
  if (schema?.tables) L.push(`tables: ${schema.tables.filter((t) => !FRAMEWORK_TABLES.has(t.name)).map((t) => t.name).join(", ")}`);
  return L.join("\n");
}

function schemaText(schema) {
  const L = [];
  for (const t of schema.tables) {
    if (FRAMEWORK_TABLES.has(t.name)) continue;
    L.push(`TABLE ${t.name} (${t.rows ?? "?"} rows after seeding)`);
    for (const c of t.columns) L.push(`  ${c.name} ${c.type}${c.nullable ? " NULL" : " NOT NULL"}${c.default !== null && c.default !== undefined ? " DEFAULT " + c.default : ""}${c.auto_increment ? " AUTOINCREMENT" : ""}`);
    for (const i of t.indexes) L.push(`  ${i.primary ? "PRIMARY KEY" : i.unique ? "UNIQUE INDEX" : "INDEX"} ${i.name} (${i.columns.join(", ")})`);
    for (const f of t.foreign_keys) L.push(`  FOREIGN KEY (${f.columns.join(", ")}) REFERENCES ${f.foreign_table}(${f.foreign_columns.join(", ")})${f.on_delete ? " ON DELETE " + f.on_delete : ""}`);
  }
  return L.join("\n");
}

// Unit-specific context + source. Everything here is derived deterministically from the build.
export function renderUnit(cat, unit, { inv, schema, routes, src }) {
  const L = [];
  const read = (f) => readFileSync(join(src, f), "utf8").split("\n");
  if (unit.kind === "schema") {
    L.push(`# Unit to evaluate: the database (kind \`schema\`)`, "");
    if (schema) L.push("## Schema after `php artisan migrate --seed` (framework tables omitted)", "```", schemaText(schema), "```", "");
    else L.push("## Schema dump unavailable (the app could not be prepared); judge from the migrations below.", "");
    L.push("## Migration sources (cite these files and lines as evidence)", "");
    let budget = cat.procedure.unit_max_chars;
    for (const m of inv.migrations) {
      const lines = read(m.file);
      const text = cut(lines, 1, { procedure: { ...cat.procedure, unit_max_chars: Math.max(2000, budget) } });
      budget -= text.length;
      L.push(`### ${m.file}`, "```php", text, "```", "");
    }
    return L.join("\n");
  }
  const lines = read(unit.file);
  L.push(`# Unit to evaluate (kind \`${unit.kind}\`)`, "", `File: ${unit.file}`);
  if (unit.id.startsWith("class:")) {
    const c = inv.classes.find((x) => x.id === unit.id);
    L.push(`Class: ${c.fqcn}${c.extends ? " extends " + c.extends : ""}${c.implements.length ? " implements " + c.implements.join(", ") : ""}`);
    L.push(`Lines ${c.line_start}-${c.line_end}; methods: ${c.methods.map((m) => `${m.name}() L${m.line_start}-${m.line_end}`).join(", ") || "none"}`);
    if (c.kind === "model" && schema) {
      const table = c.model?.table || guessTable(c.name);
      const t = schema.tables.find((x) => x.name === table);
      if (t) L.push(`Table \`${t.name}\`: ${t.columns.map((col) => `${col.name} ${col.type}`).join(", ")}; foreign keys: ${t.foreign_keys.map((f) => f.columns.join("+") + "->" + f.foreign_table).join(", ") || "none"}`);
    }
    if ((c.kind === "controller" || c.kind === "livewire") && Array.isArray(routes)) {
      const rs = routes.filter((r) => typeof r.action === "string" && (r.action === c.fqcn || r.action.startsWith(c.fqcn + "@")));
      if (rs.length) {
        L.push("Routes handled by this class (from `php artisan route:list --json`):");
        for (const r of rs.slice(0, 60)) L.push(`  ${r.method} /${String(r.uri).replace(/^\//, "")} -> ${r.action.split("@")[1] || "__invoke"}  middleware: ${(r.middleware || []).join(", ") || "none"}`);
      }
    }
    // whole file when it holds only this class, else the file header + the class span
    const classesInFile = inv.classes.filter((x) => x.file === unit.file);
    L.push("", "Source (line numbers are the file's real line numbers):", "```php");
    if (classesInFile.length === 1) L.push(cut(lines, 1, cat));
    else {
      const firstStart = Math.min(...classesInFile.map((x) => x.line_start));
      L.push(numbered(lines.slice(0, firstStart - 1), 1), "   …|", cut(lines.slice(c.line_start - 1, c.line_end), c.line_start, cat));
    }
    L.push("```");
  } else {
    if (unit.kind === "routes" && Array.isArray(routes)) L.push(`(${routes.length} routes registered in total; the code-navigation tools can show controllers and middleware.)`);
    L.push("", "Source (line numbers are the file's real line numbers):", "```" + (unit.kind === "view" ? "blade" : "php"), cut(lines, 1, cat), "```");
  }
  return L.join("\n");
}

export function guessTable(cls) {
  const snake = cls.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(snake)) return snake + "es";
  if (/[^aeiou]y$/.test(snake)) return snake.slice(0, -1) + "ies";
  return snake + "s";
}

export const loadJson = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
