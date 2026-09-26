import Database from "better-sqlite3";

/**
 * Minimal GeoPackage writer for test fixtures (0063), hand-built to the
 * OGC spec (application_id, gpkg_contents, gpkg_geometry_columns, GPB
 * geometry blobs). Deliberately not written through GDAL: fixtures built
 * by a second producer are what make the reader tests meaningful.
 * Cross-validated against DuckDB spatial's GDAL reader.
 */

export interface GpkgPointLayer {
  name: string;
  kind: "points";
  /** [lon, lat, name] rows. */
  rows: [number, number, string][];
}

export interface GpkgPolygonLayer {
  name: string;
  kind: "polygons";
  /** One ring per polygon, [lon, lat] pairs, closed. */
  rows: [number, number][][];
}

export interface GpkgAttributeTable {
  name: string;
  kind: "attributes";
  /** [code, label] rows. */
  rows: [string, string][];
}

export interface GpkgCorruptLayer {
  name: string;
  /** A layer whose geometry blob is a valid GPB header over garbage WKB —
   * a seeded defect: enumeration lists it, reading it fails ("Unsupported
   * geometry type in WKB"), which is how the group-rollback tests force a
   * genuine mid-import failure. */
  kind: "corrupt";
  /** 0185: ordinary points before the bad WKB, generated without a giant
   * in-memory row array. Default preserves the one-row refusal fixture. */
  goodPointRows?: number;
  /** Completed counterpart: change only the final geometry to a point. */
  validLastPoint?: boolean;
}

export type GpkgLayer =
  | GpkgPointLayer
  | GpkgPolygonLayer
  | GpkgAttributeTable
  | GpkgCorruptLayer;

const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';

function gpb(wkb: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write("GP", 0, "ascii");
  head.writeUInt8(0, 2); // version
  head.writeUInt8(0b00000001, 3); // little-endian, no envelope
  head.writeInt32LE(4326, 4);
  return Buffer.concat([head, wkb]);
}

function wkbPoint(x: number, y: number): Buffer {
  const wkb = Buffer.alloc(21);
  wkb.writeUInt8(1, 0);
  wkb.writeUInt32LE(1, 1);
  wkb.writeDoubleLE(x, 5);
  wkb.writeDoubleLE(y, 13);
  return wkb;
}

function wkbPolygon(ring: [number, number][]): Buffer {
  const wkb = Buffer.alloc(13 + ring.length * 16);
  wkb.writeUInt8(1, 0);
  wkb.writeUInt32LE(3, 1);
  wkb.writeUInt32LE(1, 5); // one ring
  wkb.writeUInt32LE(ring.length, 9);
  ring.forEach(([x, y], i) => {
    wkb.writeDoubleLE(x, 13 + i * 16);
    wkb.writeDoubleLE(y, 21 + i * 16);
  });
  return wkb;
}

/** Write a GeoPackage holding the given layers to `file`. */
export function buildGpkg(file: string, layers: GpkgLayer[]): void {
  const db = new Database(file);
  try {
    db.pragma("application_id = 1196444487"); // "GPKG"
    db.pragma("user_version = 10300");
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE gpkg_spatial_ref_sys (
        srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY,
        organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
        definition TEXT NOT NULL, description TEXT);
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
        identifier TEXT UNIQUE, description TEXT DEFAULT '',
        last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);
      CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL, column_name TEXT NOT NULL,
        geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
        z TINYINT NOT NULL, m TINYINT NOT NULL,
        CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name));
    `);
    db.prepare(
      "INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, NULL)",
    ).run("WGS 84", 4326, "EPSG", 4326, WGS84_WKT);
    db.prepare(
      "INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, NULL)",
    ).run("undefined", -1, "NONE", -1, "undefined");
    db.prepare(
      "INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, NULL)",
    ).run("undefined", 0, "NONE", 0, "undefined");

    const contents = db.prepare(
      "INSERT INTO gpkg_contents (table_name, data_type, identifier, srs_id) VALUES (?, ?, ?, ?)",
    );
    const geometryColumns = db.prepare(
      "INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', ?, 4326, 0, 0)",
    );

    for (const layer of layers) {
      if (layer.kind === "corrupt") {
        contents.run(layer.name, "features", layer.name, 4326);
        geometryColumns.run(layer.name, "POINT");
        db.exec(
          `CREATE TABLE "${layer.name}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, name TEXT)`,
        );
        const ins = db.prepare(
          `INSERT INTO "${layer.name}" (geom, name) VALUES (?, ?)`,
        );
        const prefix = layer.goodPointRows ?? 0;
        if (!Number.isSafeInteger(prefix) || prefix < 0) throw new Error("Invalid good-point prefix");
        for (let i = 0; i < prefix; i++) {
          ins.run(gpb(wkbPoint(7 + (i % 1000) * .0001, 51 + Math.floor(i / 1000) * .0001)), `point-${i}`);
        }
        ins.run(gpb(layer.validLastPoint ? wkbPoint(7, 51) : Buffer.from([1, 0x63, 0, 0, 0, 9, 9])), "seeded-defect");
        continue;
      }
      if (layer.kind === "attributes") {
        contents.run(layer.name, "attributes", layer.name, null);
        db.exec(
          `CREATE TABLE "${layer.name}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, label TEXT)`,
        );
        const ins = db.prepare(
          `INSERT INTO "${layer.name}" (code, label) VALUES (?, ?)`,
        );
        for (const [code, label] of layer.rows) ins.run(code, label);
        continue;
      }
      contents.run(layer.name, "features", layer.name, 4326);
      geometryColumns.run(
        layer.name,
        layer.kind === "points" ? "POINT" : "POLYGON",
      );
      if (layer.kind === "points") {
        db.exec(
          `CREATE TABLE "${layer.name}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, name TEXT)`,
        );
        const ins = db.prepare(
          `INSERT INTO "${layer.name}" (geom, name) VALUES (?, ?)`,
        );
        for (const [x, y, name] of layer.rows) ins.run(gpb(wkbPoint(x, y)), name);
      } else {
        db.exec(
          `CREATE TABLE "${layer.name}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, zone INTEGER)`,
        );
        const ins = db.prepare(
          `INSERT INTO "${layer.name}" (geom, zone) VALUES (?, ?)`,
        );
        layer.rows.forEach((ring, i) => ins.run(gpb(wkbPolygon(ring)), i + 1));
      }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
