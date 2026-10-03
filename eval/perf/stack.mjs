#!/usr/bin/env node
// node stack.mjs <laravel-root>  -> JSON on stdout: declared stack from composer.json/lock and
// package.json files (root + up to two levels deep, excluding vendor/node_modules).
// Runtime evidence (journey) and probe evidence (request kinds) are merged in aggregate.mjs.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const composer = readJson(path.join(root, 'composer.json')) || {};
const lock = readJson(path.join(root, 'composer.lock'));
const locked = {};
for (const p of [...(lock?.packages || []), ...(lock?.['packages-dev'] || [])]) locked[p.name] = p.version;
const phpDeps = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };

const pkgFiles = [];
(function walk(dir, depth) {
  if (depth > 2) return;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (['node_modules', 'vendor', '.git', 'storage', 'public'].includes(e)) continue;
    const p = path.join(dir, e);
    if (e === 'package.json') pkgFiles.push(p);
    else if (depth < 2 && statSync(p, { throwIfNoEntry: false })?.isDirectory()) walk(p, depth + 1);
  }
})(root, 0);
const jsDeps = {};
for (const f of pkgFiles) { const j = readJson(f) || {}; Object.assign(jsDeps, j.dependencies || {}, j.devDependencies || {}); }
const has = (o, re) => Object.keys(o).filter((k) => re.test(k));

const flags = {
  laravel: locked['laravel/framework'] || phpDeps['laravel/framework'] || null,
  livewire: locked['livewire/livewire'] || null,
  volt: locked['livewire/volt'] || null,
  flux: locked['livewire/flux'] || null,
  filament: locked['filament/filament'] || null,
  inertia_laravel: locked['inertiajs/inertia-laravel'] || null,
  sanctum: locked['laravel/sanctum'] || null,
  jetstream: locked['laravel/jetstream'] || null,
  inertia_client: has(jsDeps, /^@inertiajs\//),
  vue: jsDeps.vue || null,
  react: jsDeps.react || null,
  svelte: jsDeps.svelte || null,
  alpine: jsDeps.alpinejs || null,
  htmx: jsDeps['htmx.org'] || null,
  next: jsDeps.next || null,
  nuxt: jsDeps.nuxt || null,
  tailwind: jsDeps.tailwindcss || null,
  vite: jsDeps.vite || null,
};
const separateFrontends = pkgFiles.filter((f) => path.dirname(f) !== root).map((f) => path.relative(root, path.dirname(f)));
console.log(JSON.stringify({
  declared: Object.fromEntries(Object.entries(flags).filter(([, v]) => v && (!Array.isArray(v) || v.length))),
  package_json_files: pkgFiles.map((f) => path.relative(root, f)),
  separate_frontend_dirs: separateFrontends,
  routes_api_file: existsSync(path.join(root, 'routes/api.php')),
}));
