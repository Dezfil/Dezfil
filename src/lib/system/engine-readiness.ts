import type { DuckDBConnection } from "@duckdb/node-api";
import { connectQueryInstance, queryEngineStanding } from "@/lib/duckdb";
export { ENGINE_UNREADY } from "./readiness-reasons";

/**
 * Readiness's look at the engine that runs people's SQL. It starts no
 * engine that nothing has asked for: before any query starts one,
 * readiness answers on storage alone. A running or starting engine is
 * asked a trivial statement on a connection of its own, under a limit of
 * its own, rather than through the bounded evaluation, so it waits for no
 * account's admission and mounts no views.
 *
 * Only evidence of failure reads as not ready: a start that failed, or a
 * statement that failed. A statement with no answer by the limit reads as
 * busy, not dead: engine work shares the runtime's worker pool, so the
 * probe waits behind long queries, and readiness must not flap under the
 * very load a monitor sheds. An engine whose last start failed reads as
 * failed until a start succeeds, whoever began it, so only an engine whose
 * last start succeeded, or a first start, is ever read as busy. Readiness
 * starts a failed engine again itself, at most once per ENGINE_RETRY_MS and
 * one start at a time, joining a start a query has under way rather than
 * making another, so an instance taken out of rotation recovers once the
 * cause clears, with no query to start it.
 */

/** How long the probe waits for the engine. */
export const ENGINE_PROBE_MS = 2_000;
/** The least time between two starts readiness makes of a failed engine. */
export const ENGINE_RETRY_MS = 30_000;

/** Readiness's own start of a failed engine: when it was made, and
 * whether it is still under way. */
const retry = { at: Number.NEGATIVE_INFINITY, pending: false };

/** Whether the engine reads as able to serve. A failure is logged for the
 * administrator, never returned. */
export async function queryEngineAnswers(): Promise<boolean> {
  const standing = queryEngineStanding();
  if (standing === "none") return true;
  // Where the engine stands decides first: a running engine is asked
  // whatever readiness's own start is doing, since that start's connection
  // can still be queued after the engine is up.
  if (standing !== "failed") return probe(false);
  // While readiness's own start of a failed engine is under way, the engine
  // is still a failed one; nothing more is started or joined meanwhile.
  if (retry.pending) return false;
  if (Date.now() - retry.at < ENGINE_RETRY_MS) return false;
  retry.at = Date.now();
  retry.pending = true;
  return probe(true);
}

/** Connect, starting the engine (or joining its start) when `restarting`,
 * and ask the statement. Past the limit the answer is busy, unless this is
 * a failed engine's start, which proves nothing until it settles. */
async function probe(restarting: boolean): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => { timer = setTimeout(() => resolve("expired"), ENGINE_PROBE_MS); });
  const connecting = connectQueryInstance();
  if (restarting) void connecting.then(() => {}, () => {}).finally(() => { retry.pending = false; });
  try {
    const conn = await Promise.race([connecting, expired]);
    if (conn === "expired") {
      connecting.then((late) => late.disconnectSync(), () => {});
      return !restarting;
    }
    return await ask(conn, expired);
  } catch (error) {
    console.error("[health] query engine unavailable:", error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The statement on `conn`, interrupted past the limit; the connection is
 * released once the statement has settled, never while it runs. */
async function ask(conn: DuckDBConnection, expired: Promise<"expired">): Promise<boolean> {
  const asked = conn.runAndReadAll("SELECT 1");
  const released = asked.then(() => {}, () => {}).finally(() => conn.disconnectSync());
  const answer = await Promise.race([asked, expired]);
  if (answer === "expired") {
    conn.interrupt();
    return true;
  }
  await released;
  const rows = answer.getRows();
  return rows.length === 1 && Number(rows[0][0]) === 1;
}
