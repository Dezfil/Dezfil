import { describe, expect, it } from "vitest";
import { recentItems } from "./recent-model";
import type { MapOverview, TableListing } from "../api";
import type { WorkflowListing } from "../workflow-model";

/**
 * The recent list as a host with no project asks for it: nothing is left
 * out for being filed, an exclusion by identity is optional, and equal
 * times can be asked to order totally, map before workflow before dataset,
 * then the lower identity, whatever order the lists answered in.
 */

const T = "2026-09-05T00:00:00Z";
const map = (id: string, over: Partial<MapOverview> = {}) =>
  ({ id, name: id, projectId: null, layerCount: 1, updatedAt: T, lastChangedAt: T, ...over }) as unknown as MapOverview;
const wf = (id: string, over: Partial<WorkflowListing> = {}) =>
  ({
    id, name: id, origin: "workflow", projectId: null, updatedAt: T, lastChangedAt: T,
    summary: { nodes: 1, sources: 0, liveOutputs: 0, status: "up_to_date", count: 0 }, steps: [], ...over,
  }) as unknown as WorkflowListing;
const table = (id: string, over: Partial<TableListing> = {}) =>
  ({
    id, name: id, projectIds: [], rowCount: 1, geometryColumn: null, geometryType: null, importedAt: T, createdAt: T, ...over,
  }) as unknown as TableListing;
const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("a host with no project", () => {
  it("leaves nothing out for being filed and needs no exclusion, builder-origin recipes still uncounted", () => {
    const items = recentItems({
      maps: [map("m1", { projectId: "home" })],
      workflows: [wf("w1", { projectId: "home" }), wf("b1", { origin: "builder" })],
      tables: [table("t1", { projectIds: ["home", "atlas"] })],
      names: new Map(),
    });
    expect(ids(items)).toEqual(["m1", "w1", "t1"]);
  });

  it("leaves out what it excludes by identity", () => {
    const items = recentItems({
      maps: [map("m1"), map("m2")],
      workflows: [wf("w1")],
      tables: [table("t1")],
      exclude: { maps: new Set(["m2"]), workflows: new Set(["w1"]), tables: new Set() },
      names: new Map(),
    });
    expect(ids(items)).toEqual(["m1", "t1"]);
  });
});

describe("a total order on equal times", () => {
  const permutations = <T,>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  it("orders map, workflow, dataset, then the lower identity, whatever order the lists answered in", () => {
    const seen = new Set<string>();
    for (const maps of permutations(["m-b", "m-a", "m-c"]))
      for (const workflows of permutations(["w-b", "w-a"]))
        for (const tables of permutations(["t-b", "t-a"])) {
          const items = recentItems({
            maps: maps.map((id) => map(id)), workflows: workflows.map((id) => wf(id)), tables: tables.map((id) => table(id)),
            names: new Map(), limit: 10, ties: "total",
          });
          seen.add(ids(items).join(" "));
        }
    expect([...seen]).toEqual(["m-a m-b m-c w-a w-b t-a t-b"]);
  });

  it("keeps different times newest first and cuts at the limit after ordering", () => {
    const items = recentItems({
      maps: [map("m-b"), map("m-a")],
      workflows: [wf("w-a", { updatedAt: "2026-09-04T00:00:00Z" })],
      tables: [table("t-z", { importedAt: "2026-09-06T00:00:00Z" }), table("t-a")],
      names: new Map(), limit: 3, ties: "total",
    });
    expect(ids(items)).toEqual(["t-z", "m-a", "m-b"]);
  });

  it("is asked for: without it, equal times keep the lists' order", () => {
    const items = recentItems({ maps: [map("m-b"), map("m-a")], workflows: [], tables: [], names: new Map() });
    expect(ids(items)).toEqual(["m-b", "m-a"]);
  });
});
