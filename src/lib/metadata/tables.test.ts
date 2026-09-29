import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { open } from "./db";
import {
  insertTable,
  registerTable,
  listTables,
  getTableByName,
  deleteTable,
  tableNames,
  updateTableData,
  type DataTable,
} from "./tables";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  db = open(path.join(dir, "metadata.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function sample(overrides: Partial<DataTable> = {}): DataTable {
  return {
    id: "id-1",
    name: "parks",
    sourceFilename: "parks.geojson",
    format: "geojson",
    file: "tables/parks.parquet",
    geometryColumn: "geometry",
    geometryType: "POLYGON",
    crsAssumed: false,
    headerSuspect: false,
    rowCount: 42,
    createdAt: "2026-07-06T00:00:00Z",
    source: "upload",
    sourceParams: null,
    importedAt: null,
    ...overrides,
  };
}

describe("tables repository", () => {
  it("round-trips a table through insert and get", () => {
    insertTable(testAccountScope(db), sample(), db);
    expect(getTableByName("parks", db)).toEqual(sample());
  });

  it("lists tables newest first and reports names", () => {
    insertTable(testAccountScope(db), sample(), db);
    insertTable(
      testAccountScope(db),
      sample({
        id: "id-2",
        name: "stations",
        createdAt: "2026-07-07T00:00:00Z",
      }),
      db,
    );
    expect(listTables(db).map((t) => t.name)).toEqual(["stations", "parks"]);
    expect(tableNames(db)).toEqual(new Set(["parks", "stations"]));
  });

  it("rejects duplicate names", () => {
    insertTable(testAccountScope(db), sample(), db);
    expect(() => insertTable(testAccountScope(db), sample({ id: "id-2" }), db)).toThrow();
  });

  it("preserves non-spatial and crs-assumed flags", () => {
    insertTable(
      testAccountScope(db),
      sample({ geometryColumn: null, geometryType: null, crsAssumed: true }),
      db,
    );
    const got = getTableByName("parks", db);
    expect(got?.geometryColumn).toBeNull();
    expect(got?.crsAssumed).toBe(true);
  });

  it("deletes by name and reports whether anything was deleted", () => {
    insertTable(testAccountScope(db), sample(), db);
    expect(deleteTable("parks", db)).toBe(true);
    expect(deleteTable("parks", db)).toBe(false);
    expect(listTables(db)).toEqual([]);
  });

  it("round-trips provenance and applies data updates atomically", () => {
    insertTable(
      testAccountScope(db),
      sample({
        source: "url",
        sourceParams: { url: "https://example.org/parks.parquet" },
        importedAt: "2026-07-19T00:00:00Z",
      }),
      db,
    );
    const got = getTableByName("parks", db);
    expect(got?.source).toBe("url");
    expect(got?.sourceParams).toEqual({
      url: "https://example.org/parks.parquet",
    });

    updateTableData(
      { name: "parks", id: "id-1" },
      {
        file: "tables/parks-v2.parquet",
        geometryColumn: "geometry",
        geometryType: "POLYGON",
        crsAssumed: false,
        headerSuspect: false,
        rowCount: 99,
        importedAt: "2026-07-20T00:00:00Z",
      },
      db,
    );
    const refreshed = getTableByName("parks", db);
    expect(refreshed?.file).toBe("tables/parks-v2.parquet");
    expect(refreshed?.rowCount).toBe(99);
    expect(refreshed?.importedAt).toBe("2026-07-20T00:00:00Z");
    // provenance itself is untouched by a data update
    expect(refreshed?.sourceParams).toEqual({
      url: "https://example.org/parks.parquet",
    });
  });

  it("reports whether a data update matched a row", () => {
    insertTable(testAccountScope(db), sample(), db);
    const update = {
      file: "tables/parks-v2.parquet",
      geometryColumn: "geometry",
      geometryType: "POLYGON",
      crsAssumed: false,
      headerSuspect: false,
      rowCount: 7,
      importedAt: "2026-07-28T00:00:00Z",
    };
    expect(updateTableData({ name: "parks", id: "id-1" }, update, db)).toBe(
      true,
    );
    expect(updateTableData({ name: "vanished", id: "id-9" }, update, db)).toBe(
      false,
    );
    // A reclaimed name is a different table: same name, another id, no match.
    expect(updateTableData({ name: "parks", id: "id-2" }, update, db)).toBe(
      false,
    );
  });

  it("swaps data and recipe in one statement when the update carries params", () => {
    insertTable(
      testAccountScope(db),
      sample({
        source: "overture",
        sourceParams: { theme: "places", release: "2026-05-01.0" },
      }),
      db,
    );
    updateTableData(
      { name: "parks", id: "id-1" },
      {
        file: "tables/parks-v3.parquet",
        geometryColumn: "geometry",
        geometryType: "POINT",
        crsAssumed: false,
        headerSuspect: false,
        rowCount: 12,
        importedAt: "2026-07-28T00:00:00Z",
        sourceParams: { theme: "places", release: "2026-06-17.0" },
      },
      db,
    );
    const moved = getTableByName("parks", db);
    expect(moved?.file).toBe("tables/parks-v3.parquet");
    expect(moved?.sourceParams).toEqual({
      theme: "places",
      release: "2026-06-17.0",
    });
  });
});

describe("registerTable", () => {
  const base = (id: string): Omit<DataTable, "name"> => {
    const record: Partial<DataTable> = sample({
      id,
      file: `tables/${id}.parquet`,
    });
    delete record.name;
    return record as Omit<DataTable, "name">;
  };

  it("derives at insert time, so overlapping registrations get distinct names", async () => {
    // Two flows finish async work, then register the same desired name —
    // the shape of the OSM window. Derivation inside registerTable sees
    // the other row no matter how the awaits interleave.
    const [a, b] = await Promise.all([
      (async () => {
        await new Promise((r) => setTimeout(r, 10));
        return registerTable(testAccountScope(db), base("id-a"), "parks", db);
      })(),
      (async () => {
        await new Promise((r) => setTimeout(r, 10));
        return registerTable(testAccountScope(db), base("id-b"), "parks", db);
      })(),
    ]);
    expect(new Set([a.name, b.name]).size).toBe(2);
    expect([a.name, b.name].sort()).toEqual(["parks", "parks_2"]);
  });

  it("keeps the sanitizing behavior of derived names", () => {
    const record = registerTable(testAccountScope(db), base("id-c"), "NYC Taxi Zones (2024).csv", db);
    expect(record.name).toBe("nyc_taxi_zones_2024");
  });
});
