import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance, connectQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { registerTableViews, dropTableView } from "./views";

/**
 * The write-write guard. Registration writes are serialized process-wide
 * because concurrent CREATE OR REPLACE VIEW on one name is a DuckDB
 * catalog write-write conflict — recorded roughly half of concurrent
 * renders failing before the guard and 12/12 after. What these tests
 * hold is the ORDERING the guard provides: while one pass's catalog
 * writes are genuinely pending, no other pass (and no delete-time drop)
 * may enter its own. Asserted by completion order under a pinned first
 * pass, which is deterministic in both directions — green with the
 * chain, red against a build whose passes run their work immediately. A
 * load test firing concurrent queries at a warm catalog would prove
 * nothing here: once registration skips unchanged work, a warm pass
 * performs no catalog writes at all.
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
    await ingestFile(src, `${name}.csv`);
  }
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

/** Pin a connection: statements queued behind this stay pending long
 * enough that an unserialized second pass would visibly finish first. */
function pin(conn: Awaited<ReturnType<typeof connectQueryInstance>>) {
  return conn.runAndReadAll(`SELECT sum(range) AS s FROM range(500000000)`);
}

describe("registration writes are serialized process-wide", () => {
  it("a second pass cannot run while the first pass's writes are pending", async () => {
    const conn1 = await connectQueryInstance();
    const conn2 = await connectQueryInstance();
    try {
      // P1's writes queue behind the pinned statement — genuinely pending.
      // P2 rides an unpinned connection: without the guard its writes
      // would complete in milliseconds, while P1's are still pending.
      const slow = pin(conn1);
      let p1Settled = false;
      let p1SettledWhenP2Finished: boolean | null = null;
      const p1 = registerTableViews(conn1).finally(() => {
        p1Settled = true;
      });
      const p2 = registerTableViews(conn2).finally(() => {
        p1SettledWhenP2Finished = p1Settled;
      });
      await Promise.all([p1, p2, slow]);

      // The guard's property: P2 finished only after P1 had settled.
      expect(p1SettledWhenP2Finished).toBe(true);
    } finally {
      conn1.disconnectSync();
      conn2.disconnectSync();
    }
  });

  it("a delete's view drop queues behind pending registration writes", async () => {
    const conn1 = await connectQueryInstance();
    try {
      const slow = pin(conn1);
      let passSettled = false;
      let passSettledWhenDropFinished: boolean | null = null;
      const pass = registerTableViews(conn1).finally(() => {
        passSettled = true;
      });
      // The drop rides its own connection; only the shared chain orders it
      // behind the pass — which is exactly what must survive (a drop
      // slipping between a pass's writes is the same conflict).
      const drop = dropTableView("alpha").finally(() => {
        passSettledWhenDropFinished = passSettled;
      });
      await Promise.all([pass, drop, slow]);

      expect(passSettledWhenDropFinished).toBe(true);
    } finally {
      conn1.disconnectSync();
    }
  });
});
