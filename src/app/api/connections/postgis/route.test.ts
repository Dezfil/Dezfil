import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

const testConnection = vi.hoisted(() => vi.fn());
const browseRemoteTables = vi.hoisted(() => vi.fn());

vi.mock("@/lib/postgis/access", () => ({ testConnection, browseRemoteTables }));

import { POST } from "./route";
import { PATCH } from "./[id]/route";
import { POST as testSavedConnection } from "./[id]/test/route";
import { GET as browseSavedConnection } from "./[id]/tables/route";
import { GET as listSnapshots } from "./[id]/snapshots/route";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import {
  connectionPassword,
  getConnection,
  insertConnection,
  listConnections,
  recordConnectionCheck,
} from "@/lib/metadata/connections";
import * as connections from "@/lib/metadata/connections";
import * as status from "@/lib/postgis/status";
import { ApiError } from "@/lib/api/errors";
import { resetSecretKeyCache } from "@/lib/secrets";
import { insertTable } from "@/lib/metadata/tables";
import { buildTools } from "@/lib/tools/tools";
import { executeTool } from "@/lib/tools/execute";

let dir: string;

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/connections/postgis", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/connections/postgis validation", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(process.cwd(), ".tmp-test-"));
    process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
    closeMetadataDb();
    resetSecretKeyCache();
    testConnection.mockReset();
    browseRemoteTables.mockReset();
  });

  afterEach(() => {
    closeMetadataDb();
    resetSecretKeyCache();
    delete process.env.DEZFIL_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    { name: "Missing fields" },
    {
      name: "Invalid port",
      host: "db.example.org",
      port: 65536,
      database: "gis",
      username: "reader",
      password: "fixture-only",
    },
    { name: "Invalid URL", url: "jdbc:mysql://nope/db" },
  ])("rejects locally without source contact: $name", async (body) => {
    const response = await POST(testAccountRequest(request(body)));
    expect(response.status).toBe(400);
    expect(testConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["host-only with omitted password", { host: "new.example.org" }],
    ["host-only with empty password", { host: "new.example.org", password: "" }],
    ["port-only with omitted password", { port: 6432 }],
    ["port-only with empty password", { port: 6432, password: "" }],
    ["SSL-off with omitted password", { ssl: false }],
    ["SSL-off with empty password", { ssl: false, password: "" }],
    [
      "SSL-off URL without password",
      { url: "postgres://reader@old.example.org:5432/gis?sslmode=disable" },
    ],
  ])("refuses %s before source contact and leaves the stored row unchanged", async (_case, body) => {
    insertConnection(testAccountScope(), {
      id: "c1",
      name: "City",
      host: "old.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored-value",
      ssl: true,
    });
    recordConnectionCheck(testAccountScope(), "c1", {
      outcome: "connected",
      checkedAt: "2026-08-30T10:00:00.000Z",
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
    const before = metadataDb()
      .prepare("SELECT * FROM pg_connections WHERE id = ?")
      .get("c1");
    testConnection.mockResolvedValue({
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
    const response = await PATCH(testAccountRequest(request(body)), {
      params: Promise.resolve({ id: "c1" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "connection_password_required",
        message:
          "Enter the password again when changing the host or port, or turning SSL off.",
      },
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect(
      metadataDb().prepare("SELECT * FROM pg_connections WHERE id = ?").get("c1"),
    ).toEqual(before);
  });

  it.each([
    ["database", { database: "warehouse" }, { database: "warehouse" }, true],
    ["username", { username: "other-reader", password: "" }, { username: "other-reader" }, true],
    ["SSL-on", { ssl: true }, { ssl: true }, false],
  ])("keeps warning-free %s repoint on the saved endpoint", async (_case, body, changed, storedSsl) => {
    insertConnection(testAccountScope(), {
      id: "c1",
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored-value",
      ssl: storedSsl,
    });
    testConnection.mockResolvedValue({
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });

    const response = await PATCH(testAccountRequest(request(body)), {
      params: Promise.resolve({ id: "c1" }),
    });

    expect(response.status).toBe(200);
    expect(testConnection).toHaveBeenCalledOnce();
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ password: "stored-value", ...changed }),
    );
    expect(getConnection(testAccountScope(), "c1")).toMatchObject(changed);
    expect(connectionPassword(testAccountScope(), "c1")).toBe("stored-value");
  });

  it.each([
    [
      "an explicitly entered field password",
      { host: "field.example.org", password: "field-entered" },
      { host: "field.example.org", password: "field-entered" },
    ],
    [
      "a password-bearing URL",
      { url: "postgres://url-reader:url-entered@url.example.org:6432/url_db" },
      {
        host: "url.example.org",
        port: 6432,
        database: "url_db",
        username: "url-reader",
        password: "url-entered",
      },
    ],
    [
      "an entered password while turning SSL off",
      { ssl: false, password: "ssl-off-entered" },
      {
        host: "db.example.org",
        ssl: false,
        password: "ssl-off-entered",
      },
    ],
  ])("allows a guarded edit with %s", async (_case, body, candidate) => {
    insertConnection(testAccountScope(), {
      id: "c1",
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored-value",
      ssl: true,
    });
    testConnection.mockResolvedValue({
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });

    const response = await PATCH(testAccountRequest(request(body)), {
      params: Promise.resolve({ id: "c1" }),
    });

    expect(response.status).toBe(200);
    expect(testConnection).toHaveBeenCalledOnce();
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining(candidate),
    );
    expect(getConnection(testAccountScope(), "c1")).toMatchObject({
      id: "c1",
      host: candidate.host,
      status: "connected",
    });
    expect(connectionPassword(testAccountScope(), "c1")).toBe(candidate.password);
  });

  it("seeds create status and never echoes field or URL credentials", async () => {
    const distinctive = "distinctive-value";
    testConnection.mockResolvedValue({
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: null,
    });
    const response = await POST(
      testAccountRequest(request({
        name: "From URL",
        url: `postgres://reader:${distinctive}@db.example.org/gis?sslmode=disable`,
      })),
    );
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(distinctive);
    expect(JSON.parse(text)).toMatchObject({
      name: "From URL",
      status: "no_postgis",
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: null,
      ssl: false,
    });
  });

  it("keeps a field credential out of the derived tool result and status", async () => {
    const distinctive = "field-distinctive";
    testConnection.mockResolvedValue({
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
    const tool = buildTools().find(
      (candidate) => candidate.name === "create_postgis_connection",
    )!;
    const result = await executeTool(
      tool,
      {
        name: "Tool source",
        host: "db.example.org",
        database: "gis",
        username: "reader",
        password: distinctive,
        ssl: true,
      },
      "http://localhost",
      (async (url, init) => POST(testAccountRequest(new Request(url, init)))) as typeof fetch,
    );
    expect(result.status).toBe(201);
    expect(JSON.stringify(result.body)).not.toContain(distinctive);
    expect(JSON.stringify(tool)).not.toContain(distinctive);
    expect(JSON.stringify(getConnection(testAccountScope(), (result.body as { id: string }).id))).not.toContain(
      distinctive,
    );
  });

  it("keeps a URL credential out of an error body", async () => {
    const distinctive = "url-distinctive";
    testConnection.mockRejectedValue(
      new ApiError(
        "connection_failed",
        "Authentication failed. Check the username and password.",
        502,
      ),
    );
    const response = await POST(
      testAccountRequest(request({
        name: "Rejected URL",
        url: `postgres://reader:${distinctive}@db.example.org/gis`,
      })),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(distinctive);
  });

  it("stores name-only edits without source contact", async () => {
    insertConnection(testAccountScope(), {
      id: "c1",
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored-value",
      ssl: true,
    });
    const response = await PATCH(testAccountRequest(request({ name: "Renamed" })), {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(response.status).toBe(200);
    expect(testConnection).not.toHaveBeenCalled();
    expect(getConnection(testAccountScope(), "c1")?.name).toBe("Renamed");
    expect(connectionPassword(testAccountScope(), "c1") === "stored-value").toBe(true);
  });

  it("leaves fields, password, and status unchanged when the candidate fails", async () => {
    insertConnection(testAccountScope(), {
      id: "c1",
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored-value",
      ssl: true,
    });
    recordConnectionCheck(testAccountScope(), "c1", {
      outcome: "connected",
      checkedAt: "2026-08-30T10:00:00.000Z",
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
    const before = getConnection(testAccountScope(), "c1");
    testConnection.mockRejectedValue(
      new ApiError(
        "connection_failed",
        "Authentication failed. Check the username and password.",
        502,
      ),
    );
    const response = await PATCH(
      testAccountRequest(request({ host: "rejected.example.org", password: "rejected-value" })),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(response.status).toBe(502);
    expect(getConnection(testAccountScope(), "c1")).toEqual(before);
    expect(connectionPassword(testAccountScope(), "c1") === "stored-value").toBe(true);
    expect(await response.text()).not.toContain("rejected-value");
  });

  it("persists the outcome of an explicit saved-connection test", async () => {
    insertConnection(testAccountScope(), {
      id: "c1",
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored-value",
      ssl: true,
    });
    testConnection.mockResolvedValue({
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
    const response = await testSavedConnection(testAccountRequest(new Request("http://localhost")), {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(response.status).toBe(200);
    expect(getConnection(testAccountScope(), "c1")?.status).toBe("connected");
  });

  it("persists explicit-test failure without losing observed versions", async () => {
    insertConnection(testAccountScope(), {
      id: "c1",
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored-value",
      ssl: true,
    });
    recordConnectionCheck(testAccountScope(), "c1", {
      outcome: "connected",
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
    testConnection.mockRejectedValue(
      new ApiError(
        "connection_failed",
        "Authentication failed. Check the username and password.",
        502,
      ),
    );
    const response = await testSavedConnection(testAccountRequest(new Request("http://localhost")), {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(response.status).toBe(502);
    expect(getConnection(testAccountScope(), "c1")).toMatchObject({
      status: "failing",
      lastCheckError: "Authentication failed. Check the username and password.",
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
  });

  // the catalogue browse is a read. Its own result and its own failure
  // are unchanged; what it no longer does is write the stored health.
  // The prior health seeded here is deliberately the opposite of what
  // each branch used to write, so "unchanged" can fail.
  it("leaves the stored health untouched on browse success and failure", async () => {
    insertConnection(testAccountScope(), {
      id: "c1",
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored-value",
      ssl: true,
    });
    recordConnectionCheck(testAccountScope(), "c1", {
      outcome: "failing",
      checkedAt: "2026-09-01T10:00:00.000Z",
      error: "Authentication failed. Check the username and password.",
    });
    const before = getConnection(testAccountScope(), "c1");
    expect(before).toMatchObject({ status: "failing" });

    browseRemoteTables.mockResolvedValue({
      tables: [],
      health: {
        serverVersion: "PostgreSQL 16.4",
        postgisVersion: "3.4.3",
      },
    });
    const ok = await browseSavedConnection(testAccountRequest(new Request("http://localhost")), {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(ok.status).toBe(200);
    expect(getConnection(testAccountScope(), "c1")).toEqual(before);

    browseRemoteTables.mockRejectedValue(
      new ApiError(
        "connection_failed",
        "The server is unreachable. Check host, port, and network.",
        502,
      ),
    );
    const failed = await browseSavedConnection(testAccountRequest(new Request("http://localhost")), {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(failed.status).toBe(502);
    expect(getConnection(testAccountScope(), "c1")).toEqual(before);
  });

  it("lists snapshots by stored connection id, independent of the saved name", async () => {
    insertConnection(testAccountScope(), {
      id: "c1",
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored-value",
      ssl: true,
    });
    const table = (
      id: string,
      name: string,
      connectionId: string,
      connectionName: string,
    ) => ({
      id,
      name,
      sourceFilename: "public.roads",
      format: "geoparquet" as const,
      file: `tables/${id}.parquet`,
      geometryColumn: "geom",
      geometryType: "LINESTRING",
      crsAssumed: false,
      headerSuspect: false,
      rowCount: 12,
      createdAt: "2026-08-01T00:00:00.000Z",
      source: "postgis" as const,
      sourceParams: {
        connectionId,
        connectionName,
        schema: "public",
        table: "roads",
        filter: "class = 'primary'",
        limit: 100,
      },
      importedAt: "2026-08-02T00:00:00.000Z",
    });
    insertTable(testAccountScope(), table("t1", "owned", "c1", "Old name"));
    insertTable(testAccountScope(), table("t2", "same_name_other_id", "c2", "City"));

    const rename = await PATCH(testAccountRequest(request({ name: "Renamed" })), {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(rename.status).toBe(200);
    const response = await listSnapshots(testAccountRequest(new Request("http://localhost")), {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { snapshots: Array<{ name: string }> };
    expect(body.snapshots.map((snapshot) => snapshot.name)).toEqual(["owned"]);
  });
});

describe("a connection whose bookkeeping fails after it is stored", () => {
  const values = {
    name: "City",
    host: "db.example.org",
    port: 5432,
    database: "gis",
    username: "reader",
    password: "entered-value",
    ssl: true,
  };
  const busy = () => new Error("SQLITE_BUSY: database is locked");

  beforeEach(() => {
    dir = mkdtempSync(path.join(process.cwd(), ".tmp-test-"));
    process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
    closeMetadataDb();
    resetSecretKeyCache();
    testConnection.mockReset();
    browseRemoteTables.mockReset();
    testConnection.mockResolvedValue({
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeMetadataDb();
    resetSecretKeyCache();
    delete process.env.DEZFIL_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers a create whose health cannot be recorded with the stored connection, logs that once, and a retry stores no second one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(status, "recordConnectionHealth").mockImplementation(() => {
      throw busy();
    });

    const first = await POST(testAccountRequest(request(values)));
    // A client retries a create whose answer was an error. Its first name
    // is already taken by the stored connection, so it names it anew.
    if (first.status !== 201) await POST(testAccountRequest(request({ ...values, name: "City again" })));

    expect(first.status).toBe(201);
    const stored = listConnections(testAccountScope());
    expect(stored).toHaveLength(1);
    expect(await first.json()).toMatchObject({ id: stored[0].id, name: "City", host: "db.example.org" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "A stored PostGIS connection's health could not be recorded",
      expect.objectContaining({ message: expect.stringContaining("SQLITE_BUSY") }),
    );
  });

  it.each(["its health recording", "reading it back"] as const)(
    "answers an edit when %s fails after it is stored, with the edited values stored",
    async (failing) => {
      insertConnection(testAccountScope(), { id: "c1", ...values, password: "stored-value" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      if (failing === "its health recording") {
        vi.spyOn(status, "recordConnectionHealth").mockImplementation(() => {
          throw busy();
        });
      } else {
        const read = connections.getConnection;
        let failed = false;
        vi.spyOn(connections, "getConnection").mockImplementation((...args) => {
          const found = read(...args);
          // The first read that sees the edited row fails.
          if (!failed && found?.host === "edited.example.org") {
            failed = true;
            throw busy();
          }
          return found;
        });
      }

      const response = await PATCH(
        testAccountRequest(request({ host: "edited.example.org", password: "edited-value" })),
        { params: Promise.resolve({ id: "c1" }) },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: "c1", name: "City", host: "edited.example.org" });
      expect(getConnection(testAccountScope(), "c1")).toMatchObject({ host: "edited.example.org" });
      expect(connectionPassword(testAccountScope(), "c1")).toBe("edited-value");
      expect(listConnections(testAccountScope())).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
    },
  );
});
