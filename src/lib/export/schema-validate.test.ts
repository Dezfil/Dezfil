import { describe, expect, it } from "vitest";
import { validateAgainstSchema as validate, type Schema } from "./schema-validate";

/**
 * The three keywords the validator gained (` `), exercised on their own
 * so the widening is not taken on trust by the check that uses it: a
 * reference resolved against a caller-supplied definition map, a
 * constant, and the two variant lists. Each case carries its own
 * counter-case, so an assertion that could not go red is visible here.
 */

const defs: Record<string, Schema> = {
  Corner: { type: "string", enum: ["top-left", "bottom-right"] },
  Placement: {
    type: "object", additionalProperties: false, required: ["corner"],
    properties: { corner: { $ref: "#/components/schemas/Corner" }, size: { type: "integer", minimum: 1 } },
  },
  Card: { type: "object", required: ["placement"], properties: { placement: { $ref: "#/components/schemas/Placement" } } },
};

describe("references", () => {
  it("resolves through a chain and reports the failure at its real path", () => {
    expect(validate({ placement: { corner: "top-left" } }, defs.Card, "$", defs)).toEqual([]);
    expect(validate({ placement: { corner: "middle" } }, defs.Card, "$", defs)).toEqual([
      '$.placement.corner: "middle" is not one of the allowed values',
    ]);
  });
  it("resolves inside an array's items", () => {
    const schema: Schema = { type: "array", items: { $ref: "#/components/schemas/Corner" } };
    expect(validate(["top-left", "bottom-right"], schema, "$", defs)).toEqual([]);
    expect(validate(["top-left", "nowhere"], schema, "$", defs)).toEqual(['$[1]: "nowhere" is not one of the allowed values']);
  });
  it("an unknown or unsupported reference is a problem, never a silent pass", () => {
    expect(validate("anything", { $ref: "#/components/schemas/Missing" }, "$", defs))
      .toEqual(['$: unresolved reference "#/components/schemas/Missing"']);
    expect(validate("anything", { $ref: "Corner" }, "$", defs)).toEqual(['$: unresolved reference "Corner"']);
    // A caller that supplies no definitions cannot accidentally pass everything.
    expect(validate("top-left", { $ref: "#/components/schemas/Corner" })).toEqual([
      '$: unresolved reference "#/components/schemas/Corner"',
    ]);
  });
});

describe("const", () => {
  it("admits only its own value", () => {
    expect(validate("builder", { const: "builder" })).toEqual([]);
    expect(validate("sql", { const: "builder" })).toEqual(['$: "sql" is not "builder"']);
    expect(validate(null, { const: "builder" })).toEqual(['$: null is not "builder"']);
  });
});

describe("variant lists", () => {
  const oneOf: Schema = {
    oneOf: [
      { type: "object", additionalProperties: false, required: ["page", "mapId"], properties: { page: { const: "builder" }, mapId: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["page", "draft"], properties: { page: { const: "sql" }, draft: { type: "string" } } },
    ],
  };
  it("accepts a value exactly one variant admits", () => {
    expect(validate({ page: "builder", mapId: "m" }, oneOf)).toEqual([]);
    expect(validate({ page: "sql", draft: "SELECT 1" }, oneOf)).toEqual([]);
  });
  it("reports every variant's reason when none admits the value", () => {
    const problems = validate({ page: "builder", mapId: "m", appearance: "dark" }, oneOf);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("matches no oneOf variant");
    expect(problems[0]).toContain('unknown field "appearance"');
    expect(problems[0]).toContain('"builder" is not "sql"');
  });
  it("oneOf refuses a value two variants admit; anyOf accepts it", () => {
    const ambiguous = [{ type: "object", properties: {} }, { type: "object", properties: {} }];
    expect(validate({}, { oneOf: ambiguous })).toEqual(["$: matches 2 oneOf variants, which must be exactly one"]);
    expect(validate({}, { anyOf: ambiguous })).toEqual([]);
  });
  it("anyOf still refuses a value no variant admits", () => {
    expect(validate(3, { anyOf: [{ type: "string" }, { type: "boolean" }] })[0]).toContain("matches no anyOf variant");
  });
});

describe("null in a type list", () => {
  // A branch admitting only null admitted every value,
  // because a null-only type list matches none of the typed branches and so
  // reported nothing. Inside a variant list that made the null arm a
  // wildcard, which both refused a valid payload (two arms matched where
  // exactly one may) and admitted an invalid one (the null arm alone).
  it("a null-only schema admits null and nothing else", () => {
    expect(validate(null, { type: "null" })).toEqual([]);
    expect(validate(1, { type: "null" })).toEqual(["$: expected null"]);
    expect(validate("", { type: "null" })).toEqual(["$: expected null"]);
    expect(validate({}, { type: "null" })).toEqual(["$: expected null"]);
    expect(validate(null, { type: ["null"] })).toEqual([]);
    expect(validate(false, { type: ["null"] })).toEqual(["$: expected null"]);
  });
  it("as a variant it is one arm among three, never a wildcard over them", () => {
    const nullable: Schema = {
      oneOf: [
        { type: "null" },
        { type: "object", additionalProperties: false, required: ["sql"], properties: { sql: { type: "string" } } },
        { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string" } } },
      ],
    };
    expect(validate(null, nullable)).toEqual([]);
    expect(validate({ sql: "SELECT 1" }, nullable)).toEqual([]);
    expect(validate({ code: "failed" }, nullable)).toEqual([]);
    const refused = validate(123, nullable);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("matches no oneOf variant");
    expect(refused[0]).toContain("expected null");
  });
  it("a union naming null beside a type still admits both, and a typeless schema is unchanged", () => {
    expect(validate(null, { type: ["string", "null"] })).toEqual([]);
    expect(validate("x", { type: ["string", "null"] })).toEqual([]);
    expect(validate(1, { type: ["string", "null"] })).toEqual(["$: expected a string"]);
    // Stating no type at all still rejects null and admits anything else,
    // exactly as; the module's doc comment says so.
    expect(validate(null, {})).toEqual(["$: unexpected null"]);
    expect(validate(1, {})).toEqual([]);
  });
});

describe("what it read is unchanged", () => {
  const schema: Schema = {
    type: "object", additionalProperties: false, required: ["name"],
    properties: { name: { type: "string", maxLength: 4 }, count: { type: "integer", minimum: 0, maximum: 2 }, flag: { type: "boolean" }, note: { type: ["string", "null"] } },
  };
  it("required, unknown fields, bounds, lengths and nullable unions", () => {
    expect(validate({ name: "ok", count: 1, flag: true, note: null }, schema)).toEqual([]);
    expect(validate({ count: 5, flag: true }, schema)).toEqual(['$: missing required "name"', "$.count: 5 is above the maximum 2"]);
    expect(validate({ count: 5, extra: 1, name: "toolong", flag: "yes", note: 2 }, schema)).toEqual([
      '$: unknown field "extra"',
      "$.name: length 7 is over the maximum 4",
      "$.count: 5 is above the maximum 2",
      "$.flag: expected a boolean",
      "$.note: expected a string",
    ]);
  });
});
