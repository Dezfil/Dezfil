import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getConnection, insertConnection } from "@/lib/metadata/connections";
import { resetSecretKeyCache } from "@/lib/secrets";
import { getTableByName } from "@/lib/metadata/tables";
import { refreshTable } from "@/lib/ingest/refresh";
import { withConnection } from "@/lib/duckdb";
import { POST as createConnection } from "@/app/api/connections/postgis/route";
import { PATCH as updateConnection } from "@/app/api/connections/postgis/[id]/route";
import {
  testConnection,
  listRemoteTables,
  attachString,
  withPg,
} from "./access";
import { importPostgis } from "./import";
import { previewPostgis } from "./preview";

/**
 * Live integration against a real PostGIS server. Opt-in: point DEZFIL_TEST_PG_URL at a
 * DISPOSABLE database, e.g.
 *
 *   docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgis/postgis:16-3.4
 *   DEZFIL_TEST_PG_URL=postgres://postgres:test@127.0.0.1:54329/postgres vitest run postgis.live
 *
 * The suite creates and drops its own schema (dezfil_test).
 */

const url = process.env.DEZFIL_TEST_PG_URL || undefined;
const live = describe.skipIf(!url);

function parse(u: string) {
  const p = new URL(u);
  return {
    host: p.hostname,
    port: Number(p.port || 5432),
    database: p.pathname.replace(/^\//, "") || "postgres",
    username: decodeURIComponent(p.username || "postgres"),
    password: decodeURIComponent(p.password || ""),
    ssl: false,
  };
}

let dir: string;

live(url ? "postgis live integration" : "SKIP: DEZFIL_TEST_PG_URL is missing (disposable PostGIS, docs/operate/runbook.md)", () => {
  // The describe body evaluates even when skipped — parse a placeholder.
  const target = parse(url ?? "postgres://postgres:test@127.0.0.1:54329/postgres");
  const rotationRole = `dezfil_live_rotation_${process.pid}`;
  const oldPassword = "dezfil-live-old";
  const newPassword = "dezfil-live-new";
  // The egress policy blocks loopback by default; the disposable test
  // server usually lives there, so opt it in explicitly.
  process.env.DEZFIL_EGRESS_ALLOWLIST = `${target.host},localhost`;

  /** Seed geometry in EPSG:3857 (validates the source-side transform),
   * geography in 4326, and an attribute-only table. */
  async function execOnSource(
    statements: string[],
    tolerateStatementFailures = false,
  ): Promise<void> {
    await withConnection(async (conn) => {
      await conn.run("INSTALL postgres; LOAD postgres;");
      await conn.run(
        `ATTACH '${attachString(target).replace(/'/g, "''")}' AS seedpg (TYPE postgres)`,
      );
      try {
        for (const sql of statements) {
          try {
            await conn.run(
              `CALL postgres_execute('seedpg', '${sql.replace(/'/g, "''")}')`,
            );
          } catch (error) {
            if (!tolerateStatementFailures) throw error;
          }
        }
      } finally {
        await conn.run("DETACH seedpg").catch(() => {});
      }
    });
  }

  beforeAll(async () => {
    await execOnSource([
      "DROP TABLE IF EXISTS public.dezfil_live_pts",
      "DROP TABLE IF EXISTS public.dezfil_live_attrs",
      "DROP TABLE IF EXISTS public.dezfil_live_geography",
      "DROP TABLE IF EXISTS public.dezfil_live_multi_geometry",
      "DROP TABLE IF EXISTS public.dezfil_live_multi_kind",
      "CREATE TABLE public.dezfil_live_pts (id int PRIMARY KEY, name text, geom geometry(Point, 3857))",
      "INSERT INTO public.dezfil_live_pts SELECT id, 'point-' || id, ST_Transform(ST_SetSRID(ST_MakePoint(13.39 + id * 0.01, 52.49 + id * 0.01), 4326), 3857) FROM generate_series(1, 7) AS id",
      "CREATE TABLE public.dezfil_live_attrs (id int PRIMARY KEY, label text)",
      "INSERT INTO public.dezfil_live_attrs VALUES (1, 'x'), (2, 'y')",
      "CREATE TABLE public.dezfil_live_geography (id int PRIMARY KEY, label text, geog geography(Point, 4326))",
      "INSERT INTO public.dezfil_live_geography VALUES (1, 'Tiergarten', ST_SetSRID(ST_MakePoint(13.35, 52.51), 4326)::geography), (2, 'Alexanderplatz', ST_SetSRID(ST_MakePoint(13.413, 52.522), 4326)::geography)",
      "CREATE TABLE public.dezfil_live_multi_geometry (id int PRIMARY KEY, z_geom geometry(Point, 3857), a_geom geometry(LineString, 4326))",
      "CREATE TABLE public.dezfil_live_multi_kind (id int PRIMARY KEY, a_geom geometry(Point, 4326), zz_geog geography(Point, 4326))",
      "DROP SCHEMA IF EXISTS dezfil_live_rotation CASCADE",
      "CREATE SCHEMA dezfil_live_rotation",
      "CREATE TABLE dezfil_live_rotation.rotation_source (id int PRIMARY KEY, label text)",
      "INSERT INTO dezfil_live_rotation.rotation_source VALUES (1, 'before rotation')",
      `CREATE ROLE ${rotationRole} LOGIN PASSWORD '${oldPassword}'`,
      `GRANT USAGE ON SCHEMA dezfil_live_rotation TO ${rotationRole}`,
      `GRANT SELECT ON TABLE dezfil_live_rotation.rotation_source TO ${rotationRole}`,
      "ANALYZE public.dezfil_live_pts",
      "ANALYZE public.dezfil_live_geography",
      "DROP SCHEMA IF EXISTS dezfil_live_import CASCADE",
      "CREATE SCHEMA dezfil_live_import",
      "CREATE TABLE dezfil_live_import.ordinary_catalog_entry (id int)",
      "ALTER EXTENSION postgis ADD TABLE dezfil_live_import.ordinary_catalog_entry",
      "CREATE VIEW dezfil_live_import.system_status_view AS SELECT 1 AS id",
      "ALTER EXTENSION postgis ADD VIEW dezfil_live_import.system_status_view",
      "CREATE TABLE dezfil_live_import.postgis_helper (id int)",
      "CREATE VIEW dezfil_live_import.current_rows AS SELECT id FROM dezfil_live_import.postgis_helper",
      "CREATE MATERIALIZED VIEW dezfil_live_import.cached_rows AS SELECT generate_series(1, 3) AS id",
      "ANALYZE dezfil_live_import.cached_rows",
      "CREATE TABLE dezfil_live_import.never_analyzed (id int)",
      "CREATE TABLE dezfil_live_import.analyzed_empty (id int)",
      "ANALYZE dezfil_live_import.analyzed_empty",
    ]);
  }, 120_000);

  afterAll(async () => {
    await execOnSource([
      "DROP TABLE IF EXISTS public.dezfil_live_pts",
      "DROP TABLE IF EXISTS public.dezfil_live_attrs",
      "DROP TABLE IF EXISTS public.dezfil_live_geography",
      "DROP TABLE IF EXISTS public.dezfil_live_multi_geometry",
      "DROP TABLE IF EXISTS public.dezfil_live_multi_kind",
      "DROP SCHEMA IF EXISTS dezfil_live_rotation CASCADE",
      "ALTER EXTENSION postgis DROP TABLE dezfil_live_import.ordinary_catalog_entry",
      "ALTER EXTENSION postgis DROP VIEW dezfil_live_import.system_status_view",
      "DROP SCHEMA IF EXISTS dezfil_live_import CASCADE",
      `DROP ROLE IF EXISTS ${rotationRole}`,
    ], true).catch(() => {});
  }, 60_000);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
    process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
    closeMetadataDb();
    resetSecretKeyCache();
  });

  afterEach(async () => {
    closeMetadataDb();
    resetSecretKeyCache();
    delete process.env.DEZFIL_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("tests the connection and reports versions", async () => {
    const health = await testConnection(target);
    expect(health.serverVersion).toMatch(/PostgreSQL/);
    expect(health.postgisVersion).not.toBeNull();
  });

  it("fails specifically on a wrong password", async () => {
    await expect(
      testConnection({ ...target, password: "definitely-wrong" }),
    ).rejects.toMatchObject({ code: "connection_failed" });
  });

  it("lists both seeded tables with honest shapes", async () => {
    const tables = await listRemoteTables(target);
    const spatial = tables.find((t) => t.table === "dezfil_live_pts");
    const attrs = tables.find((t) => t.table === "dezfil_live_attrs");
    expect(spatial?.geometryColumn).toBe("geom");
    expect(spatial?.geometryType).toBe("POINT");
    expect(spatial?.srid).toBe(3857);
    expect(attrs?.geometryColumn).toBeNull();
  });

  it("lists geography as spatial and imports a spatial snapshot (live gate)", async () => {
    const tables = await listRemoteTables(target);
    const geography = tables.find(
      (table) => table.table === "dezfil_live_geography",
    );
    expect(geography).toMatchObject({
      schema: "public",
      kind: "table",
      system: false,
      geometryColumn: "geog",
      geometryType: "Point",
      srid: 4326,
      spatialKind: "geography",
      approxRows: 2,
    });

    insertConnection(testAccountScope(), { id: "geography-live", name: "geography", ...target });
    const imported = await importPostgis(testAccountScope(), {
      connectionId: "geography-live",
      schema: "public",
      table: "dezfil_live_geography",
      name: "pg_live_geography",
    });
    expect(imported).toMatchObject({
      source: "postgis",
      rowCount: 2,
      geometryColumn: "geog",
      geometryType: "POINT",
    });

    const { dataDir } = await import("@/lib/config");
    const point = await withConnection(async (conn) => {
      const read = await conn.runAndReadAll(
        `SELECT ST_X(geog) AS x, ST_Y(geog) AS y FROM read_parquet('${path
          .join(dataDir(), imported.file)
          .replace(/'/g, "''")}') ORDER BY id LIMIT 1`,
      );
      return read.getRowObjects()[0] as { x: number; y: number };
    });
    expect(Number(point.x)).toBeCloseTo(13.35, 3);
    expect(Number(point.y)).toBeCloseTo(52.51, 3);
  });

  it("selects the first spatial column and flags a real extension relation", async () => {
    const tables = await listRemoteTables(target);
    const multiGeometry = tables.find(
      (table) => table.table === "dezfil_live_multi_geometry",
    );
    const spatialRefSys = tables.find(
      (table) => table.schema === "public" && table.table === "spatial_ref_sys",
    );

    expect(multiGeometry).toMatchObject({
      schema: "public",
      kind: "table",
      system: false,
      geometryColumn: "a_geom",
      geometryType: "LINESTRING",
      srid: 4326,
      spatialKind: "geometry",
    });
    expect(spatialRefSys).toMatchObject({
      kind: "table",
      system: true,
    });

    // The FIRST ordering key: a relation in both catalogues picks its
    // geography column even when the geometry column sorts earlier by
    // name.
    const multiKind = tables.find(
      (table) => table.table === "dezfil_live_multi_kind",
    );
    expect(multiKind).toMatchObject({
      geometryColumn: "zz_geog",
      spatialKind: "geography",
    });
  });

  it("derives system membership independently from relation kind (red control)", async () => {
    const tables = await listRemoteTables(target);
    const fixture = tables.filter(
      (table) => table.schema === "dezfil_live_import",
    );
    const byName = new Map(fixture.map((table) => [table.table, table]));

    expect(byName.get("ordinary_catalog_entry")).toMatchObject({
      kind: "table",
      system: true,
    });
    expect(byName.get("system_status_view")).toMatchObject({
      kind: "view",
      system: true,
    });
    expect(byName.get("postgis_helper")).toMatchObject({
      kind: "table",
      system: false,
    });
  });

  it("keeps absent, unknown, known-zero, and known estimates distinct (red control)", async () => {
    const tables = await listRemoteTables(target);
    const fixture = tables.filter(
      (table) => table.schema === "dezfil_live_import",
    );
    const byName = new Map(fixture.map((table) => [table.table, table]));

    expect(byName.get("current_rows")).toEqual(
      expect.objectContaining({ kind: "view" }),
    );
    expect(byName.get("current_rows")).not.toHaveProperty("approxRows");
    expect(byName.get("cached_rows")).toMatchObject({
      kind: "materialized_view",
      approxRows: 3,
    });
    expect(byName.get("never_analyzed")).toMatchObject({
      kind: "table",
      approxRows: null,
    });
    expect(byName.get("analyzed_empty")).toMatchObject({
      kind: "table",
      approxRows: 0,
    });
  });

  it("previews the guarded filtered SELECT at a fixed five rows without mutating the source", async () => {
    insertConnection(testAccountScope(), { id: "preview-live", name: "preview", ...target });
    const sourceCount = async () =>
      withPg(target, async (conn, passthrough) => {
        const read = await conn.runAndReadAll(
          `SELECT * FROM ${passthrough("SELECT count(*)::bigint AS n FROM public.dezfil_live_pts")}`,
        );
        return Number(read.getRowObjects()[0]?.n);
      });
    const before = await sourceCount();

    const unfiltered = await previewPostgis(testAccountScope(), "preview-live", {
      schema: "public",
      table: "dezfil_live_pts",
    });
    const filtered = await previewPostgis(testAccountScope(), "preview-live", {
      schema: "public",
      table: "dezfil_live_pts",
      filter: "id > 5",
    });
    const empty = await previewPostgis(testAccountScope(), "preview-live", {
      schema: "public",
      table: "dezfil_live_pts",
      filter: "false",
    });

    expect(unfiltered.rows).toHaveLength(5);
    expect(unfiltered.rows[0]?.geom).toMatch(/^POINT\s*\(/);
    expect(filtered.rows).toHaveLength(2);
    expect(filtered.rows).not.toEqual(unfiltered.rows);
    expect(empty.rows).toEqual([]);
    expect(empty.columns.map((column) => column.name)).toEqual([
      "id",
      "name",
      "geom",
    ]);
    await expect(
      previewPostgis(testAccountScope(), "preview-live", {
        schema: "public",
        table: "dezfil_live_pts",
        filter: "true; SELECT 1",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message:
        "The filter must be a single WHERE expression: no statement separators or comments.",
    });
    await expect(
      previewPostgis(testAccountScope(), "preview-live", {
        schema: "public",
        table: "dezfil_live_pts",
        filter: "missing_column = 1",
      }),
    ).rejects.toMatchObject({ code: "malformed_file" });
    expect(await sourceCount()).toBe(before);
  });

  it("imports, transforms to WGS84, filters, refreshes atomically", async () => {
    insertConnection(testAccountScope(), { id: "live-1", name: "live", ...target });

    const imported = await importPostgis(testAccountScope(), {
      connectionId: "live-1",
      schema: "public",
      table: "dezfil_live_pts",
      name: "pg_live_import",
      filter: "id <= 2",
    });
    expect(imported.source).toBe("postgis");
    expect(imported.rowCount).toBe(2); // the filter ran on the source
    expect(imported.geometryColumn).toBe("geom");
    expect(imported.geometryType).toBe("POINT");

    // 3857 → 4326 happened at the source: coordinates are lon/lat again.
    const { withConnection: withDuck } = await import("@/lib/duckdb");
    const { dataDir } = await import("@/lib/config");
    const x = await withDuck(async (conn) => {
      const read = await conn.runAndReadAll(
        `SELECT ST_X(geom) AS x, ST_Y(geom) AS y FROM read_parquet('${path
          .join(dataDir(), imported.file)
          .replace(/'/g, "''")}') ORDER BY id LIMIT 1`,
      );
      return read.getRowObjects()[0] as { x: number; y: number };
    });
    expect(Number(x.x)).toBeCloseTo(13.4, 3);
    expect(Number(x.y)).toBeCloseTo(52.5, 3);

    const refreshed = await refreshTable(testAccountScope(), "pg_live_import");
    expect(refreshed.rowCount).toBe(2);
    expect(getTableByName("pg_live_import")?.file).not.toBe(imported.file);

    // attribute-only table imports too (joins are the point)
    const attrs = await importPostgis(testAccountScope(), {
      connectionId: "live-1",
      schema: "public",
      table: "dezfil_live_attrs",
      name: "pg_live_attrs",
    });
    expect(attrs.geometryColumn).toBeNull();
    expect(attrs.rowCount).toBe(2);
  });

  it("keeps one snapshot refreshable through password rotation and reports a repointed missing recipe", async () => {
    const reader = { ...target, username: rotationRole, password: oldPassword };
    const create = await createConnection(
      testAccountRequest(new Request("http://localhost/api/connections/postgis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Rotation source", ...reader }),
      })),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };

    const imported = await importPostgis(testAccountScope(), {
      connectionId: created.id,
      schema: "dezfil_live_rotation",
      table: "rotation_source",
      name: "pg_live_rotation",
    });
    expect(imported.rowCount).toBe(1);

    await execOnSource([
      `ALTER ROLE ${rotationRole} PASSWORD '${newPassword}'`,
      "INSERT INTO dezfil_live_rotation.rotation_source VALUES (2, 'after rotation')",
    ]);
    const beforeCredentialFailure = getTableByName(imported.name);
    await expect(refreshTable(testAccountScope(), imported.name)).rejects.toMatchObject({
      code: "connection_failed",
      message: "Authentication failed. Check the username and password.",
    });
    expect(getTableByName(imported.name)).toEqual(beforeCredentialFailure);

    const savePassword = await updateConnection(
      testAccountRequest(new Request(`http://localhost/api/connections/postgis/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      })),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(savePassword.status).toBe(200);
    expect(((await savePassword.json()) as { id: string }).id).toBe(created.id);

    const refreshed = await refreshTable(testAccountScope(), imported.name);
    expect(refreshed.id).toBe(imported.id);
    expect(refreshed.rowCount).toBe(2);
    expect(refreshed.sourceParams?.connectionId).toBe(created.id);
    expect(refreshed.file).not.toBe(imported.file);

    const repoint = await updateConnection(
      testAccountRequest(new Request(`http://localhost/api/connections/postgis/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ database: "template1" }),
      })),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(repoint.status).toBe(200);
    expect(((await repoint.json()) as { id: string }).id).toBe(created.id);
    expect(getConnection(testAccountScope(), created.id)?.database).toBe("template1");

    const beforeHostRepoint = getConnection(testAccountScope(), created.id);
    const refusedHostRepoint = await updateConnection(
      testAccountRequest(new Request(`http://localhost/api/connections/postgis/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: "localhost" }),
      })),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(refusedHostRepoint.status).toBe(400);
    expect(await refusedHostRepoint.json()).toEqual({
      error: {
        code: "connection_password_required",
        message:
          "Enter the password again when changing the host or port, or turning SSL off.",
      },
    });
    expect(getConnection(testAccountScope(), created.id)).toEqual(beforeHostRepoint);

    const completedHostRepoint = await updateConnection(
      testAccountRequest(new Request(`http://localhost/api/connections/postgis/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: "localhost", password: newPassword }),
      })),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(completedHostRepoint.status).toBe(200);
    expect(getConnection(testAccountScope(), created.id)?.host).toBe("localhost");

    const beforeMissingRecipe = getTableByName(imported.name);
    await expect(refreshTable(testAccountScope(), imported.name)).rejects.toMatchObject({
      code: "not_refreshable",
      message:
        'The stored recipe for "dezfil_live_rotation.rotation_source" no longer resolves on this connection. The previous snapshot data is unchanged.',
    });
    expect(getTableByName(imported.name)).toEqual(beforeMissingRecipe);
  }, 120_000);
});

