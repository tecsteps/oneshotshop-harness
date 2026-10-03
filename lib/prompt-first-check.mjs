// Fairness check run by `./oneshotshop finish`: the benchmark prompt must be the FIRST user
// message of a fresh agent session. Reads the copied transcripts (Claude Code and Codex formats;
// user-message filtering mirrors eval/insights/lib/adapters) and prints one JSON object:
//   {checked, build_sessions, prompt_first, problems[], other_sessions}
// Usage: node lib/prompt-first-check.mjs <transcripts-dir> <prompt-file>
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [dir, promptFile] = process.argv.slice(2);
const norm = (s) => String(s).replace(/\s+/g, " ").trim();
const prompt = norm(readFileSync(promptFile, "utf8"));

const files = [];
const walk = (d) => {
  let entries = [];
  try { entries = readdirSync(d); } catch { return; }
  for (const e of entries) {
    const p = join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (e !== "subagents") walk(p); }
    else if (e.endsWith(".jsonl") && e !== "history.jsonl") files.push(p);
  }
};
walk(dir);

const CLAUDE_SKIP = [/^<command-/, /^<local-command/, /^Caveat:/, /^<system-reminder>/];
// Codex-injected user-role items (same list as eval/insights/lib/adapters/codex.mjs).
const CODEX_SKIP = [/^# AGENTS\.md instructions/, /^<environment_context>/, /^<user_instructions>/, /^<recommended_plugins>/,
  /^<codex_internal_context/, /^<subagent_notification>/, /^<turn_aborted>/, /^<permissions instructions>/, /^<skill>/,
  /^<collaboration_mode>/];

function userMessages(file) {
  const out = [];
  const codexItems = [];   // fallback when a rollout has no event_msg/user_message
  let kind = null;
  let sawUserEvent = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    // Codex rollout: event_msg/user_message is exactly what the user typed.
    if (o.type === "session_meta") kind = "codex";
    if (o.type === "event_msg" && o.payload?.type === "user_message") { kind = "codex"; sawUserEvent = true; out.push(o.payload.message ?? ""); continue; }
    if (o.type === "response_item" && o.payload?.type === "message" && o.payload.role === "user") {
      kind = "codex";
      for (const b of o.payload.content || []) {
        const t = b.text ?? "";
        if (t.trim() && !CODEX_SKIP.some((r) => r.test(t.trim()))) codexItems.push(t);
      }
      continue;
    }
    // Claude Code session.
    if (o.type === "user" && o.message && !o.isMeta && !o.isCompactSummary && !o.isSidechain) {
      kind = kind || "claude";
      const c = o.message.content;
      const texts = typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text) : [];
      for (const t of texts) if (t && t.trim() && !CLAUDE_SKIP.some((r) => r.test(t.trim()))) out.push(t);
    }
  }
  const msgs = kind === "codex" && !sawUserEvent ? codexItems : out;
  return { kind, messages: msgs.map(norm).filter(Boolean) };
}

const result = { checked: 0, build_sessions: [], prompt_first: null, problems: [], other_sessions: [] };
for (const f of files) {
  const { kind, messages } = userMessages(f);
  if (!kind || messages.length === 0) continue;
  result.checked++;
  const rel = relative(dir, f);
  const idx = messages.findIndex((m) => m.includes(prompt));
  if (idx === -1) { result.other_sessions.push({ file: rel, first_message: messages[0].slice(0, 120) }); continue; }
  result.build_sessions.push({ file: rel, prompt_index: idx, user_messages: messages.length });
  if (idx > 0) result.problems.push({ file: rel, before_prompt: messages.slice(0, idx).map((m) => m.slice(0, 120)) });
}
if (result.checked > 0) {
  if (result.build_sessions.length === 0) result.problems.push({ file: null, error: "prompt text not found as a user message in any session" });
  result.prompt_first = result.problems.length === 0;
}
console.log(JSON.stringify(result));
