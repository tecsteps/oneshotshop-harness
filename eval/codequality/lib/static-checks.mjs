// Static (deterministic) rules: computed from the inventory (AST), the DB schema dump, and the
// outputs of eval/tools and eval/perf. No AI. Each check returns
//   {status: "ok"|"na", value, score (0..1), instances, passing, offenders[], source, note}
import { guessTable } from "./units.mjs";

const FRAMEWORK_TABLES = new Set(["cache", "cache_locks", "failed_jobs", "job_batches", "jobs", "migrations", "password_reset_tokens", "sessions"]);
const appClasses = (inv) => inv.classes.filter((c) => c.file.startsWith("app/") && !["enum", "other"].includes(c.kind) && c.type === "class");
const appMethods = (inv) => appClasses(inv).flatMap((c) => c.methods.filter((m) => !m.abstract).map((m) => ({ ...m, cls: c.fqcn, file: c.file })));
const phpKloc = (inv) => Math.max(0.001, inv.files.filter((f) => f.file.startsWith("app/")).reduce((s, f) => s + f.nonblank_lines, 0) / 1000);

const passRate = (items, ok, describe) => {
  if (!items.length) return { status: "na", note: "no instances" };
  const bad = items.filter((x) => !ok(x));
  return { status: "ok", instances: items.length, passing: items.length - bad.length, value: (items.length - bad.length) / items.length, offenders: bad.slice(0, 15).map(describe), offenders_total: bad.length };
};
const toolMetric = (tools, name) => tools?.tools?.find((t) => t.name === name && t.status === "ok")?.metrics ?? null;
const perKloc = (tools, key) => tools?.normalised?.per_kloc?.[key] ?? null;
const metricRes = (value, source, extra = {}) => (value === null || value === undefined || Number.isNaN(value) ? { status: "na", note: `${source} unavailable` } : { status: "ok", value, source, ...extra });

function singular(table) { return table.endsWith("ies") ? table.slice(0, -3) + "y" : table.endsWith("ses") ? table.slice(0, -2) : table.replace(/s$/, ""); }

export const CHECKS = {
  "inventory.method_length": ({ inv }) => passRate(appMethods(inv), (m) => m.statements <= 30, (m) => `${m.file}:${m.line_start} ${m.cls}::${m.name}() ${m.statements} statements`),
  "inventory.class_length": ({ inv }) => passRate(appClasses(inv), (c) => c.statements <= 300 && c.methods.length <= 20, (c) => `${c.file} ${c.fqcn}: ${c.statements} statements, ${c.methods.length} methods`),
  "inventory.method_complexity": ({ inv }) => passRate(appMethods(inv), (m) => m.ccn <= 10, (m) => `${m.file}:${m.line_start} ${m.cls}::${m.name}() CCN ${m.ccn}`),
  "inventory.method_nesting": ({ inv }) => passRate(appMethods(inv), (m) => m.nesting <= 3, (m) => `${m.file}:${m.line_start} ${m.cls}::${m.name}() depth ${m.nesting}`),
  "inventory.method_params": ({ inv }) => passRate(appMethods(inv).filter((m) => m.name !== "__construct"), (m) => m.params <= 4, (m) => `${m.file}:${m.line_start} ${m.cls}::${m.name}() ${m.params} params`),
  "inventory.statement_density": ({ inv }) => {
    const fs = inv.files.filter((f) => /^(app|routes|database)\//.test(f.file));
    const total = fs.reduce((s, f) => s + f.statements, 0), own = fs.reduce((s, f) => s + f.statements_own_line, 0);
    if (!total) return { status: "na", note: "no statements" };
    const worst = fs.filter((f) => f.statements > 0).map((f) => ({ f, r: f.statements_own_line / f.statements })).sort((a, b) => a.r - b.r).slice(0, 10);
    return { status: "ok", value: own / total, instances: total, passing: own, offenders: worst.filter((w) => w.r < 0.95).map((w) => `${w.f.file}: ${(w.r * 100).toFixed(0)}% of ${w.f.statements} statements on their own line`) };
  },
  "inventory.empty_catch": ({ inv }) => {
    const fs = inv.files.filter((f) => f.file.startsWith("app/"));
    const hits = fs.flatMap((f) => [...f.empty_catch.map((l) => `${f.file}:${l} empty catch`), ...f.error_suppress.map((l) => `${f.file}:${l} @-suppression`)]);
    return { status: "ok", value: hits.length / phpKloc(inv), count: hits.length, offenders: hits.slice(0, 15) };
  },
  "inventory.magic_numbers": ({ inv }) => {
    const fs = inv.files.filter((f) => f.file.startsWith("app/"));
    const hits = fs.flatMap((f) => f.magic_numbers.map((l) => `${f.file}:${l}`));
    return { status: "ok", value: hits.length / phpKloc(inv), count: hits.length, offenders: hits.slice(0, 15) };
  },
  "inventory.unused_private": ({ inv }) => {
    const total = appClasses(inv).reduce((n, c) => n + c.privates, 0);
    if (!total) return { status: "na", note: "no private members" };
    const offenders = appClasses(inv).flatMap((c) => c.unused_privates.map((u) => `${c.file}:${u.line} private ${u.type} ${u.name} never used`));
    return { status: "ok", instances: total, passing: total - offenders.length, value: (total - offenders.length) / total, offenders: offenders.slice(0, 15) };
  },
  "inventory.class_coupling": ({ inv }) => passRate(appClasses(inv), (c) => c.dependencies <= 12, (c) => `${c.file} ${c.fqcn}: ${c.dependencies} dependencies`),
  "inventory.service_location": ({ inv }) => {
    const hits = inv.files.flatMap((f) => f.service_location.map((l) => `${f.file}:${l}`));
    return { status: "ok", value: hits.length / phpKloc(inv), count: hits.length, offenders: hits.slice(0, 15) };
  },
  "inventory.env_outside_config": ({ inv }) => {
    const hits = inv.files.flatMap((f) => f.env_calls.map((l) => `${f.file}:${l}`));
    return { status: "ok", value: hits.length, count: hits.length, offenders: hits.slice(0, 15) };
  },
  "inventory.mass_assignment": ({ inv }) => {
    const models = inv.classes.filter((c) => c.kind === "model" && c.model);
    if (!models.length) return { status: "na", note: "no models" };
    const unguard = inv.files.flatMap((f) => f.unguard_calls.map((l) => `${f.file}:${l} Model::unguard()`));
    const dumps = inv.files.flatMap((f) => f.mass_assign_request.map((l) => `${f.file}:${l} request data passed wholesale to a mass-assignment method`));
    const badModels = models.filter((c) => c.model.guarded === 0 && !(c.model.fillable > 0)).map((c) => `${c.file}: $guarded = [] (everything mass-assignable)`);
    const instances = models.length + dumps.length + unguard.length;
    const failing = badModels.length + dumps.length + (unguard.length ? models.length : 0);
    return { status: "ok", instances, passing: Math.max(0, instances - failing), value: Math.max(0, instances - failing) / instances, offenders: [...unguard, ...badModels, ...dumps].slice(0, 15) };
  },
  "inventory.route_closures": ({ inv }) => {
    const rs = inv.routes.filter((r) => !r.console);
    const regs = rs.reduce((s, r) => s + r.registrations, 0);
    if (!regs) return { status: "na", note: "no routes" };
    const fat = rs.flatMap((r) => r.fat_closures.map((l) => `${r.file}:${l} route closure with logic`));
    return { status: "ok", instances: regs, passing: regs - fat.length, value: (regs - fat.length) / regs, offenders: fat };
  },
  "inventory.raw_sql_interpolation": ({ inv }) => {
    const hits = inv.files.filter((f) => /^(app|routes)\//.test(f.file)).flatMap((f) => f.raw_sql_dynamic.map((h) => `${f.file}:${h.line} ${h.call} with interpolated/concatenated SQL`));
    return { status: "ok", value: hits.length, count: hits.length, offenders: hits };
  },
  "inventory.blade_csrf": ({ inv }) => {
    const forms = inv.views.reduce((s, v) => s + v.post_forms, 0);
    if (!forms) return { status: "na", note: "no POST forms" };
    const missing = inv.views.flatMap((v) => v.post_forms_missing_csrf.map((l) => `${v.file}:${l} POST form without @csrf`));
    const unescaped = inv.views.reduce((s, v) => s + v.unescaped.length, 0);
    return { status: "ok", instances: forms, passing: forms - missing.length, value: (forms - missing.length) / forms, offenders: missing, info: { unescaped_outputs: unescaped } };
  },

  // ---- schema dump
  "schema.fk_declared": ({ schema }) => {
    if (!schema) return { status: "na", note: "schema dump unavailable" };
    const names = new Set(schema.tables.map((t) => t.name));
    const items = [];
    for (const t of schema.tables) if (!FRAMEWORK_TABLES.has(t.name)) for (const c of t.columns) {
      const m = /^(.+)_id$/.exec(c.name); if (!m) continue;
      const target = [guessTable(m[1].replace(/_([a-z])/g, (_, x) => x.toUpperCase()).replace(/^./, (x) => x.toUpperCase())), m[1] + "s", m[1]].find((x) => names.has(x));
      const fk = t.foreign_keys.find((f) => f.columns.length === 1 && f.columns[0] === c.name);
      if (!target && !fk) continue; // polymorphic/external ids
      items.push({ t: t.name, c: c.name, ok: !!fk, target: fk?.foreign_table || target });
    }
    return passRate(items, (x) => x.ok, (x) => `${x.t}.${x.c} -> ${x.target}: no FOREIGN KEY`);
  },
  "schema.fk_indexed": ({ schema }) => {
    if (!schema) return { status: "na", note: "schema dump unavailable" };
    const items = [];
    for (const t of schema.tables) if (!FRAMEWORK_TABLES.has(t.name)) {
      const leading = new Set(t.indexes.map((i) => i.columns[0]));
      const cols = new Set([...t.foreign_keys.flatMap((f) => f.columns.slice(0, 1)), ...t.columns.filter((c) => /_id$/.test(c.name) || /^(sku|slug|email|code|number|status)$/.test(c.name)).map((c) => c.name)]);
      for (const c of cols) items.push({ t: t.name, c, ok: leading.has(c) });
    }
    return passRate(items, (x) => x.ok, (x) => `${x.t}.${x.c} not the leading column of any index`);
  },
  "schema.money_not_float": ({ schema }) => {
    if (!schema) return { status: "na", note: "schema dump unavailable" };
    const items = [];
    for (const t of schema.tables) if (!FRAMEWORK_TABLES.has(t.name)) for (const c of t.columns) {
      if (!/(price|amount|total|cost|fee|(^|_)net($|_)|gross|vat|tax|discount|credit|balance|surcharge|limit)/.test(c.name)) continue;
      if (/(_id|_at|_rate_id|_count|_percent|_pct|_bp|_type|_code|_number|_name|_label|_reason|_note|_status|_method)$/.test(c.name)) continue;
      const ty = `${c.type} ${c.type_name}`.toLowerCase();
      if (/(char|text|bool|date|time|json|blob)/.test(ty)) continue;
      items.push({ t: t.name, c: c.name, ty: c.type, ok: !/(float|double|real)/.test(ty) });
    }
    return passRate(items, (x) => x.ok, (x) => `${x.t}.${x.c} stored as ${x.ty}`);
  },
  "schema.natural_keys_unique": ({ schema }) => {
    if (!schema) return { status: "na", note: "schema dump unavailable" };
    const items = [];
    for (const t of schema.tables) if (!FRAMEWORK_TABLES.has(t.name)) for (const c of t.columns) {
      const nk = /^(sku|slug)$/.test(c.name) || (c.name === "email" && /^(users|companies|customers)$/.test(t.name)) || (/^(number|order_number|invoice_number|document_number)$/.test(c.name)) || (c.name === "code" && /(promotion|coupon|voucher)/.test(t.name));
      if (!nk) continue;
      const ok = t.indexes.some((i) => (i.unique || i.primary) && (i.columns.length === 1 ? i.columns[0] === c.name : i.columns[i.columns.length - 1] === c.name));
      items.push({ t: t.name, c: c.name, ok });
    }
    return passRate(items, (x) => x.ok, (x) => `${x.t}.${x.c} has no unique index`);
  },
  "schema.naming": ({ schema }) => {
    if (!schema) return { status: "na", note: "schema dump unavailable" };
    const items = [];
    for (const t of schema.tables) if (!FRAMEWORK_TABLES.has(t.name)) {
      items.push({ what: `table ${t.name}`, ok: /^[a-z][a-z0-9_]*$/.test(t.name) });
      for (const c of t.columns) items.push({ what: `${t.name}.${c.name}`, ok: /^[a-z][a-z0-9_]*$/.test(c.name) });
    }
    return passRate(items, (x) => x.ok, (x) => `${x.what} not snake_case`);
  },
  "schema.model_casts": ({ schema, inv }) => {
    if (!schema) return { status: "na", note: "schema dump unavailable" };
    const items = [];
    for (const c of inv.classes.filter((x) => x.kind === "model" && x.model)) {
      const t = schema.tables.find((x) => x.name === (c.model.table || guessTable(c.name)));
      if (!t) continue;
      for (const col of t.columns) {
        if (["created_at", "updated_at", "deleted_at", "email_verified_at"].includes(col.name)) continue;
        const ty = `${col.type} ${col.type_name}`.toLowerCase();
        const typed = /(bool|tinyint\(1\))/.test(ty) || /(date|time)/.test(ty) || /json/.test(ty) || (/_at$/.test(col.name) && /(varchar|text|datetime)/.test(ty)) || /^(is|has|can)_/.test(col.name);
        if (!typed) continue;
        items.push({ m: c.fqcn, col: col.name, ok: c.model.casts.includes(col.name) });
      }
    }
    return passRate(items, (x) => x.ok, (x) => `${x.m}: column ${x.col} not cast`);
  },

  // ---- eval/tools + eval/perf
  "tools.sonarqube.duplicated_lines_density": ({ tools }) => metricRes(toolMetric(tools, "sonarqube")?.measures?.duplicatedLinesDensity, "eval/tools sonarqube"),
  "tools.sonarqube.code_smells_per_kloc": ({ tools }) => metricRes(perKloc(tools, "sonar_code_smells"), "eval/tools normalised.per_kloc.sonar_code_smells"),
  "tools.sonarqube.vulns_hotspots_per_kloc": ({ tools }) => { const a = perKloc(tools, "sonar_vulnerabilities"), b = perKloc(tools, "sonar_security_hotspots"); return metricRes(a === null || b === null ? null : a + b, "eval/tools sonar vulnerabilities+hotspots per kloc"); },
  "tools.readability.lines_over_120_per_1000": ({ tools }) => metricRes(perKloc(tools, "readability_lines_over_120_per_1000_lines"), "eval/tools readability"),
  "tools.phpstan.level_5_per_php_kloc": ({ tools }) => metricRes(perKloc(tools, "phpstan_level_5_errors_per_php_kloc"), "eval/tools phpstan"),
  "tools.pint.files_failing_per_php_kloc": ({ tools }) => metricRes(perKloc(tools, "pint_files_failing_per_php_kloc"), "eval/tools pint"),
  "tools.semgrep.error_findings_per_kloc": ({ tools }) => metricRes(perKloc(tools, "semgrep_error_findings"), "eval/tools semgrep"),
  "tools.tests.pass_ratio": ({ tools }) => {
    const t = tools?.tools?.find((x) => x.name === "tests");
    if (!t) return { status: "na", note: "tests tool did not run" };
    const m = t.metrics || {};
    if (!m.tests) return t.status === "ok" || m.tests === 0 ? { status: "ok", value: 0, note: "no tests" } : { status: "ok", value: 0, note: `tests tool ${t.status}: ${t.reason || "no result"}` };
    return { status: "ok", value: (m.passed ?? 0) / m.tests, source: "eval/tools tests", info: { tests: m.tests, passed: m.passed, failed: m.failed, errors: m.errors } };
  },
  "tools.tests.line_coverage": ({ tools }) => metricRes(tools?.tools?.find((x) => x.name === "tests")?.metrics?.line_coverage_pct ?? null, "eval/tools tests coverage"),
  "tools.tests.assertions_per_test": ({ tools }) => { const m = tools?.tools?.find((x) => x.name === "tests")?.metrics; return metricRes(m?.tests ? m.assertions / m.tests : null, "eval/tools tests"); },
  "perf.n_plus_one": ({ perf }) => metricRes(perf?.headline?.journey_server?.n_plus_one_distinct_statements ?? null, "eval/perf headline.journey_server"),
};

export function scoreOf(rule, res) {
  if (res.status !== "ok") return null;
  const s = rule.score_by, v = res.value;
  if (s.type === "pass_rate") return v;
  if (s.type === "linear") return v <= s.good ? 1 : v >= s.bad ? 0 : 1 - (v - s.good) / (s.bad - s.good);
  if (s.type === "linear_ratio") return v >= s.good ? 1 : v <= s.bad ? 0 : (v - s.bad) / (s.good - s.bad);
  if (s.type === "threshold") return v ? 1 : 0;
  return null;
}

export function runStaticChecks(cat, ctx) {
  return cat.staticRules.map((r) => {
    const fn = CHECKS[r.check];
    let res;
    try { res = fn ? fn(ctx) : { status: "na", note: `check ${r.check} not implemented` }; } catch (e) { res = { status: "na", note: `check failed: ${e.message}` }; }
    const score = scoreOf(r, res);
    return { rule_id: r.id, category: r.category, check: r.check, weight: r.weight, ...res, score: score === null ? null : Math.round(score * 1000) / 1000 };
  });
}
