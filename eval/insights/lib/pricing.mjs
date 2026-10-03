// Price lookup + cost computation following the agentic-engineers website rules.
import { readFileSync } from "node:fs";

export function loadPricing(path) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  for (const m of cfg.models) m._re = m.match.map((r) => new RegExp(r, "i"));
  return cfg;
}

export function findPrice(cfg, model) {
  if (!model) return null;
  return cfg.models.find((m) => m._re.some((re) => re.test(model))) || null;
}

function rate(p, key) {
  return Number(p?.[key] ?? 0);
}

/**
 * Cost for aggregated token buckets.
 * buckets: { uncachedInput, cachedInput, cacheWrite, output }
 * highShare (optional): per-bucket share of tokens that were billed at the high tier
 * (website rule 3: tier on per-request prompt size, blend, apply to authoritative totals).
 */
export function costFor(price, buckets, highShare = null) {
  if (!price) return null;
  const hi = price.tiers?.high;
  const blended = (key, shareKey) => {
    const lo = rate(price, key);
    if (!hi || !highShare) return lo;
    const s = highShare[shareKey] || 0;
    return (1 - s) * lo + s * rate(hi, key);
  };
  const c = {
    inputCost: ((buckets.uncachedInput || 0) / 1e6) * blended("input", "uncachedInput"),
    cachedInputCost: ((buckets.cachedInput || 0) / 1e6) * blended("cachedInput", "cachedInput"),
    cacheWriteCost: ((buckets.cacheWrite || 0) / 1e6) * blended("cacheWrite", "cacheWrite") + ((buckets.cacheWrite1h || 0) / 1e6) * rate(price, price.cacheWrite1h != null ? "cacheWrite1h" : "cacheWrite"),
    outputCost: ((buckets.output || 0) / 1e6) * blended("output", "output"),
  };
  c.totalCost = c.inputCost + c.cachedInputCost + c.cacheWriteCost + c.outputCost;
  for (const k of Object.keys(c)) c[k] = Math.round(c[k] * 10000) / 10000;
  return c;
}

export function priceRef(price) {
  if (!price) return null;
  const { _re, match, ...rest } = price;
  return rest;
}
