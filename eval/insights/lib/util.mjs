// Shared helpers: streaming JSONL, time, idle gaps, shell command classification.
import { createReadStream, readdirSync, statSync, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join } from "node:path";

/** Stream a (possibly .gz) JSONL file; calls fn(obj, lineNo). Bad lines are counted, not fatal. */
export async function eachJsonl(path, fn) {
  let stream = createReadStream(path);
  if (path.endsWith(".gz")) stream = stream.pipe(createGunzip());
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  let bad = 0;
  for await (const line of rl) {
    n++;
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    fn(obj, n);
  }
  return { lines: n, badLines: bad };
}

/** Recursively list files under dir (follows symlinks to files and dirs). */
export function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function toMs(ts) {
  if (ts == null) return null;
  if (typeof ts === "number") return ts < 1e12 ? ts * 1000 : ts;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

export function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

export function fmtDuration(ms) {
  if (ms == null) return null;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? `${h}h ` : ""}${h || m ? `${m}m ` : ""}${sec}s`;
}

/**
 * Website rule "Duration: exclude idle gaps": wall = last - first timestamp across the
 * whole run (orchestrator + every sub-agent); any gap > idleGapMs in the UNION timeline
 * (i.e. a period in which no agent wrote anything) is subtracted.
 */
export function durationWithIdle(timestamps, idleGapMs = 30 * 60 * 1000) {
  const ts = timestamps.filter((t) => t != null).sort((a, b) => a - b);
  if (!ts.length) return null;
  const gaps = [];
  for (let i = 1; i < ts.length; i++) {
    const g = ts[i] - ts[i - 1];
    if (g > idleGapMs) gaps.push({ from: iso(ts[i - 1]), to: iso(ts[i]), ms: g, formatted: fmtDuration(g) });
  }
  const wallMs = ts[ts.length - 1] - ts[0];
  const idleMs = gaps.reduce((s, g) => s + g.ms, 0);
  return {
    start: iso(ts[0]),
    end: iso(ts[ts.length - 1]),
    wallMs,
    wallFormatted: fmtDuration(wallMs),
    activeMs: wallMs - idleMs,
    activeFormatted: fmtDuration(wallMs - idleMs),
    idleGapThresholdMinutes: idleGapMs / 60000,
    idleGaps: gaps,
  };
}

/**
 * Shell command classification. A compound command is split into segments (&&, ||, ;, |,
 * newlines); each segment is classified by its leading command (after env assignments,
 * sudo/timeout/env wrappers), so `sed -n 1,50p tests/Pest.php` is "other", not "tests".
 */
const SEG_RULES = [
  ["playwright", /^(npx\s+(-y\s+)?(@playwright\/test|playwright)\b|playwright\b|node\s+\S*playwright|npm\s+run\s+\S*(e2e|playwright))/i],
  ["tests", /^(php\s+(-d\s+\S+\s+)*artisan\s+(test|dusk)\b|(\.\/)?vendor\/bin\/(pest|phpunit|paratest)\b|pest\b|phpunit\b|npm\s+(run\s+)?test\b|npx\s+(vitest|jest)\b|vitest\b|jest\b|composer\s+(run\s+)?test\b)/i],
  ["composer", /^composer\b/i],
  ["npm", /^(npm|npx|pnpm|yarn|bun|node|vite)\b/i],
  ["artisan", /^php\s+(-d\s+\S+\s+)*artisan\b/i],
  ["git", /^git\b/],
];
const PRIORITY = ["playwright", "tests", "composer", "npm", "artisan", "git", "other"];

function segments(cmd) {
  return String(cmd || "")
    .split(/&&|\|\||;|\||\n/)
    .map((x) => x.trim().replace(/^\(+/, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").replace(/^(?:sudo|time|timeout\s+\S+|env(?:\s+[A-Za-z_]\w*=\S*)*|nice|xargs(?:\s+-\S+)*)\s+/, "").trim())
    .filter((x) => x && !/^cd\b/.test(x));
}

export function commandCategories(cmd) {
  const cats = new Set();
  for (const seg of segments(cmd)) {
    const hit = SEG_RULES.find(([, re]) => re.test(seg));
    cats.add(hit ? hit[0] : "other");
  }
  return cats.size ? PRIORITY.filter((c) => cats.has(c)) : ["other"];
}

/** Primary category (highest priority segment). */
export function categorizeCommand(cmd) {
  return commandCategories(cmd)[0];
}

/** Best-effort exit code / error extraction from a tool output string. */
export function parseExit(text) {
  if (text == null) return { exit: null, isError: null };
  const s = typeof text === "string" ? text : JSON.stringify(text);
  const codes = [];
  for (const re of [
    /"exit_code"\s*:\s*(-?\d+)/g,
    /Process exited with code (-?\d+)/g,
    /^Exit code:?\s*(-?\d+)/gm,
    /\bexited with (?:exit )?code (-?\d+)/g,
  ]) {
    for (const m of s.matchAll(re)) codes.push(Number(m[1]));
  }
  const exit = codes.length ? Math.max(...codes.map((c) => Math.abs(c))) : null;
  const scriptFailed = /^Script (failed|error)/m.test(s.slice(0, 400));
  return { exit, isError: exit != null ? exit !== 0 : scriptFailed ? true : null };
}

/** Keep head and tail of a long string. */
export function clip(s, max, tail = 0) {
  if (s == null) return "";
  s = String(s);
  if (s.length <= max) return s;
  if (!tail) return `${s.slice(0, max)}…[+${s.length - max}]`;
  return `${s.slice(0, max - tail)} …[${s.length - max} chars cut]… ${s.slice(-tail)}`;
}

export function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** Lines of a tool output that look like errors (for highlighting). */
/** Unwrap Codex exec output envelopes ({"chunk_id":..,"output":"..."}) and strip ANSI codes. */
export function plainOutput(text) {
  let s = String(text ?? "");
  const i = s.indexOf('{"');
  if (i >= 0 && /"output"\s*:/.test(s)) {
    const j = s.lastIndexOf("}");
    try {
      const o = JSON.parse(s.slice(i, j + 1));
      if (typeof o.output === "string") s = `${s.slice(0, i)}${o.output}`;
    } catch {
      s = s.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  }
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function errorLines(text, max = 3) {
  if (!text) return [];
  const lines = plainOutput(text).split("\n").map((l) => l.replace(/[⨯✓✗·.]{6,}/g, "").trim()).filter(Boolean);
  const hits = lines.filter((l) =>
    /(error|exception|failed|failure|fatal|not found|denied|cannot|undefined|syntax|FAIL|Expected|assert)/i.test(l) && !/^(Script completed|Wall time|Output:)/.test(l),
  );
  return (hits.length ? hits : lines.filter((l) => l.trim()).slice(-2)).slice(0, max).map((l) => oneLine(l).slice(0, 220));
}

export function inc(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

export function sortedCounts(obj) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

/** Last test-runner summary line in an output (Pest/PHPUnit/Playwright/Vitest), or null. */
export function testSummary(text) {
  if (!text) return null;
  const m = plainOutput(text).match(/Tests:\s+[^\n]{3,120}|\b\d+ (?:passed|failed)\b[^\n]{0,80}|OK \(\d+ tests?[^\n]{0,60}|FAILURES![^\n]{0,80}/g);
  return m ? oneLine(m[m.length - 1]) : null;
}
