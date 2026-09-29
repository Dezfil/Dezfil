import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance, connectQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import {
  getTableByName,
  insertTable,
  updateTableData,
} from "@/lib/metadata/tables";
import { dataDir } from "@/lib/config";
import { registerTableViews } from "./views";

/**
 * One broken table registration must not poison the workspace: every other
 * table keeps querying, and only the broken table fails — at query time,
 * with its own error (a incident: an orphaned registry row whose
 * parquet artifact was gone made every query in the instance fail).
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  for (const name of ["alpha", "beta"]) {
    const src = path.join(dir, `${name}.csv`);
    await writeFile(src, "name,lon,lat\na,13.4,52.5\nb,13.3,52.4\n");
    await ingestFile(testAccountScope(), src, `${name}.csv`);
  }
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function run(sql: string): Promise<Record<string, unknown>[]> {
  const conn = await connectQueryInstance();
  try {
    await registerTableViews(testAccountScope(), conn);
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    conn.disconnectSync();
  }
}

async function seedUntypedArtifact(options: {
  name: string;
  select: string;
  geometryColumn: string | null;
}) {
  const rel = path.join("tables", `${options.name}.parquet`);
  const abs = path.join(dataDir(), rel);
  await mkdir(path.dirname(abs), { recursive: true });
  const conn = await connectQueryInstance();
  try {
    await conn.run(
      `COPY (${options.select}) TO '${abs.replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );
  } finally {
    conn.disconnectSync();
  }
  insertTable(testAccountScope(), {
    id: `${options.name}-id`,
    name: options.name,
    sourceFilename: null,
    format: "geoparquet",
    file: rel,
    geometryColumn: options.geometryColumn,
    geometryType: null,
    crsAssumed: false,
    headerSuspect: false,
    rowCount: options.select.includes("range(2)") ? 2 : 0,
    createdAt: new Date().toISOString(),
    source: "operation",
    sourceParams: null,
    importedAt: null,
  });
  return getTableByName(options.name)!;
}

describe("registered relations for retained empty geometry", () => {
  it("types zero-row and all-null WKB artifacts under the canonical label", async () => {
    await seedUntypedArtifact({
      name: "zero_geom",
      select: "SELECT 1 AS id, ST_AsWKB(NULL::GEOMETRY) AS geom WHERE false",
      geometryColumn: "geom",
    });
    await seedUntypedArtifact({
      name: "null_geom",
      select:
        "SELECT i AS id, ST_AsWKB(NULL::GEOMETRY) AS geom FROM range(2) t(i)",
      geometryColumn: "geom",
    });

    for (const name of ["zero_geom", "null_geom"]) {
      const described = await run(
        `SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM ${name}) WHERE column_name = 'geom'`,
      );
      expect(String(described[0].column_type)).toContain("GEOMETRY");
      expect(String(described[0].column_type)).toContain("EPSG:4326");
      expect(
        await run(`SELECT ST_AsText(geom) AS wkt FROM ${name}`),
      ).toHaveLength(name === "zero_geom" ? 0 : 2);
    }
    expect(
      await run(
        "SELECT * FROM zero_geom z, alpha a WHERE ST_Intersects(z.geom, a.geometry)",
      ),
    ).toHaveLength(0);
    const nulls = await run("SELECT ST_AsText(geom) AS wkt FROM null_geom");
    expect(nulls.map((row) => row.wkt)).toEqual([null, null]);
  });

  it("does not make a table unqueryable when the recorded column is absent or its bytes are not WKB", async () => {
    await seedUntypedArtifact({
      name: "missing_geom",
      select: "SELECT 7 AS id",
      geometryColumn: "nope",
    });
    await seedUntypedArtifact({
      name: "invalid_geom",
      select: "SELECT 8 AS id, 'junk'::BLOB AS geom",
      geometryColumn: "geom",
    });
    expect(await run("SELECT id FROM missing_geom")).toEqual([{ id: 7 }]);
    expect(await run("SELECT id, geom FROM invalid_geom")).toHaveLength(1);
  });

  it("falls back before registration when non-null artifact bytes contradict a retained-empty record", async () => {
    await seedUntypedArtifact({
      name: "contradictory_geom",
      select:
        "SELECT i AS id, CASE WHEN i < 150 THEN ST_AsWKB(ST_Point(i, i)) ELSE 'junk'::BLOB END AS geom FROM range(151) t(i)",
      geometryColumn: "geom",
    });

    await expect(
      run("SELECT id, geom FROM contradictory_geom ORDER BY id"),
    ).resolves.toHaveLength(151);
    const described = await run(
      "SELECT column_type FROM (DESCRIBE SELECT * FROM contradictory_geom) WHERE column_name = 'geom'",
    );
    expect(described[0].column_type).toBe("BLOB");
  });

  it("rebinds when retained geometry identity changes without an artifact swap", async () => {
    const table = await seedUntypedArtifact({
      name: "late_geom",
      select: "SELECT 1 AS id, ST_AsWKB(NULL::GEOMETRY) AS geom WHERE false",
      geometryColumn: null,
    });
    expect(
      String(
        (await run("SELECT column_type FROM (DESCRIBE SELECT * FROM late_geom) WHERE column_name = 'geom'"))[0]
          .column_type,
      ),
    ).toBe("BLOB");
    expect(
      updateTableData(
        { name: table.name, id: table.id },
        {
          file: table.file,
          geometryColumn: "geom",
          geometryType: null,
          crsAssumed: false,
          headerSuspect: false,
          rowCount: 0,
          importedAt: new Date().toISOString(),
        },
      ),
    ).toBe(true);
    const rebound = await run(
      "SELECT column_type FROM (DESCRIBE SELECT * FROM late_geom) WHERE column_name = 'geom'",
    );
    expect(String(rebound[0].column_type)).toContain("GEOMETRY");
  });
});

describe("registerTableViews with a broken registration", () => {
  it("intact tables keep querying; only the broken one fails, at query time", async () => {
    // Both registered and queryable first.
    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");
    expect((await run("SELECT count(*) AS n FROM beta"))[0].n).toBe("2");

    // Orphan beta: registry row stays, artifact disappears.
    const beta = getTableByName("beta");
    await rm(path.join(dataDir(), beta!.file), { force: true });
    resetQueryInstance(); // fresh catalog, so beta's old view is gone too

    // The workspace still works…
    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");
    // …and only the broken table errors, when it is actually queried.
    await expect(run("SELECT count(*) AS n FROM beta")).rejects.toThrow(/beta/i);
  });
});

describe("registerTableViews under abandonment", () => {
  it("an abandoned pass leaves other connections independently queryable", async () => {
    // Views exist from a normal pass.
    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");

    // A pass whose boundary abandoned it exits cleanly without touching
    // its local catalog, even though its statements would fail if interrupted.
    const conn = await connectQueryInstance();
    try {
      await registerTableViews(testAccountScope(), conn, () => true);
    } finally {
      conn.disconnectSync();
    }

    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");
    expect((await run("SELECT count(*) AS n FROM beta"))[0].n).toBe("2");
  });

  it("a pass abandoned partway keeps its completed work; the next pass finishes the rest", async () => {
    // A full pass first, so the reconciliation loop has nothing to drop
    // and the abandonment probe below is consumed by the create loop only.
    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");

    // Fresh catalog: both tables need registering again.
    resetQueryInstance();
    const conn = await connectQueryInstance();
    let probes = 0;
    const registered: string[] = [];
    try {
      // **Two probes per table since the CRS normalisation landed**: one at
      // the top of the loop, and one after the schema read that decides which
      // geometry columns to relabel — an interrupted probe must not be taken
      // for "nothing to normalise". So the pass abandons on the third probe:
      // the first table registers fully, the second has not started.
      await registerTableViews(testAccountScope(), conn, () => ++probes > 2);

      // Exactly one table completed before the abandonment and answers on
      // this catalog; the other is genuinely absent rather than half-made.
      // (Which is which is the registry's ordering, not the test's.)
      for (const name of ["alpha", "beta"]) {
        try {
          const r = await conn.runAndReadAll(
            `SELECT count(*) AS n FROM ${name}`,
          );
          expect(r.getRowObjectsJson()[0].n).toBe("2");
          registered.push(name);
        } catch {
          // The unfinished one.
        }
      }
      expect(registered).toHaveLength(1);
    } finally {
      conn.disconnectSync();
    }

    // The unfinished table is picked up by the next evaluation's pass.
    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");
    expect((await run("SELECT count(*) AS n FROM beta"))[0].n).toBe("2");
  });
});

describe("a bound table whose registry row swaps to a broken artifact", () => {
  it("stops answering rather than serving the retired artifact, and a repaired row heals on a later pass", async () => {
    // beta is bound and answering.
    expect((await run("SELECT count(*) AS n FROM beta"))[0].n).toBe("2");

    // Its row now points at an artifact that does not exist — the shape of
    // a refresh whose new file is broken. The registration for exactly
    // this table must fail; the old view must not keep answering from the
    // outgoing artifact; and the failure must not be remembered as done.
    const beta = getTableByName("beta")!;
    const swap = (file: string) =>
      updateTableData(
        { name: beta.name, id: beta.id },
        {
          file,
          geometryColumn: beta.geometryColumn,
          geometryType: beta.geometryType,
          crsAssumed: beta.crsAssumed,
          headerSuspect: false,
          rowCount: beta.rowCount,
          importedAt: new Date().toISOString(),
        },
      );
    expect(swap(path.join("tables", "does-not-exist.parquet"))).toBe(true);

    // Only beta fails, at query time, with its own error…
    await expect(run("SELECT count(*) AS n FROM beta")).rejects.toThrow(/beta/i);
    // …and the rest of the workspace is untouched.
    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");

    // The row repaired, a later pass retries and beta answers again —
    // the failure was not remembered as success.
    expect(swap(beta.file)).toBe(true);
    expect((await run("SELECT count(*) AS n FROM beta"))[0].n).toBe("2");
  });
});

describe("catalog lifetime", () => {
  it("a discarded catalog is rebuilt on the next evaluation", async () => {
    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");

    // The peaceful case: reset, then evaluate. Whatever the process
    // remembers about the old catalog must not stop the new, empty one
    // from being fully registered.
    resetQueryInstance();
    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");
    expect((await run("SELECT count(*) AS n FROM beta"))[0].n).toBe("2");
  });

  it("a restarted process rebuilds a non-empty registry before user SQL (second process, real restart)", async () => {
    // The registry this test's beforeEach populated persists on disk; a
    // genuinely fresh process — not a reset, a new OS process with no
    // binding memory — must register it before answering. The child is
    // the env-gated spec in views-restart.child.test.ts, run by the
    // repo's own vitest so the path aliases resolve; its exit code is
    // the assertion (the rule's second conjunct).
    const vitestBin = path.join(
      process.cwd(),
      "node_modules",
      ".bin",
      "vitest",
    );
    await promisify(execFile)(
      vitestBin,
      ["run", "src/lib/query/views-restart.child.test.ts"],
      {
        env: {
          ...process.env,
          DEZFIL_RESTART_CHILD: "1",
        },
        timeout: 60_000,
      },
    );
  }, 70_000);

  it("a pass belonging to a discarded catalog cannot mark the new one current", async () => {
    // Warm: a full pass has completed on catalog A.
    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");

    // A pass starts against catalog A — and before its work runs, the
    // catalog is discarded. The pass still completes against the old
    // catalog's connection; whatever it records must describe THAT
    // catalog, not the replacement.
    const connA = await connectQueryInstance();
    try {
      const pass = registerTableViews(testAccountScope(), connA);
      resetQueryInstance(); // catalog A is gone before the pass's work ran
      await pass;
    } finally {
      connA.disconnectSync();
    }

    // The first evaluations on the new catalog must see every table —
    // late work on the dead catalog must not have blessed the live one.
    expect((await run("SELECT count(*) AS n FROM alpha"))[0].n).toBe("2");
    expect((await run("SELECT count(*) AS n FROM beta"))[0].n).toBe("2");
  });
});
