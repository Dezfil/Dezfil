import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { fileMap } from "@/lib/metadata/projects";
import { createLayer, renderLayer, updateLayer } from "@/lib/layer-service";
import { boundedEvaluation } from "@/lib/query/bounded";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject, unfileDataset } from "@/lib/test-support/sharing";
import { singleUserPublication } from "@/lib/test-support/single-user-publication";
import { publishedMessage, ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { resolvePublication } from "./publication-scope";
import { getPublishedView, publishMap, resetPublishCache } from "./publish-service";
import { resetRateLimits } from "./rate-limit";
import type { AccountScope } from "@/lib/auth/scope";
import type { DataTable } from "@/lib/metadata/tables";

/**
 * A published map evaluates in its home with its current owner's reach,
 * restricted to the datasets the map's own SQL names: nothing else of the
 * owner's space is mounted for the link.
 */
const FIXTURE = path.join(process.cwd(), "src/lib/publish/fixtures/single-user-publication.json");
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "publication-context-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetPublishCache(); resetRateLimits();
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); resetPublishCache(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Rendered = { ok: boolean; error?: { code: string; message: string }; geojson?: { features: { properties: Record<string, unknown> }[] } };
const layerOf = (view: Awaited<ReturnType<typeof getPublishedView>>, name: string) =>
  view!.layers.find((layer) => layer.name === name)!.render as Rendered;

describe("a single-user store's publications", () => {
  it("answer a link on plain names byte for byte as before", async () => {
    const before = await readFile(FIXTURE, "utf8");
    const now = await singleUserPublication(directory);
    expect(now).toBe(before);
    // The comparison can fail: one more row anywhere is a different string.
    expect(now.replace('"count": 2', '"count": 3')).not.toBe(before);
  }, 60_000);

  it("fail a layer that reads the catalogue on the link with the documented reason while the owner holds datasets the map does not name", async () => {
    const scope = testAccountScope();
    for (const name of ["roads", "parks"]) {
      const file = path.join(directory, `${name}.csv`);
      await writeFile(file, `sentinel,lon,lat\n${name},1,2\n`);
      await ingestFile(scope, file, `${name}.csv`);
    }
    const map = createMap(scope, "Survey");
    await createLayer(scope, map.id, { name: "Roads", sql: "SELECT * FROM roads" });
    const forms = {
      functions: "SELECT view_name, ST_Point(0, 0) AS geom FROM duckdb_views() WHERE NOT internal",
      columns: "SELECT DISTINCT table_name, ST_Point(0, 0) AS geom FROM duckdb_columns() WHERE NOT internal",
      schema: "SELECT table_name, ST_Point(0, 0) AS geom FROM information_schema.tables",
      master: "SELECT name, ST_Point(0, 0) AS geom FROM sqlite_master",
    };
    const layers = await Promise.all(Object.entries(forms).map(([name, sql]) => createLayer(scope, map.id, { name, sql })));
    // In the owner's own builder the catalogue is the owner's, as before.
    const own = await renderLayer(scope, layers[0]) as Rendered;
    expect(own.geojson!.features.map((feature) => feature.properties.view_name).sort()).toEqual(["parks", "roads"]);
    const { token } = publishMap(scope, map.id);
    const view = await getPublishedView(token, Date.now());
    expect(layerOf(view, "Roads").ok).toBe(true);
    for (const name of Object.keys(forms)) {
      expect(layerOf(view, name), name).toMatchObject({ ok: false,
        error: { code: "catalogue_not_published", message: ERROR_CATALOGUE.catalogue_not_published } });
    }
  }, 60_000);

  it("keep rendering a layer that reads the catalogue when the map names everything the owner holds", async () => {
    const scope = testAccountScope();
    const file = path.join(directory, "roads.csv");
    await writeFile(file, "sentinel,lon,lat\nroad,1,2\n");
    await ingestFile(scope, file, "roads.csv");
    const map = createMap(scope, "Survey");
    await createLayer(scope, map.id, { name: "Roads", sql: "SELECT * FROM roads" });
    await createLayer(scope, map.id, { name: "Views", sql: "SELECT view_name, ST_Point(0, 0) AS geom FROM duckdb_views() WHERE NOT internal" });
    const { token } = publishMap(scope, map.id);
    const views = layerOf(await getPublishedView(token, Date.now()), "Views");
    expect(views.ok).toBe(true);
    expect(views.geojson!.features.map((feature) => feature.properties.view_name)).toEqual(["roads"]);
  }, 60_000);
});

describe("a publication on a shared store", () => {
  // Ada files `roads` in P and keeps `secret` and `parks` to herself; Bob, an
  // editor of P, files his `stations` there. Ada's map M, filed in P, draws
  // her roads and Bob's stations, and is published.
  let scopes: Record<string, AccountScope>;
  let tables: Record<string, DataTable>;
  let token: string;
  let mapId: string;
  beforeEach(async () => {
    scopes = Object.fromEntries(["ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
    tables = {};
    for (const [owner, name] of [["ada", "roads"], ["ada", "secret"], ["ada", "parks"], ["bob", "stations"]]) {
      const file = path.join(directory, `${owner}-${name}.csv`);
      await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
      tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
    }
    shareProject("ada", "P", [["bob", "editor"]], [tables["ada.roads"].id, tables["bob.stations"].id]);
    const map = createMap(scopes.ada, "Survey");
    fileMap(map.id, "P");
    mapId = map.id;
    await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" });
    await createLayer(scopes.ada, map.id, { name: "Stations", sql: "SELECT * FROM bob.stations" });
    token = publishMap(scopes.ada, map.id).token;
  });

  it("mounts only the datasets the map's SQL names", async () => {
    const publication = resolvePublication(token)!.scope;
    const mounted = await boundedEvaluation(async (conn) =>
      (await conn.runAndReadAll("SELECT view_name FROM duckdb_views() WHERE NOT internal ORDER BY view_name")).getRowObjects()
        .map((row) => String(row.view_name)), { scope: publication });
    expect(mounted).toEqual(["bob.stations", "roads"]);
    const view = await getPublishedView(token, Date.now());
    expect(layerOf(view, "Roads").geojson!.features.map((f) => f.properties.sentinel)).toEqual(["ada roads"]);
    expect(layerOf(view, "Stations").geojson!.features.map((f) => f.properties.sentinel)).toEqual(["bob stations"]);
  });

  it("fails by name, never drawing another dataset, once the owner can no longer reach one", async () => {
    unfileDataset("P", tables["bob.stations"].id);
    const publication = resolvePublication(token)!.scope;
    const layer = metadataDb().prepare("SELECT * FROM layers WHERE map_id = ? AND name = 'Stations'").get(mapId) as { id: string };
    const { getLayer } = await import("@/lib/metadata/maps");
    expect(await renderLayer(publication, getLayer(layer.id)!)).toMatchObject({ ok: false,
      error: { code: "sql_error", message: 'The dataset "bob.stations" is not available to you.' } });
    // The link carries the documented sentence for the code, as every
    // published failure does.
    expect(layerOf(await getPublishedView(token, Date.now()), "Stations")).toMatchObject({ ok: false,
      error: { code: "sql_error", message: publishedMessage("sql_error") } });
  });

  it("never serves a view assembled before the owner's reach changed", async () => {
    const now = Date.now();
    expect(layerOf(await getPublishedView(token, now), "Stations").ok).toBe(true);
    unfileDataset("P", tables["bob.stations"].id);
    expect(layerOf(await getPublishedView(token, now + 1), "Stations").ok).toBe(false);
  });

  it("never serves a view assembled before the map's SQL changed", async () => {
    const now = Date.now();
    expect(layerOf(await getPublishedView(token, now), "Roads").ok).toBe(true);
    const roads = metadataDb().prepare("SELECT id FROM layers WHERE map_id = ? AND name = 'Roads'").get(mapId) as { id: string };
    await updateLayer(scopes.ada, roads.id, { sql: "SELECT * FROM parks" });
    expect(layerOf(await getPublishedView(token, now + 1), "Roads").geojson!.features.map((f) => f.properties.sentinel)).toEqual(["ada parks"]);
  });
});
