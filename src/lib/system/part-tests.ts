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
import { PART_TEST_LIMITS, type Part, type PartFailure, type PartTestAnswer } from "./part-test-answer";

/**
 * A part's Test: one small fixed check of a part of this server as it is
 * configured now, never one given in the call, under the part's own time
 * limit. It changes no stored thing, leaves no file and sends nothing
 * outside this server. A second Test of a part while one runs gets the same
 * answer from the same run.
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

type PartTest = (db: Database, signal: AbortSignal, caller: Caller) => Promise<void>;

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
  async tile_builder(_db, signal) {
    const outcome = await buildTestArchive(PART_TEST_LIMITS.tile_builder * 1000, signal);
    if (outcome !== "built") throw new PartFailed(outcome);
  },

  // The render route's fixed check picture photographed on a slot free
  // now, read back at its mark; busy at once otherwise.
  async image_renderer(_db, signal, caller) {
    const outcome = await renderTestImage(caller.context, caller.baseUrl, PART_TEST_LIMITS.image_renderer * 1000, signal);
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

async function run(part: Part, db: Database, caller: Caller): Promise<PartTestAnswer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve("expired"); }, PART_TEST_LIMITS[part] * 1000);
  });
  const started = performance.now();
  try {
    const outcome = await Promise.race([TESTS[part](db, controller.signal, caller).then(() => "done" as const), expired]);
    if (outcome === "expired") return { part, result: "failed", reason: "timed_out" };
    return { part, result: "passed", milliseconds: Math.round(performance.now() - started) };
  } catch (error) {
    if (error instanceof PartFailed) return { part, result: "failed", reason: error.reason };
    // Whatever else stopped the check is said without its words.
    return { part, result: "failed", reason: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

const key = Symbol.for("dezfil.part-tests");
const host = globalThis as typeof globalThis & { [key]?: Map<Part, Promise<PartTestAnswer>> };
const running = host[key] ??= new Map();

/** Test one part, the admin rechecked first. A Test of a part already under
 * way is joined, not repeated. `baseUrl` is where this server reaches its
 * own pages, from the request when there is one. */
export async function testPart(
  context: AuthContext,
  part: Part,
  db: Database = metadataDb(),
  now = Date.now(),
  baseUrl = selfBaseUrl(),
): Promise<PartTestAnswer> {
  requireAdmin(context, db, now);
  const current = running.get(part);
  if (current) return current;
  const test: Promise<PartTestAnswer> = run(part, db, { context, baseUrl }).finally(() => {
    if (running.get(part) === test) running.delete(part);
  });
  running.set(part, test);
  return test;
}
