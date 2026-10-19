import { afterAll, expect, it, vi } from "vitest";
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
