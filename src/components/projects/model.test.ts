import { describe, it, expect } from "vitest";
import {
  cardCounts,
  contentsWords,
  filterProjects,
  isEmptyProject,
  projectPictures,
  sizeLabel,
  sortProjects,
  unfiledCounts,
  unfiledDatasetCount,
  workflowCounts,
  type ProjectOverview,
} from "./model";
import type { MapOverview } from "../api";
import type { WorkflowListing } from "../workflow-model";

/** The Projects list's pure derivations. */

const overview = (over: Partial<ProjectOverview>): ProjectOverview => ({
  id: "p1",
  name: "Berlin",
  note: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  mapCount: 0,
  publishedMapCount: 0,
  recipeCount: 0,
  tableCount: 0,
  sizeBytes: 0,
  sizeComplete: true,
  ...over,
});

const map = (over: Partial<MapOverview>): MapOverview =>
  ({
    id: "m1",
    name: "Stations",
    projectId: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  }) as MapOverview;

describe("the three sorts", () => {
  const a = overview({ id: "a", name: "Atlas", updatedAt: "2026-09-01T02:00:00Z", sizeBytes: 10 });
  const b = overview({ id: "b", name: "berlin", updatedAt: "2026-09-01T03:00:00Z", sizeBytes: 300, sizeComplete: false });
  const c = overview({ id: "c", name: "Coast", updatedAt: "2026-09-01T01:00:00Z", sizeBytes: 200 });

  it("orders by recency, by name case-insensitively, and by known size", () => {
    expect(sortProjects([a, b, c], "updated").map((p) => p.id)).toEqual(["b", "a", "c"]);
    expect(sortProjects([c, b, a], "name").map((p) => p.id)).toEqual(["a", "b", "c"]);
    // Largest orders by the displayed known sum, partial or not.
    expect(sortProjects([a, b, c], "largest").map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("search trims, ignores case, and composes by returning the input for the sorts", () => {
    expect(filterProjects([a, b, c], "  BER ").map((p) => p.id)).toEqual(["b"]);
    expect(filterProjects([a, b, c], "")).toHaveLength(3);
  });
});

describe("size honesty", () => {
  it("marks a partial sum and leaves a complete one plain", () => {
    expect(sizeLabel(overview({ sizeBytes: 2048, sizeComplete: true }))).toBe("2 KB");
    expect(sizeLabel(overview({ sizeBytes: 2048, sizeComplete: false }))).toBe("≥ 2 KB");
  });
});

describe("the picture by count (kinds)", () => {
  const wf = (over: Partial<WorkflowListing>) =>
    ({ id: "w", name: "W", origin: "workflow", projectId: "p", ...over }) as WorkflowListing;

  it("takes every map, then workflows while places remain, in listing order, four at most", () => {
    const maps = [map({ id: "m1", projectId: "p" }), map({ id: "m2", projectId: "p" })];
    const workflows = [wf({ id: "w1" }), wf({ id: "w2" }), wf({ id: "w3" })];
    const tiles = projectPictures({ maps, workflows }).get("p")!;
    expect(tiles.map((t) => t.kind + ":" + (t.kind === "map" ? t.map.id : t.workflow.id)))
      .toEqual(["map:m1", "map:m2", "workflow:w1", "workflow:w2"]);
  });

  it("five maps leave no place for a workflow", () => {
    const maps = ["a", "b", "c", "d", "e"].map((id) => map({ id, projectId: "p" }));
    const tiles = projectPictures({ maps, workflows: [wf({ id: "w1" })] }).get("p")!;
    expect(tiles.map((t) => t.kind)).toEqual(["map", "map", "map", "map"]);
  });

  it("keeps each listing's own order even when timestamps disagree", () => {
    const maps = [
      map({ id: "older", projectId: "p", updatedAt: "2026-09-01T00:00:00Z" }),
      map({ id: "newer", projectId: "p", updatedAt: "2026-09-02T00:00:00Z" }),
    ];
    const tiles = projectPictures({ maps, workflows: [] }).get("p")!;
    expect(tiles.map((t) => (t.kind === "map" ? t.map.id : ""))).toEqual(["older", "newer"]);
  });

  it("fills a small project with what it has: one workflow, one tile", () => {
    const tiles = projectPictures({ maps: [], workflows: [wf({ id: "w1" })] }).get("p")!;
    expect(tiles.map((t) => t.kind)).toEqual(["workflow"]);
  });

  it("skips unfiled objects and gives a project with neither no entry — the folder tile, whatever data it holds", () => {
    const pictures = projectPictures({
      maps: [map({ id: "m", projectId: null })],
      workflows: [wf({ projectId: null })],
    });
    expect(pictures.size).toBe(0);
  });
});

describe("counts that drop zeros", () => {
  it("shows a kind only when present and the size only with datasets", () => {
    const mapsOnly = overview({ mapCount: 3, tableCount: 0, sizeBytes: 0 });
    expect(cardCounts(mapsOnly, 0)).toEqual({ maps: 3, workflows: null, datasets: null, size: null });
    const full = overview({ mapCount: 1, tableCount: 2, sizeBytes: 2048 });
    expect(cardCounts(full, 4)).toEqual({ maps: 1, workflows: 4, datasets: 2, size: "2 KB" });
    const partial = overview({ tableCount: 1, sizeBytes: 2048, sizeComplete: false });
    expect(cardCounts(partial, 0).size).toBe("≥ 2 KB");
  });

  it("words each non-zero kind for the list, and names emptiness", () => {
    expect(contentsWords(overview({ mapCount: 1, tableCount: 2 }), 0)).toEqual(["1 map", "2 datasets"]);
    expect(contentsWords(overview({ mapCount: 0, tableCount: 0 }), 1)).toEqual(["1 workflow"]);
    expect(contentsWords(overview({}), 0)).toEqual([]);
    expect(isEmptyProject(overview({}), 0)).toBe(true);
    expect(isEmptyProject(overview({}), 1)).toBe(false);
  });

  it("derives the unfiled dataset count from the whole listing", () => {
    expect(
      unfiledDatasetCount([
        { projectIds: [] },
        { projectIds: ["p"] },
        { projectIds: [] },
      ]),
    ).toBe(2);
  });
});

describe("workflow counts derive from the origin listing, never the overview", () => {
  it("counts filed workflows per project and ignores unfiled ones", () => {
    const counts = workflowCounts([
      { projectId: "p" },
      { projectId: "p" },
      { projectId: "q" },
      { projectId: null },
    ]);
    expect(counts.get("p")).toBe(2);
    expect(counts.get("q")).toBe(1);
    expect(counts.get("r")).toBeUndefined();
  });
});

describe("the unfiled strip's counts", () => {
  it("counts each kind and knows when nothing is unfiled", () => {
    const some = unfiledCounts({
      maps: [{ projectId: null }, { projectId: "p" }],
      workflows: [{ projectId: null }],
      unfiledDatasets: 3,
    });
    expect(some).toEqual({ maps: 1, workflows: 1, datasets: 3, any: true });
    const none = unfiledCounts({
      maps: [{ projectId: "p" }],
      workflows: [],
      unfiledDatasets: 0,
    });
    expect(none.any).toBe(false);
  });
});
