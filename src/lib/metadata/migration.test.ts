import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { open, MIGRATIONS } from "./db";
import {
  getMap,
  getPublishedSnapshot,
  getPublishedTheme,
  getViewerControls,
  listLayers,
  normalizeViewerControls,
} from "./maps";
import { getTableByName } from "./tables";
import { createRecipe, getRecipe, listRecipes } from "./recipes";
import { getProject, mapProjectId, tableProjectIds } from "./projects";
import { getLayout, putLayout } from "./recipe-layouts";
import { getConnection } from "./connections";

/**
 * A database written (schema v2, no basemap/tooltip/legend columns, styles
 * without split opacities) must upgrade in place and read cleanly (legacy
 * records default on read).
 */

function writeV2Database(file: string): void {
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE data_tables (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      source_filename TEXT NOT NULL, format TEXT NOT NULL, file TEXT NOT NULL,
      geometry_column TEXT, geometry_type TEXT,
      crs_assumed INTEGER NOT NULL DEFAULT 0,
      row_count INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE maps (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      view_lng REAL NOT NULL DEFAULT 0, view_lat REAL NOT NULL DEFAULT 20,
      view_zoom REAL NOT NULL DEFAULT 1.4, publish_token TEXT UNIQUE,
      published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE layers (id TEXT PRIMARY KEY,
      map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      name TEXT NOT NULL, sql TEXT NOT NULL, style TEXT NOT NULL,
      visible INTEGER NOT NULL DEFAULT 1, ordinal INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX idx_layers_map ON layers(map_id, ordinal);
  `);
  const now = new Date().toISOString();
  legacy
    .prepare(
      `INSERT INTO data_tables (id, name, source_filename, format, file, row_count, created_at)
       VALUES ('t1', 'legacy_points', 'points.csv', 'csv', 'tables/t1.parquet', 7, ?)`,
    )
    .run(now);
  legacy
    .prepare(
      `INSERT INTO maps (id, name, created_at, updated_at) VALUES ('m1', 'Legacy map', ?, ?)`,
    )
    .run(now, now);
  const legacyStyle = JSON.stringify({
    fill: { type: "constant", color: { r: 63, g: 184, b: 175, a: 0.72 } },
    stroke: { r: 12, g: 16, b: 24, a: 0.85 },
    strokeWidth: 1,
    pointRadius: 5,
    opacity: 1,
  });
  legacy
    .prepare(
      `INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
       VALUES ('l1', 'm1', 'Old layer', 'SELECT 1', ?, 0, ?, ?)`,
    )
    .run(legacyStyle, now, now);
  legacy.pragma("user_version = 2");
  legacy.close();
}

describe("migration from an earlier database", () => {
  it("upgrades in place and legacy rows read with clean defaults", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-legacy-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      writeV2Database(file);

      const db = open(file); // applies migrations v3 through v22
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);

      const map = getMap("m1", db);
      expect(map?.basemap).toBeNull();
      // legacy maps carry no note — no box anywhere
      expect(map?.note).toBeNull();
      // legacy maps show every basemap group
      expect(map?.basemapLayers).toBeNull();
      // legacy maps keep the legend bottom-left
      expect(map?.legendCorner).toBeNull();
      // legacy maps have no docked timeline
      expect(map?.timeline).toBeNull();
      // legacy maps carry no widgets; the published toggle is on
      expect(map?.widgets).toEqual([]);
      expect(map?.widgetsPublished).toBe(true);

      const [layer] = listLayers("m1", db);
      expect(layer.tooltip).toBeNull();
      // legacy layers pop up automatic fields, like the tooltip
      expect(layer.popup).toBeNull();
      // legacy layers publish the derived projection
      expect(layer.publishedFields).toBeNull();
      expect(layer.inLegend).toBe(true);
      // Colors are solid since the opacity fix: the legacy authored alpha
      // (0.72 fill, 0.85 stroke) folds into the sliders on read — same
      // rendered pixels, honest slider positions.
      expect(layer.style.fillOpacity).toBe(0.72);
      expect(layer.style.strokeOpacity).toBe(0.85);
      expect(
        (layer.style.fill as { color: { a: number } }).color.a,
      ).toBe(1);
      expect(layer.style.stroke.a).toBe(1);
      // defaults: raw points, no filters, automatic legend text
      expect(layer.viz).toEqual({ type: "points" });
      expect(layer.filters).toEqual([]);
      expect(layer.legendTitle).toBeNull();
      expect(layer.legendLabels).toBeNull();
      // automatic legend attribute names
      expect(layer.legendAttrs).toBeNull();
      // the tile table exists and legacy layers simply have no tiles
      const tiles = db
        .prepare(`SELECT count(*) AS n FROM layer_tiles`)
        .get() as { n: number };
      expect(tiles.n).toBe(0);
      // legacy tables read as uploads with no re-run recipe
      const legacyTable = getTableByName("legacy_points", db);
      expect(legacyTable?.source).toBe("upload");
      expect(legacyTable?.sourceParams).toBeNull();
      expect(legacyTable?.importedAt).toBeNull();
      // a pre-feature CSV row migrates UNWARNED — the
      // suspect-header flag arrives false and stays false until a
      // refresh actually re-reads the source.
      expect(legacyTable?.headerSuspect).toBe(false);
      // legacy maps start with an empty timeline, cursor at zero
      const hist = db
        .prepare(
          `SELECT history_cursor AS c,
                  (SELECT count(*) FROM map_history) AS n
           FROM maps WHERE id = 'm1'`,
        )
        .get() as { c: number; n: number };
      expect(hist).toEqual({ c: 0, n: 0 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v36: PostGIS status memory", () => {
  it("migrates a legacy connection to an honest never-checked state", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-v35-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      const legacy = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 35)) legacy.exec(migration);
      legacy.pragma("user_version = 35");
      legacy.prepare(
        `INSERT INTO pg_connections
           (id, name, host, port, database, username, password_encrypted, ssl, created_at)
         VALUES ('legacy', 'Legacy', 'db.example.org', 5432, 'gis', 'reader',
                 'encrypted-envelope', 1, '2026-08-01T00:00:00.000Z')`,
      ).run();
      legacy.close();

      const db = open(file);
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      expect(getConnection(testAccountScope(db), "legacy", db)).toMatchObject({
        status: "never_checked",
        lastCheckedAt: null,
        lastCheckError: null,
        serverVersion: null,
        postgisVersion: null,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v17: the note becomes a note widget", () => {
  it("migrates title and body to a trailing widget and clears the column", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-note-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      // Build the historical schema directly; later migrations must not
      // require this fixture to maintain a parallel downgrade catalogue.
      let db = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 16)) db.exec(migration);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO maps (id, name, view_lng, view_lat, view_zoom, created_at, updated_at, note, widgets)
         VALUES ('m1', 'Titled', 0, 0, 1, ?, ?, ?, NULL),
                ('m2', 'Untitled note', 0, 0, 1, ?, ?, ?, '[{"id":"w1","type":"formula","layerId":"l1","title":"Count","field":null,"agg":"count","aggField":null,"visible":true}]')`,
      ).run(
        now,
        now,
        JSON.stringify({ title: "Sources", body: "Data © OSM", corner: "top-right" }),
        now,
        now,
        JSON.stringify({ title: null, body: "Just a body", corner: "bottom-left" }),
      );
      // The fixture widget's layer must exist, or the orphan sweep
      // would rightly drop the widget on replay.
      db.prepare(
        `INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
         VALUES ('l1', 'm2', 'L', 'SELECT 1', '{}', 0, ?, ?)`,
      ).run(now, now);
      db.pragma("user_version = 16");
      db.close();

      db = open(file);
      const m1 = getMap("m1", db);
      expect(m1?.note).toBeNull();
      expect(m1?.widgets).toEqual([
        expect.objectContaining({
          type: "note",
          layerId: null,
          title: "Sources",
          note: "Data © OSM",
          visible: true,
        }),
      ]);
      // An untitled note gets the fallback title; existing widgets keep
      // their order with the note appended; fields normalize in.
      const m2 = getMap("m2", db);
      expect(m2?.note).toBeNull();
      expect(m2?.widgets.map((w) => w.type)).toEqual(["formula", "note"]);
      expect(m2?.widgets[0]).toMatchObject({ unit: null, format: null });
      expect(m2?.widgets[1]).toMatchObject({
        title: "Note",
        note: "Just a body",
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v21: stored orphan widgets are swept", () => {
  it("drops data widgets naming a layer the map does not own; keeps the rest in order", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-orphan-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      // A genuine v20 database: the earlier schema holding a map whose
      // widgets list carries a live widget, an orphan (its layer deleted
      // in the era when deletion left widgets behind), and a note.
      const legacy = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 20)) legacy.exec(migration);
      legacy.pragma("user_version = 20");
      const now = new Date().toISOString();
      const widget = (id: string, layerId: string | null) => ({
        id,
        type: layerId === null ? "note" : "formula",
        layerId,
        title: id,
        field: layerId === null ? null : "val",
        agg: "count",
        aggField: null,
        unit: null,
        note: layerId === null ? "body" : null,
        format: null,
        visible: true,
      });
      legacy
        .prepare(
          `INSERT INTO maps (id, name, created_at, updated_at, widgets)
           VALUES ('m1', 'Swept', ?, ?, ?), ('m2', 'Untouched', ?, ?, ?)`,
        )
        .run(
          now,
          now,
          JSON.stringify([
            widget("w1", "l1"),
            widget("worphan", "dead-layer"),
            widget("wn", null),
          ]),
          now,
          now,
          JSON.stringify([widget("wk", "l2")]),
        );
      legacy
        .prepare(
          `INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
           VALUES ('l1', 'm1', 'A', 'SELECT 1', '{}', 0, ?, ?),
                  ('l2', 'm2', 'B', 'SELECT 1', '{}', 0, ?, ?)`,
        )
        .run(now, now, now, now);
      legacy.close();

      const db = open(file); // applies v21 (and the later v22, v23)
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      // The orphan is gone; survivors keep their order and their shape.
      const m1 = getMap("m1", db);
      expect(m1?.widgets.map((w) => w.id)).toEqual(["w1", "wn"]);
      expect(m1?.widgets[0]).toMatchObject({ layerId: "l1", title: "w1" });
      // A map with no orphans is untouched, byte for byte.
      const m2 = getMap("m2", db);
      expect(m2?.widgets.map((w) => w.id)).toEqual(["wk"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v22: published theme column", () => {
  it("a genuine v21 database gains the column; a legacy publication holds none", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-v21-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      const legacy = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 21)) legacy.exec(migration);
      legacy.pragma("user_version = 21");
      const now = new Date().toISOString();
      legacy
        .prepare(
          `INSERT INTO maps (id, name, view_lng, view_lat, view_zoom, publish_token, published_at, created_at, updated_at)
           VALUES ('m1', 'published before the theme default', 0, 0, 1, 'tttttttttttttttttttttt', ?, ?, ?)`,
        )
        .run(now, now, now);
      legacy.close();

      const db = open(file); // applies v22 (and the later v23)
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      // The earlier publication carries no stored default — readers get
      // dark until it is published anew.
      expect(getPublishedTheme("m1", db)).toBeNull();
      const snapshot = getPublishedSnapshot("tttttttttttttttttttttt", db);
      expect(snapshot?.publishedTheme).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v23: viewer controls column", () => {
  it("a genuine v22 database gains the column; a legacy publication shows every control", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-v22-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      const legacy = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 22)) legacy.exec(migration);
      legacy.pragma("user_version = 22");
      const now = new Date().toISOString();
      legacy
        .prepare(
          `INSERT INTO maps (id, name, view_lng, view_lat, view_zoom, publish_token, published_at, created_at, updated_at)
           VALUES ('m1', 'published before the field set', 0, 0, 1, 'uuuuuuuuuuuuuuuuuuuuuu', ?, ?, ?)`,
        )
        .run(now, now, now);
      legacy.close();

      const db = open(file); // applies v23
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      // The earlier publication stated no set, so it stores none — and a
      // stored none is exactly what reads as every control on.
      expect(getViewerControls("m1", db)).toBeNull();
      expect(normalizeViewerControls(getViewerControls("m1", db))).toEqual({
        tilt: true,
        fit: true,
        theme: true,
        basemap: true,
        coords: true,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v24: custom basemap column", () => {
  it("a genuine v23 database gains the column; a legacy map holds no custom style", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-v23-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      const legacy = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 23)) legacy.exec(migration);
      legacy.pragma("user_version = 23");
      const now = new Date().toISOString();
      legacy
        .prepare(
          `INSERT INTO maps (id, name, view_lng, view_lat, view_zoom, basemap, created_at, updated_at)
           VALUES ('m1', 'from before the basemap layers', 0, 0, 1, 'streets', ?, ?)`,
        )
        .run(now, now);
      legacy.close();

      const db = open(file); // applies v24
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      const map = getMap("m1", db);
      // No custom style, and the stored key is untouched by the upgrade.
      expect(map?.customBasemap).toBeNull();
      expect(map?.basemap).toBe("streets");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v25: a derived table has no source filename", () => {
  it("rebuilds data_tables without losing a row, and accepts a null filename after", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-v24-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      const legacy = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 24)) legacy.exec(migration);
      legacy.pragma("user_version = 24");
      const now = new Date().toISOString();
      // Every column an import fills, so the rebuild is proven to carry the
      // whole row rather than the columns the test happens to read back.
      legacy
        .prepare(
          `INSERT INTO data_tables
             (id, name, source_filename, format, file, geometry_column,
              geometry_type, crs_assumed, row_count, created_at, source,
              source_params, imported_at)
           VALUES ('t1', 'stations', 'stations.geojson', 'geojson',
                   'tables/a.parquet', 'geom', 'POINT', 1, 173, ?, 'url',
                   '{"url":"https://example.test/s.geojson"}', ?)`,
        )
        .run(now, now);
      legacy.close();

      const db = open(file); // applies v25
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);

      // The pre-existing import survives the rebuild intact — every column.
      const kept = db
        .prepare(`SELECT * FROM data_tables WHERE id = 't1'`)
        .get() as Record<string, unknown>;
      expect(kept).toMatchObject({
        id: "t1",
        name: "stations",
        source_filename: "stations.geojson",
        format: "geojson",
        file: "tables/a.parquet",
        geometry_column: "geom",
        geometry_type: "POINT",
        crs_assumed: 1,
        row_count: 173,
        source: "url",
        source_params: '{"url":"https://example.test/s.geojson"}',
        imported_at: now,
      });
      expect(kept.created_at).toBe(now);

      // The point of the rebuild: a derived table can claim no filename.
      // Before v25 this insert fails on the NOT NULL constraint.
      db.prepare(
        `INSERT INTO data_tables
           (id, name, source_filename, format, file, geometry_column,
            geometry_type, crs_assumed, row_count, created_at, source,
            source_params, imported_at)
         VALUES ('t2', 'station_counts', NULL, 'geoparquet',
                 'tables/b.parquet', NULL, NULL, 0, 1, ?, 'operation',
                 '{"operation":"sql_step"}', ?)`,
      ).run(now, now);
      const derived = db
        .prepare(`SELECT source_filename, source FROM data_tables WHERE id = 't2'`)
        .get() as { source_filename: string | null; source: string };
      expect(derived.source_filename).toBeNull();
      expect(derived.source).toBe("operation");

      // Adoption keeps unique names within the original owner.
      const owner = testAccountScope(db).accountId;
      expect(() =>
        db
          .prepare(
            `INSERT INTO data_tables
               (id, name, source_filename, format, file, crs_assumed,
                row_count, created_at, source, owner_id)
             VALUES ('t3', 'stations', NULL, 'geoparquet', 'tables/c.parquet',
                     0, 1, ?, 'operation', ?)` ,
          )
          .run(now, owner),
      ).toThrow(/UNIQUE/i);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v33: recipe origin", () => {
  it("a genuine v32 database gains the column; every recipe it held is the builder's, a new one is a workflow", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-v32-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      const legacy = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 32)) legacy.exec(migration);
      legacy.pragma("user_version = 32");
      const now = new Date().toISOString();
      legacy
        .prepare(
          `INSERT INTO recipes (id, name, created_at, updated_at) VALUES ('r1', 'Analysis of stations', ?, ?)`,
        )
        .run(now, now);
      legacy
        .prepare(
          `INSERT INTO recipes (id, name, created_at, updated_at) VALUES ('r2', 'made through the API, three steps', ?, ?)`,
        )
        .run(now, now);
      legacy.close();

      const db = open(file); // applies v33
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      // The gate's decision: stored data cannot tell a builder recipe from an
      // API-made one, so every older row is the builder's — whatever its shape.
      expect(getRecipe("r1", db)?.origin).toBe("builder");
      expect(getRecipe("r2", db)?.origin).toBe("builder");
      expect(listRecipes(db, { origin: "workflow" })).toEqual([]);
      // And a recipe created without saying is a workflow, the default.
      const fresh = createRecipe(testAccountScope(db), "Cafés within reach", db);
      expect(getRecipe(fresh.id, db)?.origin).toBe("workflow");
      expect(listRecipes(db, { origin: "workflow" }).map((r) => r.id)).toEqual([fresh.id]);
      expect(listRecipes(db, { origin: "builder" }).map((r) => r.id).sort()).toEqual(["r1", "r2"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v34: the canvas layout document", () => {
  it("a genuine v33 database gains the table; a recipe from before reads the empty document and can be arranged", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-v33-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      const legacy = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 33)) legacy.exec(migration);
      legacy.pragma("user_version = 33");
      const now = new Date().toISOString();
      legacy
        .prepare(
          `INSERT INTO recipes (id, name, origin, created_at, updated_at) VALUES ('r1', 'Cafés within reach', 'workflow', ?, ?)`,
        )
        .run(now, now);
      legacy.close();

      const db = open(file); // applies v34
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      expect(getLayout("r1", db)).toEqual({
        document: { steps: {}, sources: {}, notes: [] },
        updatedAt: null,
      });
      const written = putLayout("r1", { steps: {}, sources: { cafes: { x: 40, y: 60 } }, notes: [] }, db);
      expect(getLayout("r1", db)).toEqual({
        document: { steps: {}, sources: { cafes: { x: 40, y: 60 } }, notes: [] },
        updatedAt: written.updatedAt,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v37: projects", () => {
  it("a genuine v36 database gains the projects tables; every older map, recipe and table reads as not in a project", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-v36-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      const legacy = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 36)) legacy.exec(migration);
      legacy.pragma("user_version = 36");
      const now = new Date().toISOString();
      legacy
        .prepare(
          `INSERT INTO maps (id, name, view_lng, view_lat, view_zoom, created_at, updated_at)
           VALUES ('m1', 'Stations', 13.4, 52.5, 10, ?, ?)`,
        )
        .run(now, now);
      legacy
        .prepare(
          `INSERT INTO recipes (id, name, origin, created_at, updated_at)
           VALUES ('r1', 'Catchments', 'workflow', ?, ?)`,
        )
        .run(now, now);
      legacy
        .prepare(
          `INSERT INTO data_tables (id, name, source_filename, format, file, crs_assumed, row_count, created_at)
           VALUES ('t1', 'stations', 'stations.geojson', 'geojson', 'tables/t1.parquet', 0, 12, ?)`,
        )
        .run(now);
      legacy.close();

      const db = open(file); // applies v37
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      // Every pre-migration object is preserved and reads unfiled.
      expect(getMap("m1", db)?.name).toBe("Stations");
      expect(mapProjectId("m1", db)).toBeNull();
      expect(getRecipe("r1", db)?.projectId).toBeNull();
      expect(getTableByName("stations", db)?.id).toBe("t1");
      expect(tableProjectIds(db).size).toBe(0);
      // The projects store exists and is empty; an unknown id reads null.
      expect(getProject("p-nowhere", db)).toBeNull();
      // A recipe created without a project context reads the same unfiled state.
      const fresh = createRecipe(testAccountScope(db), "Cafés within reach", db);
      expect(getRecipe(fresh.id, db)?.projectId).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v38: project workflows are workflow-origin recipes", () => {
  it("removes only builder-origin memberships from a genuine v37 store without touching project timestamps", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-v37-"));
    const file = path.join(dir, "metadata.sqlite");
    try {
      const legacy = new Database(file);
      for (const migration of MIGRATIONS.slice(0, 37)) legacy.exec(migration);
      legacy.pragma("user_version = 37");
      const affectedCreated = "2026-08-01T10:00:00.000Z";
      const affectedUpdated = "2026-08-02T11:12:13.456Z";
      const unaffectedCreated = "2026-08-03T14:00:00.000Z";
      const unaffectedUpdated = "2026-08-04T15:16:17.890Z";
      legacy
        .prepare(
          `INSERT INTO projects (id, name, note, created_at, updated_at)
           VALUES ('p-affected', 'Affected', NULL, ?, ?),
                  ('p-unaffected', 'Unaffected', 'kept', ?, ?)`,
        )
        .run(
          affectedCreated,
          affectedUpdated,
          unaffectedCreated,
          unaffectedUpdated,
        );
      legacy
        .prepare(
          `INSERT INTO recipes (id, name, origin, project_id, created_at, updated_at)
           VALUES ('r-builder-filed', 'Builder filed', 'builder', 'p-affected', ?, ?),
                  ('r-workflow-filed', 'Workflow filed', 'workflow', 'p-affected', ?, ?),
                  ('r-workflow-unaffected', 'Workflow unaffected', 'workflow', 'p-unaffected', ?, ?),
                  ('r-builder-unfiled', 'Builder unfiled', 'builder', NULL, ?, ?)`,
        )
        .run(
          affectedCreated,
          affectedUpdated,
          affectedCreated,
          affectedUpdated,
          unaffectedCreated,
          unaffectedUpdated,
          unaffectedCreated,
          unaffectedUpdated,
        );
      legacy.close();

      const db = open(file);
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      expect(getRecipe("r-builder-filed", db)?.projectId).toBeNull();
      expect(getRecipe("r-workflow-filed", db)?.projectId).toBe("p-affected");
      expect(getRecipe("r-workflow-unaffected", db)?.projectId).toBe(
        "p-unaffected",
      );
      expect(getRecipe("r-builder-unfiled", db)?.projectId).toBeNull();
      expect(getProject("p-affected", db)).toMatchObject({
        createdAt: affectedCreated,
        updatedAt: affectedUpdated,
      });
      expect(getProject("p-unaffected", db)).toMatchObject({
        createdAt: unaffectedCreated,
        updatedAt: unaffectedUpdated,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
