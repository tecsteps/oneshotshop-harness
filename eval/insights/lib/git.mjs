// Read-only git analysis of a run branch: commits, timeline, LOC per language, tests,
// migrations/tables, stack detection (composer/npm diff vs base) and keyword hits for
// the hard B2B cases. Never checks out or modifies anything: everything is read from
// the ref via git log / ls-tree / cat-file / show.
import { spawnSync } from "node:child_process";
import { extname } from "node:path";

function git(repo, args, { buffer = false, input } = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { maxBuffer: 1 << 30, ...(buffer ? {} : { encoding: "utf8" }), input: input == null ? undefined : Buffer.from(input) });
  if (r.status !== 0) return null;
  return r.stdout;
}

export const EXCLUDE = [
  /(^|\/)vendor\//,
  /(^|\/)node_modules\//,
  /^public\/(build|vendor|hot|js|css|fonts)\//,
  /^public\/.*\.(min\.)?(js|css|map)$/,
  /^storage\//,
  /^bootstrap\/cache\//,
  /(^|\/)\.phpunit\.cache\//,
  /(^|\/)(composer|package)-lock\.json$|composer\.lock$|yarn\.lock$|pnpm-lock\.yaml$/,
  /\.min\.(js|css)$/,
  /(^|\/)(test-results|playwright-report|coverage)\//,
];
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|svg|pdf|zip|gz|woff2?|ttf|eot|otf|mp4|mp3|sqlite|db|phar|lock)$/i;

const LANG = [
  [/\.blade\.php$/, "Blade"],
  [/\.php$/, "PHP"],
  [/\.(ts|mts|cts)$/, "TypeScript"],
  [/\.tsx$/, "TSX"],
  [/\.(js|mjs|cjs)$/, "JavaScript"],
  [/\.jsx$/, "JSX"],
  [/\.vue$/, "Vue"],
  [/\.svelte$/, "Svelte"],
  [/\.(css|scss|sass|less|pcss)$/, "CSS"],
  [/\.(html?)$/, "HTML"],
  [/\.json$/, "JSON"],
  [/\.(ya?ml)$/, "YAML"],
  [/\.(md|markdown)$/, "Markdown"],
  [/\.(sh|bash)$/, "Shell"],
  [/\.sql$/, "SQL"],
  [/\.(xml|neon|dist)$/, "Config"],
];
export function langOf(path) {
  for (const [re, l] of LANG) if (re.test(path)) return l;
  return extname(path) ? `other(${extname(path)})` : "other";
}

export function resolveRef(repo, ref) {
  const out = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return out ? out.trim() : null;
}

export function resolveBase(repo, ref, base) {
  if (base) return resolveRef(repo, base);
  for (const cand of ["main", "origin/main", "master", "origin/master"]) {
    if (!resolveRef(repo, cand)) continue;
    const mb = git(repo, ["merge-base", ref, cand]);
    if (mb && mb.trim() !== resolveRef(repo, ref)) return mb.trim();
  }
  return null;
}

/** Commits base..ref with numstat (excluded paths counted separately). */
export function commits(repo, ref, base) {
  const range = base ? `${base}..${ref}` : ref;
  const out = git(repo, ["log", "--reverse", "--numstat", "--format=%x1e%H%x1f%h%x1f%aI%x1f%cI%x1f%an%x1f%s%x1f%b%x1d", range]);
  if (out == null) return [];
  const list = [];
  for (const chunk of out.split("\x1e").slice(1)) {
    const [head, stats = ""] = chunk.split("\x1d");
    const [hash, short, authorDate, commitDate, author, subject, body] = head.split("\x1f");
    let ins = 0;
    let del = 0;
    let files = 0;
    let excludedIns = 0;
    for (const line of stats.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const path = m[3];
      const a = m[1] === "-" ? 0 : +m[1];
      const d = m[2] === "-" ? 0 : +m[2];
      if (EXCLUDE.some((re) => re.test(path))) {
        excludedIns += a;
        continue;
      }
      files++;
      ins += a;
      del += d;
    }
    list.push({ hash, short, authorDate, commitDate, author, subject, body: (body || "").trim().slice(0, 1500), filesChanged: files, insertions: ins, deletions: del, excludedInsertions: excludedIns });
  }
  return list;
}

export function timeline(list, startMs, bucketMinutes = 60) {
  if (!list.length) return [];
  const t0 = startMs ?? Date.parse(list[0].commitDate);
  const size = bucketMinutes * 60000;
  const buckets = new Map();
  for (const c of list) {
    const t = Date.parse(c.commitDate);
    const idx = Math.max(0, Math.floor((t - t0) / size));
    if (!buckets.has(idx)) buckets.set(idx, { bucket: idx, from: new Date(t0 + idx * size).toISOString(), commits: 0, insertions: 0, deletions: 0, subjects: [] });
    const b = buckets.get(idx);
    b.commits++;
    b.insertions += c.insertions;
    b.deletions += c.deletions;
    if (b.subjects.length < 6) b.subjects.push(`${c.short} ${c.subject.slice(0, 90)}`);
  }
  const max = Math.max(...buckets.keys());
  const out = [];
  for (let i = 0; i <= max; i++) out.push(buckets.get(i) || { bucket: i, from: new Date(t0 + i * size).toISOString(), commits: 0, insertions: 0, deletions: 0, subjects: [] });
  return out;
}

/** Map path -> content for all included text files at ref. */
export function readTree(repo, ref) {
  const out = git(repo, ["ls-tree", "-r", "-l", "-z", ref]);
  if (out == null) return { files: [], excluded: 0 };
  const entries = [];
  let excluded = 0;
  for (const rec of out.split("\0")) {
    const m = rec.match(/^(\d+) (\w+) ([0-9a-f]+)\s+(-|\d+)\t(.+)$/s);
    if (!m || m[2] !== "blob") continue;
    const path = m[5];
    if (EXCLUDE.some((re) => re.test(path)) || BINARY.test(path) || (m[4] !== "-" && +m[4] > 2_000_000)) {
      excluded++;
      continue;
    }
    entries.push({ sha: m[3], path });
  }
  if (!entries.length) return { files: [], excluded };
  const buf = git(repo, ["cat-file", "--batch"], { buffer: true, input: entries.map((e) => e.sha).join("\n") + "\n" });
  let off = 0;
  for (const e of entries) {
    const nl = buf.indexOf(10, off);
    const header = buf.subarray(off, nl).toString();
    const size = +header.split(" ")[2];
    const body = buf.subarray(nl + 1, nl + 1 + size);
    off = nl + 1 + size + 1;
    e.binary = body.includes(0);
    e.content = e.binary ? "" : body.toString("utf8");
  }
  return { files: entries.filter((e) => !e.binary), excluded };
}

export function locByLanguage(files) {
  const by = {};
  for (const f of files) {
    const lang = langOf(f.path);
    const lines = f.content.split("\n");
    const nonBlank = lines.filter((l) => l.trim()).length;
    by[lang] ||= { files: 0, lines: 0, nonBlankLines: 0 };
    by[lang].files++;
    by[lang].lines += lines.length - (f.content.endsWith("\n") ? 1 : 0);
    by[lang].nonBlankLines += nonBlank;
  }
  return Object.fromEntries(Object.entries(by).sort((a, b) => b[1].nonBlankLines - a[1].nonBlankLines));
}

const isTestFile = (p) => /(^|\/)tests?\//i.test(p) || /\.(spec|test)\.(m?[jt]sx?)$/.test(p) || /Test\.php$/.test(p) || /(^|\/)e2e\//.test(p);

export function testStats(files) {
  const tests = files.filter((f) => isTestFile(f.path) && /\.(php|m?[jt]sx?)$/.test(f.path) && !/\/(fixtures|stubs)\//i.test(f.path));
  const kinds = {};
  let total = 0;
  const perFile = [];
  for (const f of tests) {
    let n = 0;
    if (f.path.endsWith(".php")) {
      n += (f.content.match(/^\s*(public\s+)?function\s+test\w*\s*\(/gm) || []).length;
      n += (f.content.match(/#\[Test\]|@test\b/g) || []).length;
      n += (f.content.match(/^\s*(it|test)\s*\(\s*['"]/gm) || []).length;
    } else n += (f.content.match(/(^|[^.\w])(test|it)\s*\(\s*['"`]/gm) || []).length;
    if (!n && !/Test\.php$|\.(spec|test)\./.test(f.path)) continue;
    const kind = /\/Browser\//.test(f.path) || /\bvisit\(/.test(f.content) ? "browser" : /\.(m?[jt]sx?)$/.test(f.path) ? (/playwright/.test(f.content) ? "e2e-playwright" : "js") : /\/Unit\//.test(f.path) ? "php-unit" : /\/Feature\//.test(f.path) ? "php-feature" : "php-other";
    kinds[kind] ||= { files: 0, tests: 0 };
    kinds[kind].files++;
    kinds[kind].tests += n;
    total += n;
    perFile.push({ path: f.path, tests: n, kind });
  }
  perFile.sort((a, b) => b.tests - a.tests);
  return { testFiles: perFile.length, testCases: total, byKind: kinds, largestFiles: perFile.slice(0, 15) };
}

export function schemaStats(files) {
  const migrations = files.filter((f) => /^database\/migrations\/.+\.php$/.test(f.path));
  const created = new Set();
  const altered = new Set();
  for (const f of migrations) {
    for (const m of f.content.matchAll(/Schema::create\(\s*['"]([\w.]+)['"]/g)) created.add(m[1]);
    for (const m of f.content.matchAll(/Schema::table\(\s*['"]([\w.]+)['"]/g)) altered.add(m[1]);
    for (const m of f.content.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)/gi)) created.add(m[1]);
  }
  const all = files.filter((f) => /\.php$/.test(f.path));
  const fts5 = all.filter((f) => /fts5/i.test(f.content)).map((f) => f.path);
  return {
    migrationFiles: migrations.length,
    tablesCreated: created.size,
    tables: [...created].sort(),
    tablesAlteredLater: [...altered].filter((t) => created.has(t)).sort(),
    models: files.filter((f) => /^app\/Models\/.+\.php$/.test(f.path)).length,
    seeders: files.filter((f) => /^database\/seeders\/.+\.php$/.test(f.path)).length,
    factories: files.filter((f) => /^database\/factories\/.+\.php$/.test(f.path)).length,
    fts5Files: fts5,
  };
}

export function structure(files) {
  const appDirs = {};
  for (const f of files) {
    const m = f.path.match(/^app\/([^/]+)\//);
    if (m) appDirs[m[1]] = (appDirs[m[1]] || 0) + 1;
  }
  const routes = files.filter((f) => /^routes\/.+\.php$/.test(f.path));
  return {
    appDirectories: Object.fromEntries(Object.entries(appDirs).sort((a, b) => b[1] - a[1])),
    controllers: files.filter((f) => /^app\/Http\/Controllers\/.+\.php$/.test(f.path)).length,
    livewireComponents: files.filter((f) => /^app\/(Http\/)?Livewire\/.+\.php$/.test(f.path)).length,
    voltComponents: files.filter((f) => /resources\/views\/(livewire|pages)\/.+\.blade\.php$/.test(f.path) && /new\s+class\s+extends\s+Component|use function Livewire\\Volt/.test(f.content)).length,
    filamentResources: files.filter((f) => /^app\/Filament\/.+Resource\.php$/.test(f.path)).length,
    bladeViews: files.filter((f) => /\.blade\.php$/.test(f.path)).length,
    vueComponents: files.filter((f) => /\.vue$/.test(f.path)).length,
    reactComponents: files.filter((f) => /^resources\/js\/.+\.(tsx|jsx)$/.test(f.path)).length,
    alpineXDataUsages: files.reduce((s, f) => s + (/\.(blade\.php|html|js)$/.test(f.path) ? (f.content.match(/x-data/g) || []).length : 0), 0),
    routeFiles: routes.map((f) => f.path),
    routeDefinitions: routes.reduce((s, f) => s + (f.content.match(/Route::(get|post|put|patch|delete|match|any|resource|apiResource|view|redirect)\b|Volt::route|->name\(/g) || []).length, 0),
  };
}

// --- stack detection ---------------------------------------------------------
function readJsonAt(repo, ref, path) {
  if (!ref) return null;
  const s = git(repo, ["show", `${ref}:${path}`]);
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function depDiff(head = {}, base = {}) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of Object.entries(head)) {
    if (!(k in base)) added.push(`${k} ${v}`);
    else if (base[k] !== v) changed.push(`${k} ${base[k]} -> ${v}`);
  }
  for (const k of Object.keys(base)) if (!(k in head)) removed.push(k);
  return { added, removed, changed };
}

const NOTABLE = {
  framework: [/^laravel\/framework$/, /^laravel\/laravel$/],
  frontend: [/^livewire\//, /^inertiajs\//, /^@inertiajs\//, /^vue$/, /^react$/, /^react-dom$/, /^svelte$/, /^alpinejs$/, /^@alpinejs\//, /^tailwindcss$/, /^@tailwindcss\//, /^bootstrap$/, /^htmx\.org$/, /^@hotwired\//, /^laravel\/breeze$/, /^laravel\/jetstream$/, /^@headlessui\//, /^@radix-ui\//, /^shadcn/, /^daisyui$/, /^flowbite/, /^chart\.js$/, /^apexcharts$/],
  admin: [/^filament\//, /^laravel\/nova$/, /^backpack\//, /^moonshine\//],
  auth: [/^laravel\/fortify$/, /^laravel\/sanctum$/, /^laravel\/passport$/, /^spatie\/laravel-permission$/, /^laravel\/socialite$/],
  pdf: [/dompdf/, /snappy/, /browsershot/, /mpdf/, /tcpdf/, /fpdf/, /^spatie\/laravel-pdf$/],
  search: [/^laravel\/scout$/, /tntsearch/, /meilisearch/, /algolia/, /typesense/, /^teamtnt\//],
  queue: [/^laravel\/horizon$/, /^laravel\/pulse$/, /^laravel\/telescope$/],
  money: [/moneyphp/, /^brick\/money$/, /^brick\/math$/, /^akaunting\/laravel-money$/, /^cknow\/laravel-money$/],
  media: [/^intervention\/image/, /^spatie\/image/, /^spatie\/laravel-medialibrary$/],
  excel: [/maatwebsite\/excel/, /^spatie\/simple-excel$/, /^league\/csv$/, /^openspout\//],
  data: [/^spatie\/laravel-data$/, /^spatie\/laravel-query-builder$/, /^spatie\/laravel-activitylog$/, /^spatie\/laravel-model-states$/, /^spatie\/laravel-settings$/, /^spatie\/laravel-sluggable$/],
  testing: [/^pestphp\//, /^phpunit\/phpunit$/, /^laravel\/dusk$/, /^@playwright\/test$/, /^playwright$/, /^vitest$/, /^jest$/, /^mockery\/mockery$/],
  quality: [/^larastan\//, /^phpstan\//, /^laravel\/pint$/, /^rector\//, /^eslint$/, /^prettier$/, /^typescript$/],
  devtools: [/^laravel\/boost$/, /^laravel\/sail$/, /^laravel\/pail$/, /^barryvdh\/laravel-debugbar$/, /^barryvdh\/laravel-ide-helper$/],
};

export function stack(repo, ref, base) {
  const cj = readJsonAt(repo, ref, "composer.json");
  const cjBase = readJsonAt(repo, base, "composer.json");
  const cl = readJsonAt(repo, ref, "composer.lock");
  const pj = readJsonAt(repo, ref, "package.json");
  const pjBase = readJsonAt(repo, base, "package.json");
  const pl = readJsonAt(repo, ref, "package-lock.json");
  const versions = {};
  for (const p of [...(cl?.packages || []), ...(cl?.["packages-dev"] || [])]) versions[p.name] = p.version;
  const npmVersions = {};
  for (const [k, v] of Object.entries(pl?.packages || {})) if (k.startsWith("node_modules/") && !k.slice(13).includes("node_modules/")) npmVersions[k.slice(13)] = v.version;
  const composerAll = { ...(cj?.require || {}), ...(cj?.["require-dev"] || {}) };
  const npmAll = { ...(pj?.dependencies || {}), ...(pj?.devDependencies || {}) };
  const notable = {};
  for (const [cat, res] of Object.entries(NOTABLE)) {
    const hits = [];
    for (const name of Object.keys(composerAll)) if (res.some((re) => re.test(name))) hits.push(`${name}@${versions[name] || composerAll[name]}`);
    for (const name of Object.keys(npmAll)) if (res.some((re) => re.test(name))) hits.push(`npm:${name}@${npmVersions[name] || npmAll[name]}`);
    if (hits.length) notable[cat] = hits;
  }
  const has = (n) => n in composerAll || n in npmAll;
  return {
    present: { composerJson: !!cj, composerLock: !!cl, packageJson: !!pj, packageLock: !!pl },
    php: cj?.require?.php || null,
    laravel: versions["laravel/framework"] || cj?.require?.["laravel/framework"] || null,
    frontend: {
      livewire: has("livewire/livewire") ? versions["livewire/livewire"] || true : false,
      volt: has("livewire/volt"),
      flux: has("livewire/flux") || has("livewire/flux-pro"),
      inertia: has("inertiajs/inertia-laravel"),
      vue: has("vue"),
      react: has("react"),
      svelte: has("svelte"),
      alpine: has("alpinejs"),
      tailwind: has("tailwindcss") || has("@tailwindcss/vite") ? npmVersions.tailwindcss || npmAll.tailwindcss || true : false,
      filament: has("filament/filament") ? versions["filament/filament"] || true : false,
      vite: has("vite") ? npmVersions.vite || npmAll.vite : false,
    },
    notable,
    composer: { require: cj?.require || {}, requireDev: cj?.["require-dev"] || {}, scripts: Object.keys(cj?.scripts || {}), diffVsBase: depDiff(composerAll, { ...(cjBase?.require || {}), ...(cjBase?.["require-dev"] || {}) }) },
    npm: { dependencies: pj?.dependencies || {}, devDependencies: pj?.devDependencies || {}, scripts: pj?.scripts || {}, diffVsBase: depDiff(npmAll, { ...(pjBase?.dependencies || {}), ...(pjBase?.devDependencies || {}) }) },
  };
}

// --- hard-case keyword hits (pointers for the analyst, NOT evidence of correctness) ---
export const HARD_CASES = {
  packaging_and_deposits: /\b(deposit|pfand|packag\w*|pack_?size|crate|case_?qty|units?_per|unit_of_measure|uom|six.?pack|keg)\b/i,
  catch_weight_fractional: /(catch.?weight|fraction\w*|decimal.{0,20}quantit|quantit.{0,20}decimal|per_kg|\bkg\b|weight_?(based|variance|actual))/i,
  negotiated_prices: /(negotiated|customer_?price|price_?list|contract_?price|customer_?group|tier(ed)?_?price|quantity_?price|volume_?price)/i,
  promotions: /(promotion|coupon|promo_?code|voucher|discount_?code)/i,
  vat_reverse_charge: /(reverse.?charge|vat_?(id|number|rate)|tax_?rate|ust.?id|intra.?community)/i,
  delivery_restrictions: /(delivery_?(slot|window|area|zone|restriction)|cold.?chain|chilled|frozen|postcode|postal_?code|cut.?off)/i,
  lots_expiry: /(\blots?\b|lot_?(number|no|id)|\bbatch(es)?\b|best.?before|expir\w*|\bmhd\b|fefo|fifo)/i,
  backorders_substitution: /(back.?order|substitut\w*|out.?of.?stock|allow_?backorder)/i,
  refunds_returns: /(refund|credit.?note|return_?(request|item|line|order)|\brma\b|partial.?shipment|cancellation)/i,
};

export function hardCaseHits(files, perCase = 12) {
  const res = {};
  const code = files.filter((f) => /^(app|database|resources|routes|config|tests)\//.test(f.path) && /\.(php|js|ts|vue|tsx|jsx)$/.test(f.path));
  for (const [name, re] of Object.entries(HARD_CASES)) {
    const hits = [];
    let total = 0;
    for (const f of code) {
      const lines = f.content.split("\n");
      let n = 0;
      let first = null;
      lines.forEach((l, i) => {
        if (re.test(l)) {
          n++;
          if (first == null) first = i + 1;
        }
      });
      if (n) {
        total += n;
        hits.push({ ref: `${f.path}:${first}`, hits: n });
      }
    }
    hits.sort((a, b) => b.hits - a.hits);
    res[name] = { files: hits.length, lineHits: total, top: hits.slice(0, perCase) };
  }
  return res;
}
