#!/usr/bin/env node
// Deterministic extractor: run transcripts + run branch -> stats.json. No network.
//
//   node extract.mjs --run-dir runs/<id> [--out runs/<id>/insights/stats.json]
//   node extract.mjs --transcripts <dir|file> [...] --repo <git dir> --ref <branch> [--base <ref>]
//
// See README.md for every option. Rules for duration, tokens and cost follow the
// agentic-engineers.dev CLAUDE.md so v2 numbers are comparable with v1.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import { loadPricing } from "./lib/pricing.mjs";
import { loadRun } from "./lib/transcripts.mjs";
import { durationWithIdle, categorizeCommand, commandCategories, inc, sortedCounts, oneLine, toMs, fmtDuration } from "./lib/util.mjs";
import * as G from "./lib/git.mjs";
import { Redactor } from "./lib/redact.mjs";
import { scanIntegrity } from "./lib/integrity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: extract.mjs (--run-dir DIR | --transcripts PATH...) [--repo DIR] [--ref REF] [--base REF]
  [--agent auto|codex|claude|cursor|opencode] [--pricing FILE] [--usage-csv FILE] [--model-map JSON]
  [--since ISO] [--until ISO] [--idle-gap-min 30] [--bucket-min 60] [--secrets-file FILE]... [--out FILE]`;

const args = parseArgs(process.argv.slice(2), { multi: ["transcripts", "secrets-file"] });
if (args.help || (!args["run-dir"] && !args.transcripts)) {
  console.error(USAGE);
  process.exit(args.help ? 0 : 2);
}

const runDir = args["run-dir"] ? resolve(args["run-dir"]) : null;
const meta = runDir && existsSync(join(runDir, "meta.json")) ? JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) : null;
const transcripts = (args.transcripts || [join(runDir, "transcripts")]).map((p) => resolve(p));
const repo = resolve(args.repo || (runDir ? join(runDir, "workspace") : "."));
const pricingPath = resolve(args.pricing || join(HERE, "pricing.json"));
const pricing = loadPricing(pricingPath);
const idleGapMs = Number(args["idle-gap-min"] || 30) * 60000;
const redactor = new Redactor({ secretFiles: args["secrets-file"] || [] });
const warnings = [];

// ---------------------------------------------------------------- transcripts
const t0 = Date.now();
const run = await loadRun({
  inputs: transcripts.filter((p) => existsSync(p)),
  agent: args.agent || (meta?.agent ? String(meta.agent) : "auto"),
  events: true, // full events: the integrity scan needs texts and tool outputs
  pricing,
  usageCsv: args["usage-csv"],
  modelMap: args["model-map"] ? JSON.parse(args["model-map"]) : {},
  window: meta?.first_session_start ? { start: toMs(meta.first_session_start), end: toMs(meta.finished_at) } : undefined,
  since: args.since ? toMs(args.since) : undefined,
  until: args.until ? toMs(args.until) : undefined,
});
if (run.error) warnings.push(run.error);

// ---------------------------------------------------------------- shell + tools
const shell = { total: 0, byCategory: {}, touches: {}, gitCommitCommands: 0, failed: 0, retriedAfterFailure: 0, unknownExit: 0 };
const failing = {};
const testRuns = { total: 0, passed: 0, failed: 0, unknown: 0, firstAt: null, lastAt: null, lastStatus: null, summaries: [] };
const mcp = {};
let playwrightMcp = 0;
let lastFailedCmd = null;
for (const e of run.events || []) {
  if (e.kind !== "tool") continue;
  const names = e.inner?.length ? e.inner : [e.name];
  for (const n of names) {
    const m = String(n).match(/^mcp__?([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?)__/);
    if (m) inc(mcp, m[1]);
    if (/playwright/i.test(n)) playwrightMcp++;
  }
  const cmds = e.commands || [];
  for (const c of cmds) {
    shell.total++;
    const cat = categorizeCommand(c);
    inc(shell.byCategory, cat);
    for (const k of commandCategories(c)) inc(shell.touches, k);
    if (/(^|[\s;&|(])git\s+commit\b/.test(c)) shell.gitCommitCommands++;
    const norm = oneLine(redactor.redact(c)).slice(0, 120); // redact before clipping
    if (e.isError === true) {
      shell.failed++;
      inc(failing, norm);
      lastFailedCmd = norm;
    } else if (e.isError == null) shell.unknownExit++;
    else if (lastFailedCmd && norm === lastFailedCmd) {
      shell.retriedAfterFailure++;
      lastFailedCmd = null;
    }
    if (cat === "tests" || cat === "playwright") {
      testRuns.total++;
      const sum = e.testSummary || "";
      const st = e.isError === true || /\bfail(ed|ures?)\b/i.test(sum) ? "failed" : e.isError === false || /\bpassed\b|^OK \(/.test(sum) ? "passed" : "unknown";
      if (sum) testRuns.summaries.push({ at: e.ts ? new Date(e.ts).toISOString() : null, agent: e.agent, summary: sum });
      testRuns[st]++;
      if (e.ts) {
        testRuns.firstAt ||= new Date(e.ts).toISOString();
        testRuns.lastAt = new Date(e.ts).toISOString();
      }
      testRuns.lastStatus = st;
    }
  }
}
shell.byCategory = Object.fromEntries(["composer", "npm", "artisan", "tests", "git", "playwright", "other"].map((k) => [k, shell.byCategory[k] || 0]));
shell.topFailing = sortedCounts(failing).slice(0, 15);
if (testRuns.summaries.length > 40) testRuns.summaries = [...testRuns.summaries.slice(0, 10), { note: `${testRuns.summaries.length - 30} omitted` }, ...testRuns.summaries.slice(-20)];

// ---------------------------------------------------------------- duration
const duration = durationWithIdle(run.timestamps || [], idleGapMs);
const harness = meta
  ? {
      created_at: meta.created_at ?? null,
      first_session_start: meta.first_session_start ?? null,
      last_session_end: meta.last_session_end ?? null,
      finished_at: meta.finished_at ?? null,
      wall_time: meta.wall_time ?? null,
      sessions: meta.sessions ?? null,
      timed_out: meta.timed_out ?? null,
      exit_code: meta.exit_code ?? null,
    }
  : null;

// agent stdout (Claude stream-json / Codex --json) self-reported numbers, for cross-checks only
let agentReported = null;
if (runDir && existsSync(join(runDir, "agent.jsonl"))) {
  const r = { claudeResult: null, codexTurnUsage: null };
  const cu = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, turns: 0 };
  for (const line of readFileSync(join(runDir, "agent.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "result") r.claudeResult = { total_cost_usd: o.total_cost_usd, num_turns: o.num_turns, duration_ms: o.duration_ms, duration_api_ms: o.duration_api_ms, is_error: o.is_error, subtype: o.subtype, usage: o.usage, modelUsage: o.modelUsage };
    if (o.type === "turn.completed" && o.usage) {
      cu.turns++;
      for (const k of ["input_tokens", "cached_input_tokens", "output_tokens"]) cu[k] += o.usage[k] || 0;
    }
  }
  if (cu.turns) r.codexTurnUsage = cu;
  agentReported = r;
}

// ---------------------------------------------------------------- git
let gitStats = null;
if (existsSync(repo) && G.resolveRef(repo, "HEAD")) {
  const ref = G.resolveRef(repo, args.ref || meta?.result?.head || "HEAD");
  const base = G.resolveBase(repo, ref, args.base || meta?.result?.base_commit || meta?.spec?.commit || null);
  if (!ref) warnings.push(`ref ${args.ref} not found in ${repo}`);
  else {
    const commits = G.commits(repo, ref, base);
    const tree = G.readTree(repo, ref);
    const startMs = duration ? Date.parse(duration.start) : null;
    const spanMs = commits.length ? Date.parse(commits[commits.length - 1].commitDate) - Date.parse(commits[0].commitDate) : 0;
    gitStats = {
      repo,
      ref: args.ref || meta?.result?.head || "HEAD",
      head: ref,
      base,
      baseNote: base ? null : "no base found; all history counted",
      commits: {
        count: commits.length,
        firstAt: commits[0]?.commitDate ?? null,
        lastAt: commits[commits.length - 1]?.commitDate ?? null,
        span: fmtDuration(spanMs),
        insertions: commits.reduce((s, c) => s + c.insertions, 0),
        deletions: commits.reduce((s, c) => s + c.deletions, 0),
        largest: [...commits].sort((a, b) => b.insertions - a.insertions).slice(0, 5).map((c) => ({ short: c.short, insertions: c.insertions, subject: c.subject })),
        harnessFinalCommit: commits.filter((c) => /final state \(uncommitted changes\)/.test(c.subject)).map((c) => c.short),
        list: commits,
      },
      timeline: { bucketMinutes: Number(args["bucket-min"] || 60), startsAt: startMs ? new Date(startMs).toISOString() : commits[0]?.commitDate ?? null, buckets: G.timeline(commits, startMs, Number(args["bucket-min"] || 60)) },
      loc: { note: "at head; excludes vendor/, node_modules/, public build output, storage/, lock files, binaries", excludedFiles: tree.excluded, byLanguage: G.locByLanguage(tree.files) },
      locOutsideSpecs: G.locByLanguage(tree.files.filter((f) => !/^specs\//.test(f.path))),
      tests: G.testStats(tree.files),
      schema: G.schemaStats(tree.files),
      structure: G.structure(tree.files),
      hardCaseKeywordHits: { note: "keyword pointers for the analyst, NOT evidence that a case is handled correctly", ...G.hardCaseHits(tree.files) },
    };
    try {
      gitStats.stack = G.stack(repo, ref, base);
    } catch (err) {
      warnings.push(`stack detection failed: ${err.message}`);
    }
  }
} else warnings.push(`no git repo at ${repo}; git/stack sections skipped`);

// ---------------------------------------------------------------- assemble
const stats = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generator: "oneshotshop-harness eval/insights/extract.mjs",
  runId: meta?.branch || (runDir ? runDir.split("/").pop() : null),
  inputs: { runDir, transcripts, repo, since: args.since || null, until: args.until || null, pricingFile: pricingPath, pricingTakenAt: pricing.takenAt, idleGapMinutes: idleGapMs / 60000, rawTranscriptBytes: run.rawBytes ?? null, parseSeconds: +((Date.now() - t0) / 1000).toFixed(1) },
  harnessMeta: meta ? { agent: meta.agent, agent_title: meta.agent_title, model_label: meta.model_label, agent_version: meta.agent_version, spec: meta.spec, limits: meta.limits, tools: meta.tools, mcp: meta.mcp ? { server: meta.mcp.server, available: meta.mcp.available, playwright_mcp: meta.mcp.playwright_mcp } : null, result: meta.result } : null,
  agent: { kind: run.agent, ...run.meta, modelsByRequests: run.models, otherFormatsIgnored: run.otherFormatsIgnored },
  duration: { rule: "website: wall = first..last timestamp over all transcript files; gaps > idleGapMinutes in the union timeline are idle and subtracted", transcript: duration, harness },
  activity: {
    modelRequests: run.requests,
    userTurns: run.userTurns,
    thinkingBlocks: run.thinkingBlocks ?? null,
    compactions: run.compactions ?? (run.events || []).filter((e) => e.kind === "compaction").length,
    toolCalls: { total: run.toolCalls?.total ?? 0, orchestrator: run.toolCalls?.orchestrator ?? 0, subagents: run.toolCalls?.subagents ?? 0, byName: sortedCounts(run.toolCalls?.byName || {}), innerByName: sortedCounts(run.toolCalls?.innerByName || {}) },
    shellCommands: shell,
    testRuns,
    mcpCallsByServer: mcp,
    playwrightMcpCalls: playwrightMcp,
    subagents: { count: run.subagentCount, list: run.subagents, spawns: run.spawns },
  },
  tokens: run.accounting ? { method: run.accounting.method, counterMode: run.accounting.counterMode ?? null, totals: run.accounting.totals ?? null, byModel: run.accounting.byModel, membership: run.accounting.membership, websiteRule: run.accounting.websiteRule, csv: run.accounting.rowsKept != null ? { rowsKept: run.accounting.rowsKept, rowsSkipped: run.accounting.rowsSkipped, window: run.accounting.window } : undefined } : null,
  cost: run.accounting?.cost ? { ...run.accounting.cost, pricingTakenAt: pricing.takenAt, note: "API list-price equivalent (subscription runs are not billed per token)" } : null,
  agentReported: { ...(agentReported || {}), claudeCodeCostState: run.meta?.claudeReportedCost ?? null, opencodeReportedCost: run.meta?.opencodeReportedCost ?? null },
  integrity: scanIntegrity(run.events, (s) => redactor.redact(s)),
  git: gitStats,
  files: run.files,
  warnings: [...warnings, ...(run.accounting?.notes || [])],
  redactions: null,
};
const out = redactor.deep(stats);
out.redactions = redactor.counts;

const outPath = resolve(args.out || (runDir ? join(runDir, "insights", "stats.json") : "stats.json"));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2));
const c = out.cost?.totalCost;
console.error(
  [
    `wrote ${outPath}`,
    `INTEGRITY: ${out.integrity.summary}`,
    `agent ${out.agent.kind}  models ${Object.keys(out.agent.modelsByRequests || {}).join(", ") || "-"}`,
    `duration wall ${duration?.wallFormatted ?? "-"}  active ${duration?.activeFormatted ?? "-"}  (${duration?.idleGaps.length ?? 0} idle gaps)`,
    `requests ${out.activity.modelRequests?.total ?? "-"}  tool calls ${out.activity.toolCalls.total}  shell ${shell.total}  playwright-mcp ${playwrightMcp}`,
    `cost ${c != null ? `$${c.toFixed(2)}` : "n/a"}  ${out.tokens?.counterMode ? `(codex counter: ${out.tokens.counterMode})` : ""}`,
    gitStats ? `git ${gitStats.commits.count} commits, ${gitStats.tests.testCases} tests in ${gitStats.tests.testFiles} files, ${gitStats.schema.tablesCreated} tables` : "git: -",
    ...out.warnings.map((w) => `WARN ${w}`),
  ].join("\n"),
);
