// Minimal, dependency-free JSON Schema (2020-12 subset) validator.
// Supports: type (incl. arrays and "integer"), enum, const, required, properties,
// additionalProperties (bool or schema), items, minItems, maxItems, minLength, pattern,
// minimum, maximum, format "date-time", $ref to "#/$defs/...", anyOf, oneOf.
// Usage as CLI: node lib/schema-validate.mjs <schema.json> <data.json>  (exit 1 on errors)
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function validate(schema, data) {
  const errors = [];
  const resolve = (ref) => {
    if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
    return ref.slice(2).split("/").reduce((o, k) => o[k], schema);
  };
  const check = (s, v, path) => {
    if (s === true || s === undefined) return;
    if (s === false) { errors.push(`${path}: not allowed`); return; }
    if (s.$ref) { check(resolve(s.$ref), v, path); }
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const t = typeOf(v);
      const ok = types.some((x) => x === t || (x === "integer" && t === "number" && Number.isInteger(v)));
      if (!ok) { errors.push(`${path}: expected ${types.join("|")}, got ${t}`); return; }
    }
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${path}: not one of ${JSON.stringify(s.enum)}`);
    if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(v)) errors.push(`${path}: must be ${JSON.stringify(s.const)}`);
    if (typeof v === "string") {
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${path}: does not match ${s.pattern}`);
      if (s.format === "date-time" && Number.isNaN(Date.parse(v))) errors.push(`${path}: not a date-time`);
    }
    if (typeof v === "number") {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${path}: < ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${path}: > ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
      if (s.items) v.forEach((x, i) => check(s.items, x, `${path}[${i}]`));
    }
    if (typeOf(v) === "object") {
      for (const r of s.required || []) if (!(r in v)) errors.push(`${path}: missing required "${r}"`);
      for (const [k, x] of Object.entries(v)) {
        if (s.properties && k in s.properties) check(s.properties[k], x, `${path}.${k}`);
        else if (s.additionalProperties !== undefined) check(s.additionalProperties, x, `${path}.${k}`);
      }
    }
    for (const key of ["anyOf", "oneOf"]) {
      if (!s[key]) continue;
      const passing = s[key].filter((sub) => validate({ $defs: schema.$defs, ...sub }, v).length === 0).length;
      if (key === "anyOf" && passing === 0) errors.push(`${path}: matches none of anyOf`);
      if (key === "oneOf" && passing !== 1) errors.push(`${path}: matches ${passing} of oneOf (need 1)`);
    }
  };
  check(schema, data, "$");
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [schemaFile, dataFile] = process.argv.slice(2);
  const errors = validate(JSON.parse(readFileSync(schemaFile, "utf8")), JSON.parse(readFileSync(dataFile, "utf8")));
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(`valid: ${dataFile}`);
}
