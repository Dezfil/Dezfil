import type { DuckDBConnection } from "@duckdb/node-api";
import { connectQueryInstance, SpatialNotInstalled } from "@/lib/duckdb";

/**
 * The query engine's Test: one fixed spatial question with a known answer,
 * asked on a connection of the hardened instance, the engine that runs
 * people's SQL. With no instance in place one is started for it loading
 * only the extensions already installed, installing nothing; an instance
 * already starting is joined. A spatial extension that is not installed
 * fails that start, which is discarded, so the engine stays unstarted and
 * the next query starts it as it always has.
 */

/** The area of a 2 by 3 rectangle, which only the spatial extension answers. */
const QUESTION = "SELECT ST_Area(ST_GeomFromText('POLYGON((0 0, 2 0, 2 3, 0 3, 0 0))'))";
const AREA = 6;
/** How often the interrupt re-fires once the limit is reached, so a
 * question that starts just after it cannot slip past. */
const REINTERRUPT_MS = 250;

/** Ask the question. Past the Test's limit (`signal`) the question is
 * interrupted until it stops; the Test has answered by then. */
export async function askQueryEngine(signal: AbortSignal): Promise<"answered" | "not_found" | "failed"> {
  let conn: DuckDBConnection;
  try {
    conn = await connectQueryInstance({ install: false });
  } catch (error) {
    if (error instanceof SpatialNotInstalled) return "not_found";
    throw error;
  }
  let again: ReturnType<typeof setInterval> | undefined;
  const interrupt = () => {
    conn.interrupt();
    again ??= setInterval(() => conn.interrupt(), REINTERRUPT_MS);
  };
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    if (signal.aborted) return "failed";
    const rows = (await conn.runAndReadAll(QUESTION)).getRows();
    return rows.length === 1 && rows[0][0] === AREA ? "answered" : "failed";
  } finally {
    signal.removeEventListener("abort", interrupt);
    clearInterval(again);
    conn.disconnectSync();
  }
}
