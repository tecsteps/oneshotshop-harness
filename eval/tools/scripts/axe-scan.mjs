// axe-core scan of the discovered pages (guest). Reads /out/pages.json, writes one raw result
// per page (/out/axe-<id>.json) and /out/axe-summary.json. Rules: WCAG 2.0/2.1/2.2 A + AA tags.
import { require, readJson, writeJson, CHROMIUM_ARGS } from './browser-lib.mjs';

const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];

const { pages } = readJson(process.env.PAGES_JSON || '/out/pages.json');
const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
const out = [];
try {
  for (const p of pages) {
    if (p.status !== 'ok') { out.push({ id: p.id, label: p.label, status: 'skipped', reason: p.reason }); continue; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.goto(p.url, { waitUntil: 'load', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      writeJson(`/out/axe-${p.id}.json`, { url: p.url, testEngine: res.testEngine, violations: res.violations, incomplete: res.incomplete, passes: res.passes.length });
      const rules = Object.fromEntries(IMPACTS.map((i) => [i, 0]));
      const nodes = Object.fromEntries(IMPACTS.map((i) => [i, 0]));
      for (const v of res.violations) { rules[v.impact || 'minor']++; nodes[v.impact || 'minor'] += v.nodes.length; }
      out.push({ id: p.id, label: p.label, url: p.url, status: 'ok', violations: res.violations.length,
                 violation_nodes: res.violations.reduce((s, v) => s + v.nodes.length, 0),
                 by_impact: rules, nodes_by_impact: nodes, incomplete: res.incomplete.length,
                 rules: res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })) });
      console.error(`[axe] ${p.id}: ${res.violations.length} violations`);
    } catch (e) {
      out.push({ id: p.id, label: p.label, url: p.url, status: 'failed', reason: String(e.message || e).slice(0, 300) });
    } finally { await ctx.close(); }
  }
} finally { await browser.close(); }
writeJson('/out/axe-summary.json', { axe_core: require('axe-core/package.json').version, tags: TAGS, pages: out });
