import { describe, it, expect } from "vitest";
import {
  recentHeading,
  recentItems,
  whereLine,
  whereNames,
} from "./recent-model";
import type { MapOverview, TableListing } from "../api";
import type { WorkflowListing } from "../workflow-model";

/** The empty home's recent list. */

const map = (over: Partial<MapOverview>) =>
  ({ id: "m", name: "M", projectId: null, layerCount: 2, updatedAt: "2026-09-01T00:00:00Z", ...over }) as MapOverview;
const wf = (over: Partial<WorkflowListing>) =>
  ({
    id: "w",
    name: "W",
    origin: "workflow",
    projectId: null,
    updatedAt: "2026-09-01T00:00:00Z",
    summary: { nodes: 2, sources: 1, liveOutputs: 0, status: "up_to_date", count: 0 },
    steps: [],
    ...over,
  }) as unknown as WorkflowListing;
const table = (over: Partial<TableListing>) =>
  ({
    id: "t",
    name: "t",
    projectIds: [],
    rowCount: 1860,
    geometryColumn: null,
    geometryType: null,
    importedAt: "2026-09-01T00:00:00Z",
    createdAt: "2026-08-01T00:00:00Z",
    ...over,
  }) as unknown as TableListing;
const names = new Map([
  ["pa", "Berlin"],
  ["pb", "Atlas"],
]);
const none = { maps: new Set<string>(), workflows: new Set<string>(), tables: new Set<string>() };
const HOME = "home";

describe("recent things across kinds", () => {
  it("merges the kinds newest first by each kind's own time, six at most", () => {
    const items = recentItems({
      maps: [map({ id: "m1", updatedAt: "2026-09-05T00:00:00Z" }), map({ id: "m2", updatedAt: "2026-09-01T00:00:00Z" })],
      workflows: [wf({ id: "w1", updatedAt: "2026-09-04T00:00:00Z" })],
      tables: [
        table({ id: "t1", importedAt: "2026-09-06T00:00:00Z" }),
        table({ id: "t2", importedAt: null, createdAt: "2026-09-03T00:00:00Z" }),
        table({ id: "t3", importedAt: "2026-09-02T00:00:00Z" }),
        table({ id: "t4", importedAt: "2026-08-30T00:00:00Z" }),
      ],
      projectId: HOME,
      exclude: none,
      names,
    });
    expect(items.map((i) => i.id)).toEqual(["t1", "m1", "w1", "t2", "t3", "m2"]);
  });

  it("excludes this project's members, by membership and by id, and builder-origin recipes", () => {
    const items = recentItems({
      maps: [map({ id: "m1" }), map({ id: "m2", projectId: HOME })],
      workflows: [wf({ id: "w1" }), wf({ id: "b1", origin: "builder" }), wf({ id: "w2", projectId: HOME })],
      tables: [table({ id: "t1" }), table({ id: "t2", projectIds: [HOME, "pa"] })],
      projectId: HOME,
      exclude: { maps: new Set(["m1"]), workflows: new Set(), tables: new Set(["t1"]) },
      names,
    });
    expect(items.map((i) => i.id)).toEqual(["w1"]);
  });

  it("words the kind, the place and the fact per row", () => {
    const items = recentItems({
      maps: [map({ id: "m1", projectId: "pa", layerCount: 3 })],
      workflows: [wf({ id: "w1", projectId: null })],
      tables: [
        table({ id: "t1", projectIds: ["pa", "pb"], geometryColumn: "geom", geometryType: "POINT", rowCount: 48200 }),
      ],
      projectId: HOME,
      exclude: none,
      names,
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("m1")).toMatchObject({ kind: "map", where: ["Berlin"], fact: "3 layers" });
    expect(byId.get("w1")).toMatchObject({ kind: "workflow", where: [], fact: "2 nodes" });
    expect(byId.get("t1")).toMatchObject({
      kind: "dataset",
      where: ["Atlas", "Berlin"],
      fact: "48,200 rows · Points",
    });
    expect(whereLine([])).toBe("not in a project");
    expect(whereLine(["Atlas", "Berlin"])).toBe("in Atlas, Berlin");
  });

  it("omits an unknown project name rather than inventing one", () => {
    expect(whereNames(["pa", "ghost", null], names)).toEqual(["Berlin"]);
  });

  it("heads the card by the instance, or plainly when unnamed", () => {
    expect(recentHeading("Stadtwerke")).toBe("Recent in Stadtwerke");
    expect(recentHeading(null)).toBe("Recent");
  });
});
