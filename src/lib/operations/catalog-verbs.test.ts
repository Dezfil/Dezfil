import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { OPERATIONS } from "./catalog";

/**
 * The catalog against what the phase ratified.
 *
 * **A missing verb fails here rather than being noticed later.** The list below
 * is the opening sitting's own catalog, minus the families later specs own, and
 * comparing against it is what makes "every remaining in-engine verb ships" a
 * criterion rather than a claim.
 */

/** The in-engine verbs the phase ratified, by the id each ships under. */
const RATIFIED: Record<string, string> = {
  // Proven
  sql_step: "Data",
  spatial_join: "Overlay",
  buffer: "Proximity",
  measure_columns: "Geometry",
  // This spec
  nearest_join: "Proximity",
  filter_by_location: "Proximity",
  clip: "Overlay",
  union: "Overlay",
  difference: "Overlay",
  dissolve: "Aggregation",
  group_summarize: "Aggregation",
  centroid: "Geometry",
  convex_hull: "Geometry",
  simplify: "Geometry",
  filter_rows: "Data",
  join_by_key: "Data",
  // the statistics verbs. H3 finally has a product consumer.
  h3_cell: "Statistics",
  hotspot: "Statistics",
  cluster_by_distance: "Statistics",
  // the first verb whose answers do not come from the engine at all.
  geocode_addresses: "Data",
  isochrone: "Data",
};

describe("the catalog against the ratified list", () => {
  it("offers every in-engine verb the phase ratified, and no extras", () => {
    expect(OPERATIONS.map((o) => o.id).sort()).toEqual(Object.keys(RATIFIED).sort());
  });

  it("files each verb under the group the sitting put it in", () => {
    for (const operation of OPERATIONS) {
      expect(operation.group, operation.id).toBe(RATIFIED[operation.id]);
    }
  });

  it("describes every verb well enough to render a form from", () => {
    for (const operation of OPERATIONS) {
      expect(operation.label, operation.id).not.toBe("");
      expect(operation.description.length, operation.id).toBeGreaterThan(40);
      // Every verb declares where its output's geometry comes from — the
      // property Result section reads to decide whether a result can become a
      // layer at all.
      expect(operation.outputGeometry.kind, operation.id).toMatch(
        /^(probed|none|from_input|fixed)$/,
      );
      // Every verb names the dataset it will write.
      expect(
        operation.parameters.some((p) => p.name === "name" && p.required),
        `${operation.id} declares its output name`,
      ).toBe(true);
      // A parameter that names a column says which input it belongs to,
      // otherwise a form cannot offer the right columns.
      for (const parameter of operation.parameters) {
        if (parameter.type === "field" || parameter.type === "field_list") {
          if (operation.inputs.length === 0) continue;
          expect(parameter.ofInput, `${operation.id}.${parameter.name}`).toBeTruthy();
          expect(
            operation.inputs.some((i) => i.name === parameter.ofInput),
            `${operation.id}.${parameter.name} names a real input`,
          ).toBe(true);
        }
        if (parameter.type === "enum" || parameter.type === "enum_list") {
          expect(
            (parameter.options ?? []).length,
            `${operation.id}.${parameter.name} lists its options`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("declares a unit on every parameter that means ground metres", () => {
    // A number the user reads as metres and the engine reads as degrees is the
    // distortion exists to prevent, and the unit is how an agent knows which
    // is which without knowing the verb.
    const measured = ["distance", "max_distance", "tolerance"];
    for (const operation of OPERATIONS) {
      for (const parameter of operation.parameters) {
        if (measured.includes(parameter.name)) {
          expect(parameter.unit, `${operation.id}.${parameter.name}`).toBe("metres");
        }
      }
    }
  });
});

describe("no verb invents its own conversion", () => {
  it("transforms coordinates only through the shared strategy", () => {
    // **A grep, not a judgement**. Twelve verbs is twelve
    // chances to write a `ST_Transform` with a projection of its own; the
    // strategy module is the only place allowed to name one.
    const dir = path.join(process.cwd(), "src/lib/operations");
    const offenders: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      if (entry === "measurement.ts") continue;
      const source = readFileSync(path.join(dir, entry), "utf8");
      // Every legitimate transform goes through `intoMeasurement` or
      // `backToStored`, which take the resolved CRS as an argument.
      if (/ST_Transform\s*\(/.test(source)) offenders.push(entry);
      // And nothing else names a projection literally.
      if (/EPSG:\d+/.test(source)) offenders.push(`${entry} (names an EPSG code)`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the catalog's presentation metadata", () => {
  it("every verb carries a one-line, markdown-free blurb under 90 characters", () => {
    for (const operation of OPERATIONS) {
      expect(operation.blurb, operation.id).toBeTruthy();
      expect(operation.blurb.length, operation.id).toBeLessThan(90);
      expect(operation.blurb, operation.id).not.toMatch(/[*_`#\n]/);
    }
  });
});

/** The ruling: the vocabulary grows to twenty-one unique symbols; plain `filter`
 * stays with Filter rows and `stats` with Hotspot analysis. */
describe("the symbol vocabulary under the ruling", () => {
  it("pins the four members of the formerly shared pairs, and a unique symbol per verb", () => {
    const symbolOf = new Map(OPERATIONS.map((o) => [o.id, o.symbol]));
    expect(symbolOf.get("filter_rows")).toBe("filter");
    expect(symbolOf.get("filter_by_location")).toBe("filter_location");
    expect(symbolOf.get("group_summarize")).toBe("summarize");
    expect(symbolOf.get("hotspot")).toBe("stats");
    expect(new Set(OPERATIONS.map((o) => o.symbol)).size).toBe(OPERATIONS.length);
  });
});
