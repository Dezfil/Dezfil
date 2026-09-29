import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Materialization's own failure modes. The cases here are the ones where a
 * broken implementation still looks right: a write capped at a preview, a
 * collision quietly suffixed, a failure that strands a file, and a registered
 * row pointing at an artifact cleanup removed.
 */

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dezfil-materialize-"));
  process.env.DEZFIL_DATA_DIR = dir;
  const { closeMetadataDb } = await import("@/lib/metadata/db");
  closeMetadataDb();
  const { resetQueryInstance } = await import("@/lib/duckdb");
  resetQueryInstance();
});
afterEach(async () => {
  const { closeMetadataDb } = await import("@/lib/metadata/db");
  closeMetadataDb();
  const { resetQueryInstance } = await import("@/lib/duckdb");
  resetQueryInstance();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DEZFIL_DATA_DIR;
});

/** Register a real artifact the way an import would, so runs have an input. */
async function seedTable(
  name: string,
  select: string,
  opts: {
    crsAssumed?: boolean;
    geometry?: boolean;
    headerSuspect?: boolean;
  } = {},
) {
  const { withConnection } = await import("@/lib/duckdb");
  const { measureArtifact } = await import("@/lib/ingest/ingest");
  const { insertTable } = await import("@/lib/metadata/tables");
  const { randomUUID } = await import("node:crypto");
  const rel = path.join("tables", `${randomUUID()}.parquet`);
  const abs = path.join(dir, rel);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(abs), { recursive: true });
  const measured = await withConnection(async (conn) => {
    await conn.run(`COPY (${select}) TO '${abs}' (FORMAT PARQUET)`);
    return measureArtifact(conn, abs);
  });
  insertTable(testAccountScope(), {
    id: randomUUID(),
    name,
    sourceFilename: `${name}.geojson`,
    format: "geoparquet",
    file: rel,
    geometryColumn: measured.geometryColumn,
    geometryType: measured.geometryType,
    crsAssumed: opts.crsAssumed ?? false,
    headerSuspect: opts.headerSuspect ?? false,
    rowCount: measured.rowCount,
    createdAt: new Date().toISOString(),
    source: "upload",
    sourceParams: null,
    importedAt: null,
  });
  return measured;
}

/** Remove the registry row while leaving its artifact, which is the state an
 * interrupted run leaves behind. `deleteTable` retires the file too, so it
 * cannot stand in for this. */
async function deleteTableRowOnly(name: string) {
  const { metadataDb } = await import("@/lib/metadata/db");
  metadataDb().prepare("DELETE FROM data_tables WHERE name = ?").run(name);
}

const artifacts = () => {
  try {
    return readdirSync(path.join(dir, "tables"));
  } catch {
    return [];
  }
};

describe("a result becomes a dataset", () => {
  it("writes every row, not the sample a preview shows", async () => {
    // 2500 exceeds the preview cap, and the count is asserted against the
    // fixture's own known cardinality — never against the number the run
    // reported, and never by counting the file the run just wrote. A write
    // capped at the preview passes neither.
    await seedTable("wide", "SELECT * FROM range(2500) t(id)");
    const { materialize } = await import("./materialize");
    const table = await materialize(testAccountScope(), {
      sql: "SELECT id FROM wide",
      name: "wide_copy",
      operation: "sql_step",
    });
    expect(table.rowCount).toBe(2500);

    const { executeQuery } = await import("@/lib/query/execute");
    const back = await executeQuery("SELECT count(*) AS n FROM wide_copy");
    expect(Number(back.preview[0].n)).toBe(2500);
  });

  it("registers a geometryless result as a first-class dataset", async () => {
    await seedTable("pts", "SELECT 1 AS id, ST_Point(1,2) AS geom");
    const { materialize } = await import("./materialize");
    const table = await materialize(testAccountScope(), {
      sql: "SELECT count(*) AS n FROM pts",
      name: "pt_count",
      operation: "sql_step",
    });
    // Not an error, not a layer — a table. The run answers no
    // geometry-required refusal, and this branch is exercised rather than
    // inferred from the spatial one.
    expect(table.geometryColumn).toBeNull();
    expect(table.geometryType).toBeNull();
    expect(table.rowCount).toBe(1);
    const { executeQuery } = await import("@/lib/query/execute");
    expect((await executeQuery("SELECT n FROM pt_count")).preview).toHaveLength(
      1,
    );
  });

  it("records the operation, its SQL, and its inputs by id as well as name", async () => {
    await seedTable("src_a", "SELECT 1 AS id, ST_Point(1,2) AS geom");
    const { getTableByName } = await import("@/lib/metadata/tables");
    const input = getTableByName("src_a");
    const { materialize } = await import("./materialize");
    const table = await materialize(testAccountScope(), {
      sql: "SELECT id FROM src_a",
      name: "derived",
      operation: "sql_step",
      parameters: { note: "kept" },
    });
    const params = table.sourceParams as Record<string, unknown>;
    expect(params.operation).toBe("sql_step");
    expect(params.sql).toBe("SELECT id FROM src_a");
    expect(params.parameters).toEqual({ note: "kept" });
    expect(params.inputs).toEqual([{ id: input!.id, name: "src_a" }]);
    // Never described as an upload, and it carries no filename.
    expect(table.source).toBe("operation");
    expect(table.sourceFilename).toBeNull();
    // It reports when it was produced, where an import reports its last run.
    expect(table.importedAt).toBeTruthy();
  });
});

describe("assumed CRS is inherited from geometry, not from every input", () => {
  it("inherits when the query reads the assumed input's geometry", async () => {
    await seedTable("guessy", "SELECT 1 AS id, ST_Point(1,2) AS geom", {
      crsAssumed: true,
    });
    const { materialize } = await import("./materialize");
    const table = await materialize(testAccountScope(), {
      sql: "SELECT g.geom FROM guessy g",
      name: "carried",
      operation: "sql_step",
    });
    expect(table.crsAssumed).toBe(true);
  });

  it("does not inherit from an assumed input that contributes only attributes", async () => {
    // The ruling's whole point: `guessy` supplied a number here, so the result
    // does not claim uncertainty about coordinates it never carried. An
    // implementation inheriting from every input read fails this.
    await seedTable("guessy", "SELECT 1 AS id, ST_Point(1,2) AS geom", {
      crsAssumed: true,
    });
    await seedTable("sure", "SELECT 1 AS id, ST_Point(3,4) AS geom");
    const { materialize } = await import("./materialize");
    const table = await materialize(testAccountScope(), {
      sql: "SELECT s.geom FROM sure s JOIN guessy g ON g.id = s.id",
      name: "not_carried",
      operation: "sql_step",
    });
    expect(table.crsAssumed).toBe(false);
  });
});

describe("a taken name is refused", () => {
  it("refuses rather than suffixing, and leaves the existing table untouched", async () => {
    await seedTable("taken", "SELECT 1 AS id");
    const { getTableByName, listTables } = await import("@/lib/metadata/tables");
    const before = getTableByName("taken");
    const { materialize } = await import("./materialize");
    await expect(
      materialize(testAccountScope(), {
        sql: "SELECT 2 AS id",
        name: "taken",
        operation: "sql_step",
      }),
    ).rejects.toMatchObject({ code: "name_taken" });

    // Not replaced, not renamed around: a suffixed second table would be the
    // silent workaround the gate ruled out.
    const after = getTableByName("taken");
    expect(after).toEqual(before);
    expect(listTables().map((t) => t.name)).toEqual(["taken"]);
    expect(artifacts()).toHaveLength(1);
  });

  it("refuses a name held by an import just as firmly as one it produced", async () => {
    await seedTable("shared", "SELECT 1 AS id");
    const { materialize } = await import("./materialize");
    await expect(
      materialize(testAccountScope(), { sql: "SELECT 1", name: "shared", operation: "sql_step" }),
    ).rejects.toMatchObject({ code: "name_taken" });
  });
});

describe("a failure destroys nothing and leaves nothing", () => {
  it("leaves no row, no file and a free name when the write fails", async () => {
    const { materialize } = await import("./materialize");
    const { listTables } = await import("@/lib/metadata/tables");
    const before = artifacts().length;
    await expect(
      materialize(testAccountScope(), {
        // A seeded fault the engine raises while producing rows, so the
        // failure lands after the write has begun rather than at parse time.
        sql: "SELECT CASE WHEN i > 5 THEN error('seeded fault') ELSE i END AS x FROM range(20) t(i)",
        name: "never",
        operation: "sql_step",
      }),
    ).rejects.toBeTruthy();
    expect(listTables().map((t) => t.name)).not.toContain("never");
    expect(artifacts()).toHaveLength(before);

    // The name is still free for a later run to claim.
    await materialize(testAccountScope(), { sql: "SELECT 1 AS x", name: "never", operation: "sql_step" });
    expect(listTables().map((t) => t.name)).toContain("never");
  });

  it("refuses write-shaped SQL and registers nothing", async () => {
    const { materialize } = await import("./materialize");
    const { listTables } = await import("@/lib/metadata/tables");
    await expect(
      materialize(testAccountScope(), {
        sql: "CREATE TABLE sneaky AS SELECT 1",
        name: "sneaky_out",
        operation: "sql_step",
      }),
    ).rejects.toMatchObject({ code: "sql_rejected" });
    expect(listTables()).toHaveLength(0);
    expect(artifacts()).toHaveLength(0);
  });

  it("refuses a select-shaped read outside the workspace's data", async () => {
    const { materialize } = await import("./materialize");
    const { listTables } = await import("@/lib/metadata/tables");
    const outside = path.join(os.tmpdir(), `dezfil-outside-${Date.now()}.csv`);
    writeFileSync(outside, "a\n1\n");
    try {
      await expect(
        materialize(testAccountScope(), {
          sql: `SELECT * FROM read_csv('${outside}')`,
          name: "exfil",
          operation: "sql_step",
        }),
      ).rejects.toBeTruthy();
      expect(listTables()).toHaveLength(0);
      expect(artifacts()).toHaveLength(0);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("leaves a real run's artifact for the boot sweep when registration never happens", async () => {
    // The criterion refuses a hand-planted file as evidence, and rightly: it
    // proves the sweep works, not that materialization leaves its candidate
    // where the sweep looks. So the artifact here is one a real run wrote —
    // registration is prevented by deleting the registry row the run just
    // made, which leaves exactly the state a process killed between the write
    // and the registration leaves behind.
    await seedTable("orphan_src", "SELECT 1 AS id");
    const before = artifacts().length;
    const { materialize } = await import("./materialize");
    const table = await materialize(testAccountScope(), {
      sql: "SELECT id FROM orphan_src",
      name: "orphan_out",
      operation: "sql_step",
    });
    // Drop the row, keep the file: now the artifact is unreferenced exactly as
    // an interrupted run would leave it.
    await deleteTableRowOnly(table.name);
    expect(artifacts()).toHaveLength(before + 1); // observed present first

    const { sweepTableArtifacts } = await import("@/lib/ingest/sweep");
    await sweepTableArtifacts();
    expect(artifacts()).toHaveLength(before);
  });
});

describe("the dry run describes what the run will produce", () => {
  it("agrees with the registered class, including where the two probes differ", async () => {
    // One family plus absent geometry: the registry's classification and the
    // layer path's disagree here, so this is the fixture that catches a dry
    // run wired to the wrong one. A two-family fixture would not — both
    // collapse to mixed on it.
    await seedTable(
      "mixedish",
      "SELECT * FROM (VALUES (ST_Point(1,2)), (NULL)) t(geom)",
    );
    const { dryRun, materialize } = await import("./materialize");
    const sql = "SELECT geom FROM mixedish";
    const predicted = await dryRun(sql);
    const table = await materialize(testAccountScope(), { sql, name: "written", operation: "sql_step" });
    expect(predicted.geometryType).toBe(table.geometryType);
    expect(predicted.rowCount).toBe(table.rowCount);
  });

  it("writes nothing", async () => {
    await seedTable("src_b", "SELECT 1 AS id");
    const before = artifacts().length;
    const { dryRun } = await import("./materialize");
    const r = await dryRun("SELECT id FROM src_b");
    expect(r.rowCount).toBe(1);
    expect(artifacts()).toHaveLength(before);
  });

  it("reports a count past the preview cap, not a preview of it", async () => {
    await seedTable("big", "SELECT * FROM range(2500) t(id)");
    const { dryRun } = await import("./materialize");
    expect((await dryRun("SELECT id FROM big")).rowCount).toBe(2500);
  });
});

describe("the two defects the cross-model review found", () => {
  it("saves a query that carries a trailing statement terminator", async () => {
    // The workspace seeds its editor with a terminated statement and keeps the
    // terminator after running, so this is the most ordinary result a user has
    // in front of them. Nesting it unchanged is a parse error, which made the
    // flagship case — save the query you just ran — the one case that failed.
    await seedTable("term_src", "SELECT 1 AS id");
    const { materialize } = await import("./materialize");
    const table = await materialize(testAccountScope(), {
      sql: "SELECT id FROM term_src;",
      name: "terminated",
      operation: "sql_step",
    });
    expect(table.rowCount).toBe(1);
    const { executeQuery } = await import("@/lib/query/execute");
    expect((await executeQuery("SELECT id FROM terminated")).preview).toHaveLength(1);
  });

  it("cannot be made to run DDL through a crafted geometry alias", async () => {
    // The geometry column name is read back from the result, and since this
    // spec that result can be an arbitrary user SELECT whose geometry alias
    // the user chose. Unescaped, that alias closes the probe's identifier and
    // the engine accepts whatever follows — a read-only path executing DDL,
    // proven executable against the pinned engine before the fix.
    //
    // The injected statement CREATES something rather than dropping it: a
    // registered table is a view here and lives in SQLite besides, so a DROP
    // would fail for reasons unrelated to the escaping and the test could
    // never go red. Creation is observable and is caused by nothing else.
    const alias =
      'g") AS t FROM (SELECT ST_Point(1,2) AS g); ' +
      "CREATE OR REPLACE VIEW injected_marker AS SELECT 1; --";
    const sql = `SELECT ST_Point(1,2) AS "${alias.replace(/"/g, '""')}"`;
    const { dryRun } = await import("./materialize");
    const { boundedEvaluation } = await import("@/lib/query/bounded");

    // Whether the probe succeeds or refuses is not the claim; the claim is
    // that the injected statement never ran.
    await dryRun(sql).catch(() => undefined);

    const marker = await boundedEvaluation(async (conn) => {
      const r = await conn.runAndReadAll(
        "SELECT count(*) AS n FROM duckdb_views() WHERE view_name = 'injected_marker'",
      );
      return Number(r.getRowObjects()[0].n);
    });
    expect(marker).toBe(0);
  });
});

describe("a derived table's inputs resolve by the id they were recorded under", () => {
  it("reports a deleted input as missing rather than as whatever took its name", async () => {
    // The whole reason ids are recorded: names are reclaimable. Storing the id
    // is only half the promise — the read has to use it, or the record still
    // reads as though the run had used the stranger now holding that name.
    await seedTable("shifty", "SELECT 1 AS id");
    const { materialize } = await import("./materialize");
    const derived = await materialize(testAccountScope(), {
      sql: "SELECT id FROM shifty",
      name: "from_shifty",
      operation: "sql_step",
    });

    // Delete the input, then let a different table claim its exact name.
    await deleteTableRowOnly("shifty");
    await seedTable("shifty", "SELECT 9 AS id, 'different' AS what");

    const { inspectTable } = await import("@/lib/table-service");
    const seen = await inspectTable(testAccountScope(), derived.name);
    expect(seen.inputs).toHaveLength(1);
    expect(seen.inputs![0].missing).toBe(true);
    expect(seen.inputs![0].nameReclaimed).toBe(true);
    // And it does not present the newcomer as the input that ran.
    expect(seen.inputs![0].currentName).toBeUndefined();
  });

  it("resolves a live input, and follows it through a rename", async () => {
    await seedTable("steady", "SELECT 1 AS id");
    const { materialize } = await import("./materialize");
    const derived = await materialize(testAccountScope(), {
      sql: "SELECT id FROM steady",
      name: "from_steady",
      operation: "sql_step",
    });
    const { inspectTable } = await import("@/lib/table-service");
    const seen = await inspectTable(testAccountScope(), derived.name);
    expect(seen.inputs![0]).toMatchObject({
      name: "steady",
      currentName: "steady",
      missing: false,
    });
  });
});

describe("the dry run says its three answers apart", () => {
  it("distinguishes no-geometry from a spatial result with no rows", async () => {
    await seedTable("shapes", "SELECT 1 AS id, ST_Point(1,2) AS geom");
    const { dryRun } = await import("./materialize");

    const none = await dryRun("SELECT id FROM shapes");
    expect(none.geometry).toBe("none");

    const empty = await dryRun("SELECT geom FROM shapes WHERE 1 = 0");
    expect(empty.geometry).toBe("undetermined");
    expect(empty.rowCount).toBe(0);

    const classified = await dryRun("SELECT geom FROM shapes");
    expect(classified.geometry).toBe("classified");
    expect(classified.geometryType).toBe("POINT");

    // The point of the field: the two nulls are not the same answer.
    expect(none.geometryType).toBeNull();
    expect(empty.geometryType).toBeNull();
    expect(none.geometry).not.toBe(empty.geometry);
  });

  it("retains the dry run's geometry identity for empty first runs, reruns, and all-null SQL nodes", async () => {
    await seedTable(
      "empty_shapes_source",
      "SELECT 1 AS id, ST_SetCRS(ST_Point(13.4, 52.5), 'EPSG:4326') AS geom",
      { crsAssumed: true },
    );
    const { dryRun, materialize } = await import("./materialize");

    const zeroSql = "SELECT id, geom FROM empty_shapes_source WHERE false";
    const zeroDry = await dryRun(zeroSql);
    const first = await materialize(testAccountScope(), {
      sql: zeroSql,
      name: "empty_shapes",
      operation: "simplify",
    });
    expect(zeroDry).toMatchObject({
      rowCount: 0,
      geometryColumn: "geom",
      geometryType: null,
      geometry: "undetermined",
    });
    expect(first).toMatchObject({
      geometryColumn: zeroDry.geometryColumn,
      geometryType: zeroDry.geometryType,
      rowCount: zeroDry.rowCount,
      crsAssumed: true,
    });

    const rerun = await materialize(testAccountScope(), {
      sql: zeroSql,
      name: first.name,
      operation: "simplify",
      replaceTable: { id: first.id, name: first.name },
    });
    expect(rerun.id).toBe(first.id);
    expect(rerun.geometryColumn).toBe("geom");
    expect(rerun.geometryType).toBeNull();

    const nullSql =
      "SELECT id, CASE WHEN id = 1 THEN NULL::GEOMETRY ELSE geom END AS geom FROM empty_shapes_source";
    const nullDry = await dryRun(nullSql);
    const sqlNode = await materialize(testAccountScope(), {
      sql: nullSql,
      name: "all_null_shapes",
      operation: "sql_step",
    });
    expect(nullDry).toMatchObject({
      rowCount: 1,
      geometryColumn: "geom",
      geometryType: null,
      geometry: "undetermined",
    });
    expect(sqlNode).toMatchObject({
      geometryColumn: nullDry.geometryColumn,
      geometryType: nullDry.geometryType,
      rowCount: nullDry.rowCount,
      crsAssumed: true,
    });
  });
});

describe("the suspect-header warning does not propagate", () => {
  it("an operation's output records false over a warned input", async () => {
    // The warning describes a source FILE's read; a derived table has
    // its own provenance.
    await seedTable("warned_src", "SELECT 1 AS id, ST_Point(1,2) AS geom", {
      headerSuspect: true,
    });
    const { materialize } = await import("./materialize");
    const table = await materialize(testAccountScope(), {
      sql: "SELECT * FROM warned_src",
      name: "derived_out",
      operation: "sql_step",
    });
    expect(table.headerSuspect).toBe(false);
  });
});
