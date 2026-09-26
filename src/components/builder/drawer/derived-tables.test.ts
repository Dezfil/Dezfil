import { describe, it, expect } from "vitest";
import {
  OUTPUTS_LABEL,
  SKETCHES_LABEL,
  WORKSPACE_LABEL,
  acceptsTable,
  geometryClass,
  geometryClassOf,
  groupTables,
  refusalFor,
  stepsByOutput,
} from "./derived-tables";
import type { RecipeSummary, StepSummary } from "./recipe-model";
import type { TableListing } from "../../api";

/**
 * Derived-table grouping.
 *
 * The grouping is a property of the table list wherever it appears, which is
 * why it is tested here as a function rather than through either of the two
 * surfaces that render it.
 */

function table(over: Partial<TableListing> = {}): TableListing {
  return {
    id: "t1",
    name: "stations",
    sourceFilename: "stations.geojson",
    format: "geoparquet",
    file: "tables/stations.parquet",
    geometryColumn: "geom",
    geometryType: "POINT",
    crsAssumed: false,
    rowCount: 12,
    createdAt: "2026-08-13T10:00:00.000Z",
    source: "upload",
    sourceParams: null,
    importedAt: null,
    sizeBytes: 1024,
    ...over,
  } as TableListing;
}

const recipe = {
  id: "r1",
  name: "Catchments",
  createdAt: "2026-08-13T10:00:00.000Z",
  updatedAt: "2026-08-13T10:00:00.000Z",
  steps: [
    {
      id: "s1",
      ordinal: 0,
      operation: "buffer",
      output: { id: "t2", name: "rings" },
    } as unknown as StepSummary,
  ],
} as unknown as RecipeSummary;

describe("two groups, outputs above workspace tables", () => {
  it("files a tool's output under Tool outputs", () => {
    const groups = groupTables(
      [table(), table({ id: "t2", name: "rings", source: "operation" })],
      [recipe],
    );
    expect(groups.map((g) => g.label)).toEqual([OUTPUTS_LABEL, WORKSPACE_LABEL]);
    expect(OUTPUTS_LABEL).toBe("Tool outputs");
    expect(groups[0].tables[0].table.name).toBe("rings");
    expect(groups[1].tables[0].table.name).toBe("stations");
  });

  it("omits an empty group rather than showing an empty eyebrow", () => {
    expect(groupTables([table()], []).map((g) => g.key)).toEqual(["workspace"]);
    expect(groupTables([], [recipe])).toEqual([]);
  });

  it("keeps an orphaned output under Tool outputs — the source decides", () => {
    // A dataset whose step — or whole recipe — was deleted is still a
    // tool's output: the group follows the table's own source. (The
    // row's provenance line left with; the group stays.)
    const groups = groupTables(
      [
        table({
          id: "t9",
          name: "orphan",
          source: "operation",
          sourceParams: { operation: "spatial_join" },
        }),
      ],
      [recipe],
    );
    expect(groups.map((g) => g.key)).toEqual(["outputs"]);
  });

  it("groups the current map's sketches first, other maps' as workspace", () => {
    const mine = table({
      id: "s-mine",
      name: "berlin_sketch",
      source: "sketch",
      sourceParams: { mapId: "m1", layerId: "l1" },
    });
    const theirs = table({
      id: "s-theirs",
      name: "paris_sketch",
      source: "sketch",
      sourceParams: { mapId: "m2", layerId: "l2" },
    });
    const groups = groupTables([mine, theirs, table()], [], { mapId: "m1" });
    expect(groups.map((g) => g.key)).toEqual(["sketches", "workspace"]);
    expect(groups[0].label).toBe(SKETCHES_LABEL);
    expect(groups[0].tables.map((t) => t.table.name)).toEqual([
      "berlin_sketch",
    ]);
    expect(groups[1].tables.map((t) => t.table.name)).toEqual([
      "paris_sketch",
      "stations",
    ]);
  });

  it("keeps the context-free grouping when no map is passed — the add-layer browser's view", () => {
    const mine = table({
      id: "s-mine",
      name: "berlin_sketch",
      source: "sketch",
      sourceParams: { mapId: "m1", layerId: "l1" },
    });
    const groups = groupTables([mine], []);
    expect(groups.map((g) => g.key)).toEqual(["workspace"]);
  });

  it("indexes every step that has produced something", () => {
    expect([...stepsByOutput([recipe]).keys()]).toEqual(["t2"]);
    expect(stepsByOutput([{ ...recipe, steps: [] } as RecipeSummary]).size).toBe(0);
  });
});

describe("the two facts a row carries", () => {
  it("names the geometry class a picker filters on", () => {
    expect(geometryClassOf(table({ geometryType: "MULTIPOLYGON" }))).toBe(
      "polygon",
    );
    expect(geometryClassOf(table({ geometryType: "LINESTRING" }))).toBe("line");
    expect(geometryClassOf(table({ geometryType: null }))).toBeNull();
    // Unspecific rather than unknown: `GEOMETRY` could hold any of them, and
    // guessing would disable a table that would have worked.
    expect(geometryClassOf(table({ geometryType: "GEOMETRY" }))).toBeNull();
  });

  it("reads the class in words on the row", () => {
    expect(geometryClass(table({ geometryType: "MULTIPOLYGON" }))).toBe(
      "multi polygon",
    );
    expect(
      geometryClass(table({ geometryType: null, geometryColumn: null })),
    ).toBe("no geometry");
  });
});

describe("which tables an input can take", () => {
  it("offers unknown-class spatial geometry and names its uncertainty", () => {
    const retained = table({ geometryType: null, geometryColumn: "geom" });
    expect({
      accepted: acceptsTable(["polygon"], retained),
      classLabel: geometryClass(retained),
      refusal: refusalFor(["polygon"], retained),
    }).toEqual({
      accepted: true,
      classLabel: "geometry of unknown class",
      refusal:
        "This step needs polygon geometry; “stations” holds geometry of unknown class.",
    });
  });

  it("refuses a geometryless table for a verb that names classes", () => {
    const nonSpatial = table({ geometryType: null, geometryColumn: null });
    expect(acceptsTable(["point", "line", "polygon"], nonSpatial)).toBe(false);
    // `any` explicitly includes non-spatial tables — that is what the catalog
    // means by it, and the SQL step relies on it.
    expect(acceptsTable(["any"], nonSpatial)).toBe(true);
  });

  it("offers a table whose class the input accepts, and only those", () => {
    expect(acceptsTable(["polygon"], table({ geometryType: "POINT" }))).toBe(
      false,
    );
    expect(acceptsTable(["point"], table({ geometryType: "POINT" }))).toBe(true);
    // Unspecific geometry is offered rather than pre-refused: the run knows
    // what it actually holds and this surface does not.
    expect(acceptsTable(["polygon"], table({ geometryType: "GEOMETRY" }))).toBe(
      true,
    );
  });
});
