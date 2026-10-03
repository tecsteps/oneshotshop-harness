// Cursor agent-transcript parser (~/.cursor/projects/<proj>/agent-transcripts/<id>/<id>.jsonl).
// Records are {role, message:{content:[{type:"text"|"tool_use",...}]}} with NO tokens, NO
// model and NO per-record timestamps (only <timestamp> tags inside user text). Cost must
// come from Cursor's usage-events CSV (website rule "Cursor builds"): filter rows to the
// build window, skip Errored/Free rows, price each row's four buckets at its model's rate.
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { eachJsonl, toMs, inc } from "../util.mjs";
import { findPrice, costFor, priceRef } from "../pricing.mjs";

export function sniffCursor(o) {
  return o && typeof o === "object" && "role" in o && o.message && Array.isArray(o.message.content) && !("sessionId" in o);
}

async function parseFile(path) {
  const f = { path, file: basename(path), events: [], toolByName: {}, toolCalls: 0, timestamps: [], spawnCalls: 0, userPrompts: 0 };
  let lastTs = null;
  await eachJsonl(path, (o) => {
    for (const b of o.message?.content || []) {
      if (b.type === "text" && b.text?.trim()) {
        if (o.role === "user") {
          for (const m of b.text.matchAll(/<timestamp>([^<]+)<\/timestamp>/g)) {
            const t = toMs(m[1]);
            if (t != null) {
              f.timestamps.push(t);
              lastTs = t;
            }
          }
          const q = b.text.match(/<user_query>([\s\S]*?)<\/user_query>/);
          f.userPrompts++;
          f.events.push({ ts: lastTs, kind: "user", text: (q ? q[1] : b.text).trim() });
        } else f.events.push({ ts: lastTs, kind: "assistant", text: b.text });
      } else if (b.type === "tool_use") {
        f.toolCalls++;
        inc(f.toolByName, b.name);
        if (/^(Task|Agent|subagent)/i.test(b.name)) f.spawnCalls++;
        const inp = b.input || {};
        const cmd = inp.command || inp.cmd;
        f.events.push({ ts: lastTs, kind: "tool", name: b.name, input: inp, commands: cmd ? [String(cmd)] : [], exit: null, isError: null });
      }
    }
  });
  return f;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") row.push(cur), (cur = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) row.push(cur), rows.push(row);
  return rows.filter((r) => r.length > 1);
}

export function cursorCostFromCsv(csvPath, window, pricing, modelMap = {}) {
  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const head = rows.shift().map((h) => h.trim());
  const col = (n) => head.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const C = { date: col("Date"), kind: col("Kind"), model: col("Model"), cw: col("Input (w/ Cache Write)"), inp: col("Input (w/o Cache Write)"), cr: col("Cache Read"), out: col("Output Tokens"), total: col("Total Tokens") };
  const byModel = new Map();
  let kept = 0;
  let skipped = 0;
  for (const r of rows) {
    const t = toMs(r[C.date]);
    const kind = r[C.kind] || "";
    if (/errored|free/i.test(kind) || t == null || (window.start && t < window.start) || (window.end && t > window.end)) {
      skipped++;
      continue;
    }
    kept++;
    const m = r[C.model];
    if (!byModel.has(m)) byModel.set(m, { model: m, rows: 0, cw: 0, inp: 0, cr: 0, out: 0 });
    const g = byModel.get(m);
    g.rows++;
    g.cw += +r[C.cw] || 0;
    g.inp += +r[C.inp] || 0;
    g.cr += +r[C.cr] || 0;
    g.out += +r[C.out] || 0;
  }
  let total = 0;
  const models = [...byModel.values()].map((g) => {
    const price = findPrice(pricing, modelMap[g.model] || g.model);
    const cost = costFor(price, { uncachedInput: g.inp, cachedInput: g.cr, cacheWrite: g.cw, output: g.out });
    if (cost) total += cost.totalCost;
    return { model: g.model, rows: g.rows, inputTokens: g.inp, cacheWriteTokens: g.cw, cacheReadTokens: g.cr, outputTokens: g.out, price: priceRef(price), cost };
  });
  return { rowsKept: kept, rowsSkipped: skipped, byModel: models, cost: { totalCost: +total.toFixed(4), currency: "USD", partial: models.some((m) => !m.cost) } };
}

export async function parseCursor(paths, ctx) {
  const files = [];
  for (const p of paths) files.push(await parseFile(p));
  // Orchestrator = the file that spawns sub-agents (else the one with the most user prompts).
  files.sort((a, b) => b.spawnCalls - a.spawnCalls || b.userPrompts - a.userPrompts);
  const main = files[0];
  const subs = files.slice(1);
  const label = (f) => (f === main ? "main" : `sub:${f.file.slice(0, 8)}`);
  const byName = {};
  for (const f of files) for (const [k, v] of Object.entries(f.toolByName)) inc(byName, k, v);
  const notes = ["Cursor transcripts carry no token, model or per-message timestamp data; duration comes from <timestamp> tags / meta.json, cost only from a usage-events CSV (--usage-csv)."];
  let accounting = { method: "cursor: usage-events CSV filtered to the build window, priced per row model", cost: null, notes };
  if (ctx.usageCsv) {
    const ts = files.flatMap((f) => f.timestamps);
    const window = { start: ctx.window?.start ?? (ts.length ? Math.min(...ts) : null), end: ctx.window?.end ?? null };
    accounting = { ...accounting, ...cursorCostFromCsv(ctx.usageCsv, window, ctx.pricing, ctx.modelMap || {}), window: { start: window.start ? new Date(window.start).toISOString() : null, end: window.end ? new Date(window.end).toISOString() : null } };
  }
  return {
    agent: "cursor",
    files: files.map((f) => ({ file: f.file, path: f.path, role: f === main ? "main" : "subagent", label: label(f), toolCalls: f.toolCalls })),
    events: files.flatMap((f) => f.events.map((e) => ({ ...e, agent: label(f) }))),
    timestamps: files.flatMap((f) => f.timestamps),
    meta: {},
    models: {},
    requests: { total: null },
    userTurns: main?.userPrompts || 0,
    accounting,
    toolCalls: { total: files.reduce((s, f) => s + f.toolCalls, 0), orchestrator: main?.toolCalls || 0, subagents: subs.reduce((s, f) => s + f.toolCalls, 0), byName, innerByName: byName },
    subagents: subs.map((f) => ({ label: label(f), file: f.file, toolCalls: f.toolCalls })),
    subagentCount: { spawned: subs.length, active: subs.filter((f) => f.toolCalls > 0).length, orchestratorSpawns: main?.spawnCalls || 0 },
  };
}
