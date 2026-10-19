import { afterAll, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isolatePictureData } from "@/lib/test-support/picture-data";
import { testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { createLayer, type LayerRenderData } from "@/lib/layer-service";
import { documentFacts } from "@/lib/metadata/document-facts";
import { createSketch, moveVertex } from "@/lib/sketch/store";
import { ingestFile } from "@/lib/ingest/ingest";
import { removeTable } from "@/lib/table-service";
import { retirementsSettled } from "@/lib/ingest/retire";
import { publishedPictureGeneration, readThumbnail } from "@/lib/map-thumbnails";
import { GET as renderLayer } from "@/app/api/layers/[id]/render/route";
import { encodePng } from "@/lib/export/png-codec";
import { PictureService } from "./service";
import { PictureRenderError } from "./card";
import { observePictureChanges, observePictureDataChanges } from "./hooks";
import { mintPictureCredential, revokePictureCredential } from "./credential";
import { readAttemptInputs } from "./inputs";
import { pictureBindings } from "./bindings";
import { publishPicture } from "./publication";
import { getPictureState } from "./state";
isolatePictureData();
afterAll(async () => { await retirementsSettled(); resetQueryInstance(); closeMetadataDb(); });

/** Real mutation hooks, scheduling and credentialed layer reads. Only the
 * rasterizer is replaced; the opt-in renderer proof checks actual pixels. */
function harness(scope: ReturnType<typeof testAccountScope>) {
  let now = Date.now();
  const jobs: Promise<unknown>[] = [], drawn: LayerRenderData[][] = [], launches: string[] = [];
  const service = new PictureService({ baseUrl: "http://fixture.test", available: () => true, now: () => now, run: async state => {
    launches.push(state.mapId);
    const { target } = await pictureBindings(scope, state.mapId);
    const credential = mintPictureCredential(state.mapId, Date.now() + 60000);
    try {
      const layers = target.map.layers.filter(layer => layer.visible), results: LayerRenderData[] = [];
      for (const layer of layers) {
        const response = await renderLayer(socketRequest(new Request(`http://fixture.test/api/layers/${layer.id}/render`, { headers: { "x-dezfil-picture-work": credential } })), { params: Promise.resolve({ id: layer.id }) });
        const body = await response.json() as LayerRenderData;
        if (!response.ok || !body.ok) throw new PictureRenderError("failed");
        results.push(body);
      }
      const inputs = readAttemptInputs(credential, layers.map(layer => layer.id));
      const png = encodePng({ width: 1, height: 1, rgba: new Uint8Array([launches.length, 0, 0, 255]) });
      await publishPicture(scope, target, state.requestedGeneration, { light: png, ...(target.basemaps.dark ? { dark: png } : {}) }, inputs);
      drawn.push(results);
    } finally { revokePictureCredential(credential); }
  } });
  const stopMap = observePictureChanges(event => { jobs.push(service.request(event.mapId, event.force)); });
  const stopData = observePictureDataChanges(id => service.dataChanged(id));
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await Promise.all(jobs.splice(0)); };
  return { service, launches, drawn, flush,
    tick: async () => { await flush(); now += 5000; await service.tick(); await service.queue.drain(); },
    stop: async () => { stopMap(); stopData(); await flush(); await service.drain(); },
  };
}
function clocks(mapId: string) {
  return { facts: documentFacts({ kind: "map", id: mapId }),
    map: metadataDb().prepare("SELECT updated_at, history_cursor FROM maps WHERE id = ?").get(mapId),
    history: metadataDb().prepare("SELECT * FROM map_history WHERE map_id = ? ORDER BY seq").all(mapId) };
}
it("pictures a sketch created and edited through the sketch store, with changed geometry consumed by the render", async () => {
  const scope = testAccountScope(), map = createMap(scope, "Drawn shape");
  const h = harness(scope);
  try {
    const sketch = await createSketch(scope, map.id, { kind: "polygon", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
    await h.flush();
    expect(getPictureState(map.id)?.state).toBe("waiting");
    const before = clocks(map.id);
    await h.tick();
    expect(h.launches).toEqual([map.id]);
    expect(clocks(map.id)).toEqual(before);
    expect(h.drawn[0][0].geojson).toMatchObject({ features: [{ geometry: { coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] });
    const published = getPictureState(map.id)!;
    await moveVertex(scope, sketch.table.name, sketch.featureId, 1, [2, 0]);
    await h.flush();
    expect(getPictureState(map.id)?.digest).not.toBe(published.digest);
    const afterEdit = clocks(map.id);
    await h.tick();
    expect(h.launches).toEqual([map.id, map.id]);
    expect(h.drawn[1][0].geojson).toMatchObject({ features: [{ geometry: { coordinates: [[[0, 0], [2, 0], [1, 1], [0, 0]]] } }] });
    expect(await publishedPictureGeneration(map.id)).toBeGreaterThan(published.publishedGeneration);
    expect(clocks(map.id)).toEqual(afterEdit);
  } finally { await h.stop(); }
});
it("pictures a failed missing-data map when that data arrives, without editing or reopening the map", async () => {
  const scope = testAccountScope(), csv = path.join(process.env.DEZFIL_DATA_DIR!, "arriving.csv");
  await writeFile(csv, "value,lon,lat\n7,1,2\n");
  const original = await ingestFile(scope, csv, "arriving.csv"), map = createMap(scope, "Missing data");
  await createLayer(scope, map.id, { name: "Arriving", sql: `SELECT * FROM ${original.name}` }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
  await removeTable(scope, original.name);
  const h = harness(scope);
  try {
    await h.service.request(map.id); await h.tick();
    expect(getPictureState(map.id)?.state).toBe("failed");
    expect(await readThumbnail(scope, map.id)).toBeNull();
    const failed = getPictureState(map.id)!, before = clocks(map.id);
    const arrived = await ingestFile(scope, csv, "arriving.csv");
    expect(arrived.name).toBe(original.name); expect(arrived.id).not.toBe(original.id);
    await h.tick();
    expect(getPictureState(map.id)).toMatchObject({ state: "current", requestedGeneration: failed.requestedGeneration + 1 });
    expect(h.launches).toEqual([map.id, map.id]);
    expect(h.drawn[0][0].geojson).toMatchObject({ features: [{ properties: { value: 7 }, geometry: { type: "Point", coordinates: [1, 2] } }] });
    expect(await readThumbnail(scope, map.id)).not.toBeNull();
    expect(clocks(map.id)).toEqual(before);
  } finally { await h.stop(); }
});
