import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isolatePictureData } from "@/lib/test-support/picture-data";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { documentFacts } from "@/lib/metadata/document-facts";
import { ingestFile } from "@/lib/ingest/ingest";
import { updateTableData } from "@/lib/metadata/tables";
import * as query from "@/lib/query/bounded";
import { PictureService } from "./service";
import { getPictureState } from "./state";
isolatePictureData();
afterAll(() => { resetQueryInstance(); closeMetadataDb(); });
beforeEach(() => metadataDb().exec("DELETE FROM maps"));
it("coalesces data changes before evaluating only stored dependents and reuses unchanged bindings at looks", async () => {
  const scope = testAccountScope(), csv = path.join(process.env.DEZFIL_DATA_DIR!, "points.csv");
  await writeFile(csv, "value,lon,lat\n1,1,2\n");
  const source = await ingestFile(scope, csv, "source.csv"), other = await ingestFile(scope, csv, "other.csv");
  let now = Date.now();
  const service = new PictureService({ now: () => now, available: () => false, baseUrl: "http://fixture.test" });
  const maps = [];
  for (let i = 0; i < 10; i++) {
    const map = createMap(scope, `Map ${i}`); maps.push(map);
    await createLayer(scope, map.id, { name: "Points", sql: `SELECT * FROM ${i === 0 ? source.name : other.name}` }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
    await service.request(map.id);
  }
  const before = maps.map(map => getPictureState(map.id)!.requestedGeneration);
  updateTableData(source, { ...source, sourceParams: undefined, file: other.file });
  const evaluations = vi.spyOn(query, "boundedEvaluation");
  try {
    for (let i = 0; i < 10; i++) { await service.dataChanged(source.id); now += 100; }
    expect(evaluations).toHaveBeenCalledTimes(0);
    now += 4899; await service.tick(); expect(evaluations).toHaveBeenCalledTimes(0);
    now++; await service.tick(); expect(evaluations).toHaveBeenCalledTimes(1);
    expect(maps.map(map => getPictureState(map.id)!.requestedGeneration)).toEqual(before.map((n, i) => n + (i === 0 ? 1 : 0)));
    evaluations.mockClear();
    const writes = () => (metadataDb().prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const priorWrites = writes();
    await service.look();
    expect(evaluations).toHaveBeenCalledTimes(0);
    expect(writes()).toBe(priorWrites);
  } finally { evaluations.mockRestore(); }
});

it("resolves again when the owner loses a cached input's reach", async () => {
  const { shareProject } = await import("@/lib/test-support/sharing");
  const { leaveProject } = await import("@/lib/metadata/project-people");
  const { storedBindings } = await import("./bindings");
  const scope = testAccountScope(), supplier = testAccountScope(undefined, "supplier");
  const csv = path.join(process.env.DEZFIL_DATA_DIR!, "shared.csv");
  await writeFile(csv, "value,lon,lat\n1,1,2\n");
  const table = await ingestFile(supplier, csv, "shared.csv");
  shareProject(supplier.accountId, "cached-input", [[scope.accountId, "viewer"]], [table.id]);
  const map = createMap(scope, "Cached reach");
  await createLayer(scope, map.id, { name: "Shared", sql: `SELECT * FROM supplier.${table.name}` }, { expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision });
  const service = new PictureService({ available: () => false, baseUrl: "http://fixture.test" });
  await service.request(map.id);
  expect(storedBindings(map.id)?.resolved).toBe(true);
  leaveProject(scope, "cached-input");
  await service.request(map.id);
  expect(storedBindings(map.id)?.resolved).toBe(false);
});

it("resolves continuous data changes at sixty seconds and gives each next batch its own deadline", async () => {
  const scope = testAccountScope(), csv = path.join(process.env.DEZFIL_DATA_DIR!, "continuous.csv");
  await writeFile(csv, "value,lon,lat\n1,1,2\n");
  const source = await ingestFile(scope, csv, "continuous.csv");
  const map = createMap(scope, "Continuous input");
  await createLayer(scope, map.id, { name: "Points", sql: `SELECT * FROM ${source.name}` }, {
    expectedRevision: documentFacts({ kind: "map", id: map.id }).editRevision,
  });
  let now = 0;
  const service = new PictureService({ now: () => now, available: () => false, baseUrl: "http://fixture.test" });
  await service.request(map.id);
  const evaluations = vi.spyOn(query, "boundedEvaluation");
  try {
    for (now = 0; now < 60000; now += 1000) {
      service.dataChanged(source.id);
      await service.tick();
    }
    expect(evaluations).not.toHaveBeenCalled();
    now = 59999; await service.tick(); expect(evaluations).not.toHaveBeenCalled();
    now = 60000; await service.tick(); expect(evaluations).toHaveBeenCalledTimes(1);
    expect(service.pendingDataIdsForTests()).toEqual([]);

    // The previous batch's ceiling must not shorten the next quiet wait.
    service.dataChanged(source.id);
    now = 64999; await service.tick(); expect(evaluations).toHaveBeenCalledTimes(1);
    now = 65000; await service.tick(); expect(evaluations).toHaveBeenCalledTimes(2);

    // Purging pending identities must also forget their deadline.
    now = 70000; service.dataChanged(source.id); service.clearPendingData();
    now = 200000; service.dataChanged(source.id);
    now = 204999; await service.tick(); expect(evaluations).toHaveBeenCalledTimes(2);
    now = 205000; await service.tick(); expect(evaluations).toHaveBeenCalledTimes(3);
  } finally { evaluations.mockRestore(); }
});
