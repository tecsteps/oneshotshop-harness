#!/usr/bin/env node
// Preflight without spending tokens: speak MCP over stdio to the exact Playwright MCP server the
// evaluator will get (same --mcp-config JSON), list its tools and navigate to the shop's "/".
// Usage: node preflight.js <mcp-config.json> <url>
// stdout: one JSON line {ok, tools, navigate_ok, page_title, http_status, error, servers: {name: {...}}};
// every server in the config is checked (playwright and playwright2).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const [cfgPath, url] = process.argv.slice(2);
const servers = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers;

function check(srv) {
  return new Promise((resolveCheck) => {
    const p = spawn(srv.command, srv.args, { env: { ...process.env, ...(srv.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', nextId = 1, finished = false; const waiting = new Map();
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const m = JSON.parse(line); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch {}
      }
    });
    let stderr = ''; p.stderr.on('data', (d) => { stderr += d; });
    const rpc = (method, params) => new Promise((res) => { const id = nextId++; waiting.set(id, res);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const done = (o) => { if (finished) return; finished = true; clearTimeout(timer); p.kill(); resolveCheck(o); };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout after 90s', stderr: stderr.slice(-2000) }), 90000);
    (async () => {
      const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'oneshotshop-preflight', version: '1' } });
      if (!init.result) return done({ ok: false, error: 'initialize failed', detail: init });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const tl = await rpc('tools/list', {});
      const tools = (tl.result && tl.result.tools || []).map((t) => t.name);
      const need = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_evaluate'];
      const missing = need.filter((n) => !tools.includes(n));
      const nav = await rpc('tools/call', { name: 'browser_navigate', arguments: { url } });
      const text = ((nav.result && nav.result.content) || []).map((c) => c.text || '').join('\n');
      const title = (text.match(/Page Title: (.*)/) || [])[1] || null;
      const navOk = !!nav.result && !nav.result.isError && /Page URL:/.test(text);
      let http = null;
      try { http = (await fetch(url)).status; } catch (e) { http = 'error: ' + e.message; }
      await rpc('tools/call', { name: 'browser_close', arguments: {} }).catch(() => {});
      done({ ok: missing.length === 0 && navOk && http === 200, tools: tools.length, missing_tools: missing,
             navigate_ok: navOk, page_title: title, http_status: http, error: navOk ? null : text.slice(0, 1500) });
    })().catch((e) => done({ ok: false, error: String(e), stderr: stderr.slice(-2000) }));
  });
}

(async () => {
  // Every configured browser server (playwright = storefront, playwright2 = admin) must work.
  const out = {};
  for (const [name, srv] of Object.entries(servers)) out[name] = await check(srv);
  const first = out.playwright || Object.values(out)[0] || { ok: false, error: 'no MCP server in config' };
  const bad = Object.entries(out).filter(([, o]) => !o.ok).map(([n, o]) => `${n}: ${o.error || 'not ok'}`);
  console.log(JSON.stringify({ ...first, ok: bad.length === 0, error: bad.length ? bad.join('; ') : null,
                               servers: out }));
  process.exit(bad.length ? 1 : 0);
})();
