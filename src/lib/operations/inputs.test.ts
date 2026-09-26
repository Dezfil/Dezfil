import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { queryInputs } from "./inputs";

/**
 * The input set is the edge staleness rides on and cannot be repaired after
 * records are minted, so these cases are the ones a naive walk gets wrong
 * rather than the ones it gets right. Each names the broken walk it catches.
 */

let conn: DuckDBConnection;
const GEOMETRY: Record<string, string | null> = {
  stations: "geom",
  accidents: "geom",
  boroughs: "geom",
  counts: null,
};
const geometryOf = (t: string) => GEOMETRY[t] ?? null;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(":memory:", {});
  conn = await instance.connect();
  await conn.run("CREATE TABLE stations AS SELECT 1 AS id, 'a' AS nm");
  await conn.run("CREATE TABLE accidents AS SELECT 1 AS id, 2 AS station_id");
  await conn.run("CREATE TABLE boroughs AS SELECT 1 AS id");
  await conn.run("CREATE TABLE counts AS SELECT 1 AS n");
});
afterAll(() => conn?.disconnectSync());

const inputs = (sql: string) => queryInputs(conn, sql, geometryOf);

describe("what the query reads", () => {
  it("records both sides of a join", async () => {
    const r = await inputs(
      "SELECT a.id FROM accidents a JOIN stations s ON a.station_id = s.id",
    );
    expect(r.tables).toEqual(["accidents", "stations"]);
  });

  it("records a table read only inside a subquery or a CTE body", async () => {
    const r = await inputs(
      "WITH near AS (SELECT id FROM accidents) SELECT * FROM near",
    );
    expect(r.tables).toEqual(["accidents"]);
  });

  it("does not record a CTE alias as a table — even when it shadows a real one", async () => {
    // The trap: `stations` is a real table AND a CTE name here. Both serialize
    // as BASE_TABLE, so a walk that collects every base-table node records a
    // read of `stations` that never happened.
    const r = await inputs(
      "WITH stations AS (SELECT 1 AS id) SELECT * FROM stations",
    );
    expect(r.tables).toEqual([]);
  });

  it("records the real table when an earlier CTE reads it and a later one shadows it", async () => {
    const r = await inputs(
      `WITH src AS (SELECT id FROM stations),
            stations AS (SELECT 9 AS id)
       SELECT * FROM src JOIN stations USING (id)`,
    );
    // `src` read the real stations; the later CTE only shadows the name after.
    expect(r.tables).toEqual(["stations"]);
  });

  it("records nothing for a name that appears only in a string or a comment", async () => {
    const r = await inputs(
      "SELECT 'stations' AS label, id FROM accidents -- boroughs",
    );
    expect(r.tables).toEqual(["accidents"]);
  });

  it("records a table named by a string through the dynamic table function", async () => {
    // The trap: this genuinely reads `stations`, and no BASE_TABLE node names
    // it. A base-table walk records no input at all for this run.
    const r = await inputs("SELECT * FROM query_table('stations')");
    expect(r.tables).toEqual(["stations"]);
  });

  it("resolves a dynamic name built by a constant expression", async () => {
    const r = await inputs("SELECT * FROM query_table('stat' || 'ions')");
    expect(r.tables).toEqual(["stations"]);
  });

  it("walks into SQL carried as a string", async () => {
    const r = await inputs(
      "SELECT * FROM query('SELECT id FROM boroughs JOIN accidents USING (id)')",
    );
    expect(r.tables).toEqual(["accidents", "boroughs"]);
  });
});

describe("whose geometry the query references", () => {
  it("attributes a qualified geometry column to its own table", async () => {
    const r = await inputs(
      "SELECT s.geom FROM stations s JOIN counts c ON c.n = s.id",
    );
    expect(r.tables).toEqual(["counts", "stations"]);
    expect(r.geometryTables).toEqual(["stations"]);
  });

  it("does not attribute geometry to an input that has it but contributes only attributes", async () => {
    // The case the ruling exists for, and the one a weaker test misses:
    // `boroughs` HAS a geometry column, but this query reads only its id. It
    // supplied no coordinates, so it raises no warning about them. A walk
    // that inherits from every spatial input read would name it here.
    const r = await inputs(
      "SELECT s.geom, b.id FROM stations s JOIN boroughs b ON b.id = s.id",
    );
    expect(r.tables).toEqual(["boroughs", "stations"]);
    expect(r.geometryTables).toEqual(["stations"]);
  });

  it("does not attribute geometry to a non-spatial input", async () => {
    const r = await inputs(
      "SELECT s.geom, c.n FROM stations s JOIN counts c ON c.n = s.id",
    );
    expect(r.geometryTables).toEqual(["stations"]);
  });

  it("treats a star projection as carrying every input's geometry", async () => {
    const r = await inputs("SELECT * FROM stations");
    expect(r.geometryTables).toEqual(["stations"]);
  });

  it("names no geometry when none is referenced", async () => {
    const r = await inputs("SELECT count(*) AS n FROM stations s");
    expect(r.tables).toEqual(["stations"]);
    expect(r.geometryTables).toEqual([]);
  });

  it("never names a table that has no geometry of its own", async () => {
    const r = await inputs("SELECT * FROM counts");
    expect(r.tables).toEqual(["counts"]);
    expect(r.geometryTables).toEqual([]);
  });
});

describe("the edge cases the cross-model review found", () => {
  it("does not record a recursive CTE's self-reference as a real table", async () => {
    // `stations` is both a registered table and this CTE's own name. The
    // recursive branch refers to itself, so recording a read of the real
    // table would be provenance the run never earned.
    const r = await inputs(
      `WITH RECURSIVE stations AS (
         SELECT 1 AS id
         UNION ALL
         SELECT id + 1 FROM stations WHERE id < 3
       ) SELECT * FROM stations`,
    );
    expect(r.tables).toEqual([]);
  });

  it("still records a non-recursive CTE reading the real table it shadows", async () => {
    // The counterpart the recursive fix must not break.
    const r = await inputs(
      "WITH stations AS (SELECT id FROM stations) SELECT * FROM stations",
    );
    expect(r.tables).toEqual(["stations"]);
  });

  it("records every table in a list-valued dynamic call", async () => {
    const r = await inputs("SELECT * FROM query_table(['stations', 'boroughs'])");
    expect(r.tables).toEqual(["boroughs", "stations"]);
  });
});

describe("aliases on dynamic inputs", () => {
  it("resolves a qualified geometry reference through a dynamic table's alias", async () => {
    // Without the alias the qualified reference resolves to nothing and the
    // input's geometry goes unattributed — which would silently clear an
    // assumed-CRS warning rather than raise one.
    const r = await inputs("SELECT q.geom FROM query_table('stations') AS q");
    expect(r.tables).toEqual(["stations"]);
    expect(r.geometryTables).toEqual(["stations"]);
  });
});
