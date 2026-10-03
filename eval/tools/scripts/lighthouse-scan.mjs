// Lighthouse on the discovered pages (home, category, WAT-001, NF-005; guest), presets mobile
// (Lighthouse default) and desktop, default SIMULATED throttling, N runs each (LH_RUNS, default
// 3); the median run (Lighthouse's own computeMedianRun) is reported. Every run's JSON report
// is kept as /out/lh-<page>-<preset>-<n>.json; summary in /out/lighthouse-summary.json.
import { require, importTool, readJson, writeJson, CHROMIUM_ARGS, TOOLS_HOME } from './browser-lib.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNS = Number(process.env.LH_RUNS || 3);
const PAGE_IDS = ['home', 'category', 'product-wat-001', 'product-nf-005'];
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

const { chromium } = require('playwright');
const { default: lighthouse } = await importTool('lighthouse');
const lhRoot = path.dirname(require.resolve('lighthouse/package.json'));
const { default: desktopConfig } = await import(pathToFileURL(path.join(lhRoot, 'core/config/desktop-config.js')).href);
const { computeMedianRun } = await import(pathToFileURL(path.join(lhRoot, 'core/lib/median-run.js')).href);
const chromeLauncher = await import(pathToFileURL(require.resolve('chrome-launcher', { paths: [lhRoot, TOOLS_HOME] })).href);

function metrics(lhr) {
  const a = lhr.audits;
  const num = (id) => (a[id] && typeof a[id].numericValue === 'number' ? Math.round(a[id].numericValue * 1000) / 1000 : null);
  const reqs = a['network-requests']?.details?.items || [];
  const scripts = reqs.filter((r) => r.resourceType === 'Script');
  return {
    scores: Object.fromEntries(CATEGORIES.map((c) => [c, lhr.categories[c]?.score == null ? null : Math.round(lhr.categories[c].score * 100)])),
    lcp_ms: num('largest-contentful-paint'),
    cls: num('cumulative-layout-shift'),
    tbt_ms: num('total-blocking-time'),
    fcp_ms: num('first-contentful-paint'),
    speed_index_ms: num('speed-index'),
    total_byte_weight: num('total-byte-weight'),
    js_bytes: scripts.reduce((s, r) => s + (r.transferSize || 0), 0),
    requests: reqs.length,
    dom_size: num('dom-size') ?? num('dom-size-insight'),
  };
}

const { pages } = readJson(process.env.PAGES_JSON || '/out/pages.json');
const chromePath = chromium.executablePath();
const probe = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
const chromeVersion = probe.version();
await probe.close();
const out = [];
for (const id of PAGE_IDS) {
  const p = pages.find((x) => x.id === id);
  if (!p || p.status !== 'ok') { out.push({ id, status: 'skipped', reason: p ? p.reason : 'page not discovered' }); continue; }
  const entry = { id, label: p.label, url: p.url, status: 'ok', presets: {} };
  for (const preset of ['mobile', 'desktop']) {
    const runs = [];
    for (let i = 1; i <= RUNS; i++) {
      const chrome = await chromeLauncher.launch({ chromePath, chromeFlags: ['--headless=new', ...CHROMIUM_ARGS] });
      try {
        const res = await lighthouse(p.url, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: CATEGORIES },
                                     preset === 'desktop' ? desktopConfig : undefined);
        const file = `lh-${id}-${preset}-${i}.json`;
        writeJson(`/out/${file}`, res.lhr);
        if (res.lhr.runtimeError) console.error(`[lighthouse] ${id} ${preset} #${i}: ${res.lhr.runtimeError.code}`);
        runs.push({ file, lhr: res.lhr });
      } catch (e) {
        console.error(`[lighthouse] ${id} ${preset} #${i} failed: ${e.message}`);
      } finally { await chrome.kill(); }
    }
    const ok = runs.filter((r) => !r.lhr.runtimeError);
    if (!ok.length) { entry.presets[preset] = { status: 'failed', runs: runs.length }; continue; }
    const median = computeMedianRun(ok.map((r) => r.lhr));
    const medianRun = ok.find((r) => r.lhr === median);
    entry.presets[preset] = { status: 'ok', runs: ok.length, median_report: medianRun.file, ...metrics(median),
                              performance_all_runs: ok.map((r) => Math.round((r.lhr.categories.performance?.score ?? 0) * 100)) };
    console.error(`[lighthouse] ${id} ${preset}: perf ${entry.presets[preset].scores.performance} (runs ${entry.presets[preset].performance_all_runs.join('/')})`);
  }
  out.push(entry);
}
writeJson('/out/lighthouse-summary.json', {
  lighthouse: require('lighthouse/package.json').version, chromium: chromeVersion,
  throttling: 'simulated (Lighthouse default)', runs_per_preset: RUNS, pages: out,
});
