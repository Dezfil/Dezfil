/**
 * A general structural validator over the subset of JSON Schema the
 * export contracts use: objects with required and additionalProperties,
 * arrays with items, string/number/integer/boolean with enum,
 * minimum/maximum, and maxLength, plus nullable type unions. Compiled
 * from the exported schema object itself, so the documented schema IS the
 * validity claim — never a hand-rolled twin (test walker, promoted to a
 * product module and completed: the test version ignored numeric and
 * length bounds, which cannot carry an over-maximum criterion).
 *
 * Since (` `) it also reads three keywords the published OpenAPI document
 * uses where the export contracts did not: `$ref` against a
 * caller-supplied definition map, `const`, and the variant lists `oneOf`
 * (exactly one branch) and `anyOf` (at least one). Without them the
 * assistant's own schemas could not be checked against the payloads the
 * product produces, and a hand-written walker beside the check would be
 * the twin this module exists to avoid. No dependency was added: no
 * JSON-schema validator is in the repository's dependencies.
 *
 * What it still does not read: `not`, `allOf`, `patternProperties`,
 * `pattern`, `additionalProperties` as a schema, and a schema stating no
 * type at all still rejects null, as it did, while admitting any other
 * value. A type list naming only `null` is the one kind that admits null
 * alone; it had previously matched everything as a variant.
 *
 * Returns problems as `path: sentence` strings; empty means valid.
 */

export type Schema = Record<string, unknown>;

/** Named schemas a `$ref` resolves against: the document's own
 * `components.schemas`, keyed by name. */
export type Definitions = Record<string, Schema>;

export function validateAgainstSchema(
  value: unknown,
  schema: Schema,
  at = "$",
  defs: Definitions = {},
): string[] {
  const problems: string[] = [];
  walk(value, schema, at, problems, defs);
  return problems;
}

const REF_PREFIX = "#/components/schemas/";

function walk(
  v: unknown,
  s: Schema,
  at: string,
  problems: string[],
  defs: Definitions = {},
): void {
  if (typeof s.$ref === "string") {
    const name = s.$ref.startsWith(REF_PREFIX) ? s.$ref.slice(REF_PREFIX.length) : undefined;
    const target = name ? defs[name] : undefined;
    if (!target) {
      problems.push(`${at}: unresolved reference ${JSON.stringify(s.$ref)}`);
      return;
    }
    walk(v, target, at, problems, defs);
    return;
  }
  if ("const" in s) {
    if (v !== s.const) {
      problems.push(`${at}: ${JSON.stringify(v)} is not ${JSON.stringify(s.const)}`);
    }
    return;
  }
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = s[keyword];
    if (!Array.isArray(branches)) continue;
    const failures = branches.map((branch) => {
      const found: string[] = [];
      walk(v, branch as Schema, at, found, defs);
      return found;
    });
    const matched = failures.filter((f) => f.length === 0).length;
    if (matched === 0) {
      problems.push(`${at}: matches no ${keyword} variant (${failures.map((f, i) => `#${i}: ${f.join("; ")}`).join(" | ")})`);
    } else if (keyword === "oneOf" && matched > 1) {
      problems.push(`${at}: matches ${matched} oneOf variants, which must be exactly one`);
    }
    return;
  }
  const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type];
  if (v === null) {
    if (!types.includes("null")) problems.push(`${at}: unexpected null`);
    return;
  }
  // A schema whose whole type list is null admits nothing else. None of the
  // typed branches below reads such a list, so without this it reported no
  // problem and a variant list counted it as a match for every value: the
  // nullable union's null arm became a wildcard, which both refused payloads
  // exactly one arm should admit and admitted payloads no arm should (` `).
  // A list naming null beside a real type is unaffected, and so is a schema
  // stating no type at all.
  if (types.length > 0 && types.every((type) => type === "null")) {
    problems.push(`${at}: expected null`);
    return;
  }
  if (types.includes("object")) {
    if (typeof v !== "object" || Array.isArray(v)) {
      problems.push(`${at}: expected an object`);
      return;
    }
    const props = (s.properties ?? {}) as Record<string, Schema>;
    const required = (s.required ?? []) as string[];
    const obj = v as Record<string, unknown>;
    for (const key of required) {
      if (!(key in obj)) problems.push(`${at}: missing required "${key}"`);
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) problems.push(`${at}: unknown field "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) walk(obj[key], sub, `${at}.${key}`, problems, defs);
    }
    return;
  }
  if (types.includes("array")) {
    if (!Array.isArray(v)) {
      problems.push(`${at}: expected an array`);
      return;
    }
    const items = s.items as Schema | undefined;
    if (items) v.forEach((item, i) => walk(item, items, `${at}[${i}]`, problems, defs));
    return;
  }
  if (types.includes("integer")) {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      problems.push(`${at}: expected an integer`);
      return;
    }
  } else if (types.includes("number")) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      problems.push(`${at}: expected a number`);
      return;
    }
  } else if (types.includes("string")) {
    if (typeof v !== "string") {
      problems.push(`${at}: expected a string`);
      return;
    }
  } else if (types.includes("boolean")) {
    if (typeof v !== "boolean") {
      problems.push(`${at}: expected a boolean`);
      return;
    }
  }
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) {
      problems.push(`${at}: ${v} is below the minimum ${s.minimum}`);
    }
    if (typeof s.maximum === "number" && v > s.maximum) {
      problems.push(`${at}: ${v} is above the maximum ${s.maximum}`);
    }
  }
  if (typeof v === "string" && typeof s.maxLength === "number") {
    if (v.length > s.maxLength) {
      problems.push(
        `${at}: length ${v.length} is over the maximum ${s.maxLength}`,
      );
    }
  }
  if (Array.isArray(s.enum) && !(s.enum as unknown[]).includes(v)) {
    problems.push(`${at}: ${JSON.stringify(v)} is not one of the allowed values`);
  }
}
