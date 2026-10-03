#!/usr/bin/env node
// Transcript condenser: raw agent session logs -> chronological, redacted digest that fits
// a character budget (default 150k). The agent's own words are kept verbatim (truncated),
// every tool call becomes one line (command + exit status), failures and retries are
// highlighted, timestamps are kept. Secrets are redacted on every emitted line.
//
//   node condense.mjs --run-dir runs/<id> [--budget 150000] [--out runs/<id>/insights/digest.md]
//   node condense.mjs --transcripts <dir|file>... --out digest.md
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import { loadPricing } from "./lib/pricing.mjs";
import { loadRun } from "./lib/transcripts.mjs";
import { durationWithIdle, oneLine, errorLines, categorizeCommand, plainOutput } from "./lib/util.mjs";
import { Redactor } from "./lib/redact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2), { multi: ["transcripts", "secrets-file"] });
if (args.help || (!args["run-dir"] && !args.transcripts)) {
  console.error("usage: condense.mjs (--run-dir DIR | --transcripts PATH...) [--budget 150000] [--agent auto|codex|claude|cursor|opencode] [--secrets-file FILE]... [--out FILE]");
  process.exit(args.help ? 0 : 2);
}
const runDir = args["run-dir"] ? resolve(args["run-dir"]) : null;
const meta = runDir && existsSync(join(runDir, "meta.json")) ? JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) : null;
const inputs = (args.transcripts || [join(runDir, "transcripts")]).map((p) => resolve(p)).filter((p) => existsSync(p));
const BUDGET = Number(args.budget || 150000);
const redactor = new Redactor({ secretFiles: args["secrets-file"] || [] });

const toMs = (v) => (v ? Date.parse(v) : undefined);
const run = await loadRun({ inputs, agent: args.agent || meta?.agent || "auto", events: true, pricing: loadPricing(join(HERE, "pricing.json")), since: toMs(args.since), until: toMs(args.until) });
if (run.error) {
  console.error(run.error);
  process.exit(1);
}

// ------------------------------------------------------------------ helpers
const t0 = Math.min(...(run.timestamps || []).filter(Boolean));
const short = (p) =>
  String(p || "")
    .replace(/\/Users\/[^/]+\/(?:Herd|Workspace|Sites|Code|Projects)\/[^/]+\//g, "")
    .replace(/(^|[\s"'(=])\/workspace\//g, "$1");
const clipText = (s, n) => {
  s = String(s || "").trim();
  if (n <= 0) return "";
  return s.length <= n ? s : `${s.slice(0, n)} …[+${s.length - n} chars]`;
};
const rel = (ts) => {
  if (ts == null || !Number.isFinite(t0)) return "";
  const m = Math.floor((ts - t0) / 60000);
  return `+${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};
const hhmmss = (ts) => (ts == null ? "--:--:--" : new Date(ts).toISOString().slice(11, 19));

const ROUTINE = /^(Read|Grep|Glob|LS|NotebookRead|TodoRead|BashOutput|ToolSearch|ReadFile|ListDir|Codebase.?Search|list_agents|wait|wait_agent|view_image)$|browser_(snapshot|wait_for|console_messages|network_requests|tabs|take_screenshot|resize)/;
const ROUTINE_CMD = /^\s*(cd\s+\S+\s*&&\s*)?(sed|cat|head|tail|rg|grep|ls|find|wc|nl|pwd|tree|stat|file|which|echo|printf|git\s+(status|diff|log|show|branch|rev-parse))\b/;

function describeTool(e) {
  const name = e.name || "tool";
  const inp = e.input && typeof e.input === "object" ? e.input : {};
  // Codex exec: a JS program calling tools.*
  if (e.inner?.length || name === "exec") {
    const parts = [];
    for (const c of e.commands || []) parts.push(`$ ${oneLine(short(c))}`);
    if (e.patchFiles?.length) parts.push(`patch ${e.patchFiles.slice(0, 6).map(short).join(", ")}${e.patchFiles.length > 6 ? ` (+${e.patchFiles.length - 6})` : ""}`);
    for (const m of String(e.input || "").matchAll(/tools\.(mcp__[A-Za-z0-9_]+?)__([A-Za-z0-9_]+)\s*\(\s*(\{[^)]{0,160})?/g)) parts.push(`${m[1].replace(/^mcp__/, "")}.${m[2]} ${oneLine(m[3] || "").slice(0, 120)}`);
    for (const n of e.inner || []) if (/^(update_plan|create_goal|update_goal)$/.test(n)) parts.push(n);
    if (!parts.length) parts.push(`js: ${oneLine(String(e.input || "")).slice(0, 140)}`);
    return parts.join(" ; ");
  }
  if (e.commands?.length) return `$ ${oneLine(short(e.commands[0]))}`;
  if (/apply_patch/.test(name)) return `apply_patch ${(e.patchFiles || []).map(short).join(", ")}`;
  if (/(^|\.)spawn_agent$|^(Agent|Task)$/.test(name)) return null; // rendered as SPAWN
  let parsed = inp;
  if (typeof e.input === "string") {
    try {
      parsed = JSON.parse(e.input);
    } catch {
      parsed = { input: e.input };
    }
  }
  const fp = parsed.file_path || parsed.path || parsed.filePath || parsed.notebook_path || parsed.target_file;
  if (fp) return `${name} ${short(fp)}${parsed.pattern ? ` /${parsed.pattern}/` : ""}`;
  if (parsed.pattern) return `${name} /${oneLine(parsed.pattern).slice(0, 80)}/ ${short(parsed.path || "")}`;
  if (parsed.url) return `${name.replace(/^mcp__playwright__/, "pw.")} ${parsed.url}`;
  if (parsed.query) return `${name} "${oneLine(parsed.query).slice(0, 100)}"`;
  const j = oneLine(JSON.stringify(parsed));
  return `${name.replace(/^mcp__playwright__/, "pw.").replace(/^mcp__/, "")} ${j === "{}" ? "" : j.slice(0, 140)}`;
}

function planText(e) {
  let p = e.input;
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      return oneLine(p).slice(0, 600);
    }
  }
  const items = p?.todos || p?.plan || [];
  if (!Array.isArray(items) || !items.length) return null;
  return items.map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]"} ${oneLine(t.content || t.step || "")}`).join(" | ");
}

function spawnText(e) {
  let p = e.input;
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      p = {};
    }
  }
  const who = p.task_name || p.name || p.description || p.agent_type || p.subagent_type || "agent";
  const brief = p.prompt || p.message || "";
  return { who, type: p.subagent_type || p.agent_type || "", model: p.model || "", brief: /^gAAAAA/.test(brief) ? "[brief encrypted in log]" : brief };
}

// ------------------------------------------------------------------ build items
const events = (run.events || []).map((e, i) => ({ ...e, i }));
events.sort((a, b) => (a.ts ?? -1) - (b.ts ?? -1) || a.i - b.i);
let firstUserSeen = false;
const failedBefore = new Map();
const items = [];
for (const e of events) {
  const sub = !/^main/.test(e.agent || "main");
  const base = { ts: e.ts, agent: e.agent || "main", sub, approx: !!e.tsUnreliable };
  const aux = /^aux:/.test(e.agent || "");
  if (aux && e.kind !== "assistant" && e.kind !== "error") continue; // approval-review sessions: keep only their verdicts
  if (e.kind === "user") {
    const first = !firstUserSeen && !sub;
    if (!sub) firstUserSeen = true;
    if (sub && /^(# AGENTS\.md|<)/.test(e.text.trim())) continue;
    items.push({ ...base, type: first ? "mission" : "user", key: true, text: e.text });
  } else if (e.kind === "assistant") {
    // approval reviews: only non-"allow" outcomes are interesting
    if (aux && /"outcome"\s*:\s*"allow"/.test(e.text)) continue;
    items.push({ ...base, type: aux ? "verdict" : "say", key: aux, text: e.text });
  }
  else if (e.kind === "reasoning") items.push({ ...base, type: "think", text: e.text });
  else if (e.kind === "agent_message") {
    const txt = String(e.text || "").replace(/^Message Type:.*\n?/m, "").replace(/^(Task name|Sender):.*\n?/gm, "").replace(/^Payload:\s*/m, "");
    if (!txt.trim()) continue; // encrypted inter-agent payload: no readable content
    items.push({ ...base, type: "msg", text: `${e.from || "?"} -> ${e.to || "?"}: ${txt.trim()}` });
  } else if (e.kind === "compaction") items.push({ ...base, type: "compaction", key: true, text: e.text });
  else if (e.kind === "error") items.push({ ...base, type: "error", key: true, text: e.text });
  else if (e.kind === "tool") {
    if (/(^|\.)spawn_agent$|^(Agent|Task)$/.test(e.name)) {
      const s = spawnText(e);
      items.push({ ...base, type: "spawn", key: true, text: `${s.who}${s.type ? ` [${s.type}]` : ""}${s.model ? ` (${s.model})` : ""}: ${s.brief}` });
      continue;
    }
    if (/^(TodoWrite|update_plan|TaskCreate|TaskUpdate)$/.test(e.name) || e.inner?.some((n) => /^(update_plan|create_goal|update_goal)$/.test(n))) {
      let pt = planText(e);
      const js = String(e.input || "").match(/tools\.(update_plan|create_goal|update_goal)\(\s*(\{[\s\S]*?\})\s*\)/);
      if (js) pt = `${js[1]} ${oneLine(js[2])}`;
      if (pt) {
        items.push({ ...base, type: "plan", key: true, text: pt });
        continue;
      }
    }
    const desc = describeTool(e);
    if (desc == null) continue;
    const cmds = e.commands || [];
    const norm = oneLine(cmds.join(" ; ") || desc).slice(0, 160);
    const commit = cmds.some((c) => /(^|[\s;&|(])git\s+commit\b/.test(c));
    const testish = cmds.some((c) => ["tests", "playwright"].includes(categorizeCommand(c)));
    const installish = cmds.some((c) => /\b(composer\s+(require|install|update|create-project)|npm\s+(install|i|ci)\b|artisan\s+(migrate|install|make:|db:seed))/.test(c));
    let retry = "";
    const fkey = `${base.agent}|${norm}`;
    if (failedBefore.has(fkey)) {
      const n = failedBefore.get(fkey);
      retry = e.isError === true ? ` (retry #${n}, still failing)` : e.isError === false ? ` (retry #${n}, recovered)` : ` (retry #${n})`;
    }
    if (e.isError === true) failedBefore.set(fkey, (failedBefore.get(fkey) || 0) + 1);
    else if (e.isError === false) failedBefore.delete(fkey);
    let status = e.isError === true ? `exit ${e.exit ?? "ERR"}` : e.exit != null ? `exit ${e.exit}` : e.isError === false ? "ok" : "";
    if (testish && e.output) {
      const sums = plainOutput(e.output).match(/Tests:\s+[^\n]{3,120}|\d+ (?:passed|failed)[^\n]{0,80}/g);
      if (sums) status += `${status ? " " : ""}[${oneLine(sums[sums.length - 1])}]`;
    }
    const routine = e.isError !== true && !commit && !testish && !installish && (ROUTINE.test(e.name) || (cmds.length > 0 && cmds.every((c) => ROUTINE_CMD.test(c))));
    items.push({
      ...base,
      type: "tool",
      key: commit || testish || installish || e.isError === true || !!retry,
      fail: e.isError === true,
      commit,
      routine,
      toolName: e.inner?.length ? e.inner[0] : e.name,
      text: `${desc}${status ? ` -> ${status}` : ""}${retry}`,
      errLines: e.isError === true ? errorLines(redactor.redact(e.output), 3) : [],
    });
  }
}

// Redact full texts BEFORE any truncation so a clipped secret cannot leak a fragment.
for (const it of items) it.text = redactor.redact(it.text);

// ------------------------------------------------------------------ render at a level
const LEVELS = [
  { say: 2500, think: 700, msg: 1500, user: 1500, mission: 8000, spawn: 800, plan: 1500, tool: 260, err: 3, collapse: "none", subDetail: "full" },
  { say: 1800, think: 400, msg: 900, user: 900, mission: 6000, spawn: 600, plan: 900, tool: 200, err: 3, collapse: "routine", subDetail: "full" },
  { say: 1200, think: 200, msg: 600, user: 600, mission: 5000, spawn: 450, plan: 600, tool: 170, err: 2, collapse: "ok", subDetail: "full" },
  { say: 800, think: 0, msg: 400, user: 400, mission: 4000, spawn: 350, plan: 400, tool: 150, err: 2, collapse: "ok", subDetail: "messages" },
  { say: 500, think: 0, msg: 250, user: 300, mission: 3000, spawn: 250, plan: 250, tool: 130, err: 1, collapse: "ok", subDetail: "messages" },
  { say: 300, think: 0, msg: 160, user: 200, mission: 2500, spawn: 200, plan: 160, tool: 110, err: 1, collapse: "ok", subDetail: "key" },
];

function render(L) {
  const out = []; // {line, prio}
  let day = null;
  // Collapsed runs are tracked PER AGENT (parallel agents interleave): a placeholder line
  // is reserved at the run's first call and filled in when that agent's run ends.
  const runs = new Map();
  const RUN_WINDOW_MS = 15 * 60000;
  const close = (agent) => {
    const r = runs.get(agent);
    if (!r) return;
    const names = Object.entries(r.names).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}x${c}`).join(", ");
    const span = r.last != null && r.ts != null && r.last - r.ts >= 60000 ? ` over ${Math.round((r.last - r.ts) / 60000)} min` : "";
    out[r.idx] = { line: `${r.approx ? "~" : ""}${hhmmss(r.ts)} ${rel(r.ts).padStart(6)} [${agent}] ... ${r.n} ${r.kind} call${r.n > 1 ? "s" : ""}${span} (${names})`, prio: 1 };
    runs.delete(agent);
  };
  const addToRun = (it, kind) => {
    let r = runs.get(it.agent);
    if (r && (r.kind !== kind || (it.ts != null && r.ts != null && it.ts - r.ts > RUN_WINDOW_MS))) {
      close(it.agent);
      r = null;
    }
    if (!r) {
      r = { ts: it.ts, last: it.ts, n: 0, kind, names: {}, idx: out.length, approx: it.approx };
      out.push({ line: "", prio: 1 });
      runs.set(it.agent, r);
    }
    r.n++;
    r.last = it.ts ?? r.last;
    r.names[it.toolName] = (r.names[it.toolName] || 0) + 1;
  };
  for (const it of items) {
    if (it.ts != null) {
      const d = new Date(it.ts).toISOString().slice(0, 10);
      if (d !== day) {
        for (const a of [...runs.keys()]) close(a);
        day = d;
        out.push({ line: `\n=== ${d} (UTC) ===`, prio: 9 });
      }
    }
    const pre = `${it.approx ? "~" : ""}${hhmmss(it.ts)} ${rel(it.ts).padStart(6)} [${it.agent}]`;
    if (it.sub && L.subDetail !== "full") {
      const keep = it.key || it.type === "say" || it.type === "msg";
      if (L.subDetail === "key" && !(it.key || it.type === "msg")) continue;
      if (!keep) {
        if (it.type === "tool") addToRun(it, "sub-agent tool");
        continue;
      }
    }
    if (it.type === "tool") {
      const collapsible = !it.key && (L.collapse === "ok" || (L.collapse === "routine" && it.routine));
      if (collapsible) {
        addToRun(it, L.collapse === "ok" ? "successful" : "routine");
        continue;
      }
      close(it.agent);
      const mark = it.fail ? "!! " : it.commit ? "COMMIT " : "";
      out.push({ line: `${pre} ${mark}${clipText(it.text, L.tool)}`, prio: it.fail || it.commit ? 7 : it.key ? 5 : 2 });
      for (const el of it.errLines.slice(0, L.err)) out.push({ line: `${" ".repeat(18)}!!   ${el}`, prio: 6 });
      continue;
    }
    const T = {
      mission: ["MISSION", L.mission, 10],
      user: ["USER", L.user, 6],
      say: ["SAY", L.say, it.sub ? 5 : 7],
      verdict: ["REVIEW", Math.min(L.say, 300), 3],
      think: ["THINK", L.think, 1],
      msg: ["MSG", L.msg, 4],
      spawn: ["SPAWN", L.spawn, 8],
      plan: ["PLAN", L.plan, 6],
      compaction: ["--", 200, 6],
      error: ["!! ERROR", 400, 7],
    }[it.type];
    if (!T || T[1] <= 0) continue;
    close(it.agent);
    const body = clipText(it.type === "mission" ? it.text : oneLine(it.text), T[1]);
    out.push({ line: `${pre} ${T[0]}: ${body}`, prio: T[2] });
  }
  for (const a of [...runs.keys()]) close(a);
  return out.filter((l) => l.line !== "");
}

// ------------------------------------------------------------------ header
const dur = durationWithIdle(run.timestamps || []);
const header = [
  `# Transcript digest: ${meta?.branch || (runDir ? runDir.split("/").pop() : "run")}`,
  "",
  `agent: ${run.agent}${meta?.agent_version ? ` (${meta.agent_version})` : ""} | models (requests): ${Object.entries(run.models || {}).map(([m, n]) => `${m} ${n}`).join(", ") || "n/a"}`,
  `time (UTC): ${dur?.start ?? "?"} -> ${dur?.end ?? "?"} | wall ${dur?.wallFormatted ?? "?"} | active ${dur?.activeFormatted ?? "?"} (idle gaps > 30 min removed)`,
  ...(run.files.some((f) => f.timestampsReliable === false) ? [`NOTE: ${run.files.filter((f) => f.timestampsReliable === false).map((f) => f.label).join(", ")} wrote one timestamp for all entries (paginated rollout); their lines are marked "~" and shown at the rollout's start time, in log order, not at the real time.`] : []),
  `transcript files: ${run.files.length} (${run.files.filter((f) => f.role === "main").length} main, ${run.files.filter((f) => f.role === "subagent").length} sub-agent, ${run.files.filter((f) => f.role === "aux").length} auxiliary) | raw size ${(run.rawBytes / 1e6).toFixed(1)} MB`,
  "",
  "Legend: each line = `HH:MM:SS (UTC) +H:MM since start [agent]`. MISSION/USER = prompts, SAY = the agent's own words (verbatim, truncated with …[+N chars]), THINK = reasoning summary, MSG = inter-agent message, SPAWN = sub-agent started with its brief, PLAN = plan/todo update, `$ cmd -> exit N` = shell command, `!!` = failure (error lines indented), (retry #n) = same command re-run after a failure, COMMIT = git commit, `... N calls (...)` = collapsed successful tool calls. Secrets are redacted as [REDACTED:*].",
  "",
];

// ------------------------------------------------------------------ fit to budget
let chosen = null;
let level = 0;
for (; level < LEVELS.length; level++) {
  const lines = render(LEVELS[level]).map((l) => ({ ...l, line: redactor.redact(l.line) }));
  const size = header.join("\n").length + lines.reduce((s, l) => s + l.line.length + 1, 0) + 400;
  chosen = { lines, size };
  if (args.verbose) console.error(`level ${level}: ${size} chars`);
  if (size <= BUDGET) break;
}
let dropped = 0;
if (chosen.size > BUDGET) {
  // Last resort: drop lowest-priority lines (longest first), mark gaps, and shrink the
  // target until the result (including the gap markers) fits.
  level = LEVELS.length - 1;
  const all = chosen.lines;
  const order = all.map((l, i) => i).filter((i) => all[i].prio < 9).sort((a, b) => all[a].prio - all[b].prio || all[b].line.length - all[a].line.length);
  const headLen = header.join("\n").length + 600;
  let target = BUDGET - headLen;
  for (let round = 0; round < 50; round++) {
    let size = all.reduce((s, l) => s + l.line.length + 1, 0);
    const drop = new Set();
    for (const i of order) {
      if (size <= target) break;
      drop.add(i);
      size -= all[i].line.length + 1;
    }
    const kept = [];
    let gap = 0;
    all.forEach((l, i) => {
      if (drop.has(i)) gap++;
      else {
        if (gap) kept.push({ line: `   ... ${gap} lower-priority line(s) omitted for size`, prio: 0 });
        gap = 0;
        kept.push(l);
      }
    });
    if (gap) kept.push({ line: `   ... ${gap} lower-priority line(s) omitted for size`, prio: 0 });
    const total = headLen + kept.reduce((s, l) => s + l.line.length + 1, 0);
    chosen = { lines: kept, size: total };
    dropped = drop.size;
    if (total <= BUDGET) break;
    target -= Math.max(1000, total - BUDGET);
  }
}

header.push(`Condensation level ${level}/${LEVELS.length - 1}${dropped ? ` + ${dropped} low-priority lines dropped` : ""}; budget ${BUDGET} chars.`, "", "---");
let text = redactor.redact(header.join("\n")) + "\n" + chosen.lines.map((l) => l.line).join("\n") + "\n";
text += `\n---\nredactions: ${JSON.stringify(redactor.counts)}\n`;
const outPath = resolve(args.out || (runDir ? join(runDir, "insights", "digest.md") : "digest.md"));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, text);
console.error(`wrote ${outPath}: ${text.length} chars (budget ${BUDGET}), level ${level}${dropped ? `, ${dropped} lines dropped` : ""}; raw ${(run.rawBytes / 1e6).toFixed(1)} MB -> ${(text.length / 1e3).toFixed(0)} kB (${((text.length / run.rawBytes) * 100).toFixed(2)}%); redactions ${JSON.stringify(redactor.counts)}`);
if (text.length > BUDGET) {
  console.error(`ERROR: digest exceeds budget (${text.length} > ${BUDGET})`);
  process.exit(3);
}
