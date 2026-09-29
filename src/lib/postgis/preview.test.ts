import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { closeMetadataDb } from "@/lib/metadata/db";
import {
  getConnection,
  insertConnection,
  recordConnectionCheck,
} from "@/lib/metadata/connections";
import { resetSecretKeyCache } from "@/lib/secrets";
import {
  previewPostgis,
  previewReadError,
  resolvePostgisPreviewRequest,
  type PostgisPreviewResult,
} from "./preview";

let dir: string;
const connection = {
  id: "preview-c1",
  name: "Preview source",
  host: "db.example.org",
  port: 5432,
  database: "gis",
  username: "reader",
  ssl: true,
  password: "distinctive-preview-secret",
};
const health = {
  serverVersion: "PostgreSQL 16.4",
  postgisVersion: "3.4.3",
};
const result: PostgisPreviewResult = {
  columns: [
    { name: "id", type: "int4", spatialKind: null },
    { name: "geom", type: "geometry", spatialKind: "geometry" },
  ],
  rows: [],
  connectionHealth: health,
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetSecretKeyCache();
  insertConnection(testAccountScope(), connection);
});

afterEach(async () => {
  closeMetadataDb();
  resetSecretKeyCache();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("PostGIS preview request", () => {
  it("accepts only a relation and optional filter", () => {
    expect(
      resolvePostgisPreviewRequest({
        schema: "public",
        table: "roads",
        filter: " id > 2 ",
      }),
    ).toEqual({ schema: "public", table: "roads", filter: "id > 2" });
    for (const forbidden of ["limit", "sql", "password", "url", "host"]) {
      expect(() =>
        resolvePostgisPreviewRequest({
          schema: "public",
          table: "roads",
          [forbidden]: forbidden === "limit" ? 99 : connection.password,
        }),
      ).toThrow("Preview accepts only schema, table, and filter.");
    }
  });

  it("returns zero rows with columns", async () => {
    const built = async () => result;
    await expect(
      previewPostgis(
        connection.id,
        { schema: "public", table: "roads", filter: "false" },
        built,
      ),
    ).resolves.toEqual({ columns: result.columns, rows: [] });
  });

  // the preview is a read. Every branch that used to persist an
  // observation now leaves the stored health alone. The seeded prior
  // health is the opposite of what each branch used to write, so a
  // surviving write shows up as a difference rather than as agreement.
  it("records nothing, whichever way the preview ends", async () => {
    recordConnectionCheck(connection.id, {
      outcome: "failing",
      checkedAt: "2026-09-01T10:00:00.000Z",
      error: "The server is unreachable. Check host, port, and network.",
    });
    const before = getConnection(connection.id);
    expect(before).toMatchObject({ status: "failing" });

    await expect(
      previewPostgis(
        connection.id,
        { schema: "public", table: "roads", filter: "false" },
        async () => result,
      ),
    ).resolves.toEqual({ columns: result.columns, rows: [] });
    expect(getConnection(connection.id)).toEqual(before);

    const sourceRejected = async (
      _target: unknown,
      _request: unknown,
      observeHealth?: (value: typeof health) => void,
    ) => {
      observeHealth?.(health);
      throw new ApiError(
        "malformed_file",
        "The preview could not be read from PostGIS. Check the filter expression.",
        422,
      );
    };
    await expect(
      previewPostgis(
        connection.id,
        { schema: "public", table: "roads", filter: "not_a_column" },
        sourceRejected,
      ),
    ).rejects.toMatchObject({ code: "malformed_file" });
    expect(getConnection(connection.id)).toEqual(before);

    const connectionFailed = async () => {
      throw new ApiError(
        "connection_failed",
        "Authentication failed. Check the username and password.",
        502,
      );
    };
    await expect(
      previewPostgis(
        connection.id,
        { schema: "public", table: "roads" },
        connectionFailed,
      ),
    ).rejects.toMatchObject({ code: "connection_failed" });
    expect(getConnection(connection.id)).toEqual(before);
  });

  it("keeps the stored credential outside the request and result", async () => {
    const request = { schema: "public", table: "roads" };
    const response = await previewPostgis(connection.id, request, async () => ({
      ...result,
      rows: [{ id: 1, label: "safe" }],
    }));
    expect(JSON.stringify(request)).not.toContain(connection.password);
    expect(JSON.stringify(response)).not.toContain(connection.password);

    const rejected = previewReadError(
      new Error(`source failure carrying ${connection.password}`),
    );
    expect(JSON.stringify({
      error: { code: rejected.code, message: rejected.message },
    })).not.toContain(connection.password);
  });
});
