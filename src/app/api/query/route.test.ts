import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { POST } from "./route";

/**
 * The query route's caller-departure contract as the console's Cancel
 * relies on it: aborting the request interrupts the evaluation on the
 * server — the handler settles in well under the time the statement
 * would take, with the 499 the envelope documents — and the engine
 * answers the next query at once. The browser journey proves the
 * button; this proves the server half it cannot see.
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalexanderplatz,13.41,52.52\n");
  await ingestFile(testAccountScope(), src, "stations.csv");
});
afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function post(body: unknown, signal?: AbortSignal): Request {
  return testAccountRequest(new Request("http://test/api/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }));
}

describe("POST /api/query — the caller's departure cancels (as Cancel uses it)", () => {
  it("an aborted request settles fast with 499 and the engine is free for the next query", async () => {
    const controller = new AbortController();
    // A statement that would run for many seconds uninterrupted.
    const slow = post(
      { sql: "SELECT count(*) FROM range(4000000000) WHERE range % 7 = 3" },
      controller.signal,
    );
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);
    const res = await POST(slow);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(499);
    // Interrupted, not awaited to completion: the bound is loose on purpose
    // (a slow machine), but far below the statement's natural runtime.
    expect(elapsed).toBeLessThan(5_000);
    const next = Date.now();
    const ok = await POST(post({ sql: "SELECT 42 AS answer" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).preview[0].answer).toBe(42);
    expect(Date.now() - next).toBeLessThan(5_000);
  }, 30_000);
});
