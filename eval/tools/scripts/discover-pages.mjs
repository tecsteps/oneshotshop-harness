// Discovers the fixed storefront pages (home, category, WAT-001, NF-005, cart) as a guest and
// writes /out/pages.json. Used by axe and Lighthouse so both scan the same URLs.
import { require, discoverPages, writeJson, CHROMIUM_ARGS, BASE_URL } from './browser-lib.mjs';

const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
try {
  const pages = await discoverPages(browser);
  writeJson('/out/pages.json', { base_url: BASE_URL, discovered_at: new Date().toISOString(), pages });
  for (const p of pages) console.error(`[pages] ${p.id}: ${p.status} ${p.url || p.reason}`);
} finally {
  await browser.close();
}
