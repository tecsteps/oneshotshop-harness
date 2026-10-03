// Tiny argv parser: --key value, --key=value, repeated keys become arrays, --flag => true.
export function parseArgs(argv, { multi = [], flags = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (v === undefined) {
      if (flags.includes(k)) v = true;
      else v = argv[++i];
    }
    if (multi.includes(k)) (out[k] ||= []).push(v);
    else out[k] = v;
  }
  return out;
}
