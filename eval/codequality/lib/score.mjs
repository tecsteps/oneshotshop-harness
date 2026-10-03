// Scoring: AI judgements + static rule results -> rule, category and index scores (0..100).
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

export function aiRuleStats(cat, judgements) {
  return cat.aiRules.map((r) => {
    const js = judgements.filter((j) => j.rule_id === r.id);
    const c = { pass: 0, fail: 0, na: 0, unverified: 0, missing: 0 };
    for (const j of js) {
      if (j.status === "verified") c[j.verdict]++;
      else if (j.status === "unverified") c.unverified++;
      else c.missing++;
    }
    const applicable = c.pass + c.fail;
    return { rule_id: r.id, category: r.category, weight: r.weight, units: js.length, ...c, applicable, score: applicable ? c.pass / applicable : null };
  });
}

const wmean = (items) => {
  const w = items.filter((x) => x.score !== null && x.score !== undefined);
  const sw = w.reduce((s, x) => s + x.weight, 0);
  return sw ? w.reduce((s, x) => s + x.score * x.weight, 0) / sw : null;
};

export function scoreAll(cat, aiStats, staticRes) {
  const all = [...aiStats.map((x) => ({ ...x, by: "ai" })), ...staticRes.map((x) => ({ ...x, by: "static" }))];
  const categories = {};
  for (const [k, c] of Object.entries(cat.categories)) {
    const rs = all.filter((x) => x.category === k);
    categories[k] = {
      title: c.title, weight: c.weight,
      score: r1(100 * (wmean(rs) ?? NaN)) ?? null,
      ai_score: wmean(rs.filter((x) => x.by === "ai")) === null ? null : r1(100 * wmean(rs.filter((x) => x.by === "ai"))),
      static_score: wmean(rs.filter((x) => x.by === "static")) === null ? null : r1(100 * wmean(rs.filter((x) => x.by === "static"))),
      rules_scored: rs.filter((x) => x.score !== null).length, rules_total: rs.length,
    };
    if (Number.isNaN(categories[k].score)) categories[k].score = null;
  }
  const idx = (field) => {
    const items = Object.values(categories).map((c) => ({ score: c[field] === null ? null : c[field] / 100, weight: c.weight }));
    const m = wmean(items); return m === null ? null : r1(100 * m);
  };
  return { cqi: idx("score"), ai_index: idx("ai_score"), static_index: idx("static_score"), categories };
}

// Agreement across repeated runs of the same units: per rule, the share of (unit, rule) items whose
// verified verdicts are identical in every repeat, plus mean pairwise agreement and Fleiss' kappa.
export function agreement(cat, reps, minUnanimity) {
  const key = (j) => `${j.unit_id}\u0000${j.rule_id}`;
  const maps = reps.map((rep) => new Map(rep.judgements.filter((j) => j.status === "verified").map((j) => [key(j), j.verdict])));
  const rules = [];
  for (const r of cat.aiRules) {
    const keys = [...maps[0].keys()].filter((k) => k.endsWith("\u0000" + r.id) && maps.every((m) => m.has(k)));
    let unanimous = 0, pairAgree = 0, pairs = 0;
    const cats = ["pass", "fail", "na"]; const nij = [];
    const disagreements = [];
    for (const k of keys) {
      const vs = maps.map((m) => m.get(k));
      if (vs.every((v) => v === vs[0])) unanimous++; else disagreements.push({ unit_id: k.split("\u0000")[0], verdicts: vs });
      for (let a = 0; a < vs.length; a++) for (let b = a + 1; b < vs.length; b++) { pairs++; if (vs[a] === vs[b]) pairAgree++; }
      nij.push(cats.map((c) => vs.filter((v) => v === c).length));
    }
    // Fleiss' kappa
    let kappa = null;
    const n = reps.length, N = nij.length;
    if (N > 0 && n > 1) {
      const pj = cats.map((_, j) => nij.reduce((s, row) => s + row[j], 0) / (N * n));
      const Pi = nij.map((row) => (row.reduce((s, x) => s + x * x, 0) - n) / (n * (n - 1)));
      const Pbar = Pi.reduce((s, x) => s + x, 0) / N, Pe = pj.reduce((s, x) => s + x * x, 0);
      kappa = Pe === 1 ? (Pbar === 1 ? 1 : 0) : (Pbar - Pe) / (1 - Pe);
    }
    const u = keys.length ? unanimous / keys.length : null;
    rules.push({ rule_id: r.id, category: r.category, items: keys.length, unanimous_share: u === null ? null : Math.round(u * 1000) / 1000,
      pairwise_agreement: pairs ? Math.round((pairAgree / pairs) * 1000) / 1000 : null, fleiss_kappa: kappa === null ? null : Math.round(kappa * 1000) / 1000,
      flagged: u !== null && u < minUnanimity, disagreements: disagreements.slice(0, 10) });
  }
  const tot = rules.reduce((s, r) => s + r.items, 0), un = rules.reduce((s, r) => s + (r.unanimous_share ?? 0) * r.items, 0);
  return { repeats: reps.length, min_unanimity: minUnanimity, items: tot, overall_unanimous_share: tot ? Math.round((un / tot) * 1000) / 1000 : null, flagged: rules.filter((r) => r.flagged).map((r) => r.rule_id), rules };
}
