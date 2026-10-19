import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterAll, beforeEach, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { documentFacts } from "@/lib/metadata/document-facts";
import { updateTableData } from "@/lib/metadata/tables";
import { deleteOwnedTable } from "@/lib/metadata/owned-tables";
import { removeTable } from "@/lib/table-service";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { ingestFile } from "@/lib/ingest/ingest";
import { testAccountScope } from "@/lib/test-support/accounts";
import { resetQueryInstance } from "@/lib/duckdb";
import { getPictureState, settlePicture } from "./state";
import { PictureService } from "./service";
import { observePictureDataChanges } from "./hooks";
import { storedBindings } from "./bindings";
isolatePictureData();
const scope = testAccountScope();
afterAll(() => { resetQueryInstance(); closeMetadataDb(); });
beforeEach(() => metadataDb().exec("DELETE FROM maps"));
it("committed data hooks resolve current SQL, ignore unrelated data and advance sketch drawings", async () => {
  const events: string[] = [], launches: string[] = [];
  const stop = observePictureDataChanges(id => { expect(metadataDb().inTransaction).toBe(false); events.push(id); });
  let now = Date.now();
  const service = new PictureService({ baseUrl: "http://fixture.test", now: () => now, available: () => true, run: async state => { launches.push(state.mapId); settlePicture(state.mapId, state.requestedGeneration, { state: "current" }); } });
  try {
    const csv = path.join(process.env.DEZFIL_DATA_DIR!, "roads.csv");
    await writeFile(csv, "value,lon,lat\n1,1,2\n");
    const roads = await ingestFile(scope, csv, "roads.csv"), unrelated = await ingestFile(scope, csv, "other.csv");
    const map = createMap(scope, "Bound"), catalogue = createMap(scope, "Catalogue");
    await createLayer(scope, map.id, { name: "Roads", sql: "SELECT * FROM roads" }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
    await createLayer(scope, catalogue.id, { name: "Catalogue", sql: "SELECT ST_Point(1, 2) AS geom WHERE EXISTS (SELECT table_name FROM duckdb_tables())" }, { expectedRevision: documentFacts({ kind: "map", id: catalogue.id }).editRevision });
    await service.request(map.id); await service.request(catalogue.id);
    now += 5000; service.queue.tick(); await service.queue.drain(); service.queue.tick(); await service.queue.drain();
    launches.length = 0;
    const initial = getPictureState(map.id)!;
    const cat = getPictureState(catalogue.id)!;
    expect(updateTableData(unrelated, { ...unrelated, sourceParams: undefined, file: roads.file })).toBe(true);
    await Promise.resolve(); expect(events).toContain(unrelated.id);
    expect(roads.file).not.toBe(unrelated.file);
    expect(await (await import("./bindings")).pictureBindings(scope, catalogue.id)).toMatchObject({ resolved: true });
    service.dataChanged(unrelated.id); now += 5000; await service.tick(); await service.queue.drain();
    expect(getPictureState(map.id)?.requestedGeneration).toBe(initial.requestedGeneration);
    expect(launches).toEqual([catalogue.id]);
    launches.length = 0;
    expect(getPictureState(catalogue.id)?.requestedGeneration).toBe(cat.requestedGeneration + 1);
    now += 100;
    updateTableData(roads, { ...roads, sourceParams: undefined, file: unrelated.file });
    service.dataChanged(roads.id); now += 5000; await service.tick(); await service.queue.drain();
    // Both maps changed. A single slot admits one per tick, in either order.
    await service.tick(); await service.queue.drain();
    expect(getPictureState(map.id)).toMatchObject({ requestedGeneration: initial.requestedGeneration + 1, drawingChangedAt: initial.drawingChangedAt });
    expect(launches.sort()).toEqual([map.id, catalogue.id].sort());
    metadataDb().prepare("UPDATE data_tables SET source = 'sketch' WHERE id = ?").run(roads.id);
    await service.request(map.id);
    const sketch = getPictureState(map.id)!; now += 100;
    updateTableData({ ...roads, file: unrelated.file }, { ...roads, sourceParams: undefined, file: roads.file });
    service.dataChanged(roads.id); now += 5000; await service.tick(); await service.queue.drain();
    expect(getPictureState(map.id)?.digest).not.toBe(sketch.digest);
    expect(getPictureState(map.id)?.drawingChangedAt).toBe(now - 5000);
  } finally { stop(); }
});

it("a committed dataset deletion notifies and requeues its current map, but a refused deletion does not", async () => {
  const csv = path.join(process.env.DEZFIL_DATA_DIR!, "deleted.csv");
  await writeFile(csv, "value,lon,lat\n1,1,2\n");
  const source = await ingestFile(scope, csv, "deleted.csv");
  const map = createMap(scope, "Deleted input"), unrelated = createMap(scope, "No deleted input");
  await createLayer(scope, map.id, { name: "Deleted", sql: `SELECT * FROM ${source.name}` }, {
    expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision,
  });
  let now = Date.now();
  const launches: string[] = [], events: string[] = [];
  const service = new PictureService({ baseUrl: "http://fixture.test", now: () => now, available: () => true,
    run: async state => { launches.push(state.mapId); settlePicture(state.mapId, state.requestedGeneration, { state: "current" }); },
  });
  await service.request(map.id); await service.request(unrelated.id);
  now += 5000;
  await service.tick(); await service.drain(); await service.tick(); await service.drain();
  expect(getPictureState(map.id)?.state).toBe("current");
  expect(storedBindings(map.id)).toMatchObject({ resolved: true, inputs: { datasets: [{ id: source.id }] } });
  const generation = getPictureState(map.id)!.requestedGeneration;
  launches.length = 0;
  const stop = observePictureDataChanges(id => {
    expect(metadataDb().inTransaction).toBe(false);
    expect(metadataDb().prepare("SELECT id FROM data_tables WHERE id = ?").get(id)).toBeUndefined();
    events.push(id); service.dataChanged(id);
  });
  try {
    expect(deleteOwnedTable(scope, { ...source, name: "wrong_name" })).toBe(false);
    await Promise.resolve(); expect(events).toEqual([]);
    await removeTable(scope, source.name);
    expect(events).toEqual([source.id]);
    expect(deleteOwnedTable(scope, source)).toBe(false);
    await Promise.resolve(); expect(events).toEqual([source.id]);
    now += 5000; await service.tick(); await service.drain();
    expect(getPictureState(map.id)?.requestedGeneration).toBe(generation + 1);
    expect(storedBindings(map.id)?.inputs.datasets.map(input => input.id)).not.toContain(source.id);
    expect(launches).toEqual([map.id]);
  } finally { stop(); }
});
