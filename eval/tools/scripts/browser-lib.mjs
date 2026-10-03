// Shared helpers for the browser tools (page discovery, axe, Lighthouse). Runs inside the
// oneshotshop-tools-browser image, which has playwright/@axe-core/playwright/lighthouse
// installed in ~/browser-tools; modules are resolved from there.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

export const TOOLS_HOME = process.env.BROWSER_TOOLS || '/home/agent/browser-tools';
export const require = createRequire(TOOLS_HOME + '/package.json');
export const importTool = async (spec) => import(pathToFileURL(require.resolve(spec)).href);
export const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
export const SKUS = ['WAT-001', 'NF-005'];
export const CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

export function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
export function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }

const BASE = new URL(BASE_URL);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);

// Links to localhost:8000 / 127.0.0.1:8000 (APP_URL may use either) count as the shop; they
// are normalised to BASE_URL so every tool opens the same address.
export function sameOrigin(href) {
  try {
    const u = new URL(href);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname) && (u.port || '80') === (BASE.port || '80');
  } catch { return false; }
}
export function normalise(href) {
  const u = new URL(href);
  u.protocol = BASE.protocol; u.host = BASE.host; u.hash = '';
  return u.toString();
}
const pathOf = (href) => { try { return decodeURIComponent(new URL(href).pathname + new URL(href).search); } catch { return href; } };

async function linksOf(page) {
  const all = await page.$$eval('a[href]', (as) => as.map((a) => ({
    href: a.href,
    text: (a.innerText || a.getAttribute('aria-label') || a.title || '').trim().replace(/\s+/g, ' '),
  })));
  return all.filter((l) => sameOrigin(l.href)).map((l) => ({ ...l, href: normalise(l.href) }));
}

async function open(page, url) {
  const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  return resp ? resp.status() : null;
}

const bodyHas = async (page, text) =>
  ((await page.evaluate(() => document.body ? document.body.innerText : '')) || '').toLowerCase().includes(text.toLowerCase());

const CATEGORY_TEXT = [/water.*soft|wasser.*soft|soft.*drinks/i];
const CATEGORY_PATH = /(categor|kategor|collection|sortiment|catalog|katalog|\/c\/|\/shop\/)/i;
const PRODUCT_PATH = /(product|produkt|artikel|article|item|\/p\/)/i;
const CART = /(cart|warenkorb|basket|einkaufswagen)/i;
const LOGIN = /(login|anmelden|signin|sign-in|einloggen)/i;
const SEARCH_INPUTS = [
  'input[type=search]', 'input[name=q]', 'input[name=query]', 'input[name=search]', 'input[name=s]',
  'input[name=term]', 'input[name=keyword]', 'input[name=keywords]', '[role=search] input[type=text]',
  'input[placeholder*="earch" i]', 'input[placeholder*="such" i]', 'input[aria-label*="earch" i]', 'input[aria-label*="such" i]',
];

async function findCategory(page, homeLinks) {
  const cands = homeLinks.filter((l) => new URL(l.href).pathname !== '/');
  for (const re of CATEGORY_TEXT) {
    const hit = cands.find((l) => re.test(l.text));
    if (hit) return { url: hit.href, method: `home link with text "${hit.text}"` };
  }
  const byPath = cands.find((l) => CATEGORY_PATH.test(pathOf(l.href)) && !PRODUCT_PATH.test(pathOf(l.href)));
  if (byPath) return { url: byPath.href, method: `first home link to a category path (${pathOf(byPath.href)})` };
  return null;
}

async function searchInput(page) {
  for (const sel of SEARCH_INPUTS) {
    const loc = page.locator(sel);
    const n = await loc.count();
    for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible()) return loc.nth(i);
  }
  // A search icon that reveals the field
  const toggle = page.locator('button[aria-label*="earch" i], button[aria-label*="such" i], a[aria-label*="earch" i]').first();
  if (await toggle.count()) {
    await toggle.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    for (const sel of SEARCH_INPUTS) {
      const loc = page.locator(sel);
      const n = await loc.count();
      for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible()) return loc.nth(i);
    }
  }
  return null;
}

// Tries product links on the current page (links containing the SKU first, then product-like
// paths in DOM order, at most 6) and accepts the first page whose text contains the SKU.
async function productFromLinks(page, sku, how) {
  const here = page.url();
  if (PRODUCT_PATH.test(pathOf(here)) && (await bodyHas(page, sku))) return { url: normalise(here), method: `${how} (landed on product page)` };
  const links = await linksOf(page);
  const skuLow = sku.toLowerCase();
  const ranked = [
    ...links.filter((l) => l.href.toLowerCase().includes(skuLow) || l.text.toLowerCase().includes(skuLow)),
    ...links.filter((l) => PRODUCT_PATH.test(pathOf(l.href))),
  ];
  const seen = new Set();
  for (const l of ranked) {
    if (seen.has(l.href) || l.href === normalise(here)) continue;
    seen.add(l.href);
    if (seen.size > 6) break;
    const status = await open(page, l.href).catch(() => null);
    if (status && status < 400 && (await bodyHas(page, sku))) return { url: normalise(page.url()), method: `${how} -> ${pathOf(l.href)}` };
  }
  return null;
}

// Finds the fixed storefront pages as a guest, starting from the home page and following
// visible navigation only (like the test plan's "no URL guessing" rule).
export async function discoverPages(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const pages = [];
  const add = (id, label, r, reason) => pages.push(r ? { id, label, status: 'ok', url: r.url, method: r.method, http_status: r.http_status ?? null }
                                                     : { id, label, status: 'skipped', url: null, reason });
  const homeUrl = BASE_URL + '/';
  const homeStatus = await open(page, homeUrl).catch((e) => { add('home', 'Home', null, `home did not load: ${e.message}`); return null; });
  if (homeStatus === null) { await ctx.close(); return pages; }
  add('home', 'Home', { url: homeUrl, method: 'GET /', http_status: homeStatus });
  const homeLinks = await linksOf(page);

  // Category
  const cat = await findCategory(page, homeLinks);
  let catUrl = null;
  if (cat) {
    const st = await open(page, cat.url).catch(() => null);
    if (st && st < 400) { catUrl = normalise(page.url()); add('category', 'Category', { ...cat, url: catUrl, http_status: st }); }
    else add('category', 'Category', null, `category link ${cat.url} returned ${st}`);
  } else add('category', 'Category', null, 'no category link found on the home page');

  // Products by SKU: site search first, then the category page
  for (const sku of SKUS) {
    let found = null;
    await open(page, homeUrl);
    const input = await searchInput(page);
    if (input) {
      await input.fill(sku);
      await Promise.all([page.waitForLoadState('load').catch(() => {}), input.press('Enter')]);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1000);
      found = await productFromLinks(page, sku, `site search "${sku}"`);
    }
    if (!found && catUrl) {
      await open(page, catUrl);
      found = await productFromLinks(page, sku, 'category page');
    }
    const id = 'product-' + sku.toLowerCase();
    if (found) add(id, `Product ${sku}`, { ...found, http_status: 200 });
    else add(id, `Product ${sku}`, null, input ? `search for ${sku} led to no page showing ${sku}` : `no search field on home page and ${sku} not linked from the category page`);
  }

  // Cart
  const cartLink = homeLinks.find((l) => CART.test(pathOf(l.href))) || homeLinks.find((l) => CART.test(l.text));
  if (cartLink) {
    const st = await open(page, cartLink.href).catch(() => null);
    const final = page.url();
    if (!st || st >= 400) add('cart', 'Cart', null, `cart link returned ${st}`);
    else if (LOGIN.test(pathOf(final)) && !CART.test(pathOf(final))) add('cart', 'Cart', null, `cart redirects guests to sign-in (${pathOf(final)})`);
    else add('cart', 'Cart', { url: normalise(final), method: `home link ${pathOf(cartLink.href)}`, http_status: st });
  } else add('cart', 'Cart', null, 'no cart link on the home page');

  await ctx.close();
  return pages;
}
