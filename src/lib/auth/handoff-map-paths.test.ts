import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { executeQuery } from "@/lib/query/execute";
import { mapEvaluation } from "@/lib/query/context";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import type { DataTable } from "@/lib/metadata/tables";
import type { MapRecord } from "@/lib/metadata/maps";
import type { AccountScope } from "./scope";

/**
 * SQL that lands on a map from somewhere else keeps the datasets it named.
 *
 * Ada owns the project P, its map M and a `roads` filed in P. Bob is an
 * editor of P and owns a `roads` and a `stations` of his own, unfiled. Cyd
 * reaches nothing. Every row carries its owner and dataset as a sentinel.
 *
 * Bob's console SQL added to Ada's map is carried into her home (his `roads`
 * becomes `bob.roads`, her `ada.roads` stays); a dataset page's "Add to a
 * map" names the dataset as the console does and lands its identity; the
 * add-layer workbench previews in the map's home, so what it saves draws what
 * it showed. A refused handoff writes nothing and names the reference.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let map: MapRecord;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "handoff-map-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["bob", "roads"], ["bob", "stations"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "editor"]], [tables["ada.roads"].id]);
  map = createMap(scopes.ada, "Survey", "P");
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, load: () => Promise<Record<string, unknown>>, url: string, params: Record<string, string>, body: unknown, basis?: string) {
  const request = testAccountRequest(new Request(`http://instance.test${url}`, {
    method: "POST", headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": basis } : {}) }, body: JSON.stringify(body),
  }), undefined, account);
  const response = await ((await load()).POST as Handler)(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}
const layers = () => import("@/app/api/maps/[id]/layers/route");
const query = () => import("@/app/api/query/route");
const addLayer = (account: string, body: Record<string, unknown>, mapId: string, basis: string) =>
  call(account, layers, `/api/maps/${mapId}/layers`, { id: mapId }, body, basis);
const layerCount = (mapId = map.id) =>
  (metadataDb().prepare("SELECT COUNT(*) AS n FROM layers WHERE map_id = ?").get(mapId) as { n: number }).n;
/** What the map draws for a reader: the stored SQL in the map's home. */
const drawn = async (account: string, sql: string, mapId = map.id) =>
  (await executeQuery(mapEvaluation(scopes[account], mapId), sql)).preview.map((row) => row.sentinel);

describe("console SQL added to a map", () => {
  it("is carried into the map's home, so Bob's map layer draws his roads and Ada's, as his console did", async () => {
    const sql = "-- both roads\nSELECT * FROM roads UNION ALL SELECT * FROM ada.roads ORDER BY sentinel DESC";
    const created = await addLayer("bob", { name: "Both", sql, writtenIn: { kind: "console" } }, map.id, readEditRevision({ kind: "map", id: map.id })!.editRevision!);
    expect(created.status).toBe(201);
    expect(created.body?.sql).toBe("-- both roads\nSELECT * FROM bob.roads UNION ALL SELECT * FROM ada.roads ORDER BY sentinel DESC");
    expect(await drawn("bob", String(created.body?.sql))).toEqual(["bob roads", "ada roads"]);
    // The same text stored uncarried means Ada's roads twice in her home.
    expect(await drawn("bob", sql)).toEqual(["ada roads", "ada roads"]);
  });

  it("is stored exactly as written when the map's home is the caller's own", async () => {
    const own = createMap(scopes.bob, "Bob's");
    const sql = "select *  from roads -- mine\n";
    const created = await addLayer("bob", { name: "Mine", sql, writtenIn: { kind: "console" } }, own.id, readEditRevision({ kind: "map", id: own.id })!.editRevision!);
    expect(created.status).toBe(201);
    expect(created.body?.sql).toBe(sql);
  });

  it("refuses, naming the reference and writing nothing, what cannot be carried", async () => {
    const before = layerCount();
    const refused = await addLayer("bob", { name: "Gone", sql: "SELECT * FROM roads, missing_table", writtenIn: { kind: "console" } }, map.id, readEditRevision({ kind: "map", id: map.id })!.editRevision!);
    expect(refused).toEqual({ status: 400, body: { error: { code: "sql_error", message: 'The dataset "missing_table" is not available to you.' } } });
    expect(layerCount()).toBe(before);
  });

  it("refuses a malformed context, and a map or workflow it does not reach as a missing one", async () => {
    for (const writtenIn of ["console", { kind: "desk" }, { kind: "map" }, { kind: "console", id: "x" }]) {
      expect((await addLayer("bob", { sql: "SELECT * FROM roads", writtenIn }, map.id, readEditRevision({ kind: "map", id: map.id })!.editRevision!)).body).toMatchObject({ error: { code: "invalid_request" } });
    }
    const hidden = createMap(scopes.cyd, "Cyd's");
    const absent = await addLayer("bob", { sql: "SELECT * FROM roads", writtenIn: { kind: "map", id: hidden.id } }, map.id, readEditRevision({ kind: "map", id: map.id })!.editRevision!);
    const never = await addLayer("bob", { sql: "SELECT * FROM roads", writtenIn: { kind: "map", id: "never-existed" } }, map.id, readEditRevision({ kind: "map", id: map.id })!.editRevision!);
    expect(absent.status).toBe(404);
    expect(absent).toEqual(never);
    expect(layerCount()).toBe(0);
  });
});

describe("a dataset's \"Add to a map\"", () => {
  it("lands the dataset it was opened on, by the name the console types, in any map's home", async () => {
    const { tableSubject, landingRequest } = await import("@/components/AddToMapDialog");
    const own = createMap(scopes.bob, "Bob's");
    // Bob opened Ada's shared roads: its qualified name is what he types.
    const subject = tableSubject("ada.roads")!;
    for (const target of [own.id, map.id]) {
      const created = await addLayer("bob", landingRequest(subject, ""), target, readEditRevision({ kind: "map", id: target })!.editRevision!);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: "roads", sql: "SELECT * FROM ada.roads" });
      expect(await drawn("bob", String(created.body?.sql), target)).toEqual(["ada roads"]);
    }
    // His own roads, opened from his own page, lands as his in Ada's map.
    const mine = await addLayer("bob", landingRequest(tableSubject("roads")!, ""), map.id, readEditRevision({ kind: "map", id: map.id })!.editRevision!);
    expect(mine.body).toMatchObject({ name: "roads", sql: "SELECT * FROM bob.roads" });
    expect(await drawn("bob", String(mine.body?.sql))).toEqual(["bob roads"]);
  });
});

describe("the add-layer workbench", () => {
  it("previews in the map's home, so the layer it saves draws what the preview showed", async () => {
    const { previewRequest } = await import("@/components/builder/add-layer/catalog-state");
    const sql = "SELECT sentinel FROM roads";
    const preview = await call("bob", query, "/api/query", {}, previewRequest(sql, map.id));
    expect(preview.status).toBe(200);
    expect((preview.body?.preview as { sentinel: string }[]).map((row) => row.sentinel)).toEqual(["ada roads"]);
    // The console would have shown Bob's own.
    const console = await call("bob", query, "/api/query", {}, previewRequest(sql));
    expect((console.body?.preview as { sentinel: string }[]).map((row) => row.sentinel)).toEqual(["bob roads"]);
    const saved = await addLayer("bob", { name: "Previewed", sql: "SELECT * FROM roads" }, map.id, readEditRevision({ kind: "map", id: map.id })!.editRevision!);
    expect(await drawn("bob", String(saved.body?.sql))).toEqual(["ada roads"]);
  });

  it("names, in the map's home, a reference that binds nothing for the caller", async () => {
    const refused = await call("bob", query, "/api/query", {}, { sql: "SELECT * FROM stations_x", writtenIn: { kind: "map", id: map.id } });
    expect(refused).toEqual({ status: 400, body: { error: { code: "sql_error", message: 'The dataset "stations_x" is not available to you.' } } });
    const outsider = await call("cyd", query, "/api/query", {}, { sql: "SELECT 1", writtenIn: { kind: "map", id: map.id } });
    const never = await call("cyd", query, "/api/query", {}, { sql: "SELECT 1", writtenIn: { kind: "map", id: "never-existed" } });
    expect(outsider.status).toBe(404);
    expect(outsider).toEqual(never);
  });
});
