import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterAll, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { resetQueryInstance } from "@/lib/duckdb";
import { ensureTiles, tileBuildsSettled } from "@/lib/tiles/build";
import { privateTileAccess } from "@/lib/tiles/access";
import { getTileRecord } from "@/lib/metadata/tiles";
import { observePictureChanges } from "./hooks";
vi.mock("@/lib/tiles/tiler", () => ({ runTiler: async (_source: string, destination: string) => { await (await import("node:fs/promises")).writeFile(destination, "archive"); return { ok: true }; } }));
isolatePictureData();
afterAll(() => { resetQueryInstance(); closeMetadataDb(); });
it("notifies only after the tile archive and ready record are committed", async () => {
  const scope = testAccountScope(), map = createMap(scope, "Tiles");
  const sql = "SELECT ST_Point(1, 2) AS geom";
  const layer = await createLayer(scope, map.id, { name: "Point", sql }, { expectedRevision: readDocumentRevision({ kind: "map", id: map.id })?.editRevision });
  await Promise.resolve();
  const events: string[] = [];
  const stop = observePictureChanges(event => {
    expect(metadataDb().inTransaction).toBe(false);
    expect(getTileRecord(layer.id)?.state).toBe("ready");
    events.push(event.mapId);
  });
  try {
    ensureTiles(privateTileAccess(scope, layer.id), { layerId: layer.id, sql, filters: [], geometryColumn: "geom", columns: [], projection: "" });
    await tileBuildsSettled();
    expect(events).toEqual([map.id]);
  } finally { stop(); }
});
