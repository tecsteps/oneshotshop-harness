#!/usr/bin/env node
// Deterministic, architecture-agnostic interaction journey for the perf step.
//   node journey.mjs --base http://127.0.0.1:18080 --out journey.json [--playwright-core <dir>] [--headed]
// Finds elements only by role / visible text / label / generic input types (never build-specific
// selectors). A step that cannot be found is recorded as `skipped`, never guessed.
// For every action it records the backend requests the browser made (document/xhr/fetch/form
// posts/anything that carries the probe's X-OSS-Perf-Id header), with request/response body
// bytes and the probe id for joining with the server-side probe log. Static asset requests are
// only counted (initial page weight is measured by Lighthouse in eval/tools).
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
const BASE = String(args.base || 'http://127.0.0.1:8000').replace(/\/$/, '');
const OUT = args.out || 'journey.json';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTLE_IDLE_MS = 600, SETTLE_MAX_MS = 12000, STEP_TIMEOUT = 8000;

// Fixed journey data from the spec (specs/customers.md, specs/products.md, specs/discounts.md).
const CUSTOMER = { id: 'C-10001', email: 'einkauf@osthafen-kueche.example', password: 'Hafen#2026' };
const PRODUCT = { sku: 'WAT-001', name: /sparkling mineral water/i };
const FIRST_CATEGORY = /^\s*beverages\s*$/i;
const PROMO_CODE = 'WELCOME10';

function loadPlaywright() {
  const candidates = [args['playwright-core'], process.env.OSS_PERF_PLAYWRIGHT_CORE,
    path.join(HERE, '../testplan/.playwright/node_modules/playwright-core'),
    path.join(HERE, '.playwright/node_modules/playwright-core')].filter(Boolean);
  const req = createRequire(import.meta.url);
  for (const c of candidates) { try { return { pw: req(c), from: c }; } catch { /* next */ } }
  throw new Error('playwright-core not found (run eval/testplan/runner/playwright-setup.sh or pass --playwright-core)');
}

const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack']);

async function firstVisible(locator, max = 25) {
  const n = Math.min(await locator.count().catch(() => 0), max);
  for (let i = 0; i < n; i++) {
    const l = locator.nth(i);
    if (await l.isVisible().catch(() => false)) return l;
  }
  return null;
}

// Client-rendered UIs (SPA, Inertia, Livewire lazy) may render after `load`: poll briefly.
const FIND_WAIT_MS = 5000;
async function poll(fn, ms = FIND_WAIT_MS) {
  const t0 = Date.now();
  for (;;) {
    const r = await fn();
    if (r || Date.now() - t0 > ms) return r;
    await new Promise(res => setTimeout(res, 250));
  }
}

async function findClickableNow(page, name, { roles = ['link', 'button'], allowHidden = false } = {}) {
  for (const role of roles) {
    const l = await firstVisible(page.getByRole(role, { name }));
    if (l) return { el: l, how: `${role}:visible` };
  }
  if (allowHidden) {   // e.g. inside a collapsed menu: use its href (recorded as such)
    const links = page.getByRole('link', { name, includeHidden: true });
    if (await links.count().catch(() => 0)) {
      const href = await links.first().getAttribute('href').catch(() => null);
      if (href) return { href, how: 'link:hidden-href' };
    }
  }
  return null;
}
const findClickable = (page, name, o = {}) => poll(() => findClickableNow(page, name, o), o.wait ?? FIND_WAIT_MS);
const findVisible = (fn, ms) => poll(fn, ms);

async function clickOrGo(page, found) {
  if (found.el) await found.el.click({ timeout: STEP_TIMEOUT });
  else await page.goto(new URL(found.href, page.url()).toString(), { timeout: 30000 });
}

async function runtimeEvidence(page) {
  return page.evaluate(() => ({
    livewire: !!(window.Livewire || document.querySelector('[wire\\:id],[wire\\:snapshot]')),
    livewire_components: document.querySelectorAll('[wire\\:id]').length,
    inertia: !!document.querySelector('[data-page]') || !!document.querySelector('script[data-page]'),
    alpine: !!(window.Alpine || document.querySelector('[x-data]')),
    vue: !!(window.__VUE__ || document.querySelector('[data-v-app]')),
    react: !!(document.querySelector('[data-reactroot]') || Array.from(document.querySelectorAll('body *')).slice(0, 50).some(e => Object.keys(e).some(k => k.startsWith('__react')))),
    next: !!(window.__NEXT_DATA__ || document.getElementById('__next')),
    nuxt: !!(window.__NUXT__ || document.getElementById('__nuxt')),
    htmx: !!window.htmx,
    turbo: !!window.Turbo,
    svelte: !!document.querySelector('[class*="svelte-"]'),
  })).catch(() => null);
}

async function journey(browser, label, steps) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US',
    userAgent: (await browser.newContext().then(async c => { const p = await c.newPage(); const ua = await p.evaluate(() => navigator.userAgent); await c.close(); return ua; })) + ' oss-perf-journey' });
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT);
  const log = [];
  let inflight = 0, lastActivity = Date.now();
  const byReq = new Map();
  context.on('request', (r) => {
    inflight++; lastActivity = Date.now();
    const e = { t: Date.now(), method: r.method(), url: r.url(), type: r.resourceType(), nav: r.isNavigationRequest(), post_bytes: (r.postDataBuffer() || Buffer.alloc(0)).length };
    byReq.set(r, e); log.push(e);
  });
  const done = async (r, failed) => {
    inflight = Math.max(0, inflight - 1); lastActivity = Date.now();
    const e = byReq.get(r); if (!e) return;
    e.ms = Date.now() - e.t;
    if (failed) { e.failed = r.failure()?.errorText || true; return; }
    try {
      const resp = await r.response();
      if (resp) {
        const h = await resp.allHeaders();
        e.status = resp.status(); e.perf_id = h['x-oss-perf-id'] || null; e.content_type = h['content-type'] || null;
        e.redirected_from = r.redirectedFrom() ? r.redirectedFrom().url() : null;
      }
      const s = await r.sizes();
      e.resp_bytes = s.responseBodySize; e.req_bytes = s.requestBodySize;
    } catch { /* closed */ }
  };
  context.on('requestfinished', (r) => done(r, false));
  context.on('requestfailed', (r) => done(r, true));
  // redirects: Playwright emits a new request for each hop; the hop's response arrives via requestfinished.

  async function settle() {
    const t0 = Date.now();
    await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_MAX_MS }).catch(() => {});
    while (Date.now() - t0 < SETTLE_MAX_MS) {
      if (inflight === 0 && Date.now() - lastActivity >= SETTLE_IDLE_MS) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 150));   // let sizes() promises resolve
  }

  const actions = [];
  const evidence = {};
  const ctx = { page, state: {} };
  for (const [name, fn] of steps) {
    await settle();
    const start = log.length, t0 = Date.now();
    let status = 'ok', note = null;
    try {
      const r = await fn(ctx);
      if (r && r.skip) { status = 'skipped'; note = r.skip; }
      else if (r && r.note) note = r.note;
    } catch (e) { status = 'error'; note = String(e && e.message || e).split('\n')[0].slice(0, 300); }
    await settle();
    const reqs = log.slice(start);
    // backend round trip = anything non-static to the app's origin, or anything Laravel handled
    // (probe header) that is not a static resource type (livewire.js via a route is an asset)
    const backend = reqs.filter(r => !STATIC_TYPES.has(r.type) && (r.perf_id || r.url.startsWith(BASE)))
      .map(r => ({ method: r.method, path: r.url.slice(BASE.length) || '/', type: r.type, nav: r.nav, status: r.status ?? null,
        perf_id: r.perf_id ?? null, req_bytes: r.req_bytes ?? r.post_bytes, resp_bytes: r.resp_bytes ?? null, content_type: r.content_type ?? null,
        failed: r.failed || undefined, ms: r.ms ?? null }));
    const ev = await runtimeEvidence(page);
    if (ev) for (const [k, v] of Object.entries(ev)) evidence[k] = k === 'livewire_components' ? Math.max(evidence[k] || 0, v) : (evidence[k] || v);
    actions.push({ journey: label, action: name, status, note, t_start: t0, url_after: page.url().startsWith(BASE) ? page.url().slice(BASE.length) || '/' : page.url(),
      wall_ms: Date.now() - t0, backend_requests: backend, static_requests: reqs.filter(r => STATIC_TYPES.has(r.type)).length,
      static_requests_through_laravel: reqs.filter(r => STATIC_TYPES.has(r.type) && r.perf_id).length,
      third_party_requests: reqs.filter(r => !r.url.startsWith(BASE) && !r.url.startsWith('data:')).length,
      livewire_components_on_page: ev ? ev.livewire_components : null });
    if (status !== 'ok' && ctx.state.abortOnFail?.has(name)) {
      for (const [n2] of steps.slice(steps.findIndex(s => s[0] === name) + 1)) actions.push({ journey: label, action: n2, status: 'skipped', note: `previous step '${name}' ${status}`, backend_requests: [] });
      break;
    }
  }
  await context.close();
  return { actions, evidence };
}

// ------------------------------------------------------------------------------ steps
const S = {
  home: ['home', async ({ page }) => { await page.goto(BASE + '/', { timeout: 30000 }); }],
  category: ['open-first-category', async ({ page }) => {
    let f = await findClickable(page, FIRST_CATEGORY, { allowHidden: true });
    if (!f) f = await findClickable(page, /beverages/i, { allowHidden: true });
    if (!f) return { skip: 'no link/button named "Beverages"' };
    await clickOrGo(page, f); return { note: f.how };
  }],
  search: ['search-sku', async ({ page }) => {
    let box = await findVisible(async () => await firstVisible(page.getByRole('searchbox'))
      || await firstVisible(page.locator('input[type=search], input[name=q], input[name=query], input[name=search], input[name*=search i]'))
      || await firstVisible(page.getByPlaceholder(/search|such/i)));
    if (!box) {   // search behind a toggle button
      const t = await findClickable(page, /^\s*(search|suche)\s*$/i, { roles: ['button', 'link'] });
      if (t) { await clickOrGo(page, t); box = await firstVisible(page.getByRole('searchbox')) || await firstVisible(page.locator('input[type=search], input[name*=search i], input[name=q]')) || await firstVisible(page.getByPlaceholder(/search|such/i)); }
    }
    if (!box) return { skip: 'no search box found' };
    await box.click();
    await box.pressSequentially(PRODUCT.sku, { delay: 120 });   // typing cadence: shows per-keystroke round trips
    await box.press('Enter');
    return { note: 'typed SKU with 120ms/keystroke, Enter' };
  }],
  product: ['open-product-WAT-001', async ({ page }) => {
    const f = await findClickable(page, PRODUCT.name, { roles: ['link'] }) || await findClickable(page, new RegExp(PRODUCT.sku, 'i'), { roles: ['link'] });
    if (!f) return { skip: 'no link to WAT-001 on the search results / current page' };
    await clickOrGo(page, f);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.getByText(PRODUCT.sku, { exact: false }).first().waitFor({ timeout: STEP_TIMEOUT }).catch(() => {});
    const ok = await page.getByText(PRODUCT.sku, { exact: false }).count().catch(() => 0);
    return { note: ok ? 'SKU text present' : 'opened, but SKU text not visible' };
  }],
  unit: ['select-box-unit', async ({ page, state }) => {
    // <select> with an option mentioning "box"
    for (const sel of await page.locator('select').all()) {
      if (!(await sel.isVisible().catch(() => false))) continue;
      const opts = await sel.locator('option').allTextContents();
      const i = opts.findIndex(o => /\bbox\b|karton|kiste/i.test(o) && !/crate/i.test(o));
      if (i >= 0) { await sel.selectOption({ index: i }); state.unit = opts[i].trim(); return { note: `select option "${opts[i].trim()}"` }; }
    }
    for (const role of ['radio', 'button', 'tab', 'option']) {
      const l = await firstVisible(page.getByRole(role, { name: /\bbox\b/i }));
      if (l) { if (role === 'radio') await l.check(); else await l.click(); state.unit = role; return { note: `${role} "box"` }; }
    }
    const lbl = await firstVisible(page.getByLabel(/\bbox\b/i));
    if (lbl) { await lbl.click(); return { note: 'label "box"' }; }
    return { skip: 'no packaging-unit control mentioning "box" (default unit kept)' };
  }],
  add: ['add-to-cart', async ({ page }) => {
    const f = await findClickable(page, /add to (cart|basket)|in den warenkorb|^\s*add\s*$/i, { roles: ['button'] })
      || await findClickable(page, /add to (cart|basket)/i, { roles: ['link'] });
    if (!f) return { skip: 'no add-to-cart button (expected for guests: they see no order option)' };
    const qty = await firstVisible(page.getByRole('spinbutton'));
    if (qty && (await qty.inputValue().catch(() => '1')) !== '1') await qty.fill('1');
    await f.el.click(); return { note: f.how };
  }],
  cart: ['open-cart', async ({ page }) => {
    let f = await findClickable(page, /\b(cart|basket|warenkorb)\b/i, { roles: ['link'] })
      || await findClickable(page, /\b(cart|basket|warenkorb)\b/i, { roles: ['button'] })
      || await findClickable(page, /\b(cart|basket|warenkorb)\b/i, { roles: ['link'], allowHidden: true });
    if (!f) return { skip: 'no cart link/button' };
    await clickOrGo(page, f);
    // a mini-cart drawer may open instead of a page: follow its "view cart" link if present
    const v = await findClickable(page, /view (cart|basket)|go to (cart|basket)|zum warenkorb/i, { roles: ['link', 'button'], wait: 1000 });
    if (v) { await clickOrGo(page, v); return { note: f.how + ' + view-cart' }; }
    return { note: f.how };
  }],
  qty: ['change-quantity', async ({ page }) => {
    const spin = await findVisible(() => firstVisible(page.getByRole('spinbutton')));
    if (spin) {
      await spin.fill('2'); await spin.press('Tab');
      const upd = await findClickable(page, /^\s*(update|recalculate|aktualisieren)\b/i, { roles: ['button'], wait: 0 });
      if (upd) { await new Promise(r => setTimeout(r, 300)); await upd.el.click(); return { note: 'spinbutton=2 + update button' }; }
      return { note: 'spinbutton=2 + blur' };
    }
    const plus = await findClickable(page, /^\s*\+\s*$|increase|increment|plus|erhöhen/i, { roles: ['button'] });
    if (plus) { await plus.el.click(); return { note: 'plus button' }; }
    return { skip: 'no quantity control in cart' };
  }],
  code: ['apply-promo-code', async ({ page }) => {
    const box = await findVisible(async () => await firstVisible(page.getByLabel(/code|coupon|voucher|promo|gutschein/i))
      || await firstVisible(page.getByPlaceholder(/code|coupon|voucher|promo|gutschein/i))
      || await firstVisible(page.locator('input[name*=code i], input[name*=coupon i], input[name*=promo i], input[name*=voucher i]')));
    if (!box) return { skip: 'no promotion code field' };
    await box.fill(PROMO_CODE);
    const b = await findClickable(page, /^\s*(apply|redeem|einlösen|anwenden|use code)\b/i, { roles: ['button'] });
    if (b) { await b.el.click(); return { note: 'filled + apply button' }; }
    await box.press('Enter'); return { note: 'filled + Enter' };
  }],
  checkout: ['open-checkout', async ({ page }) => {
    const f = await findClickable(page, /checkout|check out|proceed|zur kasse|kasse/i, { roles: ['link', 'button'] });
    if (!f) return { skip: 'no checkout link/button' };
    await clickOrGo(page, f); return { note: f.how };
  }],
  login: ['open-login', async ({ page }) => {
    await page.goto(BASE + '/', { timeout: 30000 });
    const f = await findClickable(page, /^\s*(log ?in|sign ?in|anmelden|login \/ register|account)\b/i, { roles: ['link', 'button'], allowHidden: true });
    if (!f) return { skip: 'no login link' };
    await clickOrGo(page, f);
    if (!(await findVisible(() => firstVisible(page.locator('input[type=password]')), 2500))) {
      const g = await findClickable(page, /^\s*(log ?in|sign ?in|anmelden)\b/i, { roles: ['link', 'button'], wait: 0 });
      if (g) await clickOrGo(page, g);
    }
    return { note: f.how };
  }],
  submitLogin: ['submit-login', async ({ page }) => {
    const pw = await findVisible(() => firstVisible(page.locator('input[type=password]')));
    const em = await firstVisible(page.getByLabel(/e-?mail/i)) || await firstVisible(page.locator('input[type=email], input[name=email], input[autocomplete=username], input[name=login]'));
    if (!pw || !em) return { skip: 'no email/password fields' };
    await em.fill(CUSTOMER.email); await pw.fill(CUSTOMER.password);
    const b = await findClickable(page, /^\s*(log ?in|sign ?in|anmelden|continue|submit)\b/i, { roles: ['button'] });
    if (b) await b.el.click(); else await pw.press('Enter');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    const out = await page.getByRole('button', { name: /log ?out|sign ?out|abmelden/i }).count().catch(() => 0)
      + await page.getByRole('link', { name: /log ?out|sign ?out|abmelden|my account|mein konto/i }).count().catch(() => 0);
    const formGone = !(await firstVisible(page.locator('input[type=password]')));
    return { note: out ? 'signed in (logout/account control present)' : formGone ? 'signed in (login form gone)' : 'submitted; sign-in not confirmed (login form still visible)' };
  }],
};

const PLACE_ORDER = /place (the )?order|buy now|submit order|complete order|confirm (the )?order|order now|pay now|zahlungspflichtig|kostenpflichtig|bestellung absenden/i;
function checkoutSteps(max = 6) {
  const out = [];
  for (let i = 1; i <= max; i++) {
    out.push([`checkout-step-${i}`, async ({ page, state }) => {
      if (state.reachedReview) return { skip: 'review already reached' };
      if (await findClickable(page, PLACE_ORDER, { roles: ['button'], wait: 1500 })) { state.reachedReview = true; return { skip: 'review reached (place-order button visible; not clicked)' }; }
      const picked = [];
      // choose the first option in every visible radio group that has nothing selected
      const radios = await page.getByRole('radio').all();
      const groups = new Map();
      for (const r of radios) {
        if (!(await r.isVisible().catch(() => false)) || !(await r.isEnabled().catch(() => false))) continue;
        const n = (await r.getAttribute('name').catch(() => null)) || 'unnamed';
        if (!groups.has(n)) groups.set(n, []);
        groups.get(n).push(r);
      }
      for (const [n, rs] of groups) {
        let any = false;
        for (const r of rs) if (await r.isChecked().catch(() => false)) any = true;
        if (!any) { await rs[0].check().catch(() => rs[0].click()); picked.push(n); await new Promise(r => setTimeout(r, 400)); }
      }
      const b = await findClickable(page, /^\s*(continue|next|weiter|review|proceed|save and continue|use this address|to payment|to review|zur zahlung|zur übersicht)\b/i, { roles: ['button', 'link'] });
      if (!b) {
        if (await findClickable(page, PLACE_ORDER, { roles: ['button'], wait: 0 })) { state.reachedReview = true; return { note: `selected ${picked.join(',') || 'nothing'}; review reached` }; }
        return { skip: `no continue/next control${picked.length ? ` (selected ${picked.join(',')})` : ''}` };
      }
      await clickOrGo(page, b);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      if (await findClickable(page, PLACE_ORDER, { roles: ['button'], wait: 2000 })) state.reachedReview = true;
      return { note: `selected ${picked.join(',') || 'nothing'}; clicked ${b.how}${state.reachedReview ? '; review reached' : ''}` };
    }]);
  }
  return out;
}

const { pw, from } = loadPlaywright();
const browser = await pw.chromium.launch({ headless: !args.headed });
const t0 = new Date().toISOString();
const guest = await journey(browser, 'guest', [S.home, S.category, S.search, S.product, S.unit, S.add, S.cart]);
const customer = await journey(browser, 'customer', [S.login, S.submitLogin, S.home, S.category, S.search, S.product, S.unit, S.add, S.cart, S.qty, S.code, S.checkout, ...checkoutSteps()]);
const result = {
  schema: 'oss-perf-journey/1', base_url: BASE, started_at: t0, finished_at: new Date().toISOString(),
  playwright_core: from, chromium: browser.version(),
  fixed_data: { customer: CUSTOMER.id, product: PRODUCT.sku, promo_code: PROMO_CODE },
  runtime_evidence: Object.fromEntries(Object.keys({ ...guest.evidence, ...customer.evidence }).map(k => [k, k === 'livewire_components' ? Math.max(guest.evidence[k] || 0, customer.evidence[k] || 0) : !!(guest.evidence[k] || customer.evidence[k])])),
  actions: [...guest.actions, ...customer.actions],
};
await browser.close();
writeFileSync(OUT, JSON.stringify(result, null, 2));
const c = (s) => result.actions.filter(a => a.status === s).length;
console.log(JSON.stringify({ out: OUT, actions: result.actions.length, ok: c('ok'), skipped: c('skipped'), error: c('error') }));
