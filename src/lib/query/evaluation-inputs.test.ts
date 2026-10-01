import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { createMap } from "@/lib/map-service";
import type { AccountScope } from "@/lib/auth/scope";
import type { DataTable } from "@/lib/metadata/tables";
import { boundedEvaluation } from "./bounded";
import { mapEvaluation } from "./context";
import { namedSql } from "./named-sql";
import { collectInputs, recordedInputs, type ArtifactInputs } from "./evaluation-inputs";

/**
 * What an evaluation records it drew. Ada and Bob each own a `roads`; Ada also
 * owns `parks`; Bob files his `roads` in his project P, where Ada is a viewer.
 * The evidence is the identities the evaluation itself bound, by owner, never
 * the names: Ada's plain `roads` is hers, `bob.roads` is Bob's, and a CTE that
 * shadows a name reads nothing. An evaluation that reads the engine's
 * catalogue records everything it had mounted.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "evaluation-inputs-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["ada", "parks"], ["bob", "roads"]] as const) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("bob", "P", [["ada", "viewer"]], [tables["bob.roads"].id]);
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

/** The evidence one evaluation of this SQL records, in the scope's context. */
async function drawn(scope: Parameters<typeof boundedEvaluation>[1]["scope"], sql: string): Promise<ArtifactInputs> {
  return boundedEvaluation(async (conn) => {
    await conn.runAndReadAll(await namedSql(conn, sql));
    return recordedInputs(conn);
  }, { scope });
}
const ids = (inputs: ArtifactInputs) => inputs.datasets.map((input) => input.id).sort();
const of = (...names: string[]) => names.map((name) => tables[name].id).sort();

describe("the inputs an evaluation records", () => {
  it("names each bound dataset by identity, by owner, with the artifact it read", async () => {
    const plain = await drawn(scopes.ada, "SELECT * FROM roads");
    expect(plain).toEqual({ catalogue: false, datasets: [{ id: tables["ada.roads"].id, file: tables["ada.roads"].file }] });
    expect(ids(await drawn(scopes.ada, "SELECT * FROM bob.roads"))).toEqual(of("bob.roads"));
    expect(ids(await drawn(scopes.ada, "SELECT a.sentinel FROM roads a JOIN bob.roads b ON true"))).toEqual(of("ada.roads", "bob.roads"));
    expect(ids(await drawn(scopes.bob, "SELECT * FROM roads"))).toEqual(of("bob.roads"));
  });

  it("follows dynamic and nested references and leaves out what a CTE shadows", async () => {
    expect(ids(await drawn(scopes.ada, "SELECT * FROM query_table('bob.roads')"))).toEqual(of("bob.roads"));
    expect(ids(await drawn(scopes.ada, "SELECT * FROM query('SELECT * FROM parks')"))).toEqual(of("ada.parks"));
    expect(ids(await drawn(scopes.ada, "WITH roads AS (SELECT 1 AS x) SELECT * FROM roads"))).toEqual([]);
    expect(ids(await drawn(scopes.ada, "WITH r AS (SELECT * FROM parks) SELECT * FROM r"))).toEqual(of("ada.parks"));
  });

  it("binds a map's plain names in its home for whoever evaluates it", async () => {
    const map = createMap(scopes.bob, "Bob's map", "P");
    // Ada reads Bob's map: its plain `roads` is Bob's, never her own.
    expect(ids(await drawn(mapEvaluation(scopes.ada, map.id), "SELECT * FROM roads"))).toEqual(of("bob.roads"));
  });

  it.each([
    ["a catalogue function", "SELECT r.sentinel FROM roads r WHERE EXISTS (SELECT table_name FROM duckdb_tables())"],
    ["the information schema", "SELECT r.sentinel FROM roads r WHERE EXISTS (SELECT table_name FROM information_schema.tables)"],
    ["a listing of relations", "SHOW TABLES"],
  ])("records the evaluation's whole reach when it reads %s", async (_, sql) => {
    const inputs = await drawn(scopes.ada, sql);
    expect(inputs.catalogue).toBe(true);
    expect(ids(inputs)).toEqual(of("ada.roads", "ada.parks", "bob.roads"));
  });

  it("collects every evaluation that settles under one artifact, failed ones included", async () => {
    const { inputs } = await collectInputs(async () => {
      await drawn(scopes.ada, "SELECT * FROM roads");
      await drawn(scopes.ada, "SELECT * FROM bob.roads").catch(() => undefined);
      await boundedEvaluation(async (conn) => {
        await namedSql(conn, "SELECT * FROM parks");
        throw new Error("the evaluation failed after binding");
      }, { scope: scopes.ada }).catch(() => undefined);
    });
    expect(inputs.catalogue).toBe(false);
    expect(ids(inputs)).toEqual(of("ada.roads", "ada.parks", "bob.roads"));
    // An evaluation inside a nested collection is evidence for both.
    const outer = await collectInputs(async () => {
      await collectInputs(() => drawn(scopes.ada, "SELECT * FROM parks"));
    });
    expect(ids(outer.inputs)).toEqual(of("ada.parks"));
  });
});
