// Claude Code transcript parser (~/.claude/projects/<proj>/<session>.jsonl + <session>/subagents/agent-*.jsonl).
//
// Accounting follows the agentic-engineers.dev CLAUDE.md rules:
//  - Streaming chunks: same requestId appears several times; keep the chunk with the
//    highest output_tokens (input/cache fields are constant).
//  - Compaction chains: the same requestId re-appears in several sub-agent files; dedupe
//    requestIds GLOBALLY (main first, then sub-agents in start order).
//  - Price each request at its own model's rate (mixed-model sessions).
//  - Active agent count: cluster sub-agent files by requestId containment
//    (union-find, merge when |A∩B| / min(|A|,|B|) >= 0.8), drop clusters with 0 tool
//    calls; validate against the orchestrator's Agent/Task spawn count.
//  - Tool calls are counted once per unique tool_use id, so checkpoint replays do not
//    inflate them.
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { eachJsonl, toMs, parseExit, inc, testSummary } from "../util.mjs";
import { findPrice, costFor, priceRef } from "../pricing.mjs";

export function sniffClaude(o) {
  return o && typeof o === "object" && ("sessionId" in o || "parentUuid" in o) && ("type" in o);
}

function blocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function resultText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x.type === "text" ? x.text : x.type === "image" ? "[image]" : "")).join("\n");
  return c == null ? "" : JSON.stringify(c);
}

async function parseFile(path, role, opts) {
  const f = { path, file: basename(path), role, requests: new Map(), toolIds: new Set(), toolByName: {}, timestamps: [], events: [], spawns: [], thinking: 0, compactions: 0, userPrompts: 0, models: {}, version: null, sessionId: null, costState: null, meta: null };
  const metaPath = path.replace(/\.jsonl$/, ".meta.json");
  if (role === "subagent" && existsSync(metaPath)) {
    try {
      f.meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      /* ignore */
    }
  }
  const pending = new Map();
  await eachJsonl(path, (o) => {
    const ts = toMs(o.timestamp);
    if (o.sessionId && !f.sessionId) f.sessionId = o.sessionId;
    if (o.version && !f.version) f.version = o.version;
    if (o.type === "cost-state") f.costState = { totalCostUSD: o.totalCostUSD, modelUsage: o.modelUsage, totalDuration: o.totalDuration };
    if (!["user", "assistant", "system"].includes(o.type)) return;
    if (ts != null && ((opts.until && ts > opts.until) || (opts.since && ts < opts.since))) return; // --since/--until build window
    if (ts != null) f.timestamps.push(ts);
    const msg = o.message || {};
    if (o.type === "system") {
      if (o.subtype === "compact_boundary" || o.compactMetadata) {
        f.compactions++;
        f.events.push({ ts, kind: "compaction", text: "context compacted" });
      } else if (o.level === "error") f.events.push({ ts, kind: "error", text: o.content || "" });
      return;
    }
    if (o.type === "assistant") {
      if (o.isApiErrorMessage) f.events.push({ ts, kind: "error", text: resultText(msg.content) });
      const rid = o.requestId || msg.id;
      if (rid && msg.usage && msg.model !== "<synthetic>") {
        const u = msg.usage;
        const cw1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
        const cur = { model: msg.model, input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: (u.cache_creation_input_tokens || 0) - cw1h, cacheWrite1h: cw1h, cacheRead: u.cache_read_input_tokens || 0 };
        const prev = f.requests.get(rid);
        if (!prev || cur.output >= prev.output) f.requests.set(rid, cur);
      }
      for (const b of blocks(msg.content)) {
        if (b.type === "text" && b.text?.trim()) f.events.push({ ts, kind: "assistant", text: b.text, id: `${msg.id}:${b.text.length}` });
        else if (b.type === "thinking") {
          f.thinking++;
          if (b.thinking?.trim()) f.events.push({ ts, kind: "reasoning", text: b.thinking });
        } else if (b.type === "tool_use") {
          if (f.toolIds.has(b.id)) continue;
          f.toolIds.add(b.id);
          inc(f.toolByName, b.name);
          const inp = b.input || {};
          const e = { ts, kind: "tool", name: b.name, id: b.id, input: inp, commands: [], exit: null, isError: null, output: null };
          if (/^(Bash|mcp__.*execute_terminal_command|Shell)$/.test(b.name) && inp.command) e.commands = [inp.command];
          if (b.name === "Agent" || b.name === "Task") f.spawns.push({ ts, description: inp.description || "", subagentType: inp.subagent_type || "", name: inp.name || "", model: inp.model || "", prompt: inp.prompt || "" });
          f.events.push(e);
          pending.set(b.id, e);
        }
      }
      return;
    }
    // user
    if (o.isCompactSummary) {
      f.events.push({ ts, kind: "compaction", text: "compaction summary inserted" });
      return;
    }
    const c = msg.content;
    if (typeof c === "string") {
      if (!o.isMeta && c.trim()) {
        f.userPrompts++;
        f.events.push({ ts, kind: "user", text: c });
      }
      return;
    }
    for (const b of blocks(c)) {
      if (b.type === "tool_result") {
        const e = pending.get(b.tool_use_id);
        if (!e) continue;
        pending.delete(b.tool_use_id);
        const txt = resultText(b.content);
        const pe = parseExit(txt);
        e.isError = b.is_error === true ? true : pe.isError ?? (b.is_error === false ? false : null);
        e.exit = pe.exit ?? (e.isError === false && e.commands.length ? 0 : pe.exit);
        if (/\b(test|pest|phpunit|playwright|vitest|jest|dusk)\b/.test(e.commands.join(" "))) e.testSummary = testSummary(txt);
        e.output = txt.length > 6000 ? `${txt.slice(0, 3000)}\n…\n${txt.slice(-2500)}` : txt;
        e.tsEnd = ts;
      } else if (b.type === "text" && b.text?.trim() && !o.isMeta) {
        f.userPrompts++;
        f.events.push({ ts, kind: "user", text: b.text });
      }
    }
  });
  for (const r of f.requests.values()) inc(f.models, r.model || "unknown");
  if (!opts.events) f.events = f.events.filter((e) => e.kind === "tool").map((e) => ({ ts: e.ts, kind: "tool", name: e.name, id: e.id, commands: e.commands, exit: e.exit, isError: e.isError, testSummary: e.testSummary }));
  return f;
}

/** Union-find clustering of sub-agent files by requestId containment (website "Active Agent Count"). */
function clusterSubagents(subs) {
  const parent = subs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const sets = subs.map((s) => new Set(s.requests.keys()));
  for (let i = 0; i < subs.length; i++)
    for (let j = i + 1; j < subs.length; j++) {
      const a = sets[i];
      const b = sets[j];
      if (!a.size || !b.size) continue;
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      let inter = 0;
      for (const x of small) if (big.has(x)) inter++;
      if (inter / small.size >= 0.8) parent[find(i)] = find(j);
    }
  const groups = new Map();
  subs.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  });
  return [...groups.values()];
}

export async function parseClaude(paths, ctx) {
  const mains = [];
  const subs = [];
  for (const p of paths) {
    const role = /\/subagents\/[^/]+\.jsonl$/.test(p) ? "subagent" : "main";
    (role === "main" ? mains : subs).push(await parseFile(p, role, ctx));
  }
  const byStart = (a, b) => (Math.min(...a.timestamps, Infinity) - Math.min(...b.timestamps, Infinity));
  mains.sort(byStart);
  subs.sort(byStart);

  // Global requestId dedup: main first, then sub-agents in start order.
  const seen = new Map();
  for (const f of [...mains, ...subs]) {
    f.ownRequests = 0;
    for (const [rid, r] of f.requests) {
      if (seen.has(rid)) {
        const prev = seen.get(rid);
        if (r.output > prev.output) seen.set(rid, r);
        continue;
      }
      seen.set(rid, r);
      f.ownRequests++;
    }
  }
  // Price per request at its own model.
  const byModel = new Map();
  for (const r of seen.values()) {
    const m = r.model || "unknown";
    if (!byModel.has(m)) byModel.set(m, { model: m, requests: 0, input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 });
    const g = byModel.get(m);
    g.requests++;
    g.input += r.input;
    g.output += r.output;
    g.cacheWrite += r.cacheWrite;
    g.cacheWrite1h += r.cacheWrite1h || 0;
    g.cacheRead += r.cacheRead;
  }
  const notes = [];
  let total = 0;
  let unpriced = false;
  const models = [...byModel.values()].map((g) => {
    const price = findPrice(ctx.pricing, g.model);
    const cost = costFor(price, { uncachedInput: g.input, cachedInput: g.cacheRead, cacheWrite: g.cacheWrite, cacheWrite1h: g.cacheWrite1h, output: g.output });
    if (cost) total += cost.totalCost;
    else unpriced = true;
    return { model: g.model, requests: g.requests, inputTokens: g.input, cacheWriteTokens: g.cacheWrite + g.cacheWrite1h, cacheWrite1hTokens: g.cacheWrite1h, cacheReadTokens: g.cacheRead, outputTokens: g.output, price: priceRef(price), cost };
  });
  if (unpriced) notes.push(`Model(s) without a price in pricing.json: ${models.filter((m) => !m.cost).map((m) => m.model).join(", ")}. Cost covers priced models only.`);
  const t = models.reduce((a, m) => ({ input: a.input + m.inputTokens, cw: a.cw + m.cacheWriteTokens, cr: a.cr + m.cacheReadTokens, out: a.out + m.outputTokens }), { input: 0, cw: 0, cr: 0, out: 0 });

  // Sub-agent clustering.
  const clusters = clusterSubagents(subs);
  const agentClusters = clusters.map((files) => {
    const toolIds = new Set(files.flatMap((f) => [...f.toolIds]));
    const ts = files.flatMap((f) => f.timestamps);
    const meta = files.map((f) => f.meta).find(Boolean) || {};
    return {
      label: `sub:${(meta.description || files[0].file.replace(/\.jsonl$/, "")).slice(0, 60)}`,
      description: meta.description || null,
      agentType: meta.agentType || null,
      model: meta.model || Object.keys(files[0].models)[0] || null,
      files: files.map((f) => f.file),
      checkpointFiles: files.length,
      toolCalls: toolIds.size,
      start: ts.length ? new Date(Math.min(...ts)).toISOString() : null,
      end: ts.length ? new Date(Math.max(...ts)).toISOString() : null,
    };
  });
  const active = agentClusters.filter((c) => c.toolCalls > 0);
  const spawns = mains.flatMap((f) => f.spawns);
  const nestedSpawns = subs.reduce((n, f) => n + f.spawns.length, 0);
  if (subs.length && agentClusters.length !== spawns.length + nestedSpawns)
    notes.push(`Sub-agent clusters (${agentClusters.length}, ${active.length} active) differ from Agent/Task spawns (${spawns.length} by the orchestrator + ${nestedSpawns} nested). Verify before publishing an agent count.`);

  // Global tool-call dedup by tool_use id.
  const allToolIds = new Set();
  const byName = {};
  let mainTools = 0;
  for (const f of [...mains, ...subs])
    for (const e of f.events)
      if (e.kind === "tool") {
        const key = e.id || `${f.file}:${e.ts}:${e.name}`;
        if (allToolIds.has(key)) {
          e.dup = true;
          continue;
        }
        allToolIds.add(key);
        inc(byName, e.name);
        if (f.role === "main") mainTools++;
      }

  const fileLabel = new Map();
  mains.forEach((f, i) => fileLabel.set(f, mains.length > 1 ? `main#${i + 1}` : "main"));
  for (const c of agentClusters) for (const fn of c.files) fileLabel.set(subs.find((s) => s.file === fn), c.label);
  const events = [];
  const seenText = new Set();
  for (const f of [...mains, ...subs])
    for (const e of f.events) {
      if (e.dup) continue;
      if (f.role === "subagent" && e.kind !== "tool") {
        // checkpoint replays repeat earlier messages verbatim
        const k = `${fileLabel.get(f)}|${e.ts}|${e.kind}|${(e.text || "").slice(0, 80)}`;
        if (seenText.has(k)) continue;
        seenText.add(k);
      }
      events.push({ ...e, agent: fileLabel.get(f) });
    }

  const costStates = mains.map((f) => f.costState).filter(Boolean);
  return {
    agent: "claude-code",
    files: [...mains, ...subs].map((f) => ({ file: f.file, path: f.path, role: f.role, label: fileLabel.get(f), sessionId: f.sessionId, version: f.version, requests: f.requests.size, uniqueRequests: f.ownRequests, toolCalls: f.toolIds.size, models: f.models, start: f.timestamps.length ? new Date(Math.min(...f.timestamps)).toISOString() : null, end: f.timestamps.length ? new Date(Math.max(...f.timestamps)).toISOString() : null })),
    events,
    timestamps: [...mains, ...subs].flatMap((f) => f.timestamps),
    meta: { versions: [...new Set([...mains, ...subs].map((f) => f.version).filter(Boolean))], claudeReportedCost: costStates.length ? costStates.map((c) => c.totalCostUSD) : null },
    models: Object.fromEntries(models.map((m) => [m.model, m.requests])),
    requests: { total: seen.size, rawAcrossFiles: [...mains, ...subs].reduce((s, f) => s + f.requests.size, 0) },
    userTurns: mains.reduce((s, f) => s + f.userPrompts, 0),
    thinkingBlocks: [...mains, ...subs].reduce((s, f) => s + f.thinking, 0),
    compactions: [...mains, ...subs].reduce((s, f) => s + f.compactions, 0),
    accounting: {
      method: "claude-code: per-requestId max-output chunk, requestIds deduped globally (main first), each request priced at its own model",
      totals: { inputTokens: t.input, cacheWriteTokens: t.cw, cacheReadTokens: t.cr, outputTokens: t.out, cacheReadShareOfInput: t.input + t.cw + t.cr ? +(t.cr / (t.input + t.cw + t.cr)).toFixed(4) : null },
      byModel: models,
      cost: models.some((m) => m.cost) ? { totalCost: +total.toFixed(4), currency: "USD", partial: unpriced } : null,
      notes,
    },
    toolCalls: { total: allToolIds.size, orchestrator: mainTools, subagents: allToolIds.size - mainTools, byName, innerByName: byName },
    subagents: agentClusters,
    spawns: spawns.map((s) => ({ ...s, prompt: s.prompt.slice(0, 600) })),
    subagentCount: { files: subs.length, clusters: agentClusters.length, active: active.length, dead: agentClusters.length - active.length, orchestratorSpawns: spawns.length, nestedSpawns, displayedTeamTotal: active.length + 1 },
  };
}
