import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { ApiError } from "@/lib/api/errors";
import { boundedEvaluation, EvaluationCancelled } from "./bounded";
import { registerTableViews } from "./views";

vi.mock("./views", async (importOriginal) => {
  const real = await importOriginal<typeof import("./views")>();
  return { registerTableViews: vi.fn(real.registerTableViews) };
});

const SLOW_SQL =
  "SELECT count(*) FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\nsudkreuz,13.36,52.48\n",
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
  // Warm the hardened instance before any test arms a short budget:
  // lazy creation (extension loads, lockdown) can cost real time, and a
  // budget that fires during acquisition would leave a test's queued
  // once-mock unconsumed for the next evaluation to inherit.
  await boundedEvaluation(async () => undefined, { scope: testAccountScope() });
  vi.mocked(registerTableViews).mockClear();
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_QUERY_TIMEOUT_S;
  await rm(dir, { recursive: true, force: true });
});

describe("boundedEvaluation", () => {
  it("interrupts work past the budget, and the engine answers again at once", async () => {
    process.env.DEZFIL_QUERY_TIMEOUT_S = "1";
    await expect(
      boundedEvaluation(async (conn) => conn.runAndReadAll(SLOW_SQL), { scope: testAccountScope() }),
    ).rejects.toMatchObject({ code: "query_timeout", status: 408 });
    // The engine was stopped, not abandoned: a follow-up evaluation answers
    // well inside the time the interrupted work would still be consuming.
    const started = Date.now();
    const rows = await boundedEvaluation(async (conn) => {
      const r = await conn.runAndReadAll("SELECT count(*) AS n FROM stations");
      return r.getRowObjects();
    }, { scope: testAccountScope() });
    expect(Number(rows[0].n)).toBe(3);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it("times out a waiter stuck in preparation instead of hanging", async () => {
    process.env.DEZFIL_QUERY_TIMEOUT_S = "1";
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(registerTableViews).mockImplementationOnce(() => gate);
    const started = Date.now();
    await expect(
      boundedEvaluation(async () => "unreachable", { scope: testAccountScope() }),
    ).rejects.toMatchObject({ code: "query_timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    // Settle the abandoned registration so its drain releases (production
    // registrations always settle; a forever-pending gate is a test-only
    // artifact that would leak interrupts into later tests).
    release();
  }, 30_000);

  it("cancels a waiter stuck in preparation when its caller leaves", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(registerTableViews).mockImplementationOnce(() => gate);
    const caller = new AbortController();
    const evaluation = boundedEvaluation(async () => "unreachable", { scope: testAccountScope(),
      signal: caller.signal,
    });
    setTimeout(() => caller.abort(), 100);
    await expect(evaluation).rejects.toBeInstanceOf(EvaluationCancelled);
    release();
  }, 30_000);

  it("keeps the door open for followers after an abandoned waiter", async () => {
    process.env.DEZFIL_QUERY_TIMEOUT_S = "1";
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(registerTableViews).mockImplementationOnce(() => gate);
    await expect(
      boundedEvaluation(async () => "unreachable", { scope: testAccountScope() }),
    ).rejects.toMatchObject({ code: "query_timeout" });
    // The abandoned registration settles, as real ones do; the follower
    // then registers for real and queries normally.
    release();
    const rows = await boundedEvaluation(async (conn) => {
      const r = await conn.runAndReadAll("SELECT count(*) AS n FROM stations");
      return r.getRowObjects();
    }, { scope: testAccountScope() });
    expect(Number(rows[0].n)).toBe(3);
  }, 30_000);

  it("cancels silently when the caller disconnects mid-statement", async () => {
    const caller = new AbortController();
    const started = Date.now();
    const evaluation = boundedEvaluation(
      async (conn) => conn.runAndReadAll(SLOW_SQL),
      { scope: testAccountScope(), signal: caller.signal },
    );
    setTimeout(() => caller.abort(), 200);
    await expect(evaluation).rejects.toBeInstanceOf(EvaluationCancelled);
    expect(Date.now() - started).toBeLessThan(10_000);
    // Nothing lingers: the next evaluation is prompt.
    const rows = await boundedEvaluation(async (conn) => {
      const r = await conn.runAndReadAll("SELECT 1 AS one");
      return r.getRowObjects();
    }, { scope: testAccountScope() });
    expect(Number(rows[0].one)).toBe(1);
  }, 30_000);

  it("rejects an already-departed caller before touching the engine", async () => {
    const caller = new AbortController();
    caller.abort();
    await expect(
      boundedEvaluation(async () => "unreachable", { scope: testAccountScope(), signal: caller.signal }),
    ).rejects.toBeInstanceOf(EvaluationCancelled);
    expect(vi.mocked(registerTableViews)).not.toHaveBeenCalled();
  });

  it("a callback tail past the deadline does not return as success", async () => {
    await expect(
      boundedEvaluation(
        async (conn) => {
          await conn.runAndReadAll("SELECT 1");
          // Non-engine post-processing (the tiled-render shape): the
          // budget elapses while no statement is running.
          await new Promise((r) => setTimeout(r, 800));
          return "too late";
        },
        { scope: testAccountScope(), budgetMs: 300 },
      ),
    ).rejects.toMatchObject({ code: "query_timeout" });
  }, 30_000);

  it("a departure during the callback tail cancels the resolution", async () => {
    const caller = new AbortController();
    const evaluation = boundedEvaluation(
      async (conn) => {
        await conn.runAndReadAll("SELECT 1");
        await new Promise((r) => setTimeout(r, 800));
        return "nobody is listening";
      },
      { scope: testAccountScope(), signal: caller.signal },
    );
    setTimeout(() => caller.abort(), 150);
    await expect(evaluation).rejects.toBeInstanceOf(EvaluationCancelled);
  }, 30_000);

  it("honors a lane's own budget and coded error", async () => {
    await expect(
      boundedEvaluation(async (conn) => conn.runAndReadAll(SLOW_SQL), { scope: testAccountScope(),
        budgetMs: 500,
        timeoutError: () =>
          new ApiError("tile_build_timeout", "the lane's own copy", 408),
      }),
    ).rejects.toMatchObject({ code: "tile_build_timeout" });
  }, 30_000);
});
