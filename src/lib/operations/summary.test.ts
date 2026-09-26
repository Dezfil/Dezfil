import { describe, it, expect } from "vitest";
import { OPERATIONS } from "./catalog";
import { parameterSummary, summaryFor } from "./summary";

/**
 * The step row's one-line sentence.
 *
 * The sweep is the point: **every verb the catalog offers produces a sentence**,
 * so a verb added by a later spec cannot ship a row that says nothing. The
 * per-verb assertions below are about the sentences a user actually reads.
 */

const of = (id: string) => OPERATIONS.find((o) => o.id === id)!;

describe("the sentence a row reads", () => {
  it("says a buffer in ground metres, around what it read", () => {
    expect(
      parameterSummary(of("buffer"), {
        input: "stations",
        distance: 500,
        name: "rings",
      }),
    ).toBe("500 m around stations");
  });

  it("says a join as a relation between two inputs, with what it carries", () => {
    expect(
      parameterSummary(of("spatial_join"), {
        left: "rings",
        right: "blocks",
        predicate: "intersects",
        carry: [{ aggregate: "count" }, { aggregate: "sum", field: "pop" }],
        name: "enriched",
      }),
    ).toBe("rings intersects blocks, carrying count, sum of pop");
  });

  it("keeps a long list short rather than running off the row", () => {
    const said = parameterSummary(of("spatial_join"), {
      left: "a",
      right: "b",
      predicate: "within",
      carry: [
        { aggregate: "count" },
        { aggregate: "sum", field: "one" },
        { aggregate: "mean", field: "two" },
        { aggregate: "max", field: "three" },
      ],
    });
    expect(said).toContain("and 1 more");
  });

  it("says which measurements were asked for", () => {
    expect(
      parameterSummary(of("measure_columns"), {
        input: "parcels",
        measures: ["area", "length"],
      }),
    ).toBe("area, length of parcels");
  });

  it("shows a query as itself, flattened and bounded", () => {
    const long = `SELECT ${"x".repeat(200)} FROM t`;
    const said = parameterSummary(of("sql_step"), { sql: long });
    expect(said.length).toBeLessThanOrEqual(80);
    expect(said.endsWith("…")).toBe(true);
    expect(
      parameterSummary(of("sql_step"), { sql: "SELECT *\n  FROM stations" }),
    ).toBe("SELECT * FROM stations");
  });

  it("says something for a step that has been given nothing yet", () => {
    // A row for a half-authored step still has to read as a row.
    for (const operation of OPERATIONS) {
      expect(parameterSummary(operation, {}).trim()).not.toBe("");
    }
  });
});

describe("every verb the catalog offers", () => {
  it("produces a non-empty sentence naming what it reads", () => {
    // The sweep a later spec's verbs are held to: a verb that ships without a
    // sentence fails here rather than showing an empty row.
    for (const operation of OPERATIONS) {
      const parameters: Record<string, unknown> = {};
      for (const input of operation.inputs) parameters[input.name] = `t_${input.name}`;
      for (const parameter of operation.parameters) {
        if (parameter.name === "name") continue;
        if (parameter.default !== undefined) parameters[parameter.name] = parameter.default;
        else if (parameter.type === "number") parameters[parameter.name] = 1;
        else if (parameter.type === "enum_list" || parameter.type === "field_list") {
          parameters[parameter.name] = ["one"];
        } else parameters[parameter.name] = "one";
      }
      const said = summaryFor(operation.id, parameters);
      expect(said.trim(), operation.id).not.toBe("");
      for (const input of operation.inputs) {
        expect(said, `${operation.id} names its ${input.name}`).toContain(
          `t_${input.name}`,
        );
      }
    }
  });
});
