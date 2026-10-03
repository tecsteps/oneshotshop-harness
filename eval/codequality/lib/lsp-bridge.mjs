// ONE shared, pre-indexed PHP language server (Intelephense, pinned in package.json) per evaluated
// build, exposed to all concurrent Codex calls as a read-only MCP server over Streamable HTTP.
//
//   node lib/lsp-bridge.mjs --root <build copy> --port <p> [--state <dir>] [--log <file>] [--ready-file <f>]
//
// - Starts intelephense --stdio, waits until indexing has ended, then listens on 127.0.0.1:<port>.
// - Each Codex call gets its own URL  http://127.0.0.1:<port>/mcp/<call-id>  (same tools, so the
//   tool definitions — part of the cached prompt prefix — are identical); the call id is only used
//   to attribute tool usage in the log.
// - Read-only by construction: the tools are lookups (no rename/edit), paths are confined to <root>.
// - Concurrency: LSP requests are multiplexed by JSON-RPC id over the single stdio connection;
//   didOpen is done once per file (memoised). Node's event loop serialises all writes.
// - MCP: stateless Streamable HTTP subset (POST JSON-RPC -> application/json; GET -> 405).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CQ_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const ROOT = realpathSync(args.root || ".");
const PORT = Number(args.port || 0);
const STATE = args.state || join(CQ_DIR, ".cache", "intelephense-state");
const LOG = args.log || null;
const MAX_LINES = 160;
mkdirSync(STATE, { recursive: true });
const VERSION = JSON.parse(readFileSync(join(CQ_DIR, "node_modules", "intelephense", "package.json"), "utf8")).version;

const log = (o) => { if (LOG) appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); };

// ------------------------------------------------------------------ LSP client
const lsp = spawn(process.execPath, [join(CQ_DIR, "node_modules", "intelephense", "lib", "intelephense.js"), "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
lsp.stderr.on("data", () => {});
lsp.on("exit", (c) => { log({ event: "lsp-exit", code: c }); process.exit(3); });
let nextId = 1; const pending = new Map(); let buf = Buffer.alloc(0);
let indexing = { started: null, ended: null, files: null };
const SETTINGS = {
  files: { maxSize: 5_000_000, associations: ["*.php", "*.phtml"], exclude: ["**/.git/**", "**/node_modules/**", "**/storage/**", "**/bootstrap/cache/**", "**/public/build/**"] },
  environment: { phpVersion: "8.4.0", includePaths: [] },
  diagnostics: { enable: false },
  telemetry: { enabled: false },
  format: { enable: false },
};
const send = (msg) => { const s = JSON.stringify({ jsonrpc: "2.0", ...msg }); lsp.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
const request = (method, params, timeoutMs = 60_000) => new Promise((res, rej) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`LSP ${method} timed out`)); }, timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
  send({ id, method, params });
});
const notify = (method, params) => send({ method, params });
let onIndexed; const indexed = new Promise((r) => (onIndexed = r));
lsp.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf("\r\n\r\n"); if (h < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, h).toString())?.[1]);
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.slice(h + 4, h + 4 + len).toString()); buf = buf.slice(h + 4 + len);
    if (msg.id !== undefined && !msg.method) { pending.get(msg.id)?.(msg); pending.delete(msg.id); continue; }
    if (msg.method === "indexingStarted") indexing.started = Date.now();
    if (msg.method === "indexingEnded") { indexing.ended = Date.now(); onIndexed(); }
    if (msg.id !== undefined && msg.method) { // server -> client request
      let result = null;
      if (msg.method === "workspace/configuration") result = (msg.params?.items || []).map((it) => (it.section === "intelephense" ? SETTINGS : it.section?.startsWith("intelephense.") ? it.section.split(".").slice(1).reduce((o, k) => o?.[k], SETTINGS) ?? null : null));
      if (msg.method === "workspace/workspaceFolders") result = [{ uri: pathToFileURL(ROOT).href, name: "build" }];
      send({ id: msg.id, result });
    }
  }
});

const uri = (rel) => pathToFileURL(join(ROOT, rel)).href;
const relOf = (u) => relative(ROOT, fileURLToPath(u));
function safeRel(p) {
  if (typeof p !== "string" || !p) throw new Error("file path required");
  const abs = isAbsolute(p) ? p : resolve(ROOT, p);
  const rel = relative(ROOT, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path outside the build");
  if (!existsSync(abs)) throw new Error(`no such file: ${rel}`);
  return rel;
}
const fileLines = new Map();
const linesOf = (rel) => { if (!fileLines.has(rel)) fileLines.set(rel, readFileSync(join(ROOT, rel), "utf8").split("\n")); return fileLines.get(rel); };
const opened = new Map();
// didOpen once per file; the first documentSymbol round trip guarantees the server has parsed the
// opened text before any concurrent request for that file is answered.
function ensureOpen(rel) {
  if (!opened.has(rel)) {
    notify("textDocument/didOpen", { textDocument: { uri: uri(rel), languageId: "php", version: 1, text: readFileSync(join(ROOT, rel), "utf8") } });
    opened.set(rel, request("textDocument/documentSymbol", { textDocument: { uri: uri(rel) } }).catch(() => null));
  }
  return opened.get(rel);
}
const numbered = (rel, from, to) => linesOf(rel).slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}| ${l.length > 400 ? l.slice(0, 400) + " …[line cut at 400 chars]" : l}`).join("\n");
const KIND = { 5: "class", 6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 22: "enum-member", 23: "struct" };

async function symbolsNamed(symbol) {
  const parts = String(symbol).replace(/^\\/, "").split(/::|->|\./);
  const name = parts.pop(); const owner = parts.length ? parts.join("\\").split("\\").pop() : null;
  const res = (await request("workspace/symbol", { query: name })) || [];
  const exact = res.filter((s) => s.name === name || s.name === `$${name}`).filter((s) => !owner || (s.containerName || "").split("\\").pop() === owner);
  return exact.filter((s) => s.location?.uri?.startsWith("file:")).filter((s) => !relOf(s.location.uri).startsWith(".."));
}

function namePosition(rel, s) {
  const r = s.location.range; const lines = linesOf(rel); const bare = s.name.replace(/^\$/, "");
  for (let l = r.start.line; l <= Math.min(r.end.line, r.start.line + 5); l++) {
    const re = new RegExp(`\\b${bare.replace(/[$]/g, "\\$")}\\b`); const m = re.exec(lines[l] || "");
    if (m) return { line: l, character: m.index };
  }
  return r.start;
}

// ------------------------------------------------------------------ MCP tools
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TOOLS = [
  { name: "find_symbol", description: "Search classes, methods, functions, properties and constants of the evaluated PHP codebase by (partial) name. Returns kind, name, container and file:line.", inputSchema: { type: "object", properties: { query: { type: "string", description: "Name or name fragment, e.g. 'OrderService' or 'placeOrder'" } }, required: ["query"] } , annotations: RO },
  { name: "definition", description: "Show the source (with line numbers) of a symbol's definition. Accepts 'Class', 'Class::method', 'Class::$property' or a function name.", inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } , annotations: RO },
  { name: "references", description: "List the places (file:line and the line's code) that reference a symbol. Accepts 'Class', 'Class::method', 'Class::$property'.", inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } , annotations: RO },
  { name: "hover", description: "Type/signature information for the symbol at a position (1-based line and column) in a file.", inputSchema: { type: "object", properties: { file: { type: "string", description: "Repository-relative path" }, line: { type: "integer" }, column: { type: "integer" } }, required: ["file", "line", "column"] } , annotations: RO },
  { name: "document_symbols", description: "Outline of a PHP file: classes, methods, properties with their line ranges.", inputSchema: { type: "object", properties: { file: { type: "string", description: "Repository-relative path" } }, required: ["file"] } , annotations: RO },
  { name: "read_lines", description: `Read lines of any file of the evaluated codebase (repository-relative path, 1-based inclusive range, at most ${MAX_LINES} lines).`, inputSchema: { type: "object", properties: { file: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } }, required: ["file", "start", "end"] } , annotations: RO },
];

async function callTool(name, a) {
  switch (name) {
    case "find_symbol": {
      const res = ((await request("workspace/symbol", { query: String(a.query || "") })) || []).filter((s) => !relOf(s.location.uri).startsWith(".."));
      const ranked = res.map((s) => ({ s, rel: relOf(s.location.uri) })).sort((x, y) => (x.rel.startsWith("vendor/") - y.rel.startsWith("vendor/")) || x.rel.localeCompare(y.rel) || x.s.location.range.start.line - y.s.location.range.start.line);
      if (!ranked.length) return `No symbols match '${a.query}'.`;
      return ranked.slice(0, 30).map(({ s, rel }) => `${KIND[s.kind] || s.kind} ${s.name}${s.containerName ? "  (" + s.containerName + ")" : ""}  ${rel}:${s.location.range.start.line + 1}`).join("\n") + (ranked.length > 30 ? `\n… ${ranked.length - 30} more` : "");
    }
    case "definition": {
      const syms = await symbolsNamed(a.symbol);
      if (!syms.length) return `No definition found for '${a.symbol}'. Try find_symbol.`;
      return syms.slice(0, 3).map((s) => {
        const rel = relOf(s.location.uri); const r = s.location.range;
        const from = r.start.line + 1, to = Math.min(r.end.line + 1, from + MAX_LINES - 1);
        return `${KIND[s.kind] || s.kind} ${s.containerName ? s.containerName + "\\" : ""}${s.name} — ${rel}:${from}-${r.end.line + 1}${to < r.end.line + 1 ? ` (first ${MAX_LINES} lines)` : ""}\n${numbered(rel, from, to)}`;
      }).join("\n\n");
    }
    case "references": {
      const syms = await symbolsNamed(a.symbol);
      if (!syms.length) return `Symbol '${a.symbol}' not found. Try find_symbol.`;
      const s = syms[0]; const rel = relOf(s.location.uri); await ensureOpen(rel);
      const refs = (await request("textDocument/references", { textDocument: { uri: s.location.uri }, position: namePosition(rel, s), context: { includeDeclaration: false } })) || [];
      const rows = refs.map((r) => ({ rel: relOf(r.uri), line: r.range.start.line + 1 })).filter((r) => !r.rel.startsWith("..") && !r.rel.startsWith("vendor/"))
        .sort((x, y) => x.rel.localeCompare(y.rel) || x.line - y.line);
      if (!rows.length) return `No references to '${a.symbol}' outside vendor/.`;
      return `${rows.length} reference(s) to ${s.containerName ? s.containerName + "\\" : ""}${s.name}:\n` + rows.slice(0, 60).map((r) => `${r.rel}:${r.line}: ${(linesOf(r.rel)[r.line - 1] || "").trim().slice(0, 200)}`).join("\n") + (rows.length > 60 ? `\n… ${rows.length - 60} more` : "");
    }
    case "hover": {
      const rel = safeRel(a.file); await ensureOpen(rel);
      const h = await request("textDocument/hover", { textDocument: { uri: uri(rel) }, position: { line: Number(a.line) - 1, character: Math.max(0, Number(a.column) - 1) } });
      const c = h?.contents; const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.value ?? x).join("\n") : c?.value;
      return text ? text.slice(0, 4000) : "No hover information at that position.";
    }
    case "document_symbols": {
      const rel = safeRel(a.file); await ensureOpen(rel);
      const res = (await request("textDocument/documentSymbol", { textDocument: { uri: uri(rel) } })) || [];
      const out = []; const walk = (arr, d) => { for (const s of arr) { const r = s.range || s.location?.range; out.push(`${"  ".repeat(d)}${KIND[s.kind] || s.kind} ${s.name}  L${r.start.line + 1}-${r.end.line + 1}`); if (s.children) walk(s.children, d + 1); } };
      walk(res, 0); return out.join("\n") || "No symbols.";
    }
    case "read_lines": {
      const rel = safeRel(a.file); const n = linesOf(rel).length;
      const from = Math.max(1, Number(a.start) || 1), to = Math.min(n, Number(a.end) || from, from + MAX_LINES - 1);
      return `${rel} lines ${from}-${to} of ${n}\n${numbered(rel, from, to)}`;
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

// ------------------------------------------------------------------ MCP over HTTP
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
async function handle(msg, callId) {
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification
  try {
    if (method === "initialize") {
      const pv = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return { jsonrpc: "2.0", id, result: { protocolVersion: pv, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "php-code-navigation", version: `intelephense-${VERSION}` } } };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [] } };
    if (method === "resources/templates/list") return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    if (method === "prompts/list") return { jsonrpc: "2.0", id, result: { prompts: [] } };
    if (method === "tools/call") {
      const t0 = Date.now(); let text, isError = false;
      try { text = await callTool(params?.name, params?.arguments || {}); } catch (e) { text = `Error: ${e.message}`; isError = true; }
      log({ call: callId, tool: params?.name, args: params?.arguments, ms: Date.now() - t0, chars: text.length, error: isError || undefined });
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  } catch (e) { return { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } }; }
}

const server = createServer(async (req, res) => {
  const m = /^\/mcp(?:\/([A-Za-z0-9._-]+))?\/?$/.exec(req.url.split("?")[0]);
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, indexing, intelephense: VERSION })); }
  if (!m) { res.writeHead(404); return res.end(); }
  if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
  let body = ""; for await (const c of req) body += c;
  let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
  const batch = Array.isArray(msg); const out = (await Promise.all((batch ? msg : [msg]).map((x) => handle(x, m[1] || "-")))).filter(Boolean);
  if (!out.length) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(batch ? out : out[0]));
});

// ------------------------------------------------------------------ start
const t0 = Date.now();
await request("initialize", {
  processId: process.pid, rootUri: pathToFileURL(ROOT).href, rootPath: ROOT, workspaceFolders: [{ uri: pathToFileURL(ROOT).href, name: "build" }],
  capabilities: { workspace: { configuration: true, workspaceFolders: true, symbol: {} }, textDocument: { hover: { contentFormat: ["markdown", "plaintext"] }, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, references: {}, definition: {} } },
  initializationOptions: { storagePath: STATE, globalStoragePath: STATE, clearCache: true },
}, 120_000);
notify("initialized", {});
notify("workspace/didChangeConfiguration", { settings: { intelephense: SETTINGS } });
const timeout = new Promise((r) => setTimeout(() => r("timeout"), Number(args["index-timeout"] || 900) * 1000));
const idx = await Promise.race([indexed, timeout]);
const indexSecs = (Date.now() - t0) / 1000;
server.listen(PORT, "127.0.0.1", () => {
  const info = { ok: idx !== "timeout", port: server.address().port, root: ROOT, intelephense: VERSION, index_secs: indexSecs, pid: process.pid };
  log({ event: "ready", ...info });
  if (args["ready-file"]) writeFileSync(args["ready-file"], JSON.stringify(info) + "\n");
  else console.log(JSON.stringify(info));
});
process.on("SIGTERM", () => { try { lsp.kill(); } catch {} process.exit(0); });
