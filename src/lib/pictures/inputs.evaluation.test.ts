import { isolatePictureData } from "@/lib/test-support/picture-data";
import { afterAll, beforeAll, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { namedSql } from "@/lib/query/named-sql";
import { mapEvaluation } from "@/lib/query/context";
import { pictureWorkScope } from "@/lib/auth/scope";
import { requestPicture } from "./state";
import { mintPictureCredential } from "./credential";
import { collectPictureEvaluation, readAttemptInputs } from "./inputs";
isolatePictureData();
let mapId: string;
let files: { id: string; file: string }[];
beforeAll(async () => {
  const scope = testAccountScope();
  mapId = createMap(scope, "Evidence").id;
  requestPicture(mapId, "drawing", Date.now());
  files = [];
  for (const name of ["roads", "parks"]) {
    const file = path.join(process.env.DEZFIL_DATA_DIR!, `${name}.csv`);
    await writeFile(file, "value,lon,lat\n1,1,2\n");
    const table = await ingestFile(scope, file, `${name}.csv`);
    files.push({ id: table.id, file: table.file });
  }
});
afterAll(() => { resetQueryInstance(); closeMetadataDb(); });
it("collects plain and catalogue evaluations under the actual owner's map home", async () => {
  for (const catalogue of [false, true]) {
    const credential = mintPictureCredential(mapId, Date.now() + 60000);
    const { scope } = pictureWorkScope(credential);
    await collectPictureEvaluation(scope, "drawn", () => boundedEvaluation(async conn => {
      await conn.runAndReadAll(await namedSql(conn, catalogue ? "SELECT * FROM roads WHERE EXISTS (SELECT table_name FROM duckdb_tables())" : "SELECT * FROM roads"));
    }, { scope: mapEvaluation(scope, mapId) }));
    expect(readAttemptInputs(credential, ["drawn"])).toEqual({ catalogue, datasets: (catalogue ? files : [files[0]]).toSorted((a, b) => a.id.localeCompare(b.id)) });
  }
});
it("a dataset replaced after the evaluation bound it never earns the replacement's identity", async () => {
  const credential = mintPictureCredential(mapId, Date.now() + 60000);
  const { scope } = pictureWorkScope(credential);
  await collectPictureEvaluation(scope, "drawn", () => boundedEvaluation(async conn => {
    await conn.runAndReadAll(await namedSql(conn, "SELECT * FROM roads"));
    metadataDb().prepare("UPDATE data_tables SET file = 'tables/replacement.parquet' WHERE id = ?").run(files[0].id);
  }, { scope: mapEvaluation(scope, mapId) }));
  expect(() => readAttemptInputs(credential, ["drawn"])).toThrow("inputs changed");
  const stored = metadataDb().prepare("SELECT work_inputs FROM map_pictures WHERE map_id = ?").get(mapId) as { work_inputs: string };
  expect(JSON.parse(stored.work_inputs).inputs.datasets).toEqual([files[0]]);
});
