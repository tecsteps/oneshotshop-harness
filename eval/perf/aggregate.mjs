#!/usr/bin/env node
// node aggregate.mjs <perf-dir> [--run-id id] [--min-scan-rows 50]
// Reads (all optional): journey.json, journey-requests.jsonl, journey-explain.json,
//   qa-requests.jsonl, qa-explain.json, stack.json, prepare.json
// Writes <perf-dir>/summary.json. Machine-independent work metrics first; *_ms only as secondary.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const DIR = argv[0];
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const RUN_ID = opt('run-id', path.basename(path.dirname(path.resolve(DIR))));
const MIN_SCAN_ROWS = Number(opt('min-scan-rows', process.env.OSS_PERF_MIN_SCAN_ROWS || 50));
const f = (n) => path.join(DIR, n);
const readJson = (n) => { try { return JSON.parse(readFileSync(f(n), 'utf8')); } catch { return null; } };
const readJsonl = (n) => {
  if (!existsSync(f(n))) return null;
  const out = [];
  for (const line of readFileSync(f(n), 'utf8').split('\n')) { if (line.trim()) { try { out.push(JSON.parse(line)); } catch { /* torn line */ } } }
  return out;
};

const pct = (arr, p) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]; };
const dist = (arr) => { const a = arr.filter((x) => x != null); return a.length ? { n: a.length, p50: pct(a, 50), p95: pct(a, 95), max: Math.max(...a), mean: Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10, sum: a.reduce((s, x) => s + x, 0) } : null; };
const countBy = (arr, fn) => arr.reduce((o, x) => { const k = fn(x); o[k] = (o[k] || 0) + 1; return o; }, {});

// The page a request belongs to: Livewire updates carry their page path, XHR/API calls the Referer.
function pagePath(r) {
  const lw = r.extra?.livewire?.page_path;
  if (r.kind === 'livewire') return lw ? '/' + String(lw).replace(/^\/+/, '') : (r.req?.referer_path || r.req?.path);
  if (r.kind === 'json' || (r.req?.xhr && r.kind !== 'inertia')) return r.req?.referer_path || r.req?.path;
  return r.req?.path;
}
// Loose, architecture-agnostic page typing from the URL (+ route name) only.
function pageType(p, r) {
  const s = `${(p || '').toLowerCase()} ${(r?.req?.route_name || '').toLowerCase()}`;
  const q = (r?.req?.query || '').toLowerCase();
  if (/(^|[\s/.])(admin|filament|backoffice|backend|staff|manage)\b/.test(s)) return 'admin';
  if (/log-?in|log-?out|register|sign-?(in|up|out)|password|forgot|verify-email|two-factor/.test(s)) return 'auth';
  if (/checkout|kasse|order-?confirm|thank-?you/.test(s)) return 'checkout';
  if (/\b(cart|basket|warenkorb)\b/.test(s)) return 'cart';
  if (/search|suche/.test(s) || /(^|&)(q|query|search|term)=/.test(q)) return 'search';
  if (/account|profile|my-|\/orders|invoices?|addresses|konto|quick-?order|order-?lists?|dashboard/.test(s)) return 'account';
  if (/products?\b|produkt|\/p\/|\bitem\b|\bsku\b/.test(s)) return 'product';
  if (/categor|kategor|\/c\/|catalog|collection|\/shop\b|browse/.test(s)) return 'category';
  if ((p || '') === '/' || /\bhome\b/.test(s)) return 'home';
  if (/^\/api\//.test(p || '')) return 'api-other';
  return 'other';
}

function stmtIndex(records) {
  const m = new Map();
  for (const r of records) for (const s of r.db?.statements || []) {
    const e = m.get(s.h) || { h: s.h, sql: s.sql, executions: 0, requests: 0, max_per_request: 0 };
    e.executions += s.n; e.requests += 1; e.max_per_request = Math.max(e.max_per_request, s.n);
    m.set(s.h, e);
  }
  return m;
}

function scanReport(explain, stmts) {
  if (!explain || !Array.isArray(explain.statements)) return null;
  const full = [], suspects = [], indexScans = [], temp = [];
  for (const st of explain.statements) {
    const use = stmts.get(st.h) || { executions: 0, requests: 0 };
    for (const sc of st.full_scans || []) {
      const e = { table: sc.table, rows: sc.rows, executions: use.executions, requests: use.requests,
        rows_examined_estimate: sc.rows != null ? sc.rows * use.executions : null, unindexed_filter_columns: sc.unindexed_filter_columns || [], like_columns: sc.like_columns || [], sql: st.sql.slice(0, 400), h: st.h };
      if ((sc.rows ?? 0) >= MIN_SCAN_ROWS) { full.push(e); if (e.unindexed_filter_columns.length) suspects.push(e); }
    }
    for (const sc of st.index_scans || []) if ((sc.rows ?? 0) >= MIN_SCAN_ROWS) indexScans.push({ table: sc.table, rows: sc.rows, index: sc.index, executions: use.executions, sql: st.sql.slice(0, 200) });
    if ((st.temp_btree || []).length) temp.push({ detail: st.temp_btree, executions: use.executions, sql: st.sql.slice(0, 200) });
  }
  const byRows = (a, b) => (b.rows_examined_estimate ?? 0) - (a.rows_examined_estimate ?? 0);
  return {
    min_rows: MIN_SCAN_ROWS,
    statements_explained: explain.statements.length,
    explain_errors: explain.statements.filter((s) => s.error).length,
    full_table_scans: { distinct_statements: full.length, executions: full.reduce((s, e) => s + e.executions, 0), rows_examined_estimate: full.reduce((s, e) => s + (e.rows_examined_estimate || 0), 0), top: full.sort(byRows).slice(0, 25) },
    missing_index_suspects: { distinct_statements: suspects.length, top: suspects.sort(byRows).slice(0, 25) },
    full_index_scans: { distinct_statements: indexScans.length, top: indexScans.slice(0, 10) },
    temp_btree: { distinct_statements: temp.length, executions: temp.reduce((s, e) => s + e.executions, 0) },
    tables: explain.tables || {},
    sqlite_version: explain.sqlite_version || null,
  };
}

function requestStats(all, explain) {
  if (!all) return null;
  const assets = all.filter((r) => r.kind === 'asset');
  const records = all.filter((r) => r.req?.ua_marker !== 'check' && r.kind !== 'asset');
  const stmts = stmtIndex(records);
  const n1Distinct = new Map();
  for (const r of records) for (const n of r.db?.n_plus_one || []) {
    const e = n1Distinct.get(n.h) || { h: n.h, sql: n.sql, requests: 0, max_n: 0, pages: new Set() };
    e.requests++; e.max_n = Math.max(e.max_n, n.n); e.pages.add(pageType(pagePath(r), r)); n1Distinct.set(n.h, e);
  }
  const block = (rs) => ({
    requests: rs.length,
    queries_per_request: dist(rs.map((r) => r.db?.queries)),
    distinct_statements_per_request: dist(rs.map((r) => r.db?.distinct)),
    repeated_executions_per_request: dist(rs.map((r) => r.db?.repeated_executions)),
    exact_duplicates_per_request: dist(rs.map((r) => r.db?.exact_duplicates)),
    requests_with_n_plus_one: rs.filter((r) => (r.db?.n_plus_one || []).length).length,
    writes_per_request: dist(rs.map((r) => r.db?.writes)),
    memory_peak_bytes: dist(rs.map((r) => r.memory_peak_bytes)),
    response_bytes: dist(rs.map((r) => r.resp?.bytes)),
    request_bytes: dist(rs.map((r) => r.req?.bytes)),
    secondary_ms: { duration: dist(rs.map((r) => r.duration_ms)), query_time: dist(rs.map((r) => r.db?.time_ms)) },
  });
  const byPage = {};
  for (const r of records) { const t = pageType(pagePath(r), r); (byPage[t] ||= []).push(r); }
  const byKind = {};
  for (const r of records) (byKind[r.kind] ||= []).push(r);
  return {
    ...block(records),
    excluded_harness_check_requests: all.filter((r) => r.req?.ua_marker === 'check').length,
    excluded_assets_served_by_laravel: { requests: assets.length, bytes: assets.reduce((s, r) => s + (r.resp?.bytes || 0), 0), paths: [...new Set(assets.map((r) => r.req?.path))].slice(0, 10) },
    by_kind: Object.fromEntries(Object.entries(byKind).map(([k, rs]) => [k, block(rs)])),
    by_page_type: Object.fromEntries(Object.entries(byPage).map(([k, rs]) => [k, block(rs)])),
    status_classes: countBy(records, (r) => `${String(r.resp?.status ?? 'none')[0]}xx`),
    n_plus_one: {
      threshold: 5,
      distinct_statements: n1Distinct.size,
      top: [...n1Distinct.values()].sort((a, b) => b.requests * b.max_n - a.requests * a.max_n).slice(0, 20).map((e) => ({ ...e, pages: [...e.pages] })),
    },
    top_statements_by_executions: [...stmts.values()].sort((a, b) => b.executions - a.executions).slice(0, 15),
    heaviest_requests: [...records].sort((a, b) => (b.db?.queries || 0) - (a.db?.queries || 0)).slice(0, 10)
      .map((r) => ({ kind: r.kind, method: r.req?.method, path: r.req?.path, page_type: pageType(pagePath(r), r), queries: r.db?.queries, n_plus_one: (r.db?.n_plus_one || []).length, memory_peak_bytes: r.memory_peak_bytes })),
    scans: scanReport(explain, stmts),
  };
}

const INTERACTIONS = /^(submit-login|search-sku|select-box-unit|add-to-cart|change-quantity|apply-promo-code|checkout-step-\d+)$/;
function journeyReport(journey, records) {
  if (!journey) return null;
  const byId = new Map((records || []).map((r) => [r.id, r]));
  const seen = new Set();
  for (const a of journey.actions) for (const b of a.backend_requests || []) if (b.perf_id) seen.add(b.perf_id);
  const actions = journey.actions.map((a) => {
    const reqs = (a.backend_requests || []);
    const server = reqs.map((b) => byId.get(b.perf_id)).filter(Boolean);
    const lw = server.filter((r) => r.kind === 'livewire');
    const inert = server.filter((r) => r.kind === 'inertia');
    const json = server.filter((r) => r.kind === 'json');
    return {
      journey: a.journey, action: a.action, status: a.status, note: a.note, kind: INTERACTIONS.test(a.action) ? 'interaction' : 'navigation',
      url_after: a.url_after,
      round_trips: reqs.length,
      round_trips_by_type: countBy(reqs, (b) => (b.nav ? 'document' : b.type)),
      round_trips_by_server_kind: countBy(server, (r) => r.kind),
      round_trips_unmatched_by_probe: reqs.filter((b) => !b.perf_id).length,
      request_bytes: reqs.reduce((s, b) => s + (b.req_bytes || 0), 0),
      response_bytes: reqs.reduce((s, b) => s + (b.resp_bytes || 0), 0),
      queries: server.reduce((s, r) => s + (r.db?.queries || 0), 0),
      max_queries_in_one_request: Math.max(0, ...server.map((r) => r.db?.queries || 0)),
      n_plus_one_statements: server.reduce((s, r) => s + (r.db?.n_plus_one || []).length, 0),
      exact_duplicate_queries: server.reduce((s, r) => s + (r.db?.exact_duplicates || 0), 0),
      writes: server.reduce((s, r) => s + (r.db?.writes || 0), 0),
      memory_peak_bytes_max: server.length ? Math.max(...server.map((r) => r.memory_peak_bytes || 0)) : null,
      livewire: lw.length ? { updates: lw.length, components_in_requests: lw.reduce((s, r) => s + (r.extra?.livewire?.components?.length || 0), 0), snapshot_bytes_sent: lw.reduce((s, r) => s + (r.extra?.livewire?.snapshot_bytes || 0), 0), calls: lw.flatMap((r) => r.extra?.livewire?.calls || []) } : undefined,
      livewire_components_on_page: a.livewire_components_on_page || undefined,
      inertia: inert.length ? { visits: inert.length, props_bytes: inert.reduce((s, r) => s + (r.extra?.inertia?.props_bytes || 0), 0) } : undefined,
      json_api: json.length ? { calls: json.length, response_bytes: json.reduce((s, r) => s + (r.resp?.bytes || 0), 0), endpoints: json.map((r) => `${r.req?.method} ${r.req?.route_uri ? '/' + r.req.route_uri.replace(/^\//, '') : r.req?.path}`) } : undefined,
      static_requests: a.static_requests,
      secondary_ms: { wall: a.wall_ms, server: Math.round(server.reduce((s, r) => s + (r.duration_ms || 0), 0)) },
      t_start: a.t_start,
    };
  });
  const unmatched = (records || []).filter((r) => !seen.has(r.id) && r.req?.ua_marker !== 'check' && r.kind !== 'asset');
  const totals = (label) => {
    const as = actions.filter((a) => a.journey === label);
    const sum = (k, filt = () => true) => as.filter(filt).reduce((s, a) => s + (a[k] || 0), 0);
    const inter = (a) => a.kind === 'interaction' && a.status === 'ok';
    return {
      actions: as.length, ok: as.filter((a) => a.status === 'ok').length, skipped: as.filter((a) => a.status === 'skipped' && !/review (already )?reached/.test(a.note || '')).map((a) => a.action), errors: as.filter((a) => a.status === 'error').map((a) => a.action),
      round_trips: sum('round_trips'), request_bytes: sum('request_bytes'), response_bytes: sum('response_bytes'), queries: sum('queries'),
      n_plus_one_statements: sum('n_plus_one_statements'), exact_duplicate_queries: sum('exact_duplicate_queries'),
      interactions: { count: as.filter(inter).length, round_trips: sum('round_trips', inter), queries: sum('queries', inter), request_bytes: sum('request_bytes', inter), response_bytes: sum('response_bytes', inter) },
    };
  };
  const per = (name) => { const a = actions.find((x) => x.journey === 'customer' && x.action === name); return a && a.status === 'ok' ? { round_trips: a.round_trips, queries: a.queries, response_bytes: a.response_bytes, request_bytes: a.request_bytes } : (a ? { status: a.status, note: a.note } : null); };
  const steps = actions.filter((a) => a.journey === 'customer' && /^checkout-step-/.test(a.action) && a.status === 'ok');
  return {
    fixed_data: journey.fixed_data, base_url: journey.base_url, chromium: journey.chromium,
    guest: totals('guest'), customer: totals('customer'),
    customer_interactions: {
      search_typing: per('search-sku'), select_unit: per('select-box-unit'), add_to_cart: per('add-to-cart'), change_quantity: per('change-quantity'),
      apply_promo_code: per('apply-promo-code'),
      checkout_steps: { steps: steps.length, reached_review: actions.some((a) => a.journey === 'customer' && /review reached/.test(a.note || '')),
        round_trips: steps.reduce((s, a) => s + a.round_trips, 0), queries: steps.reduce((s, a) => s + a.queries, 0), response_bytes: steps.reduce((s, a) => s + a.response_bytes, 0) },
    },
    server_requests_not_seen_by_browser: { count: unmatched.length, by_kind: countBy(unmatched, (r) => r.kind), note: 'e.g. server-side rendering calls of a separate frontend, or requests outside the journey' },
    actions,
  };
}

// ------------------------------------------------------------------------------ main
const journey = readJson('journey.json');
const jReq = readJsonl('journey-requests.jsonl');
const qaReq = readJsonl('qa-requests.jsonl');
const stack = readJson('stack.json') || {};
const prepare = readJson('prepare.json');
const jStats = requestStats(jReq, readJson('journey-explain.json'));
const qaStats = requestStats(qaReq, readJson('qa-explain.json'));
const jRep = journeyReport(journey, jReq);

// Stack: declared (files) + runtime (browser) + probe (request kinds actually served).
const kindsSeen = new Set([...(jReq || []), ...(qaReq || [])].map((r) => r.kind));
const htmlInertia = [...(jReq || []), ...(qaReq || [])].some((r) => r.extra?.html?.inertia_page_bytes);
const ev = journey?.runtime_evidence || {};
const d = stack.declared || {};
const detected = {
  livewire: !!(d.livewire || kindsSeen.has('livewire') || ev.livewire),
  filament: !!d.filament,
  inertia: !!(d.inertia_laravel || d.inertia_client || kindsSeen.has('inertia') || htmlInertia || ev.inertia),
  vue: !!(d.vue || ev.vue), react: !!(d.react || ev.react), svelte: !!(d.svelte || ev.svelte),
  alpine: !!(d.alpine || ev.alpine), htmx: !!(d.htmx || ev.htmx), next: !!(d.next || ev.next), nuxt: !!(d.nuxt || ev.nuxt),
  json_api: kindsSeen.has('json'),
};
detected.spa_api = detected.json_api && !detected.livewire && !detected.inertia;

const allRecs = [...(jReq || []), ...(qaReq || [])];
const extras = {};
if (detected.livewire) {
  const lw = allRecs.filter((r) => r.kind === 'livewire');
  const html = allRecs.filter((r) => r.kind === 'html' && r.extra?.html);
  const comps = {};
  for (const r of html) { const t = pageType(pagePath(r), r); (comps[t] ||= []).push(r.extra.html.livewire_components); }
  extras.livewire = {
    components_per_page_by_type: Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, dist(v)])),
    snapshot_bytes_in_html: dist(html.map((r) => r.extra.html.livewire_snapshot_bytes)),
    update_request_bytes: dist(lw.map((r) => r.req?.bytes)),
    update_response_bytes: dist(lw.map((r) => r.resp?.bytes)),
    components_per_update: dist(lw.map((r) => r.extra?.livewire?.components?.length)),
    updates_by_component: countBy(lw.flatMap((r) => r.extra?.livewire?.components || []), (c) => c),
  };
}
if (detected.inertia) {
  const iv = allRecs.filter((r) => r.kind === 'inertia');
  const html = allRecs.filter((r) => r.extra?.html?.inertia_page_bytes);
  const byComp = {};
  for (const r of [...iv, ...html]) { const c = r.extra?.inertia?.component || r.extra?.html?.inertia_component || '?'; (byComp[c] ||= []).push(r.extra?.inertia?.props_bytes ?? r.extra?.html?.inertia_page_bytes); }
  extras.inertia = { initial_page_object_bytes: dist(html.map((r) => r.extra.html.inertia_page_bytes)), visit_props_bytes: dist(iv.map((r) => r.extra?.inertia?.props_bytes)), props_bytes_by_component: Object.fromEntries(Object.entries(byComp).map(([k, v]) => [k, dist(v)])) };
}
if (detected.json_api) {
  const js = allRecs.filter((r) => r.kind === 'json');
  const byEp = {};
  for (const r of js) { const k = `${r.req?.method} /${(r.req?.route_uri || r.req?.path || '').replace(/^\//, '')}`; (byEp[k] ||= []).push(r); }
  extras.json_api = {
    response_bytes: dist(js.map((r) => r.resp?.bytes)),
    endpoints: Object.entries(byEp).map(([k, rs]) => ({ endpoint: k, calls: rs.length, queries_p50: pct(rs.map((r) => r.db?.queries), 50), response_bytes_p50: pct(rs.map((r) => r.resp?.bytes), 50) })).sort((a, b) => b.calls - a.calls).slice(0, 30),
    calls_per_journey_action: jRep ? Object.fromEntries(jRep.actions.filter((a) => a.json_api).map((a) => [`${a.journey}:${a.action}`, a.json_api.calls])) : null,
  };
}
if (detected.filament) {
  const adm = allRecs.filter((r) => pageType(pagePath(r), r) === 'admin');
  extras.filament_admin = { requests: adm.length, queries_per_request: dist(adm.map((r) => r.db?.queries)), requests_with_n_plus_one: adm.filter((r) => (r.db?.n_plus_one || []).length).length, note: adm.length ? null : 'no admin traffic recorded (journey does not visit admin; comes from the QA session)' };
}

const pick = (s) => s && {
  requests: s.requests, queries_per_request_p50: s.queries_per_request?.p50 ?? null, queries_per_request_p95: s.queries_per_request?.p95 ?? null, queries_per_request_max: s.queries_per_request?.max ?? null,
  requests_with_n_plus_one_pct: s.requests ? Math.round((1000 * s.requests_with_n_plus_one) / s.requests) / 10 : null, n_plus_one_distinct_statements: s.n_plus_one.distinct_statements,
  exact_duplicates_per_request_p95: s.exact_duplicates_per_request?.p95 ?? null,
  full_table_scan_statements: s.scans?.full_table_scans.distinct_statements ?? null, missing_index_suspects: s.scans?.missing_index_suspects.distinct_statements ?? null,
  memory_peak_bytes_p95: s.memory_peak_bytes?.p95 ?? null, html_response_bytes_p50: s.by_kind?.html?.response_bytes?.p50 ?? null,
};
const summary = {
  schema: 'oss-perf-summary/1', run_id: RUN_ID, generated_at: new Date().toISOString(),
  note: 'Work metrics are machine-independent (counts, bytes); every *_ms value is secondary and depends on the host CPU.',
  probe: prepare,
  stack: { declared: stack.declared || null, package_json_files: stack.package_json_files || null, runtime_evidence: ev, request_kinds_seen: [...kindsSeen].sort(), detected, extras_ran: Object.keys(extras) },
  headline: {
    journey_customer: jRep ? { round_trips: jRep.customer.round_trips, queries: jRep.customer.queries, response_bytes: jRep.customer.response_bytes, interaction_round_trips: jRep.customer.interactions.round_trips, interaction_queries: jRep.customer.interactions.queries, interaction_response_bytes: jRep.customer.interactions.response_bytes, skipped: jRep.customer.skipped } : null,
    journey_server: pick(jStats),
    qa_server: pick(qaStats),
  },
  journey: jRep,
  server: { journey: jStats, qa: qaStats },
  extras,
};
writeFileSync(f('summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ summary: f('summary.json'), journey_actions: jRep?.actions.length ?? 0, journey_requests: jReq?.length ?? 0, qa_requests: qaReq?.length ?? 0, extras_ran: summary.stack.extras_ran }));
