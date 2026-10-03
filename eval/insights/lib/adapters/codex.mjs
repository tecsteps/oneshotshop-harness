// Codex CLI rollout parser (~/.codex/sessions/**/rollout-*.jsonl).
//
// Accounting follows the agentic-engineers.dev CLAUDE.md "Codex builds" rules:
//  1. Never blindly sum token counters across files. Root sessions (source != sub-agent
//     spawn) each have their own counter and are summed. Every child rollout is put
//     through the membership check: if its cumulative (input, cached, output) triples
//     are members of the root sessions' triple series, it only snapshots the shared
//     process-wide counter (CLI 0.144.x) and is NOT summed; if 0% membership and its
//     per-step deltas match its own last_token_usage, it has an independent counter
//     (CLI >= 0.147) and IS summed. The data decides, not the version number.
//  2. input_tokens includes cached_input_tokens; uncached = input - cached.
//  3. Tier on per-request prompt size (last_token_usage.input_tokens), blend the
//     high-tier share per token class, apply to the authoritative totals.
//  5. Count custom_tool_call as tool calls too; the shell command lives in the JS
//     `exec` input as tools.exec_command({cmd:"..."}).
import { basename } from "node:path";
import { eachJsonl, toMs, parseExit, inc, testSummary } from "../util.mjs";
import { findPrice, costFor, priceRef } from "../pricing.mjs";

export async function sniffCodex(firstObj) {
  return firstObj?.type === "session_meta" && firstObj?.payload && ("cli_version" in firstObj.payload || "originator" in firstObj.payload);
}

function textOf(content) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
}

function unescapeJs(s) {
  try {
    return JSON.parse(`"${s.replace(/\n/g, "\\n")}"`);
  } catch {
    return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

/** Shell commands embedded in a Codex `exec` JS program or a function_call's arguments. */
export function commandsFromCall(name, input) {
  const out = [];
  if (typeof input !== "string") return out;
  if (name === "exec" || /tools\.exec_command/.test(input)) {
    for (const m of input.matchAll(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/g)) out.push(unescapeJs(m[1]));
    for (const m of input.matchAll(/\bcmd\s*:\s*`((?:[^`\\]|\\.)*)`/g)) out.push(m[1]);
    for (const m of input.matchAll(/\bcmd\s*:\s*'((?:[^'\\]|\\.)*)'/g)) out.push(unescapeJs(m[1].replace(/"/g, '\\"')));
    return out;
  }
  if (/^(shell|exec_command|shell_command|local_shell|container\.exec)$/.test(name)) {
    try {
      const a = JSON.parse(input);
      const c = a.cmd ?? a.command;
      if (Array.isArray(c)) out.push(c[c.length - 1]);
      else if (typeof c === "string") out.push(c);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function innerTools(name, input) {
  if (name !== "exec" || typeof input !== "string") return [];
  return [...input.matchAll(/tools\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);
}

function patchFiles(input) {
  if (typeof input !== "string") return [];
  return [...input.matchAll(/\*\*\* (Add|Update|Delete) File: ([^\n\\"`]+)/g)].map((m) => `${m[1][0]} ${m[2].trim()}`);
}

const BOILERPLATE_USER = [
  /^# AGENTS\.md instructions/,
  /^<environment_context>/,
  /^<user_instructions>/,
  /^<recommended_plugins>/,
  /^<codex_internal_context/,
  /^<subagent_notification>/,
  /^<turn_aborted>/,
  /^<permissions instructions>/,
  /^<skill>/,
  /^<collaboration_mode>/,
];

async function parseFile(path, opts) {
  const f = {
    path,
    file: basename(path),
    sessionId: null,
    parentId: null,
    source: null,
    isSpawn: false,
    nickname: null,
    agentPath: null,
    cliVersion: null,
    originator: null,
    models: {},
    effort: null,
    ownStartLine: null,
    inheritedSkipped: 0,
    timestamps: [],
    triples: [],
    inheritedTriples: [],
    firstOwn: null,
    finalUsage: null,
    lastUsages: [],
    lastUsagesRaw: [],
    usageRecords: [],
    selfConsistentSteps: 0,
    steps: 0,
    toolCalls: 0,
    toolByName: {},
    innerByName: {},
    userTurns: 0,
    events: [],
  };
  const pending = new Map();
  const runningSessions = new Map();
  let prevTotal = null;
  let curModel = null;
  const ev = (e) => {
    if (opts.events) f.events.push(e);
    return e;
  };

  // Pre-pass: where does a spawned sub-agent's own history start?
  let spawnPath = null;
  await eachJsonl(path, (o, lineNo) => {
    if (o.type === "session_meta") spawnPath = o.payload?.source?.subagent?.thread_spawn?.agent_path || null;
    else if (spawnPath && f.ownStartLine == null && o.type === "response_item" && o.payload?.type === "agent_message" && o.payload?.recipient === spawnPath) f.ownStartLine = lineNo;
  });
  if (spawnPath && f.ownStartLine == null) f.ownStartLine = null;

  await eachJsonl(path, (o, lineNo) => {
    const p = o.payload || {};
    if (o.type === "session_meta") {
      f.sessionId = p.id;
      f.parentId = p.parent_thread_id || p.forked_from_id || null;
      f.source = p.source;
      f.cliVersion = p.cli_version;
      f.originator = p.originator;
      const spawn = p.source?.subagent?.thread_spawn;
      f.isSpawn = !!spawn;
      f.isChild = typeof p.source === "object" && !!p.source?.subagent;
      f.nickname = spawn?.agent_nickname || p.agent_nickname || null;
      f.agentPath = spawn?.agent_path || p.agent_path || null;
      f.childKind = f.isSpawn ? "spawn" : p.source?.subagent ? JSON.stringify(p.source.subagent) : null;
      f.git = p.git || null;
      f.cwd = p.cwd;
      return;
    }
    // Forked sub-agents start with a verbatim copy of the parent's history; their own
    // work begins at the first agent_message addressed to them (found in a pre-pass).
    if (f.ownStartLine != null && lineNo < f.ownStartLine) {
      f.inheritedSkipped++;
      if (o.type === "turn_context") curModel = p.model || curModel;
      if (p.type === "thread_settings_applied") curModel = p.thread_settings?.model || curModel;
      // the website's literal membership check saw these copied parent triples too
      const t = p.type === "token_count" ? p.info?.total_token_usage : null;
      if (t) f.inheritedTriples.push(`${t.input_tokens}|${t.cached_input_tokens || 0}|${t.output_tokens}`);
      return;
    }
    const ts = toMs(o.timestamp);
    // optional build window (--since/--until): later chatter in the same session is not the build
    if (ts != null && ((opts.until && ts > opts.until) || (opts.since && ts < opts.since))) {
      f.outOfWindow = (f.outOfWindow || 0) + 1;
      return;
    }
    if (ts != null) f.timestamps.push(ts);

    if (o.type === "turn_context") {
      curModel = p.model || curModel;
      f.effort = p.effort || p.reasoning_effort || f.effort;
      return;
    }
    if (p.type === "thread_settings_applied") {
      curModel = p.thread_settings?.model || curModel;
      f.effort = p.thread_settings?.reasoning_effort || f.effort;
      return;
    }
    if (o.type === "compacted") {
      ev({ ts, kind: "compaction", text: "context compacted" });
      return;
    }
    if (o.type === "token_usage_record") {
      f.usageRecords.push({ model: curModel, usage: p.usage, thread: p.thread_token_usage });
      return;
    }
    if (o.type === "event_msg") {
      if (p.type === "token_count" && p.info) {
        const t = p.info.total_token_usage;
        const l = p.info.last_token_usage;
        if (l && l.input_tokens > 0) f.lastUsagesRaw.push(l); // v1 website tiering used every snapshot
        if (t) {
          const key = `${t.input_tokens}|${t.cached_input_tokens || 0}|${t.output_tokens}`;
          const changed = !prevTotal || prevTotal.key !== key;
          if (changed) {
            f.triples.push(key);
            if (!f.firstOwn && l) f.firstOwn = { total: t, last: l };
            if (l && l.input_tokens > 0) {
              f.lastUsages.push({ ...l, model: curModel });
              inc(f.models, curModel || "unknown");
              f.steps++;
              if (prevTotal && t.input_tokens - prevTotal.input === l.input_tokens) f.selfConsistentSteps++;
              if (!prevTotal && t.input_tokens === l.input_tokens) f.selfConsistentSteps++;
            }
            prevTotal = { key, input: t.input_tokens };
          }
          f.finalUsage = t;
          f.finalModel = curModel;
        }
        return;
      }
      if (p.type === "task_started") f.userTurns++;
      if (p.type === "error" || p.type === "stream_error") ev({ ts, kind: "error", text: p.message || JSON.stringify(p).slice(0, 400) });
      if (p.type === "turn_aborted") ev({ ts, kind: "error", text: `turn aborted: ${p.reason || ""}` });
      return;
    }
    if (o.type !== "response_item") return;

    if (p.type === "message") {
      const text = textOf(p.content);
      if (!text.trim()) return;
      if (p.role === "assistant") ev({ ts, kind: "assistant", text, phase: p.phase || null });
      else if (p.role === "user" && !BOILERPLATE_USER.some((re) => re.test(text.trimStart()))) ev({ ts, kind: "user", text });
      return;
    }
    if (p.type === "reasoning") {
      const s = (p.summary || []).map((x) => x.text || "").join("\n").trim();
      const c = Array.isArray(p.content) ? p.content.map((x) => x.text || "").join("\n").trim() : "";
      if (s || c) ev({ ts, kind: "reasoning", text: s || c });
      return;
    }
    if (p.type === "agent_message") {
      ev({ ts, kind: "agent_message", from: p.author, to: p.recipient, text: textOf(p.content) });
      return;
    }
    if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const ns = p.namespace && !String(p.name).startsWith(p.namespace) ? p.namespace : "";
      const name = `${ns ? (ns.endsWith("__") ? ns : `${ns}.`) : ""}${p.name || p.type}`;
      const input = p.input ?? p.arguments ?? (p.action ? JSON.stringify(p.action) : "");
      f.toolCalls++;
      inc(f.toolByName, name);
      const inner = innerTools(p.name, input);
      if (inner.length) for (const n of inner) inc(f.innerByName, n);
      else inc(f.innerByName, name);
      const e = ev({
        ts,
        kind: "tool",
        name,
        inner,
        commands: commandsFromCall(p.name, input),
        patchFiles: /apply_patch/.test(name) || inner.includes("apply_patch") ? patchFiles(input) : [],
        input: typeof input === "string" ? input : JSON.stringify(input),
        exit: null,
        isError: null,
        output: null,
      });
      if (!opts.events) {
        // commands still needed for stats even without full events
        f.events.push({ ts, kind: "tool", name, inner, commands: e.commands, exit: null, isError: null, lite: true });
      }
      const tgt = opts.events ? e : f.events[f.events.length - 1];
      if (p.name === "write_stdin") {
        const m = String(input).match(/"session_id"\s*:\s*(\d+)/);
        if (m) tgt.stdinSession = m[1];
      }
      pending.set(p.call_id, tgt);
      return;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
      const target = pending.get(p.call_id);
      if (!target) return;
      pending.delete(p.call_id);
      const out = typeof p.output === "string" ? p.output : textOf(p.output) || JSON.stringify(p.output ?? "");
      const { exit, isError } = parseExit(out);
      target.exit = exit;
      target.isError = isError;
      if (/\b(test|pest|phpunit|playwright|vitest|jest|dusk)\b/.test((target.commands || []).join(" "))) target.testSummary = testSummary(out);
      // long-running exec_command: exit code arrives later via write_stdin(session_id)
      const running = out.match(/Process running with session ID (\d+)/);
      if (running && exit == null) runningSessions.set(running[1], target);
      if (target.stdinSession && exit != null && runningSessions.has(target.stdinSession)) {
        const orig = runningSessions.get(target.stdinSession);
        orig.exit = exit;
        orig.isError = isError;
        orig.testSummary = orig.testSummary || testSummary(out);
        runningSessions.delete(target.stdinSession);
      }
      if (!target.lite) target.output = out.length > 6000 ? `${out.slice(0, 3000)}\n…\n${out.slice(-2500)}` : out;
      target.tsEnd = ts;
    }
  });
  if (!f.finalUsage && f.usageRecords.length) {
    // CLI versions that only write token_usage_record: per-response usage summed is the thread total.
    const acc = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
    for (const r of f.usageRecords) for (const k of Object.keys(acc)) acc[k] += r.usage?.[k] || 0;
    f.finalUsage = acc;
    f.lastUsages = f.usageRecords.map((r) => ({ ...r.usage, model: r.model }));
  }
  return f;
}

export async function parseCodex(paths, ctx) {
  const files = [];
  for (const p of paths) files.push(await parseFile(p, ctx));
  files.sort((a, b) => (a.timestamps[0] || 0) - (b.timestamps[0] || 0));

  const roots = files.filter((f) => !f.isChild);
  const children = files.filter((f) => f.isChild);
  const rootTriples = new Set(roots.flatMap((f) => f.triples));
  const notes = [];
  const KEYS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];

  // Own usage of a rollout = final cumulative - the counter value it started from.
  // Forked sub-agents inherit the parent's counter value at fork time (a baseline);
  // the baseline is read off the first own step: total - last_token_usage.
  for (const f of files) {
    f.baseline = Object.fromEntries(KEYS.map((k) => [k, 0]));
    if (f.firstOwn) for (const k of KEYS) f.baseline[k] = Math.max(0, (f.firstOwn.total[k] || 0) - (f.firstOwn.last[k] || 0));
    f.ownUsage = f.finalUsage ? Object.fromEntries(KEYS.map((k) => [k, (f.finalUsage[k] || 0) - f.baseline[k]])) : null;
    f.selfCons = f.steps ? f.selfConsistentSteps / f.steps : 0;
  }

  // Counter check for every child rollout (website rule 1: let the data decide).
  //  - selfConsistency: share of own steps where delta(total.input) == own last.input.
  //    A live counter shared by parallel agents cannot satisfy this.
  //  - memberShareOwn: own triples (inherited parent history excluded) found in root series.
  //  - memberShareWebsite: the literal v1 check, which also sees the parent history copied
  //    into the top of a forked child (kept to explain differences to v1 numbers).
  const membership = children.map((f) => {
    const own = f.triples;
    const lit = [...f.inheritedTriples, ...f.triples];
    const shareOwn = own.length ? own.filter((t) => rootTriples.has(t)).length / own.length : 0;
    const shareLit = lit.length ? lit.filter((t) => rootTriples.has(t)).length / lit.length : 0;
    let counter;
    if (!own.length) counter = "no-usage";
    else if (f.selfCons >= 0.8) counter = f.baseline.input_tokens > 0 ? "own-forked-baseline" : "own";
    else if (shareOwn >= 0.5) counter = "shared-live";
    else counter = "ambiguous";
    f.counter = counter;
    f.shareLit = shareLit;
    return { file: f.file, label: f.nickname || f.agentPath || f.childKind, ownTriples: own.length, inheritedTriples: f.inheritedTriples.length, memberShareOwn: +shareOwn.toFixed(4), memberShareWebsite: +shareLit.toFixed(4), selfConsistency: +f.selfCons.toFixed(4), baselineInputTokens: f.baseline.input_tokens, counter, summed: counter === "own" || counter === "own-forked-baseline" };
  });
  for (const m of membership) if (m.counter === "ambiguous" || m.counter === "shared-live") notes.push(`Child rollout ${m.file} (${m.label}) counter=${m.counter} (selfConsistency ${m.selfConsistency}, memberShareOwn ${m.memberShareOwn}); NOT summed. Check manually.`);
  for (const f of roots) if (f.steps && f.selfCons < 0.8) notes.push(`Root session ${f.file} has selfConsistency ${f.selfCons.toFixed(2)}; its counter may include other processes.`);
  const counted = [...roots, ...children.filter((f) => f.counter === "own" || f.counter === "own-forked-baseline")];
  const modes = new Set(membership.map((m) => m.counter).filter((c) => c !== "no-usage"));
  const counterMode = !children.length ? "single-process" : [...modes].sort().join("+") || "no-child-usage";

  const rootModel = (() => {
    const c = {};
    for (const f of roots) for (const [m, n] of Object.entries(f.models)) if (m !== "unknown") c[m] = (c[m] || 0) + n;
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  })();

  function account(list, useOwn, websiteMode = false) {
    const groups = new Map();
    for (const f of list) {
      const u = useOwn ? f.ownUsage : f.finalUsage;
      if (!u) continue;
      const model = websiteMode ? rootModel || "unknown" : f.finalModel || Object.keys(f.models).find((m) => m !== "unknown") || "unknown";
      if (!groups.has(model)) groups.set(model, { model, files: 0, usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, reqs: [] });
      const g = groups.get(model);
      g.files++;
      g.usage.input += u.input_tokens || 0;
      g.usage.cached += u.cached_input_tokens || 0;
      g.usage.cacheWrite += u.cache_write_input_tokens || 0;
      g.usage.output += u.output_tokens || 0;
      g.usage.reasoning += u.reasoning_output_tokens || 0;
      g.reqs.push(...(websiteMode ? f.lastUsagesRaw : f.lastUsages));
    }
    const byModel = [];
    const tot = { inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    let totalCost = 0;
    let unpriced = [];
    for (const g of groups.values()) {
      let price = findPrice(ctx.pricing, g.model);
      let priceNote = null;
      if (!price && rootModel && findPrice(ctx.pricing, rootModel)) {
        price = findPrice(ctx.pricing, rootModel);
        priceNote = `no price for '${g.model}'; priced like the orchestrator model ${rootModel} (v1 website practice for auxiliary sessions)`;
      }
      const thr = price?.tiers?.thresholdPromptTokens;
      const tier = { low: { uncachedInput: 0, cachedInput: 0, cacheWrite: 0, output: 0 }, high: { uncachedInput: 0, cachedInput: 0, cacheWrite: 0, output: 0 } };
      const sizes = [];
      for (const r of g.reqs) {
        sizes.push(r.input_tokens);
        const b = thr && r.input_tokens > thr ? tier.high : tier.low;
        b.uncachedInput += r.input_tokens - (r.cached_input_tokens || 0);
        b.cachedInput += r.cached_input_tokens || 0;
        b.cacheWrite += r.cache_write_input_tokens || 0;
        b.output += r.output_tokens || 0;
      }
      const share = (k) => (tier.low[k] + tier.high[k] ? tier.high[k] / (tier.low[k] + tier.high[k]) : 0);
      const highShare = { uncachedInput: share("uncachedInput"), cachedInput: share("cachedInput"), cacheWrite: share("cacheWrite"), output: share("output") };
      const buckets = { uncachedInput: g.usage.input - g.usage.cached, cachedInput: g.usage.cached, cacheWrite: g.usage.cacheWrite, output: g.usage.output };
      const cost = costFor(price, buckets, thr ? highShare : null);
      if (!cost) unpriced.push(g.model);
      else totalCost += cost.totalCost;
      sizes.sort((a, b) => a - b);
      byModel.push({
        model: g.model,
        files: g.files,
        requests: g.reqs.length,
        inputTokens: g.usage.input,
        cachedInputTokens: g.usage.cached,
        uncachedInputTokens: buckets.uncachedInput,
        cacheWriteInputTokens: g.usage.cacheWrite,
        outputTokens: g.usage.output,
        reasoningOutputTokens: g.usage.reasoning,
        promptSize: { median: sizes[Math.floor(sizes.length / 2)] || 0, max: sizes[sizes.length - 1] || 0, aboveTierThreshold: thr ? sizes.filter((x) => x > thr).length : 0, tierThreshold: thr || null },
        highTierShare: thr ? Object.fromEntries(Object.entries(highShare).map(([k, v]) => [k, +v.toFixed(4)])) : null,
        price: priceRef(price),
        priceNote,
        cost,
      });
      tot.inputTokens += g.usage.input;
      tot.cachedInputTokens += g.usage.cached;
      tot.uncachedInputTokens += buckets.uncachedInput;
      tot.cacheWriteInputTokens += g.usage.cacheWrite;
      tot.outputTokens += g.usage.output;
      tot.reasoningOutputTokens += g.usage.reasoning;
    }
    tot.codexDisplayedTotal = tot.uncachedInputTokens + tot.outputTokens;
    tot.cacheReadShareOfInput = tot.inputTokens ? +(tot.cachedInputTokens / tot.inputTokens).toFixed(4) : null;
    return { byModel, totals: tot, cost: byModel.some((m) => m.cost) ? { totalCost: +totalCost.toFixed(4), currency: "USD", partial: unpriced.length > 0 } : null, unpriced };
  }

  const main = account(counted, true);
  if (main.unpriced.length) notes.push(`Model(s) without a price in pricing.json: ${main.unpriced.join(", ")}. Cost is partial.`);
  for (const m of main.byModel) if (m.priceNote) notes.push(m.priceNote);
  // What the v1 website actually did: if the literal membership check flags any spawned
  // child as "shared" (>= 50%), ALL spawned children were excluded (build #15); otherwise
  // all were summed (build #18). Root and auxiliary sessions always counted at final totals.
  const spawnedKids = children.filter((f) => f.isSpawn);
  const websiteShared = spawnedKids.some((f) => f.shareLit >= 0.5);
  for (const f of files) f.websiteCountsIt = !f.isSpawn || !websiteShared;
  const websiteList = files.filter((f) => f.websiteCountsIt);
  const website = account(websiteList, false, true);
  const byModel = main.byModel;
  const tot = main.totals;
  const totalCost = main.cost?.totalCost ?? 0;
  const unpriced = main.unpriced.length > 0;
  if (Math.abs((website.cost?.totalCost ?? 0) - totalCost) > 0.01 * Math.max(1, totalCost))
    notes.push(`Cost differs from the literal v1 website rule ($${website.cost?.totalCost?.toFixed(2)} over ${websiteList.length} files): see tokens.websiteRule and README "Codex counters".`);

  // Tool calls (outer calls, website-comparable) and inner tools.
  const sum = (arr, k) => arr.reduce((s, f) => s + f[k], 0);
  const merge = (arr, k) => arr.reduce((acc, f) => {
    for (const [n, c] of Object.entries(f[k])) inc(acc, n, c);
    return acc;
  }, {});
  const spawned = children.filter((f) => f.isSpawn);

  const labelOf = (f) => (f.isChild ? (f.isSpawn ? `sub:${f.nickname || f.agentPath || f.file.slice(-13, -6)}` : `aux:${(f.childKind || "").replace(/[{}"]/g, "").slice(0, 30)}`) : roots.length > 1 ? `main#${roots.indexOf(f) + 1}` : "main");
  // "paginated" child rollouts are written with ONE timestamp for every entry (the spawn
  // time); their events cannot be placed in time. Flag them instead of pretending.
  for (const f of files) f.tsReliable = f.timestamps.length < 50 || new Set(f.timestamps).size / f.timestamps.length > 0.02;
  const events = [];
  for (const f of files) for (const e of f.events) events.push({ ...e, agent: labelOf(f), tsUnreliable: !f.tsReliable || undefined });
  const unreliable = files.filter((f) => !f.tsReliable);
  if (unreliable.length) notes.push(`${unreliable.length} rollout(s) carry a single timestamp for all entries (paginated rewrite): ${unreliable.map(labelOf).join(", ")}. Their events are not individually timed; duration uses only real timestamps.`);
  const ambiguousBaseline = files.filter((f) => f.isChild && f.baseline.input_tokens > 0 && !f.inheritedTriples.length && !(f.firstOwn && f.firstOwn.last.input_tokens === 0));
  if (ambiguousBaseline.length)
    notes.push(`Lower-bound cost: ${ambiguousBaseline.length} child rollout(s) start at a non-zero counter with no visible parent history (${ambiguousBaseline.map((f) => `${labelOf(f)} ${(f.baseline.input_tokens / 1e6).toFixed(1)}M input`).join(", ")}). If that baseline is the agent's own pruned earlier history rather than a copied parent counter, real usage is higher by up to that amount.`);

  return {
    agent: "codex",
    files: files.map((f) => ({
      file: f.file,
      path: f.path,
      role: f.isChild ? (f.isSpawn ? "subagent" : "aux") : "main",
      label: labelOf(f),
      sessionId: f.sessionId,
      parentId: f.parentId,
      cliVersion: f.cliVersion,
      start: f.timestamps.length ? new Date(Math.min(...f.timestamps)).toISOString() : null,
      end: f.timestamps.length ? new Date(Math.max(...f.timestamps)).toISOString() : null,
      timestampsReliable: f.tsReliable,
      models: f.models,
      toolCalls: f.toolCalls,
      requests: f.steps,
      inheritedEntriesSkipped: f.inheritedSkipped,
      entriesOutsideWindow: f.outOfWindow || 0,
      counter: f.isChild ? f.counter : "root",
      summedIntoTotal: counted.includes(f),
      countedByWebsiteRule: !!f.websiteCountsIt,
      selfConsistency: +f.selfCons.toFixed(4),
      baseline: f.baseline,
      ownUsage: f.ownUsage,
      finalUsage: f.finalUsage,
    })),
    events,
    timestamps: files.flatMap((f) => f.timestamps),
    meta: {
      cliVersions: [...new Set(files.map((f) => f.cliVersion).filter(Boolean))],
      originators: [...new Set(files.map((f) => f.originator).filter(Boolean))],
      reasoningEffort: [...new Set(files.map((f) => f.effort).filter(Boolean))],
      git: roots[0]?.git || null,
      cwd: roots[0]?.cwd || null,
    },
    models: merge(files, "models"),
    requests: { total: sum(counted, "steps"), allFiles: sum(files, "steps") },
    userTurns: sum(roots, "userTurns"),
    accounting: {
      method: "codex: per rollout own usage = final total_token_usage - starting counter (first own total - first own last_token_usage) = sum of that rollout's own per-request last_token_usage; summed over root sessions and every child whose counter advances only by its own requests (selfConsistency >= 0.8); copied parent history at the top of forked children is excluded; input includes cached; tier blended per request prompt size. A lower bound when a child's starting counter is ambiguous (see notes).",
      counterMode,
      membership,
      totals: tot,
      byModel,
      cost: main.cost,
      websiteRule: { description: "v1 website rule: final totals (no fork baseline) of root + auxiliary sessions; spawned children summed only if no child is >=50% member of the root triple series (literal check incl. copied parent history)", childrenTreatedAsShared: websiteShared, files: websiteList.length, totals: website.totals, cost: website.cost },
      notes,
    },
    toolCalls: {
      total: sum(files, "toolCalls"),
      orchestrator: sum(roots, "toolCalls"),
      subagents: sum(children, "toolCalls"),
      byName: merge(files, "toolByName"),
      innerByName: merge(files, "innerByName"),
    },
    subagents: spawned.map((f) => ({
      label: labelOf(f),
      nickname: f.nickname,
      agentPath: f.agentPath,
      file: f.file,
      start: f.timestamps.length ? new Date(Math.min(...f.timestamps)).toISOString() : null,
      end: f.timestamps.length ? new Date(Math.max(...f.timestamps)).toISOString() : null,
      toolCalls: f.toolCalls,
      counter: f.counter,
      ownUsage: f.ownUsage,
    })),
    subagentCount: { spawned: spawned.length, active: spawned.filter((f) => f.toolCalls > 0).length, auxSessions: children.length - spawned.length },
  };
}
