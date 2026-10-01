import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { createLegacyStore, legacy, legacyFiles, legacyRows } from "../../../scripts/legacy-store-fixture.mjs";
import { closeMetadataDb, metadataDb, MIGRATIONS } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { testAccountScope } from "@/lib/test-support/accounts";
import { allMaps, mapWithLayers } from "@/lib/map-service";
import { executeQuery } from "@/lib/query/execute";
import { listRecipes } from "@/lib/metadata/owned-recipes";
import { listProjects, projectMemberIds } from "@/lib/metadata/owned-projects";
import { listOwnedTables } from "@/lib/metadata/owned-tables";
import { getPublishedView } from "@/lib/publish/publish-service";
import { resetPublishCache } from "@/lib/publish/publication-resolution";

/**
 * The legacy store, adopted by its first account at the version just before
 * project sharing, then opened by the application: every list, map, SQL
 * result and the published link read as they did, and nothing is shared.
 */
const ENTRY = MIGRATIONS.findIndex(sql => sql.includes("CREATE TABLE project_people"));
let directory: string;
afterEach(async () => {
  closeMetadataDb(); resetQueryInstance(); resetPublishCache(); vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("opens an adopted store from before project sharing with the same lists, map, SQL result and publication", async () => {
  directory = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "sharing-upgrade-"));
  await createLegacyStore(directory);
  const now = "2026-01-01T00:00:00.000Z";
  const old = new Database(path.join(directory, "metadata.sqlite"));
  old.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.slice(legacy.version, ENTRY)) old.exec(migration);
  old.pragma(`user_version = ${ENTRY}`);
  old.prepare(`INSERT INTO accounts (id, name, email, is_admin, status, created_at, updated_at)
    VALUES ('first', ?, 'first@example.test', 1, 'active', ?, ?)`).run(legacy.name, now, now);
  old.exec("INSERT INTO original_account VALUES (1, 'first')");
  const before = legacyRows(old);
  expect(old.prepare("SELECT DISTINCT owner_id FROM maps").all()).toEqual([{ owner_id: "first" }]);
  old.close();
  const files = await legacyFiles(directory);

  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetPublishCache();
  const db = metadataDb();
  expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  expect(legacyRows(db)).toEqual(before);
  expect(db.prepare("SELECT sql_name FROM accounts").all()).toEqual([{ sql_name: "legacy_cartographer" }]);
  expect(db.prepare("SELECT * FROM project_people").all()).toEqual([]);

  const scope = testAccountScope(db, "first");
  expect(allMaps(scope).map(map => map.id)).toEqual([legacy.map]);
  const map = mapWithLayers(scope, legacy.map);
  expect(map.layers.map(layer => [layer.id, layer.sql])).toEqual([[legacy.layer, `SELECT * FROM ${legacy.table}`]]);
  expect(map.publishToken).toBe(legacy.token);
  expect(listRecipes(scope, db).map(recipe => recipe.id)).toEqual([legacy.workflow]);
  expect(listProjects(scope, db).map(project => [project.id, project.name, project.note])).toEqual([[legacy.project, "Legacy project", "Keep this note"]]);
  expect(projectMemberIds(scope, legacy.project, db)).toEqual({ maps: [legacy.map], recipes: [legacy.workflow], tables: ["legacy-table"] });
  expect(listOwnedTables(scope, db).map(table => table.name)).toEqual([legacy.table]);
  expect((await executeQuery(scope, `SELECT name, value FROM ${legacy.table}`)).preview).toEqual([{ name: "station", value: 7 }]);
  const published = await getPublishedView(legacy.token, Date.now());
  expect(published?.layers[0].render.geojson).toMatchObject({ features: [expect.anything()] });
  expect((await legacyFiles(directory))["tables/legacy.parquet"]).toBe(files["tables/legacy.parquet"]);
});
