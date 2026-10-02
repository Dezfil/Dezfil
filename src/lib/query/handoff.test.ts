import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { connectQueryInstance, resetQueryInstance } from "@/lib/duckdb";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { ingestFile } from "@/lib/ingest/ingest";
import { listOwnedTables } from "@/lib/metadata/owned-tables";
import { createMap } from "@/lib/map-service";
import type { AccountScope } from "@/lib/auth/scope";
import type { DataTable } from "@/lib/metadata/tables";
import type { Namespace, ReachableDataset } from "./bindings";
import { contextOf, mapEvaluation } from "./context";
import { namespaceFor } from "./namespace";
import { executeQuery } from "./execute";
import { carryName, carryParameters, carrySql } from "./handoff";

/**
 * The handoff: a reference carried from the context it was written in into
 * another keeps the dataset it meant. The namespaces below are Bo's console
 * (his home, his reach), a map of Ada's (her home, Bo's reach), Ada's
 * workflows with and without declared outputs, and Bo's own workflow, so
 * every combination of same home, different home, qualified, internal output
 * and unresolvable reference is side by side.
 */

function dataset(id: string, name: string, owner: string, sqlName: string | null = owner): ReachableDataset {
  const table: DataTable = {
    id, name, sourceFilename: null, format: "geoparquet", file: `tables/${id}.parquet`, geometryColumn: "geometry",
    geometryType: null, crsAssumed: false, headerSuspect: false, rowCount: 1, createdAt: "2026-01-01T00:00:00.000Z",
    source: "upload", sourceParams: null, importedAt: null,
  };
  return { ...table, ownerId: owner, ownerSqlName: sqlName };
}
const reach = [
  dataset("ada-roads", "roads", "ada"),
  dataset("bo-roads", "roads", "bo"),
  dataset("bo-stations", "stations", "bo"),
  dataset("ada-staged", "staged", "ada"),
  dataset("bo-staged", "staged", "bo"),
  dataset("ord-roads", "roads", "ord", "order"),
];
const space = (home: string, outputs: [string, string | null][] = []): Namespace => ({
  home: { id: home, sqlName: home }, datasets: reach, outputs: new Map(outputs),
});
const boConsole = space("bo");
const adaMap = space("ada");
const boMap = space("bo");
/** Ada's workflow as Bo runs it: `staged` is its output, Bo's own run made it. */
const adaWorkflowForBo = space("ada", [["staged", "bo-staged"]]);
/** The same workflow as Ada runs it. */
const adaWorkflowForAda = space("ada", [["staged", "ada-staged"]]);
/** A workflow whose `staged` nobody running it has produced. */
const unproduced = space("ada", [["staged", null]]);
/** Ada's workflow that declares `roads` as an output of its own. */
const declaresRoads = space("ada", [["roads", null]]);

describe("carrying a named input", () => {
  it("keeps a plain name in the same home and qualifies it for another home", () => {
    expect(carryName("roads", boConsole, boMap)).toBe("roads");
    expect(carryName("roads", boConsole, adaMap)).toBe("bo.roads");
    expect(carryName("Stations", boConsole, adaMap)).toBe("bo.stations");
    expect(carryName("roads", adaMap, boConsole)).toBe("ada.roads");
  });

  it("leaves an already qualified reference as written, against a same-named declared output too", () => {
    expect(carryName("ada.roads", boConsole, adaMap)).toBe("ada.roads");
    expect(carryName("bo.roads", boConsole, adaMap)).toBe("bo.roads");
    expect(carryName("ada.roads", boConsole, declaresRoads)).toBe("ada.roads");
    expect(carryName("cy.nothing", boConsole, adaMap)).toBe("cy.nothing");
  });

  it("carries a departing internal output as the particular dataset it is for the acting account", () => {
    expect(carryName("staged", adaWorkflowForBo, boConsole)).toBe("staged");
    expect(carryName("staged", adaWorkflowForBo, adaMap)).toBe("bo.staged");
    expect(carryName("staged", adaWorkflowForAda, adaMap)).toBe("staged");
    expect(carryName("staged", adaWorkflowForAda, boConsole)).toBe("ada.staged");
  });

  it("refuses an internal output the acting account has not produced", () => {
    expect(() => carryName("staged", unproduced, adaMap)).toThrow(
      expect.objectContaining({ code: "sql_error", message: 'The dataset "staged" is a workflow output you have not produced yet, so it cannot be carried over.' }),
    );
  });

  it("qualifies a home dataset whose plain name an output takes where it goes, within one home", () => {
    expect(carryName("roads", adaMap, declaresRoads)).toBe("ada.roads");
    expect(carryName("roads", boConsole, declaresRoads)).toBe("bo.roads");
  });

  it("keeps an unresolvable name in the same home and refuses it into another, naming it as written", () => {
    expect(carryName("nothing", boConsole, boMap)).toBe("nothing");
    const refused = expect.objectContaining({ code: "sql_error", message: 'The dataset "Nothing" is not available to you.' });
    expect(() => carryName("Nothing", boConsole, adaMap)).toThrow(refused);
    // The same home, but the destination would read an output of its own.
    expect(() => carryName("nothing", space("ada"), space("ada", [["nothing", null]]))).toThrow(
      expect.objectContaining({ message: 'The dataset "nothing" is not available to you.' }),
    );
  });

  it("carries a step's dataset parameters and leaves the given object unchanged", async () => {
    const parameters = { input: "roads", other: "ada.roads", distance: 5 };
    const carried = await carryParameters(null as never, { inputs: [{ name: "input" }, { name: "other" }], takesSql: false }, parameters, boConsole, adaMap);
    expect(carried).toEqual({ input: "bo.roads", other: "ada.roads", distance: 5 });
    expect(parameters).toEqual({ input: "roads", other: "ada.roads", distance: 5 });
  });
});

describe("carrying SQL text", () => {
  const carry = async (sql: string, from: Namespace, to: Namespace) => {
    const conn = await connectQueryInstance();
    try { return await carrySql(conn, sql, from, to); } finally { conn.disconnectSync(); }
  };
  const refusal = async (sql: string, from: Namespace, to: Namespace) => {
    try { await carry(sql, from, to); } catch (error) { return error; }
    return null;
  };

  it("rewrites only the references that move, keeping the rest of the text byte for byte", async () => {
    const sql = "-- é from Bo's console 😀\nselect r.geometry, roads.name\n  from roads   r join ada.roads on true -- the shared one\n";
    expect(await carry(sql, boConsole, adaMap)).toBe(
      "-- é from Bo's console 😀\nselect r.geometry, roads.name\n  from bo.roads   r join ada.roads on true -- the shared one\n",
    );
    const same = "SELECT * FROM roads JOIN stations USING (id)";
    expect(await carry(same, boConsole, boMap)).toBe(same);
    expect(await carry('SELECT * FROM "ROADS"', boConsole, adaMap)).toBe("SELECT * FROM bo.roads");
  });

  it("carries dynamic, listed and nested references inside their literals", async () => {
    expect(await carry("SELECT * FROM query_table('roads')", boConsole, adaMap)).toBe("SELECT * FROM query_table('bo.roads')");
    expect(await carry("SELECT * FROM query_table(['roads', 'ada.roads'], true)", boConsole, adaMap))
      .toBe("SELECT * FROM query_table(['bo.roads', 'ada.roads'], true)");
    expect(await carry("SELECT * FROM query('SELECT * FROM roads WHERE ''x'' <> name')", boConsole, adaMap))
      .toBe("SELECT * FROM query('SELECT * FROM bo.roads WHERE ''x'' <> name')");
    // Computed, but nothing in it moves.
    const computed = "SELECT * FROM query_table('ada.' || 'roads')";
    expect(await carry(computed, boConsole, adaMap)).toBe(computed);
  });

  it("refuses a computed name that would have to change, and a name out of reach, naming each", async () => {
    expect(await refusal("SELECT * FROM query_table('ro' || 'ads')", boConsole, adaMap)).toMatchObject({
      code: "sql_error", message: 'The dataset reference "roads" is computed, so it cannot be carried over. Name the dataset directly.',
    });
    expect(await refusal("SELECT * FROM roads, missing_one", boConsole, adaMap)).toMatchObject({
      code: "sql_error", message: 'The dataset "missing_one" is not available to you.',
    });
    expect(await refusal("SELECT * FROM staged", unproduced, boConsole)).toMatchObject({
      code: "sql_error", message: 'The dataset "staged" is a workflow output you have not produced yet, so it cannot be carried over.',
    });
  });

  it("leaves common table expressions, the engine's catalogues and qualified names alone", async () => {
    for (const sql of [
      "WITH roads AS (SELECT 1 AS x) SELECT * FROM roads",
      "SELECT table_name FROM information_schema.tables",
      "SELECT * FROM ada.roads JOIN bo.stations ON true",
    ]) expect(await carry(sql, boConsole, adaMap)).toBe(sql);
  });

  it("follows an engine-qualified table with its qualified columns, and quotes a SQL name the parser would misread", async () => {
    expect(await carry("SELECT main.roads.name FROM main.roads", boConsole, adaMap)).toBe("SELECT bo.roads.name FROM bo.roads");
    const fromOrder = { ...space("ord"), datasets: reach };
    expect(await carry("SELECT * FROM roads", fromOrder, adaMap)).toBe('SELECT * FROM "order"."roads"');
  });

  it("keeps a moved table's implicit name where another relation of its FROM clause goes by it", async () => {
    // `roads.name` named Bo's plain `roads`; qualified, it would go by
    // `bo.roads` beside `ada.roads`, so it keeps `roads` as its alias.
    expect(await carry("SELECT roads.name, ada.roads.name FROM roads, ada.roads", boConsole, adaMap))
      .toBe("SELECT roads.name, ada.roads.name FROM bo.roads AS roads, ada.roads");
    expect(await carry("SELECT r.name FROM roads r, ada.roads", boConsole, adaMap)).toBe("SELECT r.name FROM bo.roads r, ada.roads");
    expect(await carry("SELECT main.roads.name FROM main.roads, ada.roads", boConsole, adaMap))
      .toBe("SELECT roads.name FROM bo.roads AS roads, ada.roads");
    // Alone in its FROM clause, a schema-qualified table goes by its own name.
    expect(await carry("SELECT roads.name FROM roads", boConsole, adaMap)).toBe("SELECT roads.name FROM bo.roads");
    expect(await carry("DESCRIBE roads", boConsole, adaMap)).toBe("DESCRIBE bo.roads");
  });

  it("carries a departing output and keeps a home dataset external against the destination's output", async () => {
    expect(await carry("SELECT * FROM staged", adaWorkflowForBo, adaMap)).toBe("SELECT * FROM bo.staged");
    expect(await carry("SELECT * FROM roads", adaMap, declaresRoads)).toBe("SELECT * FROM ada.roads");
  });

  it("refuses what the read-only guard refuses where it was written", async () => {
    expect(await refusal("DELETE FROM roads", boConsole, adaMap)).toMatchObject({ code: "sql_rejected" });
  });
});

describe("a carried statement keeps its rows where it lands", () => {
  const initialDir = process.env.DEZFIL_DATA_DIR!;
  let directory: string;
  let scopes: Record<string, AccountScope>;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(initialDir, "handoff-"));
    vi.stubEnv("DEZFIL_DATA_DIR", directory);
    closeMetadataDb(); resetQueryInstance();
    scopes = Object.fromEntries(["ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
    for (const owner of ["ada", "bob"]) {
      const file = path.join(directory, `${owner}.csv`);
      await writeFile(file, `sentinel,lon,lat\n${owner},1,2\n`);
      await ingestFile(scopes[owner], file, "roads.csv");
    }
  });
  afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  it("draws Bob's roads and Ada's shared roads in Ada's map exactly as Bob's console did, never Ada's twice", async () => {
    const adaRoads = listOwnedTables(scopes.ada)[0];
    shareProject("ada", "P", [["bob", "editor"]], [adaRoads.id]);
    const map = createMap(scopes.ada, "Ada's map", "P");
    const console = contextOf(scopes.bob);
    const inMap = mapEvaluation(scopes.bob, map.id);
    const sql = "SELECT sentinel FROM roads UNION ALL SELECT sentinel FROM ada.roads ORDER BY 1 DESC";
    const rows = async (scope: Parameters<typeof executeQuery>[0], text: string) =>
      (await executeQuery(scope, text)).preview.map((row) => row.sentinel);
    expect(await rows(console, sql)).toEqual(["bob", "ada"]);
    // Uncarried, the same text silently rebinds in Ada's home.
    expect(await rows(inMap, sql)).toEqual(["ada", "ada"]);
    const conn = await connectQueryInstance();
    let carried: string;
    try { carried = await carrySql(conn, sql, namespaceFor(console), namespaceFor(inMap)); } finally { conn.disconnectSync(); }
    expect(carried).toBe("SELECT sentinel FROM bob.roads UNION ALL SELECT sentinel FROM ada.roads ORDER BY 1 DESC");
    expect(await rows(inMap, carried)).toEqual(["bob", "ada"]);
  });

  it("keeps a column qualified by a moved table's implicit name bound to that table", async () => {
    const adaRoads = listOwnedTables(scopes.ada)[0];
    shareProject("ada", "P", [["bob", "editor"]], [adaRoads.id]);
    const map = createMap(scopes.ada, "Ada's map", "P");
    const console = contextOf(scopes.bob);
    const inMap = mapEvaluation(scopes.bob, map.id);
    const sql = "SELECT roads.sentinel AS mine, ada.roads.sentinel AS shared FROM roads, ada.roads";
    const pairs = async (scope: Parameters<typeof executeQuery>[0], text: string) => (await executeQuery(scope, text)).preview;
    expect(await pairs(console, sql)).toEqual([{ mine: "bob", shared: "ada" }]);
    const conn = await connectQueryInstance();
    let carried: string;
    try { carried = await carrySql(conn, sql, namespaceFor(console), namespaceFor(inMap)); } finally { conn.disconnectSync(); }
    expect(await pairs(inMap, carried)).toEqual([{ mine: "bob", shared: "ada" }]);
  });
});
