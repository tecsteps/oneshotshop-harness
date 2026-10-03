// Fast offline tests (no Docker, no Codex):  node --test eval/codequality/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CQ_DIR, loadCatalogue, renderMarkdown, rulesForKind } from "../lib/catalogue.mjs";
import { buildUnits, sampleUnits, renderUnit } from "../lib/units.mjs";
import { checkEvidence, checkJudgements, parseResponse, responseSchema } from "../lib/verify.mjs";
import { runStaticChecks } from "../lib/static-checks.mjs";
import { aiRuleStats, scoreAll, agreement } from "../lib/score.mjs";
import { validate } from "../../../lib/schema-validate.mjs";

const cat = loadCatalogue();

test("catalogue: valid, 25-40 AI rules, every AI rule has why_ai, every static rule a known check", async () => {
  assert.ok(cat.aiRules.length >= 25 && cat.aiRules.length <= 40, `ai rules: ${cat.aiRules.length}`);
  for (const r of cat.aiRules) assert.ok(r.why_ai.length > 20, r.id);
  const { CHECKS } = await import("../lib/static-checks.mjs");
  for (const r of cat.staticRules) assert.ok(CHECKS[r.check], `${r.id}: unknown check ${r.check}`);
});

test("catalogue: matches the owner-approved version + hash in config/versions.env", () => {
  const env = readFileSync(join(CQ_DIR, "config", "versions.env"), "utf8");
  assert.equal(/CQ_CATALOGUE_VERSION="([^"]+)"/.exec(env)[1], cat.catalogue.version);
  assert.equal(/CQ_CATALOGUE_SHA256="([0-9a-f]+)"/.exec(env)[1], cat.hash, "rules.yaml changed: bump catalogue.version and record the new hash after owner approval");
});

test("catalogue: rules.md is up to date", () => {
  assert.equal(readFileSync(join(CQ_DIR, "rules.md"), "utf8"), renderMarkdown(cat), "run: node eval/codequality/lib/catalogue.mjs render");
});

// fixture build: a git repo copy of test/fixture
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cq-fixture-"));
  cpSync(join(CQ_DIR, "test", "fixture"), dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"], { cwd: dir });
  return dir;
}
const havePhp = (() => { try { execFileSync("php", ["-v"]); return existsSync(join(CQ_DIR, ".cache/php-tools/vendor/autoload.php")); } catch { return false; } })();

test("inventory + sampling + prompts + static checks on the fixture", { skip: !havePhp && "host php or .cache/php-tools missing" }, () => {
  const src = fixture();
  const inv = JSON.parse(execFileSync("php", [join(CQ_DIR, "php/inventory.php"), src, join(CQ_DIR, ".cache/php-tools/vendor/autoload.php")], { encoding: "utf8" }));
  const kinds = Object.fromEntries(inv.classes.map((c) => [c.name, c.kind]));
  assert.deepEqual(kinds, { CartController: "controller", Product: "model", PricingService: "service", CartTest: "test_class" });
  const f = (p) => inv.files.find((x) => x.file === p);
  assert.deepEqual(f("app/Http/Controllers/CartController.php").raw_sql_dynamic.map((x) => x.line), [19]);
  assert.deepEqual(f("routes/web.php").env_calls, [7]);
  assert.deepEqual(inv.views[0].post_forms_missing_csrf, [3]);
  // sampling is deterministic and independent of the order of the inventory
  const units = buildUnits(cat, inv, src);
  const a = sampleUnits(cat, units).map((u) => u.id), b = sampleUnits(cat, [...units].reverse()).map((u) => u.id);
  assert.deepEqual(a, b);
  const schema = JSON.parse(readFileSync(join(CQ_DIR, "test/fixture/fixture-schema.json"), "utf8"));
  const text = renderUnit(cat, units.find((u) => u.kind === "controller"), { inv, schema, routes: null, src });
  assert.match(text, /   17\|         \$total = \$product->price/);
  const st = Object.fromEntries(runStaticChecks(cat, { inv, schema, tools: null, perf: null }).map((r) => [r.rule_id, r]));
  assert.equal(st["DM-S03"].score, 0);   // float money
  assert.equal(st["DM-S01"].score, 0);   // missing FK
  assert.equal(st["SEC-S04"].score, 0);  // POST form without @csrf
  assert.equal(st["LV-S02"].score, 0);   // $guarded = []
  assert.equal(st["CC-S12"].status, "na"); // no tools summary
});

test("evidence verification: exact quote, whitespace-tolerant, rejects paraphrase / wrong lines / outside paths", () => {
  const root = join(CQ_DIR, "test", "fixture");
  const file = "app/Http/Controllers/CartController.php";
  assert.equal(checkEvidence(root, { file, line_start: 17, line_end: 17, quote: "$total = $product->price * $request->input('qty') * 1.19;" }), null);
  assert.equal(checkEvidence(root, { file, line_start: 17, line_end: 17, quote: "$total  =  $product->price" }), null);
  assert.match(checkEvidence(root, { file, line_start: 17, line_end: 17, quote: "$total = $price * 1.19" }), /not found/);
  assert.match(checkEvidence(root, { file, line_start: 5, line_end: 6, quote: "$total = $product->price" }), /not found/);
  assert.match(checkEvidence(root, { file: "../../rules.yaml", line_start: 1, line_end: 1, quote: "catalogue" }), /outside/);
  assert.match(checkEvidence(root, { file, line_start: 900, line_end: 901, quote: "anything here" }), /beyond/);
});

test("response parsing, schema and completeness checks", () => {
  const ids = rulesForKind(cat, "routes").map((r) => r.id);
  const resp = { unit_id: "routes:routes/web.php", judgements: ids.map((id) => ({ rule_id: id, verdict: "pass", reason: "ok", evidence: [] })) };
  resp.judgements[0] = { rule_id: ids[0], verdict: "fail", reason: "x", evidence: [] };
  const p = parseResponse("```json\n" + JSON.stringify(resp) + "\n```");
  assert.ok(p.ok);
  assert.deepEqual(validate(responseSchema(cat, "routes"), p.data), []);
  const c = checkJudgements(cat, "routes", join(CQ_DIR, "test", "fixture"), { judgements: p.data.judgements.slice(0, -1) });
  assert.deepEqual(c[ids[0]].problems, ["fail without evidence"]);
  assert.deepEqual(c[ids.at(-1)].problems, ["missing judgement"]);
});

test("scoring and agreement", () => {
  const mk = (unit, rule, verdict) => ({ unit_id: unit, rule_id: rule, verdict, status: "verified", evidence: [] });
  const js = [mk("u1", "CC-01", "pass"), mk("u2", "CC-01", "fail"), mk("u1", "LV-01", "fail"), mk("u1", "SEC-01", "na")];
  const stats = aiRuleStats(cat, js);
  assert.equal(stats.find((r) => r.rule_id === "CC-01").score, 0.5);
  assert.equal(stats.find((r) => r.rule_id === "SEC-01").score, null);
  const s = scoreAll(cat, stats, []);
  assert.equal(s.categories.clean_code.ai_score, 50);
  assert.equal(s.categories.laravel.score, 0);
  const ag = agreement(cat, [{ judgements: js }, { judgements: js }, { judgements: [...js.slice(0, 1), mk("u2", "CC-01", "pass"), ...js.slice(2)] }], 0.8);
  const cc01 = ag.rules.find((r) => r.rule_id === "CC-01");
  assert.equal(cc01.items, 2); assert.equal(cc01.unanimous_share, 0.5); assert.equal(cc01.flagged, true);
  assert.equal(ag.rules.find((r) => r.rule_id === "LV-01").unanimous_share, 1);
});
