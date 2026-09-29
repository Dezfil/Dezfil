import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { submit, cancel, isExecuting, jobSettled, laneSettled, resetLane } from "./lane";

/**
 * Criterion 7, against a real engine — the half the fake unit of work cannot
 * reach.
 *
 * The fake proves ordering, capacity and FIFO. It cannot prove that DuckDB
 * actually stopped, nor that the lane held its slot until it did, because it
 * has no engine to stop. This does both, and deliberately does NOT use the
 * shape the spec rules out: a prompt follow-up probe proves nothing here,
 * because every evaluation gets its own connection, so a fast probe is equally
 * consistent with the cancelled statement still burning a core.
 *
 * What it observes instead is the seeded statement's *own* settlement, and the
 * order of two events rather than the clock.
 */

// Roughly 4x10^10 row pairs: minutes of work, so "settled in seconds" is
// decisive rather than marginal.
const ENDLESS_SQL =
  "SELECT count(*) FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), src, "stations.csv");
  // Warm the hardened instance so lazy creation is not inside a measurement.
  await boundedEvaluation(async () => undefined);
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("cancelling a running operation", () => {
  it("stops the engine early, and holds the slot until it has stopped", async () => {
    // One log, so the assertion is about ORDER and not about two clocks.
    const events: string[] = [];

    submit("slow", async (signal) => {
      events.push("slow-entered");
      try {
        await boundedEvaluation(
          async (conn) => {
            // Inside the callback: the connection is acquired and the views
            // registered, so what follows is the engine actually working.
            events.push("statement-issued");
            return conn.runAndReadAll(ENDLESS_SQL);
          },
          { signal },
        );
      } catch {
        // Cancellation surfaces here; the outcome mapping is the caller's job.
      }
      // Reached only once the engine has genuinely released this statement.
      events.push("slow-settled");
    });
    submit("next", async () => {
      events.push("next-entered");
    });

    await until(() => isExecuting("slow"));
    // Cancelling here would prove nothing: boundedEvaluation acquires a
    // connection and registers views before it runs anything, so a cancel that
    // lands in that window stops an evaluation that never reached the engine.
    // Wait for the statement to be issued AND to have been running a while —
    // the statement is known to run for minutes, so a second of it is real
    // engine work rather than setup.
    await until(() => events.includes("statement-issued"));
    await new Promise((r) => setTimeout(r, 2_000));
    expect(events).toEqual(["slow-entered", "statement-issued"]);

    const startedCancelAt = Date.now();
    expect(cancel("slow")).toBe(true);
    await jobSettled("slow");
    const stoppedAfterMs = Date.now() - startedCancelAt;

    await laneSettled();

    // 1. The seeded statement's own execution ended early. Left alone it runs
    //    for minutes; this is the engine having actually been interrupted.
    expect(stoppedAfterMs).toBeLessThan(8_000);

    // 2. The slot was held until it did. If the lane released on the cancel
    //    instead of on settlement, "next-entered" would precede "slow-settled"
    //    and the concurrency cap would be a number the product does not honour.
    expect(events).toEqual([
      "slow-entered",
      "statement-issued",
      "slow-settled",
      "next-entered",
    ]);
  }, 120_000);

  it("leaves the engine usable afterwards", async () => {
    submit("slow", async (signal) => {
      await boundedEvaluation(async (conn) => conn.runAndReadAll(ENDLESS_SQL), {
        signal,
      }).catch(() => undefined);
    });
    await until(() => isExecuting("slow"));
    await new Promise((r) => setTimeout(r, 2_000));
    cancel("slow");
    await laneSettled();

    const rows = await boundedEvaluation(async (conn) => {
      const r = await conn.runAndReadAll("SELECT count(*) AS n FROM stations");
      return r.getRowObjects();
    });
    expect(Number(rows[0].n)).toBe(2);
  }, 120_000);
});
