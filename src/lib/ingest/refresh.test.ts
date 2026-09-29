import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, access, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getTableByName, insertTable } from "@/lib/metadata/tables";
import { removeTable } from "@/lib/table-service";
import { getTileRecord, upsertTileRecord } from "@/lib/metadata/tiles";
import { dataDir } from "@/lib/config";
import { resetQueryInstance, connectQueryInstance } from "@/lib/duckdb";
import { boundedEvaluation } from "@/lib/query/bounded";
import { registerTableViews } from "@/lib/query/views";
import { ingestFile } from "./ingest";
import { importFromUrl } from "./remote";

/** Single-table imports, unwrapped (made the answer a result set). */
const importOne = async (url: string, name?: string) =>
  (await importFromUrl(testAccountScope(), url, name)).tables[0];
import { refreshTable, invalidateTilesForTable } from "./refresh";
import { resetRefreshFences } from "./fence";
import { retirementsSettled } from "./retire";

let dir: string;
let server: Server;
let base: string;
let rows = 2;
let bodyOverride: string | null = null;
let failNext = false;
let onRequest: (() => void) | null = null;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  // The egress policy blocks loopback by default; this suite's fixture
  // server lives there, so it opts in the way an administrator would.
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  closeMetadataDb();
  resetRefreshFences();
  resetQueryInstance();
  rows = 2;
  bodyOverride = null;
  failNext = false;
  onRequest = null;

  server = createServer((_req, res) => {
    onRequest?.();
    if (failNext) {
      res.writeHead(500);
      res.end("down");
      return;
    }
    const body =
      bodyOverride ??
      "name,lat,lon\n" +
      Array.from({ length: rows }, (_, i) => `p${i},52.${i},13.${i}`).join(
        "\n",
      ) +
      "\n";
    res.writeHead(200, { "content-type": "text/csv" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  await rm(dir, { recursive: true, force: true });
});

/** One evaluation through the real door: registration, then the count. */
async function evalCount(name: string): Promise<number> {
  return boundedEvaluation(async (conn) => {
    const reader = await conn.runAndReadAll(
      `SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`,
    );
    return Number((reader.getRowObjectsJson()[0] as { n: unknown }).n);
  }, { scope: testAccountScope() });
}

/** Register a map + layer whose SQL references the table, plus a tile record. */
function seedDependentLayer(table: string, layerId: string): void {
  const db = metadataDb();
  const scope = testAccountScope(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO maps (id, name, created_at, updated_at, owner_id) VALUES (?, 'm', ?, ?, ?)`,
  ).run(`map-${layerId}`, now, now, scope.accountId);
  db.prepare(
    `INSERT INTO layers (id, map_id, name, sql, style, ordinal, created_at, updated_at)
     VALUES (?, ?, 'l', ?, '{}', 0, ?, ?)`,
  ).run(layerId, `map-${layerId}`, `SELECT * FROM ${table}`, now, now);
  upsertTileRecord({
    layerId,
    state: "ready",
    fingerprint: "f1",
    error: null,
    featureCount: 10,
    builtAt: now,
  });
}

describe("refreshTable", () => {
  it("re-runs the stored URL import and swaps data atomically", async () => {
    const url = `${base}/points.csv`;
    const before = await importOne(url);
    expect(before.rowCount).toBe(2);
    const oldArtifact = path.join(dataDir(), before.file);

    rows = 5;
    const after = await refreshTable(testAccountScope(), before.name);
    expect(after.rowCount).toBe(5);
    expect(after.file).not.toBe(before.file);
    expect(after.sourceParams).toEqual({ url });
    expect(after.importedAt).not.toBe(before.importedAt);
    // the old artifact retires (no readers in flight → promptly), the new
    // one exists
    await retirementsSettled();
    await expect(access(oldArtifact)).rejects.toThrow();
    await expect(
      access(path.join(dataDir(), after.file)),
    ).resolves.toBeUndefined();
  });

  it("retains a recognized WKT column when refresh leaves every geometry blank", async () => {
    bodyOverride = "name,wkt\na,POINT (13.4 52.5)\n";
    const before = await importOne(`${base}/shapes.csv`);
    expect(before.geometryColumn).toBe("geometry");
    expect(before.crsAssumed).toBe(true);

    bodyOverride = "name,wkt\na,\nb,\n";
    const after = await refreshTable(testAccountScope(), before.name);
    expect(after).toMatchObject({
      geometryColumn: "geometry",
      geometryType: null,
      rowCount: 2,
      crsAssumed: true,
    });
  });

  it("the first evaluation after a refresh answers from the new artifact", async () => {
    const before = await importOne(`${base}/points.csv`);
    // Bind the view by actually evaluating — the dangerous transition is a
    // table that is already bound when its artifact swaps underneath it.
    expect(await evalCount(before.name)).toBe(2);

    rows = 7;
    await refreshTable(testAccountScope(), before.name);
    // The registry row is necessary but not sufficient: the answer must
    // come through the catalog view, from the new artifact.
    expect(await evalCount(before.name)).toBe(7);
  });

  it("a deleted name reclaimed by a new import answers the newcomer, not the ghost", async () => {
    // The skip keys on identity AND artifact: a re-import under a
    // reclaimed name mints both anew, and the bound old view must not
    // survive it. The reclaimed-name race test checks metadata only;
    // this one binds the outgoing view and evaluates the newcomer
    // (the rule's re-import conjunct).
    const before = await importOne(`${base}/points.csv`);
    expect(await evalCount(before.name)).toBe(2); // bound

    await removeTable(testAccountScope(), before.name);
    rows = 5;
    const reclaimed = await importOne(`${base}/points.csv`);
    expect(reclaimed.name).toBe(before.name);
    expect(reclaimed.id).not.toBe(before.id);

    expect(await evalCount(reclaimed.name)).toBe(5);
  });

  it("re-enters the egress policy: a de-allowlisted source refuses to refresh", async () => {
    const before = await importOne(`${base}/points.csv`);
    delete process.env.DEZFIL_EGRESS_ALLOWLIST;
    await expect(refreshTable(testAccountScope(), before.name)).rejects.toMatchObject({
      code: "egress_blocked",
      status: 403,
    });
    // and the previous data is still served, untouched
    expect(getTableByName(before.name)?.rowCount).toBe(2);
  });

  it("leaves the previous data fully intact when the source is down", async () => {
    const before = await importOne(`${base}/points.csv`);
    failNext = true;
    await expect(refreshTable(testAccountScope(), before.name)).rejects.toMatchObject({
      code: "remote_fetch_failed",
    });
    const still = getTableByName(before.name);
    expect(still?.rowCount).toBe(2);
    expect(still?.file).toBe(before.file);
    await expect(
      access(path.join(dataDir(), before.file)),
    ).resolves.toBeUndefined();
  });

  it("refuses to refresh an uploaded table, specifically", async () => {
    const src = path.join(dir, "plain.csv");
    await writeFile(src, "name,value\na,1\n");
    const uploaded = await ingestFile(testAccountScope(), src, "plain.csv");
    await expect(refreshTable(testAccountScope(), uploaded.name)).rejects.toMatchObject({
      code: "not_refreshable",
    });
  });

  it("drops tile records of dependent layers so renders rebuild", async () => {
    const before = await importOne(`${base}/points.csv`);
    seedDependentLayer(before.name, "layer-dep");
    seedDependentLayer("other_table", "layer-other");

    await refreshTable(testAccountScope(), before.name);
    expect(getTileRecord("layer-dep")).toBeNull();
    expect(getTileRecord("layer-other")).not.toBeNull();
  });

  it("invalidateTilesForTable matches conservatively by name", () => {
    seedDependentLayer("stations", "layer-a");
    expect(invalidateTilesForTable(testAccountScope(), "stations")).toBe(1);
    expect(invalidateTilesForTable(testAccountScope(), "stations")).toBe(0);
  });

  it("does not treat identifier neighbors as references", () => {
    // Substring neighbors on both sides of the name...
    seedDependentLayer("main_roads", "layer-sub");
    seedDependentLayer("roads_2", "layer-suffix");
    expect(invalidateTilesForTable(testAccountScope(), "roads")).toBe(0);
    // ...and an underscore in the refreshed name is not a wildcard.
    seedDependentLayer("axb", "layer-underscore");
    expect(invalidateTilesForTable(testAccountScope(), "a_b")).toBe(0);
    // The neighbors' own refreshes still find them.
    expect(invalidateTilesForTable(testAccountScope(), "main_roads")).toBe(1);
    expect(invalidateTilesForTable(testAccountScope(), "roads_2")).toBe(1);
  });

  it("still invalidates genuine references in any written form", () => {
    // The engine binds identifiers case-insensitively; quoting is bounding.
    seedDependentLayer("Stations", "layer-cased");
    seedDependentLayer('"stations"', "layer-quoted");
    expect(invalidateTilesForTable(testAccountScope(), "stations")).toBe(2);
  });

  it("refuses a second refresh of the same table while one runs, then allows the next", async () => {
    const before = await importOne(`${base}/points.csv`);
    rows = 5;
    // The fence is claimed before the first await, so the conflict is
    // deterministic — no timing games.
    const first = refreshTable(testAccountScope(), before.name);
    await expect(refreshTable(testAccountScope(), before.name)).rejects.toMatchObject({
      code: "refresh_in_flight",
      status: 409,
    });
    const settled = await first;
    expect(settled.rowCount).toBe(5);
    // The fence released: the next refresh runs, and the directory holds
    // exactly the one registered artifact.
    rows = 3;
    const again = await refreshTable(testAccountScope(), before.name);
    expect(again.rowCount).toBe(3);
    await retirementsSettled();
    const files = await readdir(path.join(dataDir(), "tables"));
    expect(files).toEqual([path.basename(again.file)]);
  });

  it("reports success when post-commit cleanup stumbles", async () => {
    const before = await importOne(`${base}/points.csv`);
    // Injection: tile invalidation cannot run — its table is gone. The
    // committed swap must still be the answer the caller reads.
    metadataDb().prepare(`DROP TABLE layer_tiles`).run();
    rows = 4;
    const after = await refreshTable(testAccountScope(), before.name);
    expect(after.rowCount).toBe(4);
    expect(getTableByName(before.name)?.rowCount).toBe(4);
    expect(getTableByName(before.name)?.file).toBe(after.file);
  });

  it("lets distinct tables refresh concurrently and releases the fence on failure", async () => {
    const a = await importOne(`${base}/alpha.csv`);
    const b = await importOne(`${base}/beta.csv`);
    const [ra, rb] = await Promise.all([
      refreshTable(testAccountScope(), a.name),
      refreshTable(testAccountScope(), b.name),
    ]);
    expect(ra.name).toBe(a.name);
    expect(rb.name).toBe(b.name);

    failNext = true;
    await expect(refreshTable(testAccountScope(), a.name)).rejects.toMatchObject({
      code: "remote_fetch_failed",
    });
    failNext = false;
    // A failed refresh does not wedge the unit.
    await expect(refreshTable(testAccountScope(), a.name)).resolves.toMatchObject({
      name: a.name,
    });
  });

  it("answers not_found and leaves no candidate when the table is deleted mid-refresh", async () => {
    const before = await importOne(`${base}/points.csv`);
    // The delete lands while the refresh is fetching its source — the row is
    // gone by the time the candidate tries to swap in.
    onRequest = () => {
      metadataDb()
        .prepare(`DELETE FROM data_tables WHERE name = ?`)
        .run(before.name);
    };
    await expect(refreshTable(testAccountScope(), before.name)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    // The candidate was cleaned up: the only artifact left is the old one
    // (this injection bypassed the delete service, which owns its removal).
    const files = await readdir(path.join(dataDir(), "tables"));
    expect(files).toEqual([path.basename(before.file)]);
  });

  it("resolves refresh racing delete deterministically in both orders", async () => {
    // Order A: the delete service runs while the refresh is building.
    const a = await importOne(`${base}/alpha.csv`);
    let pendingDelete: Promise<void> | undefined;
    onRequest = () => {
      pendingDelete = removeTable(testAccountScope(), a.name);
    };
    await expect(refreshTable(testAccountScope(), a.name)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await pendingDelete;
    expect(getTableByName(a.name)).toBeNull();

    // Order B: the refresh arrives after the delete began.
    onRequest = null;
    const b = await importOne(`${base}/beta.csv`);
    const del = removeTable(testAccountScope(), b.name);
    await expect(refreshTable(testAccountScope(), b.name)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await del;

    // Either order: the tables end deleted and zero files remain — no old
    // artifact, no new one, no candidate.
    expect(getTableByName(b.name)).toBeNull();
    await retirementsSettled();
    expect(await readdir(path.join(dataDir(), "tables"))).toEqual([]);
  });

  it("the registration pass drops views for vanished tables — a lost drop self-heals", async () => {
    const before = await importOne(`${base}/points.csv`);
    await boundedEvaluation(async (conn) => {
      await conn.runAndReadAll(`SELECT count(*) FROM points`);
    }, { scope: testAccountScope() });
    // The row goes without the delete service ever running its view drop —
    // the lost-drop shape. The next pass reconciles against the registry.
    metadataDb()
      .prepare(`DELETE FROM data_tables WHERE name = ?`)
      .run(before.name);
    const message = await boundedEvaluation(async (conn) => {
      await conn.runAndReadAll(`SELECT * FROM points`);
    }, { scope: testAccountScope() }).then(
      () => "no error",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(message).toMatch(/points does not exist/);
    expect(message).not.toMatch(/parquet|tables\//i);
  });

  it("a deleted table answers unknown-table SQL, like a never-imported name", async () => {
    const before = await importOne(`${base}/points.csv`);
    // Materialize the view in the shared catalog, then delete the table.
    await boundedEvaluation(async (conn) => {
      await conn.runAndReadAll(`SELECT count(*) FROM points`);
    }, { scope: testAccountScope() });
    await removeTable(testAccountScope(), before.name);

    const errorOf = (sql: string) =>
      boundedEvaluation(async (conn) => {
        await conn.runAndReadAll(sql);
      }, { scope: testAccountScope() }).then(
        () => "no error",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
    const deleted = await errorOf(`SELECT * FROM points`);
    const never = await errorOf(`SELECT * FROM never_imported`);
    expect(deleted).toMatch(/points does not exist/);
    expect(never).toMatch(/never_imported does not exist/);
    // No artifact paths leak into the deleted table's answer.
    expect(deleted).not.toMatch(/parquet|tables\//i);
  });

  it("never yanks the artifact from an in-flight evaluation; retirement lands after it settles", async () => {
    const before = await importOne(`${base}/points.csv`);
    const oldArtifact = path.join(dataDir(), before.file);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sawFirstCount!: () => void;
    const firstCounted = new Promise<void>((r) => (sawFirstCount = r));

    // An evaluation binds the pre-refresh artifact path, then holds the
    // floor while the refresh commits underneath it.
    const evaluation = boundedEvaluation(async (conn) => {
      const a = await conn.runAndReadAll(
        `SELECT count(*)::INT AS c FROM points`,
      );
      sawFirstCount();
      await gate;
      const b = await conn.runAndReadAll(
        `SELECT count(*)::INT AS c FROM points`,
      );
      return [Number(a.getRowObjects()[0].c), Number(b.getRowObjects()[0].c)];
    }, { scope: testAccountScope() });
    await firstCounted;

    rows = 6;
    await refreshTable(testAccountScope(), before.name);
    // Committed — but the old artifact is retired, not removed: the
    // in-flight evaluation still holds it.
    await expect(access(oldArtifact)).resolves.toBeUndefined();

    release();
    // The held evaluation completes against the old data — no engine file
    // error — and only then does the retirement land.
    await expect(evaluation).resolves.toEqual([2, 2]);
    await retirementsSettled();
    await expect(access(oldArtifact)).rejects.toThrow();

    // An evaluation started after the commit reads the refreshed data.
    const fresh = await boundedEvaluation(async (conn) => {
      const r = await conn.runAndReadAll(
        `SELECT count(*)::INT AS c FROM points`,
      );
      return Number(r.getRowObjects()[0].c);
    }, { scope: testAccountScope() });
    expect(fresh).toBe(6);
  });

  it("cannot resurrect a name reclaimed by a newer import mid-refresh", async () => {
    const before = await importOne(`${base}/points.csv`);
    // Mid-build, the table is deleted and its name reclaimed by a brand-new
    // import (different id). The refresh of the dead table must not write
    // into the newcomer.
    onRequest = () => {
      metadataDb()
        .prepare(`DELETE FROM data_tables WHERE name = ?`)
        .run(before.name);
      insertTable(testAccountScope(), {
        ...before,
        id: "reclaimed-id",
        file: "tables/reclaimed.parquet",
        rowCount: 1,
      });
    };
    await expect(refreshTable(testAccountScope(), before.name)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    const survivor = getTableByName(before.name);
    expect(survivor?.id).toBe("reclaimed-id");
    expect(survivor?.file).toBe("tables/reclaimed.parquet");
    expect(survivor?.rowCount).toBe(1);
  });
});

describe("mutations committing during an in-flight registration pass", () => {
  /**
   * Pin a registration pass mid-flight: a long statement occupies the
   * shared connection, so the pass's own statements — queued behind it on
   * the same connection — genuinely span the mutation each test commits.
   * The pass snapshots the registry before the mutation and finishes after
   * it, which is exactly the window under test. `settled` lets
   * each test PROVE the overlap happened rather than assume it.
   *
   * The catalog is reset first so the pinned pass has real writes to do: a
   * warm incremental pass performs no catalog statements at all, would
   * never queue behind the pinned connection, and the "overlap" this
   * fixture promises would be vacuous — the same trap the guard test
   * names, biting the overlap fixture.
   */
  async function pinnedPass() {
    resetQueryInstance();
    const conn = await connectQueryInstance();
    const slow = conn.runAndReadAll(
      `SELECT sum(range) AS s FROM range(500000000)`,
    );
    let done = false;
    const pass = registerTableViews(testAccountScope(), conn).finally(() => {
      done = true;
    });
    return {
      settled: () => done,
      drain: async () => {
        await slow;
        await pass;
        conn.disconnectSync();
      },
    };
  }

  it("an upload committing mid-pass is seen by the first evaluation after it", async () => {
    await importOne(`${base}/points.csv`);
    expect(await evalCount("points")).toBe(2);

    const pin = await pinnedPass();
    const src = path.join(dir, "fresh.csv");
    await writeFile(src, "name,lat,lon\nx,52.1,13.1\ny,52.2,13.2\nz,52.3,13.3\n");
    await ingestFile(testAccountScope(), src, "fresh.csv");
    // The mutation committed while the pass was genuinely in flight.
    expect(pin.settled()).toBe(false);
    await pin.drain();

    expect(await evalCount("fresh")).toBe(3);
  });

  it("a refresh committing mid-pass answers from its new artifact afterwards", async () => {
    const before = await importOne(`${base}/points.csv`);
    expect(await evalCount(before.name)).toBe(2);

    const pin = await pinnedPass();
    rows = 9;
    await refreshTable(testAccountScope(), before.name);
    expect(pin.settled()).toBe(false);
    await pin.drain();

    expect(await evalCount(before.name)).toBe(9);
  });

  it("a delete committing mid-pass stops answering afterwards", async () => {
    await importOne(`${base}/points.csv`);
    expect(await evalCount("points")).toBe(2);

    const pin = await pinnedPass();
    // The registry row goes synchronously at the call; the chained view
    // drop lands behind the pinned pass, so the removal settles after it.
    const removal = removeTable(testAccountScope(), "points");
    expect(pin.settled()).toBe(false);
    await pin.drain();
    await removal;

    await expect(evalCount("points")).rejects.toThrow(/points/i);
  });
});

describe("the suspect-header warning across refreshes", () => {
  it("a refresh recomputes the warning in both directions", async () => {
    bodyOverride = null; // the ordinary clean shape
    try {
      const before = await importOne(`${base}/moody.csv`);
      expect(before.headerSuspect).toBe(false);

      // The source turns into the field find's own unsplit shape (the
      // tracked fixture): the refresh's own read ADDS the warning.
      bodyOverride = await readFile(
        path.join(process.cwd(), "e2e", "fixtures", "broken-header.csv"),
        "utf8",
      );
      const warned = await refreshTable(testAccountScope(), before.name);
      expect(warned.headerSuspect).toBe(true);

      // And a repaired source CLEARS it — the warning is a description
      // of the latest read, never a permanent stain.
      bodyOverride = null;
      const cleared = await refreshTable(testAccountScope(), before.name);
      expect(cleared.headerSuspect).toBe(false);
    } finally {
      bodyOverride = null;
    }
  });
});
