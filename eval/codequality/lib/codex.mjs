// One isolated, stateless, ephemeral `codex exec` call (no session reuse).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Features switched off for every judging call: the call only reads the prompt and may use the
// code-navigation MCP server. (Code mode stays on: gpt-6-luna calls MCP tools through it.)
export const DISABLED_FEATURES = ["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "image_generation", "browser_use",
  "browser_use_external", "computer_use", "view_image", "goals", "skill_search", "tool_suggest", "sleep_tool", "hooks", "in_app_browser",
  "shell_snapshot", "workspace_dependencies", "skill_mcp_dependency_install", "realtime_conversation", "memories"];

export function codexArgs({ model, effort, instructionsFile, schemaFile, lastFile, mcpUrl, toolTimeoutSecs = 30 }) {
  const a = ["exec", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral", "--json", "-s", "read-only",
    "-m", model, "-c", `model_reasoning_effort=${effort}`, "-c", "web_search=disabled",
    "-c", `model_instructions_file=${JSON.stringify(instructionsFile)}`,
    "-c", "include_environment_context=false", "-c", "include_permissions_instructions=false", "-c", "include_apps_instructions=false",
    "-c", "include_collaboration_mode_instructions=false", "-c", "project_doc_max_bytes=0",
    "--output-schema", schemaFile, "-o", lastFile];
  for (const f of DISABLED_FEATURES) a.push("--disable", f);
  if (mcpUrl) a.push("-c", `mcp_servers.code.url=${JSON.stringify(mcpUrl)}`, "-c", `mcp_servers.code.tool_timeout_sec=${toolTimeoutSecs}`,
    "-c", 'mcp_servers.code.default_tools_approval_mode="approve"', "-c", "mcp_servers.code.startup_timeout_sec=20");
  a.push("-"); // prompt from stdin
  return a;
}

const RATE = /rate.?limit|too many requests|\b429\b|usage limit|quota|try again (at|in)|capacity|overloaded/i;

// Runs one call. Never throws; resolves with a record.
export function runCodex({ bin = "codex", promptFile, eventsFile, timeoutMs, ...opts }) {
  return new Promise((resolveP) => {
    const cwd = mkdtempSync(join(tmpdir(), "oneshotshop-cq-")); // empty, call-private working directory
    const args = codexArgs(opts);
    const t0 = Date.now();
    const out = openSync(eventsFile, "w");
    const errFile = eventsFile.replace(/\.jsonl$/, "") + ".stderr.log";
    const err = openSync(errFile, "w");
    const stdin = openSync(promptFile, "r");
    const child = spawn(bin, args, { cwd, stdio: [stdin, out, err], env: { ...process.env, NO_COLOR: "1" } });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      for (const fd of [out, err, stdin]) { try { closeSync(fd); } catch {} }
      rmSync(cwd, { recursive: true, force: true });
      const rec = { exit_code: code, timed_out: timedOut, duration_ms: Date.now() - t0, usage: null, errors: [], tool_calls: 0, tool_failures: 0, thread_id: null };
      const text = existsSync(eventsFile) ? readFileSync(eventsFile, "utf8") : "";
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "thread.started") rec.thread_id = ev.thread_id;
        if (ev.type === "turn.completed" && ev.usage) {
          const u = ev.usage; rec.usage ??= { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
          for (const k of Object.keys(rec.usage)) rec.usage[k] += u[k] || 0;
        }
        if (ev.type === "error" || ev.type === "turn.failed") rec.errors.push(String(ev.message || ev.error?.message || JSON.stringify(ev)).slice(0, 500));
        if (ev.type === "item.completed" && ev.item?.type === "error") rec.errors.push(String(ev.item.message).slice(0, 300));
        if (ev.type === "item.completed" && ev.item?.type === "mcp_tool_call") { rec.tool_calls++; if (ev.item.status === "failed") rec.tool_failures++; }
      }
      const stderr = existsSync(errFile) ? readFileSync(errFile, "utf8") : "";
      rec.rate_limited = rec.errors.some((e) => RATE.test(e)) || (code !== 0 && RATE.test(stderr.slice(-4000)));
      rec.final = existsSync(opts.lastFile) ? readFileSync(opts.lastFile, "utf8") : "";
      rec.ok = code === 0 && !timedOut && !!rec.final.trim();
      if (!rec.ok && !rec.errors.length) rec.errors.push(timedOut ? `timed out after ${timeoutMs} ms` : `exit ${code}: ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
      resolveP(rec);
    });
    child.on("error", (e) => { clearTimeout(timer); resolveP({ ok: false, errors: [e.message], duration_ms: Date.now() - t0, usage: null, rate_limited: false, final: "" }); });
  });
}

export function priceOf(pricing, model, usage) {
  const p = pricing.models[model];
  if (!p || !usage) return null;
  const uncached = Math.max(0, usage.input_tokens - usage.cached_input_tokens);
  return (uncached * p.input + usage.cached_input_tokens * p.cached_input + usage.output_tokens * p.output) / 1e6;
}

export { writeFileSync };
