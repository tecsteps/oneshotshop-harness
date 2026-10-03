// OpenCode parser (~/.local/share/opencode/opencode.db, SQLite). EXPERIMENTAL: written
// against the documented message/part JSON shape, not yet verified on a real build log.
// Uses the sqlite3 CLI (read-only, -json); no npm dependency.
import { spawnSync } from "node:child_process";
import { inc } from "../util.mjs";
import { findPrice, costFor, priceRef } from "../pricing.mjs";

function q(db, sql) {
  const r = spawnSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}

export async function parseOpencode(dbPaths, ctx) {
  const db = dbPaths[0];
  const sessions = q(db, "select id, parent_id, title, time_created from session order by time_created");
  const messages = q(db, "select id, session_id, time_created, data from message order by time_created");
  const parts = q(db, "select id, message_id, session_id, time_created, data from part order by time_created, id");
  const root = sessions.filter((s) => !s.parent_id);
  const label = new Map(sessions.map((s) => [s.id, s.parent_id ? `sub:${(s.title || s.id).slice(0, 40)}` : root.length > 1 ? `main#${root.indexOf(s) + 1}` : "main"]));
  const events = [];
  const timestamps = [];
  const byModel = new Map();
  const byName = {};
  let tools = 0;
  let mainTools = 0;
  let userTurns = 0;
  let reportedCost = 0;
  for (const m of messages) {
    const d = JSON.parse(m.data);
    timestamps.push(m.time_created);
    if (d.role === "assistant" && d.tokens) {
      const k = d.modelID || "unknown";
      if (!byModel.has(k)) byModel.set(k, { model: k, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      const g = byModel.get(k);
      g.requests++;
      g.input += d.tokens.input || 0;
      g.output += (d.tokens.output || 0) + (d.tokens.reasoning || 0);
      g.cacheRead += d.tokens.cache?.read || 0;
      g.cacheWrite += d.tokens.cache?.write || 0;
      reportedCost += d.cost || 0;
    }
    if (d.role === "user" && !sessions.find((s) => s.id === m.session_id)?.parent_id) userTurns++;
  }
  const msgRole = new Map(messages.map((m) => [m.id, JSON.parse(m.data).role]));
  for (const p of parts) {
    const d = JSON.parse(p.data);
    const ts = p.time_created;
    const agent = label.get(p.session_id) || "main";
    if (d.type === "text" && d.text?.trim()) events.push({ ts, agent, kind: msgRole.get(p.message_id) === "user" ? "user" : "assistant", text: d.text });
    else if (d.type === "reasoning" && d.text?.trim()) events.push({ ts, agent, kind: "reasoning", text: d.text });
    else if (d.type === "tool") {
      tools++;
      if (agent.startsWith("main")) mainTools++;
      inc(byName, d.tool);
      const st = d.state || {};
      const exit = st.metadata?.exit ?? null;
      events.push({ ts, agent, kind: "tool", name: d.tool, input: st.input || {}, commands: st.input?.command ? [st.input.command] : [], exit, isError: st.status === "error" ? true : exit != null ? exit !== 0 : null, output: typeof st.output === "string" ? st.output.slice(0, 6000) : null });
    }
  }
  let total = 0;
  const models = [...byModel.values()].map((g) => {
    const price = findPrice(ctx.pricing, g.model);
    const cost = costFor(price, { uncachedInput: g.input, cachedInput: g.cacheRead, cacheWrite: g.cacheWrite, output: g.output });
    if (cost) total += cost.totalCost;
    return { model: g.model, requests: g.requests, inputTokens: g.input, cacheReadTokens: g.cacheRead, cacheWriteTokens: g.cacheWrite, outputTokens: g.output, price: priceRef(price), cost };
  });
  return {
    agent: "opencode",
    files: [{ file: "opencode.db", path: db, role: "main", sessions: sessions.length }],
    events,
    timestamps,
    meta: { opencodeReportedCost: reportedCost },
    models: Object.fromEntries(models.map((m) => [m.model, m.requests])),
    requests: { total: models.reduce((s, m) => s + m.requests, 0) },
    userTurns,
    accounting: { method: "opencode (experimental): per-message tokens from opencode.db, priced per model", byModel: models, cost: models.some((m) => m.cost) ? { totalCost: +total.toFixed(4), currency: "USD", partial: models.some((m) => !m.cost) } : null, notes: ["OpenCode adapter is experimental and unverified on a real build."] },
    toolCalls: { total: tools, orchestrator: mainTools, subagents: tools - mainTools, byName, innerByName: byName },
    subagents: sessions.filter((s) => s.parent_id).map((s) => ({ label: label.get(s.id), title: s.title })),
    subagentCount: { spawned: sessions.filter((s) => s.parent_id).length },
  };
}
