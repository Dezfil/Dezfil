import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { connectQueryInstance, resetQueryInstance } from "@/lib/duckdb";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { ingestFile } from "@/lib/ingest/ingest";
import type { AccountScope } from "@/lib/auth/scope";
import type { DataTable } from "@/lib/metadata/tables";
import { firstExternalUnbound, resolveParameter, resolveReference, resolveSql, type Namespace, type ReachableDataset } from "./bindings";

/**
 * The binding resolver: every dataset reference resolves to an identity in
 * the namespace of an evaluation (the SQL home, the caller's reach and a
 * workflow's declared outputs), or is reported as written. The fixture puts
 * the cases that a name-only resolver gets wrong side by side: two owners'
 * `roads` in one reach, a declared output shadowing a home dataset, a
 * qualified external input beside a same-named declared output, and a name
 * outside reach.
 */

function dataset(id: string, name: string, ownerId: string, geometryColumn: string | null = "geometry"): ReachableDataset {
  const table: DataTable = {
    id, name, sourceFilename: null, format: "geoparquet", file: `tables/${id}.parquet`, geometryColumn,
    geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 1, createdAt: "2026-01-01T00:00:00.000Z",
    source: "upload", sourceParams: null, importedAt: null,
  };
  return { ...table, ownerId, ownerSqlName: ownerId };
}
const adaRoads = dataset("ada-roads", "roads", "ada");
const bobRoads = dataset("bob-roads", "roads", "bob");
const adaStats = dataset("ada-stats", "stats", "ada", null);
const bobOutput = dataset("bob-output", "roads", "bob");
const namespace = (outputs: [string, string | null][] = []): Namespace => ({
  home: { id: "ada", sqlName: "ada" },
  datasets: [adaRoads, bobRoads, adaStats, bobOutput],
  outputs: new Map(outputs),
});
const bound = (ns: Namespace, ...parts: string[]) => {
  const resolution = resolveReference(ns, parts);
  return resolution.status === "bound" ? resolution.dataset.id : resolution;
};

describe("resolving a reference in a namespace", () => {
  it("binds a plain name to the home's dataset and a qualified one to its owner's, never the other way", () => {
    expect(bound(namespace(), "roads")).toBe("ada-roads");
    expect(bound(namespace(), "bob", "roads")).toBe("bob-roads");
    expect(bound(namespace(), "BOB", "Roads")).toBe("bob-roads");
    expect(bound(namespace(), "ada", "roads")).toBe("ada-roads");
    expect(bound(namespace(), "bob.roads")).toBe("bob-roads");
  });

  it("keeps the engine's own qualified forms meaning what a plain name means", () => {
    for (const parts of [["main", "roads"], ["temp", "roads"], ["memory", "roads"], ["memory", "main", "roads"], ["temp", "main", "roads"]]) {
      expect(bound(namespace(), ...parts)).toBe("ada-roads");
    }
    expect(resolveReference(namespace(), ["information_schema", "tables"])).toEqual({ status: "engine" });
    expect(resolveReference(namespace(), ["pg_catalog", "pg_class"])).toEqual({ status: "engine" });
  });

  it("lets a declared output take its plain name ahead of the home, while the qualified name stays the home's", () => {
    const ns = namespace([["roads", "bob-output"]]);
    expect(bound(ns, "roads")).toBe("bob-output");
    expect(bound(ns, "ada", "roads")).toBe("ada-roads");
    expect(bound(ns, "main", "roads")).toBe("bob-output");
  });

  it("keeps a qualified external input external beside a same-named declared output", () => {
    const ns = namespace([["roads", "bob-output"]]);
    expect(bound(ns, "bob", "roads")).toBe("bob-roads");
    expect(resolveParameter(ns, "bob.roads").resolution).toMatchObject({ status: "bound", dataset: { id: "bob-roads" } });
    expect(resolveParameter(ns, "roads").resolution).toMatchObject({ status: "bound", dataset: { id: "bob-output" }, output: true });
  });

  it("reserves a declared output's name before it exists, with no fallback to the home's dataset", () => {
    const ns = namespace([["roads", null], ["stats", "not-in-reach"]]);
    expect(resolveReference(ns, ["roads"])).toEqual({ status: "reserved" });
    expect(resolveReference(ns, ["stats"])).toEqual({ status: "reserved" });
    expect(bound(ns, "ada", "roads")).toBe("ada-roads");
  });

  it("reports a name outside reach as unbound, external when it is qualified", () => {
    expect(resolveReference(namespace(), ["cyd", "roads"])).toEqual({ status: "unbound", external: true });
    expect(resolveReference(namespace(), ["bob", "stats"])).toEqual({ status: "unbound", external: true });
    expect(resolveReference(namespace(), ["missing"])).toEqual({ status: "unbound", external: false });
    expect(resolveParameter(namespace(), '"cyd"."roads"').resolution).toEqual({ status: "unbound", external: true });
  });
});

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "bindings-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  for (const owner of ["ada", "bob"]) {
    const file = path.join(directory, `${owner}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner},1,2\n`);
    await ingestFile(scopes[owner], file, "roads.csv");
  }
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe("resolving every reference of a statement", () => {
  it("resolves static, dynamic, list, computed and nested references to identities, and attributes geometry by alias", async () => {
    const conn = await connectQueryInstance();
    try {
      const ns = namespace();
      const ids = async (sql: string) => (await resolveSql(conn, sql, ns)).datasets.map((d) => d.id);
      expect(await ids("SELECT r.geometry FROM roads r JOIN bob.roads b ON true")).toEqual(["ada-roads", "bob-roads"]);
      expect((await resolveSql(conn, "SELECT r.geometry FROM roads r JOIN bob.roads b ON true", ns)).geometry).toEqual(new Set(["ada-roads"]));
      expect(await ids("SELECT * FROM query_table(['ro' || 'ads', 'bob.' || 'roads'], true)")).toEqual(["ada-roads", "bob-roads"]);
      expect(await ids("SELECT * FROM query_table('bob.roads')")).toEqual(["bob-roads"]);
      expect(await ids("SELECT * FROM query('SELECT * FROM bob.roads')")).toEqual(["bob-roads"]);
      expect(await ids("WITH roads AS (SELECT 1 AS x) SELECT * FROM roads, ada.roads")).toEqual(["ada-roads"]);
      expect(await ids("SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT * FROM bob.roads'))")).toEqual(["bob-roads"]);
    } finally { conn.disconnectSync(); }
  });

  it("names the first reference outside reach exactly as written", async () => {
    const conn = await connectQueryInstance();
    try {
      const bindings = await resolveSql(conn, 'SELECT * FROM roads, "Cyd"."Old Roads", bob.nothing', namespace());
      expect(firstExternalUnbound(bindings)).toBe('Cyd."Old Roads"');
      expect(firstExternalUnbound(await resolveSql(conn, "SELECT * FROM roads, missing", namespace()))).toBeNull();
    } finally { conn.disconnectSync(); }
  });
});

describe("the consumers bind by identity", () => {
  it("keeps a qualified read out of the plain reads a workflow orders by", async () => {
    const { queryInputs } = await import("@/lib/operations/inputs");
    const { assertOrderingValid } = await import("@/lib/operations/recipe-order");
    const { stepReads } = await import("@/lib/operations/step-reads");
    const conn = await connectQueryInstance();
    try {
      expect(await queryInputs(conn, "SELECT * FROM bob.parcels JOIN roads USING (id)", () => null))
        .toMatchObject({ tables: ["roads"], external: ["bob.parcels"] });
    } finally { conn.disconnectSync(); }
    // A step reading Ada's own `staged` by qualified name does not depend on
    // the later step whose declared output is called `staged`.
    const reader = { id: "reader", ordinal: 0, operation: "sql_step", parameters: { sql: "SELECT * FROM ada.staged", name: "first" }, proposedParameters: null, outputTableName: null };
    const producer = { id: "producer", ordinal: 1, operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "staged" }, proposedParameters: null, outputTableName: null };
    const steps = [reader, producer] as unknown as Parameters<typeof assertOrderingValid>[0];
    const reads = new Map([["reader", await stepReads(scopes.ada, reader)], ["producer", await stepReads(scopes.ada, producer)]]);
    expect(reads.get("reader")).toEqual([]);
    expect(() => assertOrderingValid(steps, reads)).not.toThrow();
  });

  it("refuses to materialize a statement whose qualified reference is outside reach, naming it", async () => {
    const { materialize } = await import("@/lib/operations/materialize");
    for (const sql of ["SELECT * FROM bob.roads", "SELECT * FROM zz.roads"]) {
      await expect(materialize(scopes.ada, { name: "copied", sql, operation: "sql_step" }))
        .rejects.toMatchObject({ code: "sql_error", status: 400, message: `The dataset "${sql.slice(14)}" is not available to you.` });
    }
  });

  it("resolves a named verb's input to the identity its qualified name reaches, and the plain name to the caller's own", async () => {
    const { inputTable, tableRef, bindingKey } = await import("@/lib/operations/compile-support");
    const { listOwnedTables } = await import("@/lib/metadata/owned-tables");
    const ada = listOwnedTables(scopes.ada)[0], bob = listOwnedTables(scopes.bob)[0];
    shareProject("ada", "P", [["bob", "viewer"]], [ada.id]);
    const shared = inputTable(scopes.bob, "ada.roads", "input");
    expect(shared).toMatchObject({ id: ada.id, name: "roads" });
    expect([tableRef(shared), bindingKey(shared)]).toEqual(['"ada"."roads"', "ada.roads"]);
    const own = inputTable(scopes.bob, "roads", "input");
    expect([own.id, tableRef(own), bindingKey(own)]).toEqual([bob.id, '"roads"', "roads"]);
    const refusal = (scope: AccountScope, name: string) => { try { inputTable(scope, name, "input"); } catch (error) { return error; } };
    expect(refusal(scopes.ada, "bob.roads")).toMatchObject({ code: "not_found", message: 'The input "bob.roads" is not a table in this workspace.' });
    expect(refusal(scopes.cyd, "ada.roads")).toMatchObject({ code: "not_found", message: 'The input "ada.roads" is not a table in this workspace.' });
    expect(refusal(scopes.cyd, "ada.nothing")).toMatchObject({ code: "not_found", message: 'The input "ada.nothing" is not a table in this workspace.' });
  });
});
