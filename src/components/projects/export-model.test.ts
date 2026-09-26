import { describe, expect, it } from "vitest";
import {
  datasetSub,
  footerStatus,
  groupSmall,
  mapRowMeta,
  omittedLine,
  sizeText,
  sizeTotal,
  treeRows,
  workflowRowMeta,
  type ExportDatasetRow,
} from "./export-model";

/** The 16-C dialog's model — the exact forms
 * asserted as authored literals, never re-derived. */

const ds = (over: Partial<ExportDatasetRow>): ExportDatasetRow => ({
  id: "t1",
  name: "stations",
  sizeBytes: 1024,
  source: "upload",
  projectIds: ["p1"],
  geometryColumn: "geometry",
  geometryType: "POINT",
  ...over,
});

describe("row facts and sub-line precedence", () => {
  it("meta lines", () => {
    expect(mapRowMeta({ id: "m", name: "M", layerCount: 1, published: false })).toBe("1 layer");
    expect(mapRowMeta({ id: "m", name: "M", layerCount: 3, published: true })).toBe("3 layers · published");
    expect(workflowRowMeta({ id: "w", name: "W", nodeCount: 4 })).toBe("4 nodes");
  });

  it("shared wins over result; several memberships list alphabetically", () => {
    const names = new Map([
      ["p1", "Berlin"],
      ["p2", "Atlas"],
      ["p3", "Harbor"],
    ]);
    expect(datasetSub(ds({ source: "operation" }), "p1", names)).toBe(
      "a result; its workflow makes it again",
    );
    expect(
      datasetSub(ds({ source: "operation", projectIds: ["p1", "p3", "p2"] }), "p1", names),
    ).toBe("also in Atlas, Harbor, included as a copy");
    expect(datasetSub(ds({}), "p1", names)).toBe("");
  });
});

describe("the exact forms", () => {
  it("sizes under the rule", () => {
    expect(sizeText(sizeTotal([ds({}), ds({ sizeBytes: 1024 })]))).toBe("2 KB");
    expect(sizeText(sizeTotal([ds({}), ds({ sizeBytes: null })]))).toBe("≥ 1 KB");
  });

  it("group smalls and footer", () => {
    expect(groupSmall(3, 3)).toBe("3");
    expect(groupSmall(1, 3)).toBe("1 of 3");
    expect(groupSmall(2, 5, "9 KB")).toBe("2 of 5 · 9 KB");
    expect(
      footerStatus({ maps: 2, workflows: 0, datasets: 1 }, "9 KB"),
    ).toBe("2 maps · 0 workflows · 1 dataset · 9 KB");
    expect(footerStatus({ maps: 0, workflows: 0, datasets: 0 }, "0 B")).toBe(
      "Nothing chosen",
    );
  });

  it("the omitted line names only non-zero groups", () => {
    expect(omittedLine({ maps: 1, workflows: 0, datasets: 2 })).toBe(
      "1 map · 2 datasets",
    );
    expect(omittedLine({ maps: 0, workflows: 0, datasets: 0 })).toBe("");
  });
});

describe("the review tree (complete)", () => {
  it("names every map file and every dataset file — no summary row", () => {
    const rows = treeRows({
      file: "  Berlin Study!  ",
      maps: [
        { id: "a", name: "Transit map", layerCount: 1, published: false },
        { id: "b", name: "Transit map", layerCount: 2, published: false },
      ],
      workflows: [],
      datasets: [
        ds({ name: "d1" }),
        ds({ name: "d2" }),
        ds({ name: "d3" }),
        ds({ name: "d4" }),
      ],
      datasetSize: "4 KB",
    });
    expect(rows.map((r) => r.label)).toEqual([
      "berlin-study.dezfil/",
      "project.json",
      "maps/",
      "transit-map.json",
      "transit-map-2.json",
      "datasets/",
      "d1.parquet",
      "d2.parquet",
      "d3.parquet",
      "d4.parquet",
    ]);
    expect(rows.some((r) => r.label === "…")).toBe(false);
    expect(rows.find((r) => r.label === "datasets/")?.note).toBe(
      "4 datasets · 4 KB",
    );
    // No workflows folder when none are chosen.
    expect(rows.some((r) => r.label === "workflows/")).toBe(false);
  });

  it("names datasets by their effective format, and claims no size for a conversion", () => {
    const rows = treeRows({
      file: "study",
      maps: [],
      workflows: [],
      datasets: [
        ds({ name: "stations" }),
        ds({ name: "readings", geometryColumn: null, geometryType: null }),
      ],
      datasetSize: null,
      datasetFormat: "geojson",
    });
    expect(rows.map((r) => r.label)).toEqual([
      "study.dezfil/",
      "project.json",
      "datasets/",
      "stations.geojson",
      "readings.csv",
    ]);
    expect(rows.find((r) => r.label === "datasets/")?.note).toBe("2 datasets");
    const csv = treeRows({
      file: "study",
      maps: [],
      workflows: [],
      datasets: [ds({ name: "stations" })],
      datasetSize: null,
      datasetFormat: "csv",
    });
    expect(csv.map((r) => r.label)).toContain("stations.csv");
    expect(
      footerStatus({ maps: 1, workflows: 0, datasets: 2 }, null),
    ).toBe("1 map · 0 workflows · 2 datasets");
  });
});
