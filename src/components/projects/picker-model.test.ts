import { describe, it, expect } from "vitest";
import {
  composeChange,
  emptySelection,
  pickerItems,
  pickerLabel,
  pickerStatus,
  searchItems,
  selectionCount,
  type DepsRead,
} from "./picker-model";
import type { DependencyWire } from "./add-model";
import type { MapOverview, TableListing } from "../api";
import type { WorkflowListing } from "../workflow-model";

/** The project-first picker's model. */

const map = (over: Partial<MapOverview>) =>
  ({ id: "m", name: "M", projectId: null, layerCount: 1, updatedAt: "2026-09-01T00:00:00Z", ...over }) as MapOverview;
const wf = (over: Partial<WorkflowListing>) =>
  ({
    id: "w",
    name: "W",
    origin: "workflow",
    projectId: null,
    summary: { nodes: 1, sources: 1, liveOutputs: 0, status: "up_to_date", count: 0 },
    steps: [],
    ...over,
  }) as unknown as WorkflowListing;
const table = (over: Partial<TableListing>) =>
  ({ id: "t", name: "t", projectIds: [], rowCount: 12, geometryColumn: "geom", geometryType: "POLYGON", ...over }) as unknown as TableListing;
const dep = (id: string, producer: { id: string; name: string } | null = null): DependencyWire => ({
  id,
  name: id,
  source: "upload",
  rowCount: 1,
  projectIds: [],
  geometryColumn: null,
  geometryType: null,
  producer,
});
const ready = (deps: DependencyWire[]): DepsRead => ({ status: "ready", deps });
const names = new Map([["pa", "Berlin"]]);

describe("what each tab offers", () => {
  it("lists everything not in this project, in listing order, workflow-origin only", () => {
    const lists = pickerItems({
      maps: [map({ id: "m1", projectId: "here" }), map({ id: "m2", projectId: "pa" }), map({ id: "m3" })],
      workflows: [wf({ id: "w1" }), wf({ id: "b1", origin: "builder" }), wf({ id: "w2", projectId: "here" })],
      tables: [table({ id: "t1", projectIds: ["here", "pa"] }), table({ id: "t2", projectIds: ["pa"] })],
      projectId: "here",
      names,
    });
    expect(lists.maps.map((i) => i.id)).toEqual(["m2", "m3"]);
    expect(lists.maps[0].where).toEqual(["Berlin"]);
    expect(lists.workflows.map((i) => i.id)).toEqual(["w1"]);
    expect(lists.datasets.map((i) => i.id)).toEqual(["t2"]);
    expect(lists.datasets[0].fact).toBe("12 rows · Polygons");
  });

  it("searches by name, case-insensitively", () => {
    const items = [{ name: "Stations map" }, { name: "Lane density" }];
    expect(searchItems(items, "LANE")).toEqual([{ name: "Lane density" }]);
    expect(searchItems(items, "  ")).toEqual(items);
  });
});

describe("one composed change", () => {
  it("brings a map's datasets and their distinct producers, a workflow's datasets, a dataset alone; shared ones once", () => {
    const sel = emptySelection();
    sel.maps.add("m1");
    sel.workflows.add("w1");
    sel.datasets.add("t9");
    const reads = new Map<string, DepsRead>([
      ["m1", ready([dep("t1", { id: "wp", name: "Producer" }), dep("t2", { id: "wp", name: "Producer" }), dep("t9")])],
      ["w1", ready([dep("t2"), dep("t3")])],
    ]);
    const c = composeChange(sel, reads);
    expect(c.members.addMaps).toEqual(["m1"]);
    expect(new Set(c.members.addRecipes)).toEqual(new Set(["w1", "wp"]));
    expect(new Set(c.members.addTables)).toEqual(new Set(["t9", "t1", "t2", "t3"]));
    // Unique objects: the picked three plus t1, t2, t3 and the producer.
    expect(c.summary).toEqual({ maps: 1, workflows: 1, datasets: 1, brought: 4 });
    expect(c.blocked).toEqual([]);
    expect(selectionCount(sel)).toBe(3);
  });

  it("neither counts nor sends what the project already holds", () => {
    const sel = emptySelection();
    sel.maps.add("m1");
    const reads = new Map<string, DepsRead>([
      ["m1", ready([dep("t1", { id: "wp", name: "Producer" }), dep("t2", { id: "wq", name: "Other" })])],
    ]);
    const c = composeChange(sel, reads, { workflows: new Set(["wp"]), tables: new Set(["t1"]) });
    expect(c.members.addTables).toEqual(["t2"]);
    expect(c.members.addRecipes).toEqual(["wq"]);
    expect(c.summary.brought).toBe(2);
  });

  it("blocks on a selected object whose bring-along set is not known", () => {
    const sel = emptySelection();
    sel.maps.add("m1");
    sel.workflows.add("w1");
    const reads = new Map<string, DepsRead>([
      ["m1", { status: "failed", error: "nope" }],
    ]);
    const c = composeChange(sel, reads);
    expect(c.blocked).toEqual(["m1", "w1"]);
  });

  it("words the footer", () => {
    expect(pickerStatus({ maps: 0, workflows: 0, datasets: 0, brought: 0 })).toBe("Nothing picked");
    expect(pickerStatus({ maps: 1, workflows: 0, datasets: 2, brought: 3 })).toBe("1 map · 2 datasets · 3 they bring");
    expect(pickerLabel({ maps: 1, workflows: 0, datasets: 2, brought: 3 })).toBe("Add 6 items");
    expect(pickerLabel({ maps: 0, workflows: 0, datasets: 1, brought: 0 })).toBe("Add 1 item");
  });
});
