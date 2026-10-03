// eval/codequality workflow (called by run.sh). Deterministic orchestration around small,
// isolated, stateless Codex calls: one call = one unit + the checklist for its kind.
//
//   node lib/orchestrate.mjs judge  --out <dir> --src <build copy> --extract <dir> [--concurrency N] [--budget-usd X]
//                                   [--limit N] [--kinds a,b] [--units id1,id2] [--no-lsp]
//   node lib/orchestrate.mjs score  --out <dir> --src <dir> --extract <dir> --tools <summary.json> --perf <summary.json> --meta <meta.json>
//   node lib/orchestrate.mjs agreement --cal <calibration dir> --reps rep-1,rep-2,rep-3
//   node lib/orchestrate.mjs units  --out <dir> --src <dir> --extract <dir>      (sample only, no AI)
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CQ_DIR, loadCatalogue, rulesForKind, sha256 } from "./catalogue.mjs";
import { buildUnits, sampleUnits, renderRules, renderRepoMap, renderUnit, loadJson } from "./units.mjs";
import { responseSchema, parseResponse, checkJudgements } from "./verify.mjs";
import { runCodex, priceOf } from "./codex.mjs";
import { runStaticChecks } from "./static-checks.mjs";
import { aiRuleStats, scoreAll, agreement } from "./score.mjs";
import { validate } from "../../../lib/schema-validate.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d = null) => { const i = argv.indexOf("--" + k); return i > 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const flag = (k) => argv.includes("--" + k);
const log = (...a) => console.error(`[codequality ${new Date().toISOString().slice(11, 19)}]`, ...a);
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const slug = (id) => id.replace(/^[a-z]+:/, "").replace(/[^A-Za-z0-9]+/g, "_").slice(-60) + "-" + sha256(id).slice(0, 8);

const cat = loadCatalogue();
{ const env = readFileSync(join(CQ_DIR, "config", "versions.env"), "utf8"); const ah = /CQ_CATALOGUE_SHA256="([0-9a-f]+)"/.exec(env)?.[1];
  if (ah !== cat.hash) console.error(`[codequality] WARNING: rules.yaml (sha256 ${cat.hash.slice(0, 12)}) differs from the approved catalogue in config/versions.env (${(ah || "none").slice(0, 12)}); results are not comparable`); }
const pricing = JSON.parse(readFileSync(join(CQ_DIR, "config", "pricing.json"), "utf8"));
const MODEL = process.env.CQ_MODEL || cat.procedure.model;
const EFFORT = process.env.CQ_EFFORT || cat.procedure.reasoning_effort;
const CODEX = process.env.CQ_CODEX_BIN || "codex";

function context() {
  const ex = opt("extract");
  const inv = loadJson(join(ex, "inventory.json"));
  if (!inv) throw new Error(`no inventory.json in ${ex}`);
  return { inv, schema: loadJson(join(ex, "schema.json")), routes: loadJson(join(ex, "routes.json")), src: opt("src") };
}

function selectUnits(ctx) {
  let units = sampleUnits(cat, buildUnits(cat, ctx.inv, ctx.src));
  const kinds = opt("kinds"); if (kinds) units = units.filter((u) => kinds.split(",").includes(u.kind));
  const ids = opt("units"); if (ids) units = units.filter((u) => ids.split(",").includes(u.id));
  const lim = opt("limit"); if (lim) units = units.slice(0, Number(lim));
  return units;
}

// ------------------------------------------------------------------ prompts (deterministic)
function preparePrompts(outDir, ctx, units) {
  const pdir = join(outDir, "prompt"); mkdirSync(pdir, { recursive: true });
  const instructions = join(pdir, "instructions.md");
  copyFileSync(join(CQ_DIR, "prompts", "instructions.md"), instructions);
  const repoMap = renderRepoMap(ctx.inv, ctx.schema);
  writeFileSync(join(pdir, "repo-map.md"), repoMap + "\n");
  const kinds = [...new Set(units.map((u) => u.kind))];
  const perKind = {};
  for (const k of kinds) {
    const rules = renderRules(cat, k);
    const schemaFile = join(pdir, `schema-${k}.json`);
    writeJson(schemaFile, responseSchema(cat, k));
    writeFileSync(join(pdir, `rules-${k}.md`), rules + "\n");
    perKind[k] = { rules, schemaFile };
  }
  const instrText = readFileSync(instructions, "utf8");
  return units.map((u) => {
    const prefix = perKind[u.kind].rules + "\n\n" + repoMap + "\n\n"; // stable prefix: rules(kind) + repo map(build)
    const body = renderUnit(cat, u, ctx) + `\n\nReturn the JSON object for unit_id "${u.id}" now: one judgement for each of the ${rulesForKind(cat, u.kind).length} checklist rules.`;
    const prompt = prefix + body;
    const promptSha = sha256([instrText, prompt, readFileSync(perKind[u.kind].schemaFile, "utf8"), MODEL, EFFORT].join("\u0000"));
    return { unit: u, prompt, promptSha, prefixChars: instrText.length + prefix.length, schemaFile: perKind[u.kind].schemaFile, instructions };
  });
}

// ------------------------------------------------------------------ shared LSP bridge
async function startBridge(outDir, src) {
  const ready = join(outDir, "lsp-ready.json"); rmSync(ready, { force: true });
  const child = spawn(process.execPath, [join(CQ_DIR, "lib", "lsp-bridge.mjs"), "--root", src, "--port", "0", "--state", join(CQ_DIR, ".cache", "intelephense-state", sha256(src).slice(0, 12)),
    "--log", join(outDir, "lsp-tools.jsonl"), "--ready-file", ready], { stdio: ["ignore", "ignore", "ignore"] });
  const t0 = Date.now();
  while (!existsSync(ready)) {
    if (child.exitCode !== null) throw new Error("LSP bridge exited during start-up");
    if (Date.now() - t0 > 20 * 60_000) { child.kill(); throw new Error("LSP bridge did not become ready in 20 min"); }
    await new Promise((r) => setTimeout(r, 500));
  }
  const info = JSON.parse(readFileSync(ready, "utf8"));
  log(`LSP bridge ready on port ${info.port}: intelephense ${info.intelephense}, indexed in ${info.index_secs}s`);
  return { child, info };
}

// ------------------------------------------------------------------ scheduler
class Gate {
  constructor(max) { this.max = max; this.limit = max; this.active = 0; this.peak = 0; this.waiters = []; this.pausedUntil = 0; this.backoffs = 0; this.okStreak = 0; this.backoffSecs = 20; }
  async acquire() {
    for (;;) {
      const wait = this.pausedUntil - Date.now();
      if (wait > 0) { await new Promise((r) => setTimeout(r, Math.min(wait, 5000))); continue; }
      if (this.active < this.limit) { this.active++; this.peak = Math.max(this.peak, this.active); return; }
      await new Promise((r) => this.waiters.push(r));
    }
  }
  release() { this.active--; const w = this.waiters.shift(); if (w) w(); }
  rateLimited() {
    this.backoffs++; this.okStreak = 0;
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + this.backoffSecs * 1000);
    log(`rate limit detected: pausing ${this.backoffSecs}s, concurrency -> ${this.limit}`);
    this.backoffSecs = Math.min(this.backoffSecs * 2, 600);
  }
  succeeded() { if (++this.okStreak >= 10 && this.limit < this.max) { this.limit = Math.min(this.max, this.limit + 2); this.okStreak = 0; this.backoffSecs = 20; const w = this.waiters.shift(); if (w) w(); } }
}

async function judge() {
  const outDir = opt("out"); mkdirSync(join(outDir, "calls"), { recursive: true });
  const ctx = context();
  const units = selectUnits(ctx);
  writeJson(join(outDir, "units.json"), { catalogue: cat.catalogue.version, catalogue_sha256: cat.hash, count: units.length,
    by_kind: units.reduce((o, u) => ((o[u.kind] = (o[u.kind] || 0) + 1), o), {}), units });
  const jobs = preparePrompts(outDir, ctx, units);
  const conc = Number(opt("concurrency", process.env.CQ_CONCURRENCY || 16));
  const budgetUsd = Number(opt("budget-usd", process.env.CQ_BUDGET_USD || 5));
  const timeoutMs = cat.procedure.call_timeout_secs * 1000;
  const gate = new Gate(conc);
  const callsLog = join(outDir, "calls.jsonl");
  let spent = 0, budgetHit = false;
  const t0 = Date.now();
  const bridge = flag("no-lsp") ? null : await startBridge(outDir, ctx.src);
  const mcpBase = bridge ? `http://127.0.0.1:${bridge.info.port}/mcp/` : null;

  async function call(job, dir, purpose, n, promptText) {
    const tag = `${purpose}-${n}`;
    const promptFile = join(dir, `${tag}.prompt.md`); writeFileSync(promptFile, promptText);
    const lastFile = join(dir, `${tag}.last.json`); rmSync(lastFile, { force: true });
    for (let rl = 0; ; rl++) {
      if (spent >= budgetUsd) { budgetHit = true; return { ok: false, budget: true, errors: ["budget exhausted"] }; }
      await gate.acquire();
      const started = Date.now(), activeAtStart = gate.active;
      let rec;
      try {
        rec = await runCodex({ bin: CODEX, promptFile, eventsFile: join(dir, `${tag}.events.jsonl`), lastFile, timeoutMs, model: MODEL, effort: EFFORT,
          instructionsFile: job.instructions, schemaFile: job.schemaFile, mcpUrl: mcpBase ? mcpBase + `${slug(job.unit.id)}.${tag}` : null });
      } finally { gate.release(); }
      const cost = priceOf(pricing, MODEL, rec.usage) ?? 0; spent += cost;
      appendFileSync(callsLog, JSON.stringify({ unit_id: job.unit.id, kind: job.unit.kind, purpose, attempt: n, rate_limit_round: rl, started_at: new Date(started).toISOString(),
        duration_ms: rec.duration_ms, active_at_start: activeAtStart, ok: rec.ok, rate_limited: rec.rate_limited, timed_out: rec.timed_out, usage: rec.usage, cost_usd: cost,
        tool_calls: rec.tool_calls, tool_failures: rec.tool_failures, errors: rec.errors }) + "\n");
      if (rec.rate_limited && !rec.ok) { gate.rateLimited(); if (rl < 12) continue; }
      if (rec.ok) gate.succeeded();
      return { ...rec, cost };
    }
  }

  async function runUnit(job) {
    const dir = join(outDir, "calls", slug(job.unit.id)); mkdirSync(dir, { recursive: true });
    const resultFile = join(dir, "result.json");
    const prev = loadJson(resultFile);
    if (prev && prev.prompt_sha256 === job.promptSha && prev.status !== "error" && !flag("force")) return prev;
    const attempts = [];
    let checked = null, parsed = null;
    for (let n = 1; n <= 3 && !checked; n++) {
      const rec = await call(job, dir, "judge", n, job.prompt);
      attempts.push({ purpose: "judge", n, ok: rec.ok, duration_ms: rec.duration_ms, usage: rec.usage, cost_usd: rec.cost, tool_calls: rec.tool_calls, errors: rec.errors });
      if (rec.budget) break;
      if (!rec.ok) continue;
      parsed = parseResponse(rec.final);
      if (!parsed.ok) { attempts[attempts.length - 1].errors = [parsed.error]; continue; }
      const schemaErrors = validate(JSON.parse(readFileSync(job.schemaFile, "utf8")), parsed.data);
      if (schemaErrors.length) { attempts[attempts.length - 1].errors = ["schema: " + schemaErrors.slice(0, 3).join("; ")]; parsed = null; continue; }
      checked = checkJudgements(cat, job.unit.kind, ctx.src, parsed.data);
    }
    const judgements = [];
    if (checked) {
      let bad = Object.entries(checked).filter(([, v]) => v.problems.length);
      let reasked = new Set();
      if (bad.length && cat.procedure.reask_invalid_evidence > 0) {
        const ids = bad.map(([id]) => id);
        const why = bad.map(([id, v]) => `- ${id}: ${v.problems.join("; ")}`).join("\n");
        const reaskText = job.prompt + `\n\n# Re-check (your previous answer was rejected by the mechanical evidence check)\n${why}\n\nAnswer again ONLY for these rule ids: ${ids.join(", ")}. A fail needs evidence whose quote is copied verbatim from the cited numbered lines of an existing file. Return the same JSON shape with judgements only for these rules.`;
        const rec = await call(job, dir, "reask", 1, reaskText);
        attempts.push({ purpose: "reask", n: 1, ok: rec.ok, duration_ms: rec.duration_ms, usage: rec.usage, cost_usd: rec.cost, tool_calls: rec.tool_calls, errors: rec.errors, rules: ids });
        if (rec.ok) {
          const p2 = parseResponse(rec.final);
          if (p2.ok) {
            const c2 = checkJudgements(cat, job.unit.kind, ctx.src, { judgements: p2.data.judgements.filter((j) => ids.includes(j.rule_id)) });
            for (const id of ids) if (c2[id]?.judgement && !c2[id].problems.length) { checked[id] = c2[id]; }
          }
        }
        reasked = new Set(ids);
      }
      for (const [rule_id, v] of Object.entries(checked)) {
        const status = v.problems.length ? (v.judgement ? "unverified" : "missing") : "verified";
        judgements.push({ unit_id: job.unit.id, kind: job.unit.kind, rule_id, verdict: v.judgement?.verdict ?? null, reason: v.judgement?.reason ?? null,
          evidence: v.judgement?.evidence ?? [], status, reasked: reasked.has(rule_id), problems: v.problems });
      }
    }
    const res = { unit_id: job.unit.id, kind: job.unit.kind, file: job.unit.file, selected_by: job.unit.selected_by, prompt_sha256: job.promptSha, prompt_chars: job.prompt.length,
      prefix_chars: job.prefixChars, model: MODEL, effort: EFFORT, status: checked ? "done" : budgetHit ? "skipped_budget" : "error", attempts, judgements };
    writeJson(resultFile, res);
    return res;
  }

  log(`judging ${jobs.length} units (concurrency ${conc}, budget $${budgetUsd}, model ${MODEL}/${EFFORT})`);
  let done = 0;
  const results = await Promise.all(jobs.map((j) => runUnit(j).then((r) => { done++; if (done % 10 === 0 || done === jobs.length) log(`${done}/${jobs.length} units`); return r; })));
  if (bridge) bridge.child.kill("SIGTERM");
  const wall = (Date.now() - t0) / 1000;
  writeFileSync(join(outDir, "judgements.jsonl"), results.flatMap((r) => r.judgements).map((j) => JSON.stringify(j)).join("\n") + "\n");
  // run statistics (this invocation's calls only)
  const calls = existsSync(callsLog) ? readFileSync(callsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => Date.parse(c.started_at) >= t0) : [];
  const run = { started_at: new Date(t0).toISOString(), wall_secs: wall, lsp: bridge?.info ?? null, concurrency_max: conc, concurrency_peak: gate.peak, rate_limit_backoffs: gate.backoffs,
    calls: calls.length, latency_ms_p50: pct(calls.map((c) => c.duration_ms), 50), latency_ms_p95: pct(calls.map((c) => c.duration_ms), 95), budget_usd: budgetUsd, budget_exhausted: budgetHit,
    units: results.length, units_done: results.filter((r) => r.status === "done").length, units_error: results.filter((r) => r.status === "error").map((r) => r.unit_id),
    units_skipped_budget: results.filter((r) => r.status === "skipped_budget").length };
  writeJson(join(outDir, "judge-run.json"), run);
  log(`judging finished in ${wall.toFixed(0)}s: ${run.units_done}/${run.units} units, ${calls.length} calls, peak concurrency ${gate.peak}, backoffs ${gate.backoffs}`);
  return run;
}

function usageOf(outDir) {
  const f = join(outDir, "calls.jsonl");
  const calls = existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const u = { calls: calls.length, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, cost_usd: 0 };
  for (const c of calls) { for (const k of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]) u[k] += c.usage?.[k] || 0; u.cost_usd += c.cost_usd || 0; }
  u.cached_share = u.input_tokens ? Math.round((u.cached_input_tokens / u.input_tokens) * 1000) / 1000 : null;
  u.cost_usd = Math.round(u.cost_usd * 10000) / 10000;
  u.by_purpose = calls.reduce((o, c) => ((o[c.purpose] = (o[c.purpose] || 0) + 1), o), {});
  u.rate_limited_calls = calls.filter((c) => c.rate_limited).length;
  u.tool_calls = calls.reduce((s, c) => s + (c.tool_calls || 0), 0);
  const d = calls.map((c) => c.duration_ms);
  u.latency_ms = { p50: pct(d, 50), p95: pct(d, 95), max: d.length ? Math.max(...d) : null };
  return u;
}

function readJudgements(outDir) {
  const dir = join(outDir, "calls");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((d) => loadJson(join(dir, d, "result.json"))?.judgements ?? []);
}

function score() {
  const outDir = opt("out");
  const ctx = context();
  const tools = loadJson(opt("tools")), perf = loadJson(opt("perf")), meta = loadJson(opt("meta"));
  const judgements = readJudgements(outDir);
  const staticRes = runStaticChecks(cat, { inv: ctx.inv, schema: ctx.schema, tools, perf });
  writeJson(join(outDir, "static.json"), { catalogue: cat.catalogue.version, rules: staticRes });
  const aiStats = aiRuleStats(cat, judgements);
  const scores = scoreAll(cat, aiStats, staticRes);
  const units = loadJson(join(outDir, "units.json"));
  const run = loadJson(join(outDir, "judge-run.json"));
  const extract = loadJson(join(opt("extract"), "extract.json"));
  const usage = usageOf(outDir);
  const ver = { pass: 0, fail: 0, na: 0 };
  for (const j of judgements) if (j.status === "verified") ver[j.verdict]++;
  const ev = judgements.flatMap((j) => j.evidence || []);
  const summary = {
    schema: "oneshotshop-codequality/1",
    run: meta?.branch ?? null, commit: extract?.commit ?? null, generated_at: new Date().toISOString(),
    status: run && run.units_done === run.units && !run.budget_exhausted ? "complete" : "incomplete",
    catalogue: (() => { const env = readFileSync(join(CQ_DIR, "config", "versions.env"), "utf8"); const av = /CQ_CATALOGUE_VERSION="([^"]+)"/.exec(env)?.[1] ?? null, ah = /CQ_CATALOGUE_SHA256="([0-9a-f]+)"/.exec(env)?.[1] ?? null;
      return { id: cat.catalogue.id, version: cat.catalogue.version, sha256: cat.hash, approved_version: av, approved_sha256: ah, matches_approved: av === cat.catalogue.version && ah === cat.hash,
        rules: cat.rules.length, ai_rules: cat.aiRules.length, static_rules: cat.staticRules.length }; })(),
    model: { name: MODEL, reasoning_effort: EFFORT, codex_cli: (() => { try { return execFileSync(CODEX, ["--version"], { encoding: "utf8" }).trim(); } catch { return null; } })(), votes_per_judgement: cat.procedure.votes_per_judgement },
    lsp: run?.lsp ? { server: `intelephense ${run.lsp.intelephense}`, transport: "shared MCP over HTTP (lib/lsp-bridge.mjs)", index_secs: run.lsp.index_secs } : null,
    scores,
    rules: [...aiStats.map((r) => ({ ...r, decided_by: "ai", score: r.score === null ? null : Math.round(r.score * 1000) / 1000 })),
      ...staticRes.map((r) => ({ rule_id: r.rule_id, category: r.category, weight: r.weight, decided_by: "static", check: r.check, status: r.status, value: r.value ?? null, score: r.score, note: r.note ?? null }))],
    units: { inventory: ctx.inv.classes.reduce((o, c) => ((o[c.kind] = (o[c.kind] || 0) + 1), o), { view: ctx.inv.views.length, test: ctx.inv.tests.length, routes: ctx.inv.routes.length }),
      sampled: units?.by_kind ?? null, sampled_total: units?.count ?? 0 },
    judgements: { total: judgements.length, verified: judgements.filter((j) => j.status === "verified").length, unverified: judgements.filter((j) => j.status === "unverified").length,
      missing: judgements.filter((j) => j.status === "missing").length, reasked: judgements.filter((j) => j.reasked).length, verdicts: ver, evidence_items: ev.length },
    usage,
    pricing: { model: MODEL, usd_per_million: pricing.models[MODEL] ?? null, retrieved: pricing.retrieved, note: "API-equivalent; calls run on the owner's Codex login" },
    timing: { extract_secs: extract?.seconds ?? null, judge: run },
    static_metrics: { per_kloc: tools?.normalised?.per_kloc ?? null, basis: tools?.normalised?.basis ?? null, perf_headline: perf?.headline?.journey_server ?? null },
    files: { judgements: "codequality/judgements.jsonl", static: "codequality/static.json", units: "codequality/units.json", calls: "codequality/calls/" },
  };
  const errs = validate(JSON.parse(readFileSync(join(CQ_DIR, "schema", "summary.schema.json"), "utf8")), summary);
  if (errs.length) { log("summary.json INVALID:\n" + errs.join("\n")); process.exitCode = 1; }
  writeJson(join(outDir, "summary.json"), summary);
  log(`CQI ${scores.cqi} (AI ${scores.ai_index}, static ${scores.static_index}); ${summary.judgements.verified}/${summary.judgements.total} judgements verified; ${usage.calls} calls, ${usage.input_tokens} input tokens (${Math.round((usage.cached_share || 0) * 100)}% cached), $${usage.cost_usd}`);
}

function agreementCmd() {
  const calDir = opt("cal"); const reps = opt("reps").split(",");
  const repData = reps.map((r) => ({ name: r, judgements: readJudgements(join(calDir, r)) }));
  const res = agreement(cat, repData, cat.procedure.calibration.min_unanimity);
  res.catalogue = { version: cat.catalogue.version, sha256: cat.hash };
  res.cqi_by_rep = reps.map((r) => ({ rep: r, cqi: loadJson(join(calDir, r, "summary.json"))?.scores?.cqi ?? null, ai_index: loadJson(join(calDir, r, "summary.json"))?.scores?.ai_index ?? null }));
  res.usage_by_rep = reps.map((r) => ({ rep: r, ...usageOf(join(calDir, r)) }));
  writeJson(join(calDir, "agreement.json"), res);
  log(`agreement over ${res.repeats} repeats: ${res.items} items, unanimous ${res.overall_unanimous_share}; flagged: ${res.flagged.join(", ") || "none"}`);
}

try {
  if (cmd === "judge") await judge();
  else if (cmd === "score") score();
  else if (cmd === "agreement") agreementCmd();
  else if (cmd === "units") { const ctx = context(); const u = selectUnits(ctx); console.log(JSON.stringify({ count: u.length, units: u.map((x) => `${x.kind} ${x.selected_by} ${x.id} (${x.size} chars)`) }, null, 2)); }
  else { console.error("usage: orchestrate.mjs judge|score|agreement|units ..."); process.exit(2); }
} catch (e) { log("ERROR", e.stack || e.message); process.exit(1); }
