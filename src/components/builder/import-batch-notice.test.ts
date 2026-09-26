import { describe, it, expect } from "vitest";
import {
  fileSoftOutcomes,
  importBatchNotice,
  unlayeredFiles,
} from "./use-layer-source-coordinator";

/** The one-notice batch contract. */
describe("importBatchNotice", () => {
  it("keeps the exact single-table success copy", () => {
    expect(
      importBatchNotice({
        created: ["wind_farms"],
        nonSpatial: [],
        failed: [],
        unconfirmed: [],
      }),
    ).toBe("Added wind_farms to this map");
  });

  it("names every layer of a multi-table batch once", () => {
    expect(
      importBatchNotice({
        created: ["a", "b", "c"],
        nonSpatial: [],
        failed: [],
        unconfirmed: [],
      }),
    ).toBe("Added 3 layers to this map: a, b, c");
  });

  it("reports a kept non-spatial table without a layer attempt", () => {
    expect(
      importBatchNotice({
        created: ["a"],
        nonSpatial: ["lookup_codes"],
        failed: [],
        unconfirmed: [],
      }),
    ).toBe(
      "Added a to this map · lookup_codes kept as a table: no geometry for a layer",
    );
  });

  it("keeps definite failure and unconfirmed clauses distinct", () => {
    expect(
      importBatchNotice({
        created: [],
        nonSpatial: [],
        failed: ["bad_geo"],
        unconfirmed: ["flaky_net"],
      }),
    ).toBe(
      "bad_geo landed in datasets: adding the layer failed · Adding flaky_net could not be confirmed, reloading",
    );
  });
});

/** The held-open decision and its notes: a file with no
 * confirmed layer holds the catalog; a partial-success file does not
 * (the gate-ratified narrowing); the note clauses keep the upload and
 * layer domains distinct. */
describe("unlayeredFiles and fileSoftOutcomes", () => {
  it("holds only the files that confirmed no layer", () => {
    const files = [
      { filename: "good.geojson", confirmed: 1, outcomes: [] },
      {
        filename: "broken.csv",
        confirmed: 0,
        outcomes: ["broken imported as a table: no geometry for a layer"],
      },
      {
        // Partial success: one layer confirmed, another table soft —
        // deliberately NOT held (spec out-of-scope carve-out).
        filename: "mixed.gpkg",
        confirmed: 1,
        outcomes: ["mixed_lookup — adding the layer failed"],
      },
    ];
    expect(unlayeredFiles(files).map((f) => f.filename)).toEqual([
      "broken.csv",
    ]);
  });

  it("an all-confirmed batch holds nothing — the close condition", () => {
    expect(
      unlayeredFiles([
        { filename: "a.geojson", confirmed: 2, outcomes: [] },
        { filename: "b.geojson", confirmed: 1, outcomes: [] },
      ]),
    ).toEqual([]);
  });

  it("names each table's outcome with its domain distinct", () => {
    expect(
      fileSoftOutcomes({
        nonSpatial: ["broken"],
        failed: ["pts"],
        unconfirmed: ["zones"],
      }),
    ).toEqual([
      "broken imported as a table: no geometry for a layer",
      "pts: adding the layer failed",
      "zones: the layer could not be confirmed; the map reloaded, nothing was retried",
    ]);
  });
});
