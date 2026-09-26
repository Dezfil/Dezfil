import { describe, expect, it, vi } from "vitest";
import type { DataTable } from "../api";
import type { Layer } from "@/lib/metadata/maps";
import { defaultStyle } from "@/lib/style/defaults";
import { POINTS_VIZ } from "@/lib/viz";
import {
  createPostgisLayerFromTable,
  dismissedPostgisNotice,
  type PostgisLayerOutcome,
} from "./use-layer-source-coordinator";

function table(spatial = true): DataTable {
  return {
    id: "table-1",
    name: "source_places",
    sourceFilename: null,
    format: "geoparquet",
    file: "tables/source_places.parquet",
    geometryColumn: spatial ? "geom" : null,
    geometryType: spatial ? "POINT" : null,
    crsAssumed: false,
    headerSuspect: false,
    rowCount: 3,
    createdAt: "2026-08-31T10:00:00.000Z",
    source: "postgis",
    sourceParams: { connectionId: "connection-1" },
    importedAt: "2026-08-31T10:00:00.000Z",
  };
}

function layer(): Layer {
  return {
    id: "layer-1",
    mapId: "map-1",
    name: "source_places",
    sql: "SELECT * FROM source_places",
    visible: true,
    style: defaultStyle("POINT"),
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
  };
}

describe("the PostGIS single-table layer outcome", () => {
  it("confirms a spatial layer only from the created response", async () => {
    const request = vi.fn(async () =>
      new Response(JSON.stringify(layer()), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      createPostgisLayerFromTable("map-1", table(), request),
    ).resolves.toEqual({ kind: "created", layer: layer() });
    expect(request).toHaveBeenCalledWith(
      "/api/maps/map-1/layers",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps an attribute-only snapshot without attempting a layer", async () => {
    const request = vi.fn();
    await expect(
      createPostgisLayerFromTable("map-1", table(false), request),
    ).resolves.toEqual({
      kind: "attribute_only",
      message:
        "source_places was imported as a table. It has no geometry for a layer.",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the layer API's definite rejection", async () => {
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: "invalid_request", message: "Geometry is invalid." } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      createPostgisLayerFromTable("map-1", table(), request),
    ).resolves.toEqual({ kind: "rejected", message: "Geometry is invalid." });
  });

  it.each([
    ["unreadable success", async () => new Response("not-json", { status: 201 })],
    ["network failure", async () => Promise.reject(new Error("offline"))],
  ])("returns unconfirmed for %s", async (_case, request) => {
    await expect(
      createPostgisLayerFromTable("map-1", table(), request),
    ).resolves.toEqual({
      kind: "unconfirmed",
      message:
        "The layer create could not be confirmed. The layer may exist. Reloading the map's state; nothing was retried.",
    });
  });
});

describe("dismissed PostGIS completion", () => {
  it.each<[PostgisLayerOutcome, string]>([
    [{ kind: "created", layer: layer() }, "Added source_places to this map"],
    [
      { kind: "attribute_only", message: "inline detail" },
      "source_places kept as a table: no geometry for a layer",
    ],
    [
      { kind: "rejected", message: "inline detail" },
      "source_places landed in datasets: adding the layer failed",
    ],
    [
      { kind: "unconfirmed", message: "inline detail" },
      "Adding source_places could not be confirmed, reloading",
    ],
  ])("routes %s through the durable builder notice", (outcome, notice) => {
    expect(dismissedPostgisNotice(table(), outcome)).toBe(notice);
  });
});
