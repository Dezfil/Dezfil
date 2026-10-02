import { describe, expect, it } from "vitest";
import {
  archiveBaseName,
  memberFileNames,
  mapProjection,
  workflowProjection,
} from "./project-archive";

/** The 16-C archive's pure pieces: the naming rule and
 * the projections, proven against independently authored literals
 * and seeded runtime/publication facts. */

describe("the naming rule", () => {
  it("slugs to the reference's file form with the project fallback", () => {
    expect(archiveBaseName("Berlin mobility study")).toBe(
      "berlin-mobility-study",
    );
    expect(archiveBaseName("  Harbor / Käfige 2026!  ")).toBe(
      "harbor-k-fige-2026",
    );
    expect(archiveBaseName("")).toBe("project");
    expect(archiveBaseName("   ")).toBe("project");
    expect(archiveBaseName("!!!")).toBe("project");
  });

  it("suffixes collisions ordinally in listing order, per folder", () => {
    expect(
      memberFileNames(["Transit map", "Transit map", "Other", "Transit map"]),
    ).toEqual(["transit-map", "transit-map-2", "other", "transit-map-3"]);
    // Empty file forms collide onto the fallback and stay distinct.
    expect(memberFileNames(["???", "!!!"])).toEqual(["untitled", "untitled-2"]);
    // A name that already ends in an ordinal cannot be overwritten by a
    // suffixed sibling: the suffix advances past it.
    expect(memberFileNames(["Map", "Map", "Map 2"])).toEqual([
      "map",
      "map-2",
      "map-2-2",
    ]);
    expect(memberFileNames(["Map 2", "Map", "Map"])).toEqual([
      "map-2",
      "map",
      "map-3",
    ]);
  });
});

describe("the map projection", () => {
  const wire = {
    id: "m1",
    name: "Transit",
    viewport: { lng: 13.4, lat: 52.5, zoom: 10, pitch: 0, bearing: 0 },
    basemap: null,
    customBasemap: null,
    basemapLayers: null,
    note: null,
    legendCorner: null,
    legendOrder: null,
    timeline: null,
    widgets: [],
    widgetsPublished: { w1: true },
    publishedFields: { note: true },
    layerOrder: ["l1"],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    // The seeded publication facts that must NOT survive.
    publishToken: "tok-secret-value",
    publishedAt: "2026-08-03T00:00:00.000Z",
    published: true,
    // The route-level membership that must not survive either.
    projectId: "p1",
    layers: [{ id: "l1", name: "stations", sql: "SELECT 1" }],
  };

  it("strips publication state and membership, keeps authored fields", () => {
    const out = mapProjection(wire) as Record<string, unknown>;
    expect(out.publishToken).toBeUndefined();
    expect(out.publishedAt).toBeUndefined();
    expect(out.published).toBeUndefined();
    expect(out.projectId).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("tok-secret-value");
    // Authored publication CONTROLS are definition, not state.
    expect(out.widgetsPublished).toEqual({ w1: true });
    expect(out.publishedFields).toEqual({ note: true });
    expect(out.name).toBe("Transit");
    expect(out.layers).toEqual(wire.layers);
  });
});

describe("the workflow projection", () => {
  const step = {
    id: "s1",
    recipeId: "r1",
    ordinal: 1,
    operation: "sql_step",
    parameters: { sql: "SELECT 1", name: "out" },
    summary: "SQL step",
    origin: "workflow",
    // Runtime facts that must NOT survive.
    proposedParameters: { sql: "SELECT 2" },
    output: { id: "t9", name: "out" },
    condition: "ready",
    conditions: ["ready"],
    causes: [],
    missingInputs: [],
    inputs: [{ id: "t1", name: "src" }],
    reads: [{ id: "t1", name: "src" }],
    latestAttempt: { id: "job1", outcome: "succeeded" },
    lastSuccessAt: "2026-08-04T00:00:00.000Z",
  };
  const wire = {
    id: "r1",
    name: "Catchments",
    origin: "workflow",
    projectId: "p1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    summary: "1 step",
    steps: [step],
  };
  const layout = {
    steps: { s1: { x: 10, y: 20 } },
    sources: {},
    notes: [],
    updatedAt: "2026-08-05T00:00:00.000Z",
  };

  it("allow-lists the definition, adds the layout annex, drops runtime", () => {
    const out = workflowProjection(wire, layout) as Record<string, unknown>;
    expect(out.id).toBe("r1");
    expect(out.name).toBe("Catchments");
    expect(out.origin).toBe("workflow");
    expect(out.projectId).toBeUndefined();
    expect(out.summary).toBeUndefined();
    expect(out.layout).toEqual(layout);
    const s = (out.steps as Record<string, unknown>[])[0];
    expect(s).toEqual({
      id: "s1",
      ordinal: 1,
      operation: "sql_step",
      parameters: { sql: "SELECT 1", name: "out" },
      origin: "workflow",
    });
    const text = JSON.stringify(out);
    for (const gone of [
      "proposedParameters",
      "latestAttempt",
      "lastSuccessAt",
      "condition",
      "causes",
      "missingInputs",
      '"inputs"',
      '"reads"',
      '"output"',
    ]) {
      expect(text).not.toContain(gone);
    }
  });
});
