import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterAll, expect, it } from "vitest";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { removeLayer } from "@/lib/layer-removal";
import { undoChange, redoChange } from "@/lib/map-history";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { documentFacts } from "@/lib/metadata/document-facts";
import { resetQueryInstance } from "@/lib/duckdb";
import { observePictureChanges } from "./hooks";
isolatePictureData();
const scope = testAccountScope();
afterAll(() => { resetQueryInstance(); closeMetadataDb(); });
it("notifies after committed creation, map and layer changes, removal, undo and redo", async () => {
  const events: string[] = [];
  const stop = observePictureChanges(event => { expect(metadataDb().inTransaction).toBe(false); events.push(event.mapId); });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const map = createMap(scope, "Hooks"); await flush(); expect(events.splice(0)).toEqual([map.id]);
    const revision = () => documentFacts({ kind: "map", id: map.id }).editRevision;
    updateMap(scope, map.id, { viewport: { lng: 1, lat: 1, zoom: 3 } }); await flush(); expect(events.splice(0)).toEqual([map.id]);
    const layer = await createLayer(scope, map.id, { name: "Mark", sql: "SELECT ST_Point(1, 1) AS geom" }, { expectedRevision: revision() });
    await flush(); expect(events.splice(0)).toEqual([map.id]);
    await updateLayer(scope, layer.id, { visible: false }, { expectedRevision: revision() }); await flush(); expect(events.splice(0)).toEqual([map.id]);
    await undoChange(scope, map.id, { expectedRevision: revision() }); await flush(); expect(events.splice(0)).toEqual([map.id]);
    await redoChange(scope, map.id, { expectedRevision: revision() }); await flush(); expect(events.splice(0)).toEqual([map.id]);
    await removeLayer(scope, layer.id, { expectedRevision: revision() }); await flush(); expect(events.splice(0)).toEqual([map.id]);
  } finally { stop(); }
});
