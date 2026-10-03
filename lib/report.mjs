// Builds runs/<branch>/report.json from everything the run and its evaluation produced,
// validates it against eval/report.schema.json and writes it. Exit 1 if invalid.
// Usage: node lib/report.mjs <harness-root> <branch>
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { validate } from "./schema-validate.mjs";

const [root, branch] = process.argv.slice(2);
const run = join(root, "runs", branch);
const rel = (p) => (p && existsSync(p) ? relative(root, p) : null);
const json = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const text = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

const meta = json(join(run, "meta.json"));
if (!meta) { console.error(`no meta.json in ${run}`); process.exit(1); }
const evaluation = json(join(run, "evaluate.json")) || { steps: {} };
const steps = { ...(evaluation.steps || {}) };
// This report is the running "report" step: record it as done in its own output.
if (steps.report?.status === "running") steps.report = { ...steps.report, status: "done", note: "this report" };
// Only results of steps that completed are embedded (no stale files from failed re-runs).
const done = (k) => steps[k]?.status === "done";

// Testplan pass 1: score as-is, results as-is, plus per-area counts by result value.
const tpDir = join(run, "testplan", "pass-1");
const tpScore = json(join(tpDir, "score.json"));
const tpResults = json(join(tpDir, "results.json"));
let testplan = null;
if (done("testplan") && (tpScore || tpResults)) {
  const list = Array.isArray(tpResults?.results) ? tpResults.results : [];
  const areas = new Map();
  for (const r of list) {
    const a = r.area || "?";
    const e = areas.get(a) || { area: a, total: 0, byResult: {} };
    e.total += 1;
    const k = r.result === "" || r.result == null ? "unrecorded" : String(r.result);
    e.byResult[k] = (e.byResult[k] || 0) + 1;
    areas.set(a, e);
  }
  testplan = { pass: 1, score: tpScore, perArea: [...areas.values()], results: list.length ? list : null };
}

// Human impression + screenshots (with optional captions.md: "NN-title.png: caption").
const humanDir = join(run, "human");
const impression = text(join(humanDir, "impression.md"));
const template = text(join(root, "lib", "templates", "impression.md"));
const shotsDir = join(humanDir, "screenshots");
const captions = {};
for (const line of (text(join(shotsDir, "captions.md")) || "").split("\n")) {
  const m = line.match(/^\s*[-*]?\s*`?([0-9]{2}-[a-z0-9-]+\.(?:png|jpe?g|webp))`?\s*[:—-]\s*(.+?)\s*$/i);
  if (m) captions[m[1]] = m[2];
}
const screenshots = existsSync(shotsDir)
  ? readdirSync(shotsDir).filter((f) => /^[0-9]{2}-[a-z0-9-]+\.(png|jpe?g|webp)$/.test(f)).sort()
      .map((f) => ({ file: f, path: relative(root, join(shotsDir, f)), caption: captions[f] ?? null }))
  : [];
const impressionComplete = impression !== null && template !== null && impression.trim() !== template.trim();

// Playwright MCP / Chromium: the agent's container (meta.mcp) and the evaluator's host install
// (testplan preflight), plus the pinned version from lib/versions.sh.
const pinned = (text(join(root, "lib", "versions.sh")) || "").match(/PLAYWRIGHT_MCP_VERSION="([^"]+)"/)?.[1] ?? null;
const pre = json(join(tpDir, "preflight.json"));
const playwright = {
  pinnedMcp: pinned,
  run: meta.mcp ? { playwrightMcp: meta.mcp.playwright_mcp ?? null, playwrightCore: meta.mcp.playwright_core ?? null, chromium: meta.mcp.chromium ?? null, available: meta.mcp.available ?? null } : null,
  evaluator: pre ? { playwrightMcp: pre.playwright_mcp ?? null, chromium: pre.chromium ?? null, preflightOk: (pre.ok ?? pre.pass ?? null) } : null,
};

const byStep = {};
for (const [k, s] of Object.entries(steps)) if (typeof s.cost_usd === "number") byStep[k] = s.cost_usd;

const report = {
  schemaVersion: 1,
  branch,
  generatedAt: new Date().toISOString(),
  run: {
    agent: meta.agent,
    agentTitle: meta.agent_title ?? null,
    agentVersion: meta.agent_version ?? null,
    modelLabel: meta.model_label,
    modelSlug: meta.model_slug,
    status: meta.status,
    image: meta.image,
    spec: meta.spec,
    prompt: { ...meta.prompt },
    limits: meta.limits ?? null,
    wallTime: meta.wall_time ?? null,
    sessions: Array.isArray(meta.sessions) ? meta.sessions.length : 0,
    result: meta.result ?? null,
    pushed: meta.pushed === true,
    mcp: meta.mcp ? { ...meta.mcp, list_output: undefined } : null,
    tools: meta.tools ?? null,
  },
  playwright,
  gate: done("gate") ? json(join(run, "gate.json")) : null,
  tools: done("tools") ? json(join(run, "tools", "summary.json")) : null,
  testplan,
  perf: (() => {
    const p = done("perf") ? json(join(run, "perf", "summary.json")) : null;
    return p ? { headline: p.headline ?? null, stack: p.stack ?? null } : null;
  })(),
  insights: done("insights") ? json(join(run, "insights", "insights.json")) : null,
  human: { impressionComplete, impressionMarkdown: impressionComplete ? impression : null, screenshots },
  evaluation: steps,
  costs: { evaluationUsd: Object.values(byStep).reduce((a, b) => a + b, 0), byStep },
  artifacts: {
    meta: rel(join(run, "meta.json")),
    workspace: rel(join(run, "workspace")),
    transcripts: rel(join(run, "transcripts")),
    gate: rel(join(run, "gate.json")),
    gateLogs: rel(join(run, "gate", "logs")),
    toolsSummary: rel(join(run, "tools", "summary.json")),
    toolsDir: rel(join(run, "tools")),
    testplanResults: rel(join(tpDir, "results.json")),
    testplanScore: rel(join(tpDir, "score.json")),
    testplanPreflight: rel(join(tpDir, "preflight.json")),
    perfSummary: rel(join(run, "perf", "summary.json")),
    insightsJson: rel(join(run, "insights", "insights.json")),
    insightsMarkdown: rel(join(run, "insights", "insights.md")),
    insightsStats: rel(join(run, "insights", "stats.json")),
    humanImpression: rel(join(humanDir, "impression.md")),
    screenshots: rel(shotsDir),
    evaluateLog: rel(join(run, "evaluate.log")),
  },
};

const out = JSON.parse(JSON.stringify(report)); // drops undefined fields
const errors = validate(JSON.parse(readFileSync(join(root, "eval", "report.schema.json"), "utf8")), out);
if (errors.length) { console.error("report.json is INVALID:\n" + errors.join("\n")); process.exit(1); }
writeFileSync(join(run, "report.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`report.json valid (eval/report.schema.json): ${screenshots.length} screenshots, impression ${impressionComplete ? "included" : "missing"}, testplan ${testplan ? "included" : "missing"}, insights ${out.insights ? "included" : "missing"}`);
