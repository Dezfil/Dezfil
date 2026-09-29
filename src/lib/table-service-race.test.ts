import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuckDBConnection } from "@duckdb/node-api";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getTableByName } from "@/lib/metadata/tables";
import { importFromUrl } from "@/lib/ingest/remote";
import { refreshTable } from "@/lib/ingest/refresh";
import { retirementsSettled } from "@/lib/ingest/retire";
import { readHold } from "@/lib/test-support/read-hold";
import { inspectTable, removeTable } from "./table-service";

let dir: string;
let server: Server;
let url: string;
let polygon = false;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-heal-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  closeMetadataDb();
  polygon = false;
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/geo+json" });
    res.end(JSON.stringify({ type: "FeatureCollection", features: [{
      type: "Feature", properties: {}, geometry: polygon
        ? { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
        : { type: "Point", coordinates: [0, 0] },
    }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/legacy.geojson`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await retirementsSettled();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  await rm(dir, { recursive: true, force: true });
});

async function legacyPoint() {
  const table = (await importFromUrl(testAccountScope(), url)).tables[0];
  expect(table.geometryType).toBe("POINT");
  metadataDb().prepare("UPDATE data_tables SET geometry_type = 'MIXED' WHERE id = ?").run(table.id);
  return table;
}

function heldInspection(name: string, label: string) {
  const hold = readHold(label);
  const original = DuckDBConnection.prototype.runAndReadAll;
  let hits = 0;
  vi.spyOn(DuckDBConnection.prototype, "runAndReadAll").mockImplementation(async function (this: DuckDBConnection, sql, ...args) {
    const result = await original.call(this, sql, ...args);
    // This is the measured legacy family, before inspection can persist it.
    // beforeMutation rejects if a SQL change ever disarms this interception.
    if (sql.includes("SELECT DISTINCT ST_GeometryType") && sql.includes("LIMIT 5")) {
      hits++;
      await hold.engage();
    }
    return result;
  });
  const inspection = inspectTable(testAccountScope(), name);
  void inspection.catch(() => undefined);
  return { ...hold, inspection, assertSingleHold: () => expect(hits).toBe(1) };
}

describe("late geometry repair", () => {
  it("preserves the polygon generation after a real refresh", async () => {
    const old = await legacyPoint();
    const held = heldInspection(old.name, "refresh");
    try {
      await held.beforeMutation();
      polygon = true;
      const fresh = await refreshTable(testAccountScope(), old.name);
      expect(fresh.id).toBe(old.id);
      expect(fresh.file).not.toBe(old.file);
      expect(fresh.geometryType).toBe("POLYGON");
      held.release();
      expect((await held.inspection).geometryType).toBe("POINT");
      held.assertSingleHold();
      expect(getTableByName(old.name)).toMatchObject({ id: fresh.id, file: fresh.file, geometryType: "POLYGON" });
    } finally {
      held.release();
      await held.inspection.catch(() => undefined);
    }
  });

  it("preserves a polygon import reclaiming a deleted name", async () => {
    const old = await legacyPoint();
    const held = heldInspection(old.name, "name reclamation");
    try {
      await held.beforeMutation();
      await removeTable(testAccountScope(), old.name);
      polygon = true;
      const fresh = (await importFromUrl(testAccountScope(), url)).tables[0];
      expect(fresh.name).toBe(old.name);
      expect(fresh.id).not.toBe(old.id);
      expect(fresh.file).not.toBe(old.file);
      expect(fresh.geometryType).toBe("POLYGON");
      held.release();
      await held.inspection;
      held.assertSingleHold();
      expect(getTableByName(old.name)).toMatchObject({ id: fresh.id, file: fresh.file, geometryType: "POLYGON" });
    } finally {
      held.release();
      await held.inspection.catch(() => undefined);
    }
  });

  it("refuses a changed id even when the artifact generation is equal", async () => {
    const old = await legacyPoint();
    const held = heldInspection(old.name, "isolated identity");
    try {
      await held.beforeMutation();
      // Isolate identity from generation: a new identity owns the same bytes.
      metadataDb().prepare("UPDATE data_tables SET id = ?, geometry_type = 'MIXED' WHERE id = ?")
        .run("replacement-id", old.id);
      expect(getTableByName(old.name)?.file).toBe(old.file);
      held.release();
      await held.inspection;
      held.assertSingleHold();
      expect(getTableByName(old.name)).toMatchObject({ id: "replacement-id", file: old.file, geometryType: "MIXED" });
    } finally {
      held.release();
      await held.inspection.catch(() => undefined);
    }
  });
});
