import { describe, expect, it } from "vitest";
import type { PostgisLayerCompletion, PostgisLayerLine } from "./PostgisLayerDone";
import { postgisLayerHeading } from "./PostgisLayerDone";
import type { PostgisLayerOutcome } from "@/components/builder/use-layer-source-coordinator";
import { defaultStyle } from "@/lib/style/defaults";
import { POINTS_VIZ } from "@/lib/viz";

const base = {
  connection: {
    id: "connection-1",
    name: "Berlin production",
    host: "db.internal",
    port: 5432,
    database: "geo",
    username: "reader",
    ssl: true,
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
    status: "connected" as const,
    lastCheckedAt: "2026-08-31T10:00:00.000Z",
    lastCheckError: null,
    serverVersion: "PostgreSQL 17",
    postgisVersion: "3.5",
  },
  relation: {
    schema: "public",
    table: "places",
    kind: "table" as const,
    system: false,
    geometryColumn: "geom",
    geometryType: "POINT",
    srid: 4326,
    spatialKind: "geometry" as const,
    approxRows: 3,
  },
  table: {
    id: "table-1",
    name: "places",
    sourceFilename: null,
    format: "geoparquet" as const,
    file: "tables/places.parquet",
    geometryColumn: "geom",
    geometryType: "POINT",
    crsAssumed: false,
    headerSuspect: false,
    rowCount: 3,
    createdAt: "2026-08-31T10:00:00.000Z",
    source: "postgis" as const,
    sourceParams: { connectionId: "connection-1" },
    importedAt: "2026-08-31T10:00:00.000Z",
  },
  filter: "",
};

const created: PostgisLayerOutcome = {
  kind: "created",
  layer: {
    id: "layer-1",
    mapId: "map-1",
    name: "places",
    sql: "SELECT * FROM places",
    style: defaultStyle("POINT"),
    visible: true,
    tooltip: null,
    popup: null,
    publishedFields: null,
    inLegend: true,
    viz: POINTS_VIZ,
    filters: [],
    legendTitle: null,
    legendLabels: null,
    legendAttrs: null,
    ordinal: 0,
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
  },
};

function completion(outcome: PostgisLayerLine): PostgisLayerCompletion {
  return { ...base, outcome };
}

describe("PostGIS Add layer completion headings", () => {
  it("reserves the success claim for a coordinator-confirmed layer", () => {
    expect(postgisLayerHeading(completion(created))).toEqual({
      label: "Added to the map as",
      name: "places",
    });
    for (const outcome of [
      { kind: "attribute_only", message: "No geometry." },
      { kind: "rejected", message: "Rejected." },
      { kind: "unconfirmed", message: "Unconfirmed." },
    ] satisfies PostgisLayerOutcome[]) {
      expect(postgisLayerHeading(completion(outcome)).label).not.toContain(
        "Added to the map",
      );
    }
  });

  it("shows the card pending without claiming a layer", () => {
    expect(postgisLayerHeading(completion({ kind: "pending" }))).toEqual({
      label: "Imported as",
      name: "places",
    });
  });

  it("names uncertainty separately from definite table-only outcomes", () => {
    expect(
      postgisLayerHeading(
        completion({ kind: "unconfirmed", message: "Unconfirmed." }),
      ),
    ).toEqual({ label: "Layer creation unconfirmed for", name: "places" });
    expect(
      postgisLayerHeading(
        completion({ kind: "rejected", message: "Rejected." }),
      ),
    ).toEqual({ label: "Imported as", name: "places" });
  });
});
