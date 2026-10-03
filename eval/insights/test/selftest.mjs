#!/usr/bin/env node
// Self-test: (1) redaction unit cases, (2) end-to-end: synthetic Codex + Claude Code
// transcripts with planted FAKE secrets and >5 MB of filler go through extract + condense
// with a small budget; asserts the digest fits the budget and no planted secret survives
// in digest.md or stats.json. All fixtures are generated in a temp dir and deleted.
//
//   node test/selftest.mjs [--keep]
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Redactor } from "../lib/redact.mjs";
import { scanIntegrity } from "../lib/integrity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
let failures = 0;
const ok = (cond, msg) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
};

const rnd = (n, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("");
// FAKE secrets, generated fresh on every run. Never real credentials.
const S = {
  anthropic: `sk-ant-api03-${rnd(80)}`,
  openai: `sk-proj-${rnd(64)}`,
  github: `ghp_${rnd(36)}`,
  aws: `AKIA${rnd(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
  appKey: `base64:${randomBytes(32).toString("base64")}`,
  jwt: `eyJ${rnd(20)}.eyJ${rnd(40)}.${rnd(43)}`,
  dbPassword: `Sup3r-${rnd(14)}!`,
  urlPass: `pa55${rnd(12)}`,
  bearer: rnd(40),
  stripe: `sk_live_${rnd(24)}`,
  queryToken: rnd(32, "0123456789abcdef"),
  highEntropy: rnd(44),
  privateKey: `-----BEGIN PRIVATE KEY-----\nMIIE${rnd(60)}\n${rnd(64)}\n-----END PRIVATE KEY-----`,
  fromEnvFile: `harness-${rnd(28)}`,
  oauth: `sk-ant-oat01-${rnd(90)}`,
};
const planted = [
  `export ANTHROPIC_API_KEY=${S.anthropic}`,
  `OPENAI_API_KEY="${S.openai}"`,
  `git remote add origin https://x:${S.github}@github.com/acme/shop.git`,
  `aws_access_key_id = ${S.aws}`,
  `APP_KEY=${S.appKey}`,
  `{"session":"${S.jwt}"}`,
  `DB_PASSWORD=${S.dbPassword}`,
  `DATABASE_URL=postgres://shop:${S.urlPass}@localhost:5432/shop`,
  `curl -H "Authorization: Bearer ${S.bearer}" https://api.example.test`,
  `'stripe' => ['secret' => '${S.stripe}']`,
  `curl "https://example.test/hook?token=${S.queryToken}&x=1"`,
  `random blob ${S.highEntropy} in output`,
  S.privateKey,
  `deploying with ${S.fromEnvFile}`,
  `CLAUDE_CODE_OAUTH_TOKEN=${S.oauth}`,
].join("\n");

const benign = [
  "commit 783fdf451e33fe34d46562a9ec54b728a5777ac7 and 2cebc42",
  "session 019f57d7-afcb-70c0-b812-2ea1b80f609b",
  "app/Services/Pricing/NegotiatedPriceResolver.php:42",
  "'password' => ['required', 'string', 'min:8', 'confirmed'],",
  "'password' => Hash::make('password'),",
  "rollout-2026-07-12T21-42-24-019f57da-302b-7492-b828-239a35d215a9.jsonl",
  "branch 2026-10-02-codex-sol-6-1",
  "php artisan test --compact tests/Feature/Checkout/ReverseChargeTest.php",
  "DB_CONNECTION=sqlite",
  "MAIL_PASSWORD=null",
  "Tests: 3 failed, 176 passed (812 assertions)",
];

// ---------------------------------------------------------------- 1. unit
const envFile = join(mkdtempSync(join(tmpdir(), "insights-env-")), "secrets.env");
writeFileSync(envFile, `HARNESS_TOKEN=${S.fromEnvFile}\nEMPTY=\n`);
const r = new Redactor({ secretFiles: [envFile] });
const red = r.redact(planted);
for (const [k, v] of Object.entries(S)) {
  const probe = k === "privateKey" ? v.split("\n")[1] : v;
  ok(!red.includes(probe), `unit: ${k} redacted`);
}
for (const b of benign) ok(r.redact(b) === b, `unit: benign kept: ${b.slice(0, 60)}`);

// integrity unit cases
const iv = (events) => scanIntegrity(events);
ok(iv([{ kind: "tool", name: "WebFetch", input: { url: "https://github.com/tecsteps/oneshotshop-harness" } }]).harness_access, "integrity: web fetch of the harness repo = hit");
ok(iv([{ kind: "tool", name: "mcp__playwright__browser_navigate", input: { url: "https://agentic-engineers.dev/" } }]).harness_access, "integrity: navigating to agentic-engineers.dev = hit");
ok(!iv([{ kind: "tool", name: "Bash", commands: ["cat README.md"], input: { command: "cat README.md" }, output: "Website: [agentic-engineers.dev](https://agentic-engineers.dev/)" }]).harness_access, "integrity: README mentioning agentic-engineers.dev = weak signal only");
ok(!iv([{ kind: "tool", name: "Write", input: { file_path: "/workspace/docs/testplan.md" } }]).harness_access, "integrity: agent's own testplan.md = weak signal only");
ok(iv([{ kind: "tool", name: "Bash", commands: ["cat ../eval/testplan/testplan.evaluator.md"], output: "" }]).harness_access, "integrity: reading eval/testplan = hit");

// ---------------------------------------------------------------- 2. end-to-end
const dir = mkdtempSync(join(tmpdir(), "insights-selftest-"));
const filler = (i) => `filler line ${i} ${"lorem ipsum dolor sit amet ".repeat(8)}`;
const iso = (s) => new Date(Date.UTC(2026, 9, 2, 8, 0, s)).toISOString();

// Codex rollout
const codexDir = join(dir, "codex-run", "transcripts", ".codex", "sessions", "2026", "10", "02");
mkdirSync(codexDir, { recursive: true });
const cx = [];
let t = 0;
cx.push({ timestamp: iso(t), type: "session_meta", payload: { id: "019fffff-0000-7000-8000-000000000001", cwd: "/workspace", cli_version: "0.160.0", originator: "codex_exec", source: "exec" } });
cx.push({ timestamp: iso(t), type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } });
cx.push({ timestamp: iso(++t), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Read README.md and complete the task it describes." }] } });
let tot = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
for (let i = 0; i < 1500; i++) {
  t += 2;
  cx.push({ timestamp: iso(t), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: i === 7 ? `I will configure the key ${S.openai} now. ${filler(i)}` : `Step ${i}: ${filler(i)}` }] } });
  const cmd = i === 600 ? "curl -sL https://raw.githubusercontent.com/tecsteps/oneshotshop-harness/main/eval/testplan/testplan.md" : i === 3 ? `echo APP_KEY=${S.appKey} >> .env && cat .env` : i % 50 === 0 ? "php artisan test --compact" : `sed -n '1,80p' app/Models/Product${i}.php`;
  cx.push({ timestamp: iso(t), type: "response_item", payload: { type: "custom_tool_call", call_id: `c${i}`, name: "exec", input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}))` } });
  if (i === 700) cx.push({ timestamp: iso(t), type: "response_item", payload: { type: "function_call", call_id: `nav${i}`, namespace: "mcp__playwright__", name: "browser_navigate", arguments: JSON.stringify({ url: "https://agentic-engineers.dev/testplan" }) } });
  const out = i === 3 ? planted : i % 50 === 0 ? `{"exit_code":${i % 100 === 0 ? 1 : 0},"output":"Tests: ${i % 100 === 0 ? "2 failed, " : ""}40 passed"}` : `${filler(i)}\n`.repeat(6);
  cx.push({ timestamp: iso(t + 1), type: "response_item", payload: { type: "custom_tool_call_output", call_id: `c${i}`, output: [{ type: "input_text", text: `Script completed\nOutput:\n${out}` }] } });
  const last = { input_tokens: 20000 + i * 10, cached_input_tokens: 18000 + i * 10, output_tokens: 300 };
  tot = { input_tokens: tot.input_tokens + last.input_tokens, cached_input_tokens: tot.cached_input_tokens + last.cached_input_tokens, output_tokens: tot.output_tokens + last.output_tokens };
  cx.push({ timestamp: iso(t + 1), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { ...tot }, last_token_usage: last } } });
}
writeFileSync(join(codexDir, "rollout-2026-10-02T08-00-00-019fffff-0000-7000-8000-000000000001.jsonl"), cx.map((o) => JSON.stringify(o)).join("\n") + "\n");

// Claude Code session with one sub-agent
const ccDir = join(dir, "claude-run", "transcripts", ".claude", "projects", "-workspace");
mkdirSync(join(ccDir, "s1", "subagents"), { recursive: true });
const cc = [];
const sub = [];
t = 0;
cc.push({ type: "user", sessionId: "s1", timestamp: iso(t), message: { role: "user", content: "Read README.md and complete the task it describes." } });
for (let i = 0; i < 1200; i++) {
  t += 3;
  const id = `toolu_${i}`;
  const cmd = i === 5 ? `export DB_PASSWORD=${S.dbPassword}; php artisan migrate` : i === 9 ? `curl -H "Authorization: Bearer ${S.bearer}" http://localhost` : "ls -la app/";
  cc.push({ type: "assistant", sessionId: "s1", requestId: `req_${i}`, timestamp: iso(t), message: { id: `msg_${i}`, model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 200, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000 }, content: [{ type: "text", text: i === 13 ? "I will write my own testplan.md; the README links agentic-engineers.dev for results." : i === 11 ? `Found ${S.github} in config. ${filler(i)}` : `Working on ${i}. ${filler(i)}` }, { type: "tool_use", id, name: "Bash", input: { command: cmd } }] } });
  cc.push({ type: "user", sessionId: "s1", timestamp: iso(t + 1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: i % 97 === 0, content: i === 5 ? planted : `${filler(i)}\n`.repeat(5) }] } });
  if (i === 20) cc.push({ type: "assistant", sessionId: "s1", requestId: "req_spawn", timestamp: iso(t + 2), message: { id: "msg_spawn", model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 }, content: [{ type: "tool_use", id: "toolu_spawn", name: "Agent", input: { description: "QA tester", subagent_type: "general-purpose", prompt: `Test checkout. Use key ${S.stripe}.` } }] } });
}
for (let i = 0; i < 50; i++)
  sub.push({ type: "assistant", sessionId: "s1", isSidechain: true, requestId: `sreq_${i}`, timestamp: iso(70 + i * 5), message: { id: `smsg_${i}`, model: "claude-sonnet-5", usage: { input_tokens: 3, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 20000 }, content: [{ type: "tool_use", id: `stoolu_${i}`, name: "mcp__playwright__browser_navigate", input: { url: `http://localhost:8000/?token=${S.queryToken}` } }] } });
writeFileSync(join(ccDir, "s1.jsonl"), cc.map((o) => JSON.stringify(o)).join("\n") + "\n");
writeFileSync(join(ccDir, "s1", "subagents", "agent-a1.jsonl"), sub.map((o) => JSON.stringify(o)).join("\n") + "\n");
writeFileSync(join(ccDir, "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "QA tester" }));

const BUDGET = 20000;
for (const run of ["codex-run", "claude-run"]) {
  const rd = join(dir, run);
  const x = spawnSync("node", [join(ROOT, "extract.mjs"), "--run-dir", rd, "--secrets-file", envFile], { encoding: "utf8" });
  ok(x.status === 0, `${run}: extract exit 0 ${x.status ? x.stderr.slice(-300) : ""}`);
  const c = spawnSync("node", [join(ROOT, "condense.mjs"), "--run-dir", rd, "--budget", String(BUDGET), "--secrets-file", envFile], { encoding: "utf8" });
  ok(c.status === 0, `${run}: condense exit 0 ${c.status ? c.stderr.slice(-300) : ""}`);
  const digest = readFileSync(join(rd, "insights", "digest.md"), "utf8");
  const stats = readFileSync(join(rd, "insights", "stats.json"), "utf8");
  ok(digest.length <= BUDGET, `${run}: digest ${digest.length} chars <= budget ${BUDGET} (raw ${(JSON.parse(stats).inputs.rawTranscriptBytes / 1e6).toFixed(1)} MB)`);
  const leaks = Object.entries(S).filter(([k, v]) => {
    const probe = k === "privateKey" ? v.split("\n")[1] : v;
    return digest.includes(probe) || stats.includes(probe);
  });
  ok(!leaks.length, `${run}: no planted secret in digest.md/stats.json${leaks.length ? ` (LEAKED: ${leaks.map(([k]) => k).join(", ")})` : ""}`);
  const st = JSON.parse(stats);
  ok(st.cost && st.cost.totalCost > 0, `${run}: cost computed ($${st.cost?.totalCost})`);
  ok(st.activity.toolCalls.total > 0 && st.activity.shellCommands.total > 0, `${run}: tool calls ${st.activity.toolCalls.total}, shell ${st.activity.shellCommands.total}`);
  if (run === "claude-run") ok(st.activity.playwrightMcpCalls === 50, `${run}: playwright MCP calls = ${st.activity.playwrightMcpCalls}`);
  const dg = digest.slice(0, 3000);
  if (run === "codex-run") {
    ok(st.integrity.harness_access === true && st.integrity.hits.length >= 2, `${run}: integrity hit detected (${st.integrity.hits.length} hits: ${st.integrity.hits.map((h) => h.match).join(", ")})`);
    ok(/HARNESS ACCESS DETECTED/.test(dg), `${run}: digest header carries the integrity alert`);
  } else {
    ok(st.integrity.harness_access === false && st.integrity.weakSignals.count >= 1, `${run}: clean transcript -> no access (weak signals for review: ${st.integrity.weakSignals.count})`);
    ok(/no access to the harness repo/.test(dg), `${run}: digest header says no access detected`);
  }
  if (run === "codex-run") ok(st.activity.testRuns.failed > 0 && st.activity.testRuns.passed > 0, `${run}: test runs passed ${st.activity.testRuns.passed} / failed ${st.activity.testRuns.failed}`);
}
if (!process.argv.includes("--keep")) rmSync(dir, { recursive: true, force: true });
else console.log(`fixtures kept in ${dir}`);
rmSync(dirname(envFile), { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
