// Discover transcript files, detect the agent format and dispatch to the right adapter.
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { walk } from "./util.mjs";
import { parseCodex } from "./adapters/codex.mjs";
import { parseClaude } from "./adapters/claude.mjs";
import { parseCursor } from "./adapters/cursor.mjs";
import { parseOpencode } from "./adapters/opencode.mjs";

function firstJson(path) {
  try {
    let head;
    if (path.endsWith(".gz")) head = gunzipSync(readFileSync(path)).subarray(0, 1 << 20).toString("utf8");
    else {
      const fd = openSync(path, "r");
      const buf = Buffer.alloc(1 << 20);
      const n = readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      head = buf.subarray(0, n).toString("utf8");
    }
    for (const line of head.split("\n").slice(0, 20)) {
      if (!line.trim()) continue;
      try {
        return JSON.parse(line);
      } catch {
        /* partial line */
      }
    }
  } catch {
    /* unreadable */
  }
  return null;
}

export function classify(path) {
  if (/opencode\.db$/.test(path)) return "opencode";
  if (!/\.jsonl(\.gz)?$/.test(path)) return null;
  const o = firstJson(path);
  if (!o) return null;
  if (o.type === "session_meta" && o.payload) return "codex";
  if (/\/agent-transcripts\//.test(path) && o.role && o.message) return "cursor";
  if (/\/history\.jsonl$/.test(path)) return null;
  if ("sessionId" in o || "parentUuid" in o || "leafUuid" in o || o.type === "summary") return "claude-code";
  if (/\/\.claude\/projects\//.test(path) && ["user", "assistant", "system", "summary"].includes(o.type)) return "claude-code";
  if (o.role && o.message && Array.isArray(o.message.content)) return "cursor";
  return null;
}

export function discover(inputs) {
  const files = [];
  for (const i of inputs) {
    const st = statSync(i);
    if (st.isDirectory()) files.push(...walk(i));
    else files.push(i);
  }
  const byKind = {};
  for (const f of files) {
    const k = classify(f);
    if (!k) continue;
    (byKind[k] ||= { files: [], bytes: 0 }).files.push(f);
    byKind[k].bytes += statSync(f).size;
  }
  return byKind;
}

const AGENT_ALIASES = { claude: "claude-code", "claude-code": "claude-code", codex: "codex", cursor: "cursor", "cursor-agent": "cursor", opencode: "opencode" };

export async function loadRun({ inputs, agent, events = true, pricing, usageCsv, modelMap, window, since, until }) {
  const byKind = discover(inputs);
  let kind = agent && agent !== "auto" ? AGENT_ALIASES[agent] || null : null; // unknown agent names fall back to auto-detection
  if (!kind) kind = Object.entries(byKind).sort((a, b) => b[1].bytes - a[1].bytes)[0]?.[0];
  if (!kind || !byKind[kind]) {
    return { agent: kind || "unknown", error: `no ${kind || "supported"} transcripts found in ${inputs.join(", ")}`, discovered: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.files.length])) };
  }
  const paths = byKind[kind].files.sort();
  const ctx = { events, pricing, usageCsv, modelMap, window, since, until };
  const res = kind === "codex" ? await parseCodex(paths, ctx) : kind === "claude-code" ? await parseClaude(paths, ctx) : kind === "cursor" ? await parseCursor(paths, ctx) : await parseOpencode(paths, ctx);
  res.rawBytes = byKind[kind].bytes;
  res.otherFormatsIgnored = Object.fromEntries(Object.entries(byKind).filter(([k]) => k !== kind).map(([k, v]) => [k, v.files.length]));
  return res;
}
