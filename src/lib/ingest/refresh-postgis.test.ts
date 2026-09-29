import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

const buildPostgisArtifact = vi.hoisted(() => vi.fn());
const requireTarget = vi.hoisted(() => vi.fn());

vi.mock("@/lib/postgis/import", () => ({
  buildPostgisArtifact,
  requireTarget,
}));

import { refreshTable } from "./refresh";
import { closeMetadataDb } from "@/lib/metadata/db";
import {
  getConnection,
  insertConnection,
  recordConnectionCheck,
} from "@/lib/metadata/connections";
import { getTableByName, insertTable } from "@/lib/metadata/tables";
import { resetSecretKeyCache } from "@/lib/secrets";
import { ApiError } from "@/lib/api/errors";

let dir: string;

function seed(): void {
  const connection = insertConnection(testAccountScope(), {
    id: "c1",
    name: "City",
    host: "db.example.org",
    port: 5432,
    database: "gis",
    username: "reader",
    password: "stored-value",
    ssl: true,
  });
  requireTarget.mockImplementation(() => {
    const current = getConnection("c1")!;
    return {
      connection: current,
      target: { ...current, password: "stored-value" },
    };
  });
  insertTable(testAccountScope(), {
    id: "t1",
    name: "roads",
    sourceFilename: "public.roads",
    format: "geoparquet",
    file: "tables/old.parquet",
    geometryColumn: "geom",
    geometryType: "LINESTRING",
    crsAssumed: false,
    headerSuspect: false,
    rowCount: 12,
    createdAt: "2026-08-01T00:00:00.000Z",
    source: "postgis",
    sourceParams: {
      connectionId: "c1",
      connectionName: "City",
      schema: "public",
      table: "roads",
    },
    importedAt: "2026-08-01T00:00:00.000Z",
  });
}

describe("PostGIS refresh status", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(process.cwd(), ".tmp-test-"));
    process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
    closeMetadataDb();
    resetSecretKeyCache();
    buildPostgisArtifact.mockReset();
    requireTarget.mockReset();
    seed();
  });

  afterEach(() => {
    closeMetadataDb();
    resetSecretKeyCache();
    delete process.env.DEZFIL_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks a stored Failing connection before source contact", async () => {
    recordConnectionCheck("c1", {
      outcome: "failing",
      error: "Authentication failed. Check the username and password.",
    });
    buildPostgisArtifact.mockResolvedValue({
      geometryColumn: "geom",
      geometryType: "LINESTRING",
      crsAssumed: false,
      headerSuspect: false,
      rowCount: 20,
    });
    await expect(refreshTable("roads")).rejects.toMatchObject({
      code: "connection_failed",
      message: "Authentication failed. Check the username and password.",
    });
    expect(buildPostgisArtifact).not.toHaveBeenCalled();
    expect(getTableByName("roads")?.rowCount).toBe(12);
    expect(getConnection("c1")?.status).toBe("failing");
  });

  it("records a successful refresh and swaps only after the build succeeds", async () => {
    buildPostgisArtifact.mockResolvedValue({
      geometryColumn: "geom",
      geometryType: "LINESTRING",
      crsAssumed: false,
      headerSuspect: false,
      rowCount: 20,
      connectionHealth: {
        serverVersion: "PostgreSQL 16.4",
        postgisVersion: "3.4.3",
      },
    });
    const refreshed = await refreshTable("roads");
    expect(refreshed.rowCount).toBe(20);
    expect(getConnection("c1")).toMatchObject({
      status: "connected",
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
  });

  it("maps a missing stored source table and leaves the previous data intact", async () => {
    const before = getTableByName("roads");
    recordConnectionCheck("c1", {
      outcome: "connected",
      checkedAt: "2026-08-31T10:00:00.000Z",
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
    const connectionBefore = getConnection("c1");
    buildPostgisArtifact.mockImplementation(
      async (_target, _recipe, _artifact, observeHealth) => {
        observeHealth({
          serverVersion: "PostgreSQL 17.1",
          postgisVersion: "3.5.0",
        });
        throw new ApiError(
          "not_found",
          "Table public.roads has no columns or does not exist.",
          404,
        );
      },
    );
    await expect(refreshTable("roads")).rejects.toMatchObject({
      code: "not_refreshable",
      message:
        'The stored recipe for "public.roads" no longer resolves on this connection. The previous snapshot data is unchanged.',
    });
    expect(getTableByName("roads")).toEqual(before);
    expect(getConnection("c1")).toEqual(connectionBefore);
  });
});
