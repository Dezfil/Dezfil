import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import {
  encryptSecret,
  decryptSecret,
  resetSecretKeyCache,
} from "@/lib/secrets";
import {
  insertConnection,
  listConnections,
  getConnection,
  connectionPassword,
  connectionStatusAt,
  recordConnectionCheck,
  renameConnection,
  deleteConnection,
} from "@/lib/metadata/connections";
import {
  attachString,
  composeImportSelect,
  assertFilterSafe,
  testConnection,
} from "./access";
import { importPostgis, resolvePostgisRequest } from "./import";
import { createProject, tableProjectIds } from "@/lib/metadata/projects";
import { listTables } from "@/lib/metadata/tables";
import { POST as createConnectionRoute } from "@/app/api/connections/postgis/route";
import {
  ConnectionInputError,
  connectionEndpointsEqual,
  parseConnectionUrl,
  resolveCreateConnectionInput,
  resolveUpdateConnectionInput,
} from "./connection-input";
import { insertTable, listPostgisSnapshots } from "@/lib/metadata/tables";

let dir: string;

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
  delete process.env.DEZFIL_SECRET_KEY;
  await rm(dir, { recursive: true, force: true });
});

describe("secrets", () => {
  it("round-trips with an auto-generated key file", async () => {
    const stored = encryptSecret("hunter2");
    expect(stored).not.toContain("hunter2");
    expect(decryptSecret(stored)).toBe("hunter2");
    // the key file landed in the data dir, hex, 32 bytes
    const key = await readFile(
      path.join(dir, "data", "secret.key"),
      "utf8",
    );
    expect(key.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses DEZFIL_SECRET_KEY when set and rejects malformed keys", () => {
    process.env.DEZFIL_SECRET_KEY = "ab".repeat(32);
    resetSecretKeyCache();
    const stored = encryptSecret("s3cret");
    expect(decryptSecret(stored)).toBe("s3cret");

    process.env.DEZFIL_SECRET_KEY = "too-short";
    resetSecretKeyCache();
    expect(() => encryptSecret("x")).toThrow(/64 hex/);
  });

  it("every encryption is unique (fresh iv)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });
});

describe("connections repository", () => {
  const sample = {
    id: "c1",
    name: "City geodata",
    host: "db.example.org",
    port: 5432,
    database: "geodata",
    username: "dezfil_ro",
    ssl: true,
    password: "pass'word\\!",
  };

  it("stores encrypted, returns password-free shapes, decrypts internally", () => {
    const created = insertConnection(testAccountScope(), sample);
    expect(created).toMatchObject({
      status: "never_checked",
      lastCheckedAt: null,
      lastCheckError: null,
      serverVersion: null,
      postgisVersion: null,
    });
    expect("password" in created).toBe(false);
    expect(JSON.stringify(listConnections(testAccountScope()))).not.toContain("pass'word");
    expect(JSON.stringify(getConnection(testAccountScope(), "c1"))).not.toContain("pass'word");

    // at rest: the row carries an envelope, not the plaintext
    const raw = metadataDb()
      .prepare(`SELECT password_encrypted FROM pg_connections WHERE id = 'c1'`)
      .get() as { password_encrypted: string };
    expect(raw.password_encrypted).not.toContain("pass'word");

    // the internal accessor is the only way back
    expect(connectionPassword(testAccountScope(), "c1")).toBe("pass'word\\!");
  });

  it("persists status across restart and retains observed versions on failure", () => {
    insertConnection(testAccountScope(), sample);
    const checkedAt = "2026-08-20T10:00:00.000Z";
    expect(
      recordConnectionCheck(testAccountScope(), "c1", {
        outcome: "connected",
        checkedAt,
        serverVersion: "PostgreSQL 16.4",
        postgisVersion: "3.4.3",
      }),
    ).toBe(true);

    closeMetadataDb();
    expect(getConnection(testAccountScope(), "c1", undefined, new Date("2026-08-21T10:00:00Z"))).toMatchObject({
      status: "connected",
      lastCheckedAt: checkedAt,
      lastCheckError: null,
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });

    recordConnectionCheck(testAccountScope(), "c1", {
      outcome: "failing",
      checkedAt: "2026-08-22T10:00:00.000Z",
      error: "Authentication failed. Check the username and password.",
    });
    expect(getConnection(testAccountScope(), "c1")).toMatchObject({
      status: "failing",
      lastCheckError: "Authentication failed. Check the username and password.",
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
  });

  it("turns connected stale at exactly seven days and not before", () => {
    const checkedAt = "2026-08-01T12:00:00.000Z";
    expect(
      connectionStatusAt(
        "connected",
        checkedAt,
        new Date("2026-08-08T11:59:59.999Z"),
      ),
    ).toBe("connected");
    expect(
      connectionStatusAt(
        "connected",
        checkedAt,
        new Date("2026-08-08T12:00:00.000Z"),
      ),
    ).toBe("not_checked_lately");
    expect(
      connectionStatusAt(
        "failing",
        checkedAt,
        new Date("2026-09-01T12:00:00.000Z"),
      ),
    ).toBe("failing");
  });

  it("keeps status memory credential-free and tolerates bookkeeping failures after authorization", () => {
    insertConnection(testAccountScope(), sample);
    recordConnectionCheck(testAccountScope(), "c1", {
      outcome: "failing",
      error: "Authentication failed. Check the username and password.",
    });
    expect(JSON.stringify(getConnection(testAccountScope(), "c1"))).not.toContain(sample.password);

    const db = metadataDb();
    db.exec(`CREATE TRIGGER reject_status BEFORE UPDATE OF last_checked_at ON pg_connections
      BEGIN SELECT RAISE(ABORT, 'Bookkeeping unavailable'); END;`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      recordConnectionCheck(testAccountScope(), "c1", { outcome: "connected" }, db),
    ).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      "[connections] status memory could not be recorded.",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(sample.password);
    log.mockRestore();
    closeMetadataDb();
  });

  it("renames and deletes; deletion reports honestly", () => {
    insertConnection(testAccountScope(), sample);
    expect(renameConnection(testAccountScope(), "c1", "Renamed")).toBe(true);
    expect(getConnection(testAccountScope(), "c1")?.name).toBe("Renamed");
    expect(deleteConnection(testAccountScope(), "c1")).toBe(true);
    expect(deleteConnection(testAccountScope(), "c1")).toBe(false);
    expect(connectionPassword(testAccountScope(), "c1")).toBeNull();
  });

  it("rejects duplicate names", () => {
    insertConnection(testAccountScope(), sample);
    expect(() => insertConnection(testAccountScope(), { ...sample, id: "c2" })).toThrow();
  });
});

describe("egress policy on the connection door", () => {
  const target = (host: string) => ({
    host,
    port: 5432,
    database: "d",
    username: "u",
    password: "p",
    ssl: false,
  });

  it("rejects a private-address host uniformly, before any connection", async () => {
    // No server, no DuckDB, no extension load — the rejection is the
    // policy's own, and it is identical for live and dead destinations.
    await expect(testConnection(target("10.0.0.9"))).rejects.toMatchObject({
      code: "egress_blocked",
      status: 403,
    });
    await expect(
      testConnection(target("169.254.169.254")),
    ).rejects.toMatchObject({ code: "egress_blocked", status: 403 });
  });

  it("rejects a hostname resolving to loopback, identically", async () => {
    const viaName = await testConnection(target("localhost")).catch((e) => e);
    const viaIp = await testConnection(target("127.0.0.1")).catch((e) => e);
    expect(viaName.code).toBe("egress_blocked");
    expect({ code: viaName.code, message: viaName.message }).toEqual({
      code: viaIp.code,
      message: viaIp.message,
    });
  });

  it("pins the vetted address into the attach string", () => {
    const s = attachString(target("db.example.com"), "203.0.113.7");
    expect(s).toContain("host='db.example.com'");
    expect(s).toContain("hostaddr='203.0.113.7'");
    // Without a vetted address the parameter is absent entirely.
    expect(attachString(target("db.example.com"))).not.toContain("hostaddr");
  });
});

describe("attach strings and SQL composition", () => {
  it("escapes libpq values and honours ssl mode", () => {
    const s = attachString({
      host: "h",
      port: 5433,
      database: "d'b",
      username: "u",
      password: "p'w\\d",
      ssl: true,
    });
    expect(s).toContain("port=5433");
    expect(s).toContain("sslmode=require");
    expect(s).toContain("dbname='d\\'b'");
    expect(s).toContain("password='p\\'w\\\\d'");
    expect(
      attachString({
        host: "h",
        port: 5432,
        database: "d",
        username: "u",
        password: "p",
        ssl: false,
      }),
    ).toContain("sslmode=prefer");
  });

  it("converts geometry columns to transformed WKB, quotes identifiers", () => {
    const sql = composeImportSelect(
      "public",
      "parcels",
      [
        { name: "id", udt: "int4" },
        { name: "geom", udt: "geometry" },
        { name: "weird\"col", udt: "text" },
      ],
      "value > 3",
      100,
    );
    expect(sql).toContain(
      `ST_AsBinary(ST_Transform("geom"::geometry, 4326)) AS "geom"`,
    );
    expect(sql).toContain(`"weird""col"`);
    expect(sql).toContain(`FROM "public"."parcels"`);
    expect(sql).toContain("WHERE value > 3");
    expect(sql).toContain("LIMIT 100");
  });

  it("rejects statement smuggling in filters and bad limits", () => {
    expect(() => assertFilterSafe("a = 1; DROP TABLE x")).toThrow(
      /single WHERE expression/,
    );
    expect(() => assertFilterSafe("a = 1 -- comment")).toThrow();
    expect(() => assertFilterSafe("a = 1 /* c */")).toThrow();
    expect(() => assertFilterSafe("value > 3 AND name = 'x'")).not.toThrow();
    expect(() =>
      composeImportSelect("s", "t", [{ name: "a", udt: "int4" }], undefined, 0),
    ).toThrow(/positive integer/);
  });

  it("validates import requests", () => {
    expect(() =>
      resolvePostgisRequest({ connectionId: "", schema: "s", table: "t" }),
    ).toThrow(/connectionId/);
    expect(() =>
      resolvePostgisRequest({
        connectionId: "c",
        schema: "s",
        table: "t",
        limit: -1,
      }),
    ).toThrow(/positive integer/);
    const ok = resolvePostgisRequest({
      connectionId: "c",
      schema: "public",
      table: "parcels",
      filter: "  value > 3 ",
      limit: 50,
      name: "parcels_small",
    });
    expect(ok.recipe.filter).toBe("value > 3");
    expect(ok.requestedName).toBe("parcels_small");
  });
});

describe("connection input contract", () => {
  it("rejects an invalid URL with the form's server-owned sentence", async () => {
    const response = await createConnectionRoute(
      testAccountRequest(new Request("http://localhost/api/connections/postgis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Broken", url: "jdbc:mysql://nope/db" }),
      })),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "That does not look like a Postgres URL.",
      },
    });
  });

  it("interprets URL and key-value forms identically", () => {
    const url = parseConnectionUrl(
      "postgres://reader:p%40ss@db.example.org:5433/gis?sslmode=require",
    );
    const kv = parseConnectionUrl(
      "host=db.example.org port=5433 dbname=gis user=reader password='p@ss' sslmode=require",
    );
    expect(url).toEqual(kv);
  });

  it("lets present fields win over URL parts", () => {
    const resolved = resolveCreateConnectionInput({
      name: "City",
      url: "postgres://url_user:url_pass@url.example.org/url_db?sslmode=disable",
      host: "field.example.org",
      port: 5434,
      ssl: true,
    });
    expect(resolved).toMatchObject({
      host: "field.example.org",
      port: 5434,
      database: "url_db",
      username: "url_user",
      ssl: true,
    });
    expect(resolved.password === "url_pass").toBe(true);
  });

  it("keeps stored SSL when an edit URL omits sslmode", () => {
    const url = "postgres://reader@new.example.org/gis";
    expect(parseConnectionUrl(url).ssl).toBeUndefined();
    const current = {
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored_value",
      ssl: false,
    };
    const resolved = resolveUpdateConnectionInput(
      { url },
      current,
    );
    expect(resolved.values.ssl).toBe(false);
  });

  it("keeps a stored non-default port when an edit URL omits the port", () => {
    const url = "postgres://reader@new.example.org/gis?sslmode=require";
    expect(parseConnectionUrl(url).port).toBeUndefined();
    const current = {
      name: "City",
      host: "db.example.org",
      port: 6432,
      database: "gis",
      username: "reader",
      password: "stored_value",
      ssl: true,
    };
    const resolved = resolveUpdateConnectionInput(
      { url },
      current,
    );
    expect(resolved.values.port).toBe(6432);
  });

  it("keeps the stored password for blank and omitted edits unless the URL supplies one", () => {
    const current = {
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored_value",
      ssl: true,
    };
    const omitted = resolveUpdateConnectionInput({}, current);
    expect(omitted.values.password === current.password).toBe(true);
    expect(omitted.passwordFromStore).toBe(true);
    const blank = resolveUpdateConnectionInput({ password: "" }, current);
    expect(blank.values.password === current.password).toBe(true);
    expect(blank.passwordFromStore).toBe(true);
    const fromUrl = resolveUpdateConnectionInput(
      { url: "host=db.example.org dbname=gis user=reader password=rotated" },
      current,
    );
    expect(fromUrl.values.password === current.password).toBe(false);
    expect(fromUrl.passwordFromStore).toBe(false);
    expect(fromUrl.connectivityChanged).toBe(true);

    const fieldWins = resolveUpdateConnectionInput(
      {
        password: " field password ",
        url: "host=db.example.org dbname=gis user=reader password=url-password",
      },
      current,
    );
    expect(fieldWins.values.password).toBe(" field password ");
    expect(fieldWins.passwordFromStore).toBe(false);
  });

  it("requires password re-entry only for a stored-password endpoint change or SSL downgrade", () => {
    const current = {
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored_value",
      ssl: true,
    };
    const omitted = resolveUpdateConnectionInput({ ssl: false }, current);
    expect(omitted.endpointChanged).toBe(false);
    expect(omitted.passwordFromStore).toBe(true);
    expect(omitted.passwordReentryRequired).toBe(true);
    expect(
      resolveUpdateConnectionInput(
        {
          url: "postgres://reader@db.example.org:5432/gis?sslmode=disable",
        },
        current,
      ).passwordReentryRequired,
    ).toBe(true);
    expect(
      resolveUpdateConnectionInput(
        { ssl: false, password: "entered-again" },
        current,
      ).passwordReentryRequired,
    ).toBe(false);
    expect(
      resolveUpdateConnectionInput(
        { ssl: true, password: "" },
        { ...current, ssl: false },
      ).passwordReentryRequired,
    ).toBe(false);
  });

  it.each([
    ["host whitespace", " db.example.org ", 5432],
    ["numeric port spelling", "db.example.org", " 05432 "],
    ["DNS case", "DB.EXAMPLE.ORG", 5432],
    ["one terminal DNS dot", "db.example.org.", 5432],
  ])("treats %s as the same endpoint", (_case, host, port) => {
    const current = {
      name: "City",
      host: "db.example.org",
      port: 5432,
      database: "gis",
      username: "reader",
      password: "stored_value",
      ssl: true,
    };
    const resolved = resolveUpdateConnectionInput({ host, port }, current);
    expect(resolved.endpointChanged).toBe(false);
  });

  it("treats bracketed, unbracketed, compressed, and expanded IPv6 forms equally", () => {
    expect(
      connectionEndpointsEqual(
        { host: "[2001:db8::1]", port: 5432 },
        { host: "2001:0db8:0000:0000:0000:0000:0000:0001", port: 5432 },
      ),
    ).toBe(true);
    expect(
      connectionEndpointsEqual(
        { host: "2001:db8::1", port: 5432 },
        { host: "[2001:0db8:0:0:0:0:0:1]", port: 5432 },
      ),
    ).toBe(true);
  });

  it("detects genuine endpoint changes without resolving DNS", () => {
    expect(
      connectionEndpointsEqual(
        { host: "localhost", port: 5432 },
        { host: "127.0.0.1", port: 5432 },
      ),
    ).toBe(false);
    expect(
      connectionEndpointsEqual(
        { host: "db.example.org", port: 5432 },
        { host: "db.example.org", port: 5433 },
      ),
    ).toBe(false);
  });

  it("rejects missing values and invalid ports before a caller can connect", () => {
    expect(() => resolveCreateConnectionInput({ name: "Missing" })).toThrow(
      "Host is required.",
    );
    expect(() =>
      resolveCreateConnectionInput({
        name: "Bad port",
        host: "db.example.org",
        port: 70000,
        database: "gis",
        username: "reader",
        password: "value",
      }),
    ).toThrow("The port is invalid.");
    expect(() => parseConnectionUrl("jdbc:mysql://nope/db")).toThrow(
      ConnectionInputError,
    );
  });
});

describe("import status memory", () => {
  const sample = {
    id: "import-c1",
    name: "Import source",
    host: "db.example.org",
    port: 5432,
    database: "gis",
    username: "reader",
    ssl: true,
    password: "stored-value",
  };

  it("records controlled import success", async () => {
    insertConnection(testAccountScope(), sample);
    await importPostgis(
      testAccountScope(),
      { connectionId: sample.id, schema: "public", table: "roads" },
      async () => ({
        geometryColumn: "geom",
        geometryType: "LINESTRING",
        crsAssumed: false,
        headerSuspect: false,
        rowCount: 12,
        connectionHealth: {
          serverVersion: "PostgreSQL 16.4",
          postgisVersion: "3.4.3",
        },
      }),
    );
    expect(getConnection(testAccountScope(), sample.id)).toMatchObject({
      status: "connected",
      lastCheckedAt: expect.any(String),
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
  });

  it("records controlled import failure without persisting engine detail", async () => {
    insertConnection(testAccountScope(), sample);
    await expect(
      importPostgis(
        testAccountScope(),
        { connectionId: sample.id, schema: "public", table: "roads" },
        async (_target, _recipe, _artifact, observeHealth) => {
          observeHealth?.({
            serverVersion: "PostgreSQL 16.4",
            postgisVersion: "3.4.3",
          });
          throw new Error("engine detail that must not be persisted");
        },
      ),
    ).rejects.toThrow();
    expect(getConnection(testAccountScope(), sample.id)).toMatchObject({
      status: "connected",
      lastCheckedAt: expect.any(String),
      lastCheckError: null,
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    });
  });
});

describe("snapshots by connection", () => {
  it("uses only the stored connection id and retains recipe facts", () => {
    insertConnection(testAccountScope(), { id: "c1", name: "Current name", host: "db.example.org", port: 5432,
      database: "geodata", username: "reader", password: "fixture-only", ssl: true });
    const base = {
      sourceFilename: "public.roads",
      format: "geoparquet" as const,
      file: "tables/t.parquet",
      geometryColumn: "geom",
      geometryType: "LINESTRING",
      crsAssumed: false,
      headerSuspect: false,
      rowCount: 12,
      createdAt: "2026-08-01T00:00:00.000Z",
      source: "postgis" as const,
      importedAt: "2026-08-02T00:00:00.000Z",
    };
    insertTable(testAccountScope(), {
      ...base,
      id: "t1",
      name: "owned",
      sourceParams: {
        connectionId: "c1",
        connectionName: "Old name",
        schema: "public",
        table: "roads",
        filter: "class = 'primary'",
        limit: 100,
      },
    });
    insertTable(testAccountScope(), {
      ...base,
      id: "t2",
      name: "not_owned",
      sourceParams: {
        connectionId: "c2",
        connectionName: "Current name",
        schema: "public",
        table: "roads",
      },
    });
    expect(listPostgisSnapshots(testAccountScope(), "c1")).toEqual([
      expect.objectContaining({
        name: "owned",
        sourceParams: expect.objectContaining({
          connectionId: "c1",
          filter: "class = 'primary'",
          limit: 100,
        }),
      }),
    ]);
  });
});

describe("the snapshot road's project context", () => {
  const sample = {
    id: "proj-c1",
    name: "Import source",
    host: "db.example.org",
    port: 5432,
    database: "gis",
    username: "reader",
    ssl: true,
    password: "stored-value",
  };
  const stubBuild = async () => ({
    geometryColumn: "geom",
    geometryType: "LINESTRING",
    crsAssumed: false,
    headerSuspect: false,
    rowCount: 12,
    connectionHealth: {
      serverVersion: "PostgreSQL 16.4",
      postgisVersion: "3.4.3",
    },
  });

  it("files the snapshot in the same act", async () => {
    insertConnection(testAccountScope(), sample);
    const p = createProject(testAccountScope(), { name: "A" });
    const table = await importPostgis(
      testAccountScope(),
      { connectionId: sample.id, schema: "public", table: "roads", projectId: p.id },
      stubBuild,
    );
    expect(tableProjectIds().get(table.id)).toEqual([p.id]);
  });

  it("an unknown project rolls the registration back", async () => {
    insertConnection(testAccountScope(), sample);
    await expect(
      importPostgis(
        testAccountScope(),
        { connectionId: sample.id, schema: "public", table: "roads", projectId: "p-vanished" },
        stubBuild,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(listTables().length).toBe(0);
  });
});
