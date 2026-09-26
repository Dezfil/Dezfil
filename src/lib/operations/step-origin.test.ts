import { describe, it, expect } from "vitest";
import type { LayerFilter, LayerViz } from "@/lib/viz";
import { effectiveSql } from "@/lib/query/compile";
import { captureFromLayer } from "./step-origin";

/**
 * E1, executably.
 *
 * The decisive comparison in several of these is against `effectiveSql` — what
 * the layer actually *renders*. A capture that matched it would be the defect
 * doctrine names: an operation answering about hexagons when the user asked
 * about stations.
 */

const layer = (over: Partial<Parameters<typeof captureFromLayer>[0]> = {}) => ({
  id: "l1",
  mapId: "m1",
  name: "Stations",
  sql: "SELECT * FROM stations",
  filters: [] as LayerFilter[],
  viz: { type: "points" } as LayerViz,
  ...over,
});

const categoryFilter: LayerFilter = {
  field: "borough",
  kind: "category",
  values: ["Mitte"],
} as unknown as LayerFilter;

const hexbin: LayerViz = {
  type: "hexbin",
  cellKm: 1.2,
  aggregate: { fn: "count" },
} as unknown as LayerViz;

const grid: LayerViz = {
  type: "grid",
  cellKm: 5,
  aggregate: { fn: "count" },
} as unknown as LayerViz;

const od: LayerViz = {
  type: "arc",
  origin: { kind: "geometry", field: "from_geom" },
  dest: { kind: "geometry", field: "to_geom" },
  height: 0.6,
} as unknown as LayerViz;

describe("filters are folded in", () => {
  it("takes the layer's SQL unchanged when it has no filters", () => {
    const { sql } = captureFromLayer(layer());
    expect(sql).toContain("SELECT * FROM stations");
    expect(captureFromLayer(layer()).origin.filterCount).toBe(0);
  });

  it("applies the layer's filters, so the step inherits its scope", () => {
    const { sql, origin } = captureFromLayer(layer({ filters: [categoryFilter] }));
    expect(sql).toMatch(/WHERE/i);
    expect(sql).toContain("borough");
    expect(origin.filterCount).toBe(1);
  });
});

describe("visualization aggregation is never consumed", () => {
  for (const [label, viz, expected] of [
    ["hexbin", hexbin, "hexbin"],
    ["grid", grid, "grid"],
    ["origin–destination", od, "origin-destination"],
  ] as const) {
    it(`takes the source behind a ${label} layer, not what it draws`, () => {
      const captured = captureFromLayer(layer({ viz }));
      const rendered = effectiveSql(
        { sql: "SELECT * FROM stations", filters: [], viz },
        "geometry",
      );

      // What the layer draws and what the step runs are different things.
      expect(captured.sql).not.toBe(rendered);
      expect(captured.sql).toContain("SELECT * FROM stations");
      // And the step took none of the aggregation the render applies.
      expect(captured.sql).not.toMatch(/h3_|ST_MakeLine|__grid/i);

      expect(captured.origin.renderedAs).toBe(expected);
      expect(captured.origin.substitutedSource).toBe(true);
    });
  }

  it("says so, rather than leaving the substitution to be discovered", () => {
    for (const viz of [hexbin, grid, od]) {
      const { origin } = captureFromLayer(layer({ viz }));
      expect(origin.substitutionNote).toBeTruthy();
      expect(origin.substitutionNote).toMatch(/not on the (bins|cells|lines)/i);
    }
  });

  it("keeps filters even while substituting the source", () => {
    const { sql } = captureFromLayer(layer({ viz: hexbin, filters: [categoryFilter] }));
    expect(sql).toContain("borough");
    expect(sql).not.toMatch(/h3_/i);
  });

  it("notes no substitution for a layer drawn directly", () => {
    const { origin } = captureFromLayer(layer());
    expect(origin.renderedAs).toBe("direct");
    expect(origin.substitutedSource).toBe(false);
    expect(origin.substitutionNote).toBeUndefined();
  });
});

describe("the capture is a snapshot", () => {
  it("records what it came from, so a later edit is visibly not reflected", () => {
    const { origin } = captureFromLayer(layer({ name: "Stations" }));
    expect(origin).toMatchObject({ layerId: "l1", mapId: "m1", layerName: "Stations" });
    expect(origin.capturedAt).toBeTruthy();
  });

  it("does not change when the layer it came from changes afterwards", () => {
    const original = layer({ filters: [categoryFilter] });
    const captured = captureFromLayer(original);

    // The layer's filters are edited after the fact.
    original.filters = [];

    // The captured SQL is unaffected — it is a value, not a reference.
    expect(captured.sql).toContain("borough");
  });
});
