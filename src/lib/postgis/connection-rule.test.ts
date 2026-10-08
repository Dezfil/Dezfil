import type { Database } from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { insertConnection } from "@/lib/metadata/connections";
import { insertTable } from "@/lib/metadata/tables";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { callAs, ROADS, ruleRefusalBody, tokenFor, type Road } from "@/lib/test-support/rule-roads";
import { PATCH as changeInstanceSettings } from "@/app/api/instance/settings/route";

/**
 * Who may add database connections, on every road. Admins only refuses a
 * member a new connection, or pointing one at another host, port or database,
 * and takes nothing away: testing, browsing, importing, refreshing, renaming,
 * a new password or user name for the same database and deleting keep working.
 * The rule is checked again in the write itself, after the connection test,
 * so a rule saved while the test ran is the one that decides.
 */
const SENTENCE = "Only admins can add database connections on this instance.";
const health = { serverVersion: "fixture", postgisVersion: "fixture" };
const source = vi.hoisted(() => ({ test: vi.fn(), browse: vi.fn(), attach: vi.fn(), build: vi.fn() }));
vi.mock("@/lib/postgis/access", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/postgis/access")>(),
  testConnection: source.test, browseRemoteTables: source.browse, withPg: source.attach,
}));
vi.mock("@/lib/postgis/import", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/postgis/import")>();
  const build = source.build as unknown as typeof actual.buildPostgisArtifact;
  return { ...actual, buildPostgisArtifact: build,
    importPostgis: (scope: Parameters<typeof actual.importPostgis>[0], request: Parameters<typeof actual.importPostgis>[1]) =>
      actual.importPostgis(scope, request, build) };
});

let db: Database;
let tokens: Record<string, string>;
const values = { host: "db.example.test", port: 5432, database: "survey", username: "reader", password: "fixture", ssl: true };

beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  for (const account of ["admin", "member"]) {
    // Made while everyone could: what a narrowed rule must leave working.
    const scope = testAccountScope(db, account);
    insertConnection(scope, { ...values, id: `${account}-connection`, name: `${account} survey` }, db);
    insertTable(scope, { id: `${account}-snapshot`, name: `${account}_snapshot`, sourceFilename: "public.roads",
      file: `tables/${account}-snapshot.parquet`, format: "geoparquet", geometryColumn: null, geometryType: null,
      crsAssumed: false, headerSuspect: false, rowCount: 1, createdAt: "time", importedAt: "time", source: "postgis",
      sourceParams: { connectionId: `${account}-connection`, schema: "public", table: "roads" } }, db);
  }
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  tokens = { admin: tokenFor(db, "admin"), member: tokenFor(db, "member") };
  source.test.mockReset().mockResolvedValue(health);
  source.browse.mockReset().mockResolvedValue({ tables: [] });
  source.attach.mockReset().mockRejectedValue(new Error("The source is reached only through the fixture build."));
  source.build.mockReset().mockImplementation(async (_target: unknown, _recipe: unknown, artifact: string) => {
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, "snapshot");
    return { geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 2, connectionHealth: health };
  });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

async function setConnections(value: "everyone" | "admins") {
  const response = await changeInstanceSettings(testAccountRequest(new Request("http://instance.test/api/instance/settings", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ "connections.create": value }),
  }), db, "admin"));
  expect(response.status).toBe(200);
}
const connections = () => db.prepare("SELECT * FROM pg_connections ORDER BY id").all();

/** Each change a narrowed rule refuses: a new connection, and the account's
 * own connection pointed at another host, port or database. */
function refusedChanges(account: string): [string, string, Record<string, unknown>][] {
  const id = `${account}-connection`;
  return [
    ["a new connection", "create_postgis_connection", { ...values, name: "Another survey" }],
    ["another host", "update_postgis_connection", { id, host: "elsewhere.example.test", password: "fixture" }],
    ["another port", "update_postgis_connection", { id, port: 5433, password: "fixture" }],
    ["another database", "update_postgis_connection", { id, database: "archive" }],
  ];
}

/** Everything a narrowed rule keeps, ending with the deletion. */
async function keeps(road: Road, account: string) {
  const id = `${account}-connection`, token = tokens[account];
  const kept: [string, string, Record<string, unknown>, number][] = [
    ["testing", "test_postgis_connection", { id }, 200],
    ["browsing", "list_postgis_tables", { id }, 200],
    ["importing", "import_table_from_postgis", { connectionId: id, schema: "public", table: "rivers" }, 201],
    ["refreshing", "refresh_table", { name: `${account}_snapshot` }, 200],
    ["renaming", "update_postgis_connection", { id, name: `Renamed by ${road}` }, 200],
    ["a new password", "update_postgis_connection", { id, password: "rotated" }, 200],
    ["another user name", "update_postgis_connection", { id, username: "editor" }, 200],
    ["the same host spelled otherwise", "update_postgis_connection", { id, host: "DB.Example.Test." }, 200],
  ];
  for (const [label, tool, args, status] of kept) {
    const answer = await callAs(db, road, account, token, tool, args);
    expect(answer.status, `${label}: ${JSON.stringify(answer.body)}`).toBe(status);
  }
  expect(db.prepare("SELECT name, host, port, database, username FROM pg_connections WHERE id = ?").get(id))
    .toEqual({ name: `Renamed by ${road}`, host: "DB.Example.Test.", port: 5432, database: "survey", username: "editor" });
  expect((await callAs(db, road, account, token, "delete_postgis_connection", { id })).status).toBeLessThan(300);
  expect(db.prepare("SELECT count(*) AS n FROM pg_connections WHERE id = ?").get(id)).toEqual({ n: 0 });
}

describe("who may add database connections", () => {
  it.each(ROADS)("under admins, refuses a member a new or repointed connection by %s, before any test reaches the source", async road => {
    await setConnections("admins");
    for (const [label, tool, args] of refusedChanges("member")) {
      const before = connections();
      const answer = await callAs(db, road, "member", tokens.member, tool, args);
      expect(answer, label).toEqual({ status: 403, body: ruleRefusalBody("connections.create", SENTENCE) });
      expect(connections(), label).toEqual(before);
    }
    expect(source.test).not.toHaveBeenCalled();
  });

  it.each(ROADS)("under admins, keeps all a member does with their connection by %s", async road => {
    await setConnections("admins");
    await keeps(road, "member");
  });

  it.each(ROADS)("under admins, lets an admin add and repoint connections by %s", async road => {
    await setConnections("admins");
    for (const [label, tool, args] of refusedChanges("admin")) {
      const answer = await callAs(db, road, "admin", tokens.admin, tool, args);
      expect(answer.status, `${label}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
    }
    expect(db.prepare("SELECT host, port, database FROM pg_connections WHERE id = 'admin-connection'").get())
      .toEqual({ host: "elsewhere.example.test", port: 5433, database: "archive" });
  });

  it.each(ROADS)("under everyone, lets a member add and repoint connections by %s", async road => {
    for (const [label, tool, args] of refusedChanges("member")) {
      const answer = await callAs(db, road, "member", tokens.member, tool, args);
      expect(answer.status, `${label}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
    }
  });

  it.each([
    ["a new connection", "create_postgis_connection", { ...values, name: "Late survey" }],
    ["another database", "update_postgis_connection", { id: "member-connection", database: "archive" }],
  ] as const)("refuses %s when the rule narrows while the connection test runs, storing nothing", async (_label, tool, args) => {
    const before = connections();
    source.test.mockImplementationOnce(async () => { await setConnections("admins"); return health; });
    const answer = await callAs(db, "token", "member", tokens.member, tool, args);
    expect(answer).toEqual({ status: 403, body: ruleRefusalBody("connections.create", SENTENCE) });
    expect(source.test).toHaveBeenCalledTimes(1);
    expect(connections()).toEqual(before);
  });

  it("refuses at the connection service itself, whatever road reaches it", async () => {
    await setConnections("admins");
    const { createConnection, editConnection } = await import("./connection-service");
    const scope = testAccountScope(db, "member");
    const refusal = { code: "rule_refused", status: 403, message: SENTENCE, extra: { rule: "connections.create" } };
    await expect(createConnection(scope, { ...values, name: "Direct" })).rejects.toMatchObject(refusal);
    await expect(editConnection(scope, "member-connection", { database: "archive" })).rejects.toMatchObject(refusal);
    expect(source.test).not.toHaveBeenCalled();
  });
});
