import type { Database } from "better-sqlite3";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { dataDir } from "@/lib/config";
import { ensureDataDir } from "@/lib/data-dir";
import { MIGRATIONS, metadataDb } from "@/lib/metadata/db";
import { selfBaseUrl } from "@/lib/self-url";
import { askQueryEngine } from "./engine-test";
import { renderTestImage } from "./renderer-test";
import { buildTestArchive } from "./tiler-test";
import { TILER_STOP_GRACE_MS } from "@/lib/tiles/tiler";
import { PART_TEST_LIMITS, type Part, type PartFailure, type PartTestAnswer } from "./part-test-answer";

/**
 * A part's Test: one small fixed check of a part of this server as it is
 * configured now, never one given in the call, under the part's own time
 * limit, stopped early enough that its work, termination and cleanup
 * included, has ended by then. It changes no stored thing, leaves no file
 * and sends nothing outside this server. A second Test of a part asked
 * while one runs, its work still ending included, gets that run's answer.
 *
 * The answer is a closed shape (`part-test-answer.ts`): what went wrong is
 * read only to choose its reason, and none of its words, which may hold a
 * path, ever reach the answer.
 */

/** A failure the check itself names; anything else thrown is `failed`. */
class PartFailed extends Error {
  constructor(readonly reason: PartFailure) { super(reason); }
}

/** Who asked, and where this server reaches its own pages. */
interface Caller { context: AuthContext; baseUrl: string }

/** One part's check: `signal` is its stop, which comes `stopMs` after it
 * starts, early enough for its work to end within the Test's limit. */
type PartTest = (db: Database, signal: AbortSignal, caller: Caller, stopMs: number) => Promise<void>;

/** SQLite's own busy answer, after the store's busy wait. */
const isBusy = (error: unknown) => typeof (error as { code?: unknown })?.code === "string" &&
  (error as { code: string }).code.startsWith("SQLITE_BUSY");

const TESTS: Record<Part, PartTest> = {
  // The readiness check's own probe: one empty file written and removed.
  async data_folder() {
    await ensureDataDir(dataDir());
  },

  // One fixed spatial question on the engine that runs people's SQL,
  // starting a cold one with what is installed and installing nothing.
  async query_engine(_db, signal) {
    const outcome = await askQueryEngine(signal);
    if (outcome !== "answered") throw new PartFailed(outcome);
  },

  // A small archive built from a few fixed points beside any layer build,
  // the version probed first.
  async tile_builder(_db, signal, _caller, stopMs) {
    const outcome = await buildTestArchive(stopMs, signal);
    if (outcome !== "built") throw new PartFailed(outcome);
  },

  // The render route's fixed check picture photographed on a slot free
  // now, read back at its mark; busy at once otherwise.
  async image_renderer(_db, signal, caller, stopMs) {
    const outcome = await renderTestImage(caller.context, caller.baseUrl, stopMs, signal);
    if (outcome !== "rendered") throw new PartFailed(outcome);
  },

  // The write lock taken and given back around one fixed fact, the
  // schema's version; the rollback writes nothing. The store's busy wait,
  // which equals this Test's limit, is what answers busy.
  async metadata_database(db) {
    if (db.inTransaction) throw new PartFailed("busy");
    try { db.exec("BEGIN IMMEDIATE"); }
    catch (error) { throw isBusy(error) ? new PartFailed("busy") : error; }
    try {
      if (db.pragma("user_version", { simple: true }) !== MIGRATIONS.length) throw new PartFailed("failed");
    } finally { db.exec("ROLLBACK"); }
  },
};

/**
 * How long before its limit each part's work is stopped, so that its end,
 * termination and cleanup included, falls within the limit: the engine's
 * question is interrupted a second early; the tiler is asked to stop with
 * its grace before it is ended outright, and a second for its exit and its
 * folder's removal, still to come; the renderer's browser is closed or
 * ended with time to spare. A check that cannot be stopped, a file written
 * or the write lock taken, runs to its limit.
 */
export const PART_TEST_ENDING_MS: Readonly<Record<Part, number>> = {
  data_folder: 0,
  query_engine: 1_000,
  tile_builder: TILER_STOP_GRACE_MS + 1_000,
  image_renderer: 500,
  metadata_database: 0,
};

/** A Test under way: its answer, given by its limit at the latest, and the
 * end of its part's own work, which may come later. */
interface Running { answer: Promise<PartTestAnswer>; settled: Promise<void> }

function start(part: Part, db: Database, caller: Caller, onSettled: () => void): Running {
  const limitMs = PART_TEST_LIMITS[part] * 1000;
  const stopMs = limitMs - PART_TEST_ENDING_MS[part];
  const controller = new AbortController();
  const stop = setTimeout(() => controller.abort(), stopMs);
  const started = performance.now();
  const outcome = TESTS[part](db, controller.signal, caller, stopMs).then(
    (): PartTestAnswer => ({ part, result: "passed", milliseconds: Math.round(performance.now() - started) }),
    (error: unknown): PartTestAnswer => ({
      part, result: "failed",
      // Stopped for its time, whatever it said as it ended; otherwise the
      // reason the check names, and anything else without its words.
      reason: controller.signal.aborted ? "timed_out" : error instanceof PartFailed ? error.reason : "failed",
    }),
  ).finally(() => clearTimeout(stop));
  let limit: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<PartTestAnswer>(resolve => {
    limit = setTimeout(() => resolve({ part, result: "failed", reason: "timed_out" }), limitMs);
  });
  // Settled only once the part's work has ended, its termination and
  // cleanup included; attached before the answer, so a Test whose work has
  // ended is gone from the runs before its answer is read.
  const settled = outcome.then(() => { clearTimeout(limit); onSettled(); });
  return { answer: Promise.race([outcome, expired]), settled };
}

const key = Symbol.for("dezfil.part-tests");
const host = globalThis as typeof globalThis & { [key]?: Map<Part, Running> };
const running = host[key] ??= new Map();

/** Test one part, the admin rechecked first. A Test of a part asked while
 * one is under way, its part's work still ending included, is joined, not
 * repeated: it gets that run's answer. `baseUrl` is where this server
 * reaches its own pages, from the request when there is one. */
export async function testPart(
  context: AuthContext,
  part: Part,
  db: Database = metadataDb(),
  now = Date.now(),
  baseUrl = selfBaseUrl(),
): Promise<PartTestAnswer> {
  requireAdmin(context, db, now);
  const current = running.get(part);
  if (current) return current.answer;
  const test: Running = start(part, db, { context, baseUrl }, () => {
    if (running.get(part) === test) running.delete(part);
  });
  running.set(part, test);
  return test.answer;
}

/** Test seam: every part's Test under way has settled, its work ended. */
export async function partTestsSettled(): Promise<void> {
  await Promise.all([...running.values()].map(test => test.settled));
}
