import type { DuckDBInstance } from "@duckdb/node-api";

const attempts = new WeakMap<DuckDBInstance, Promise<boolean>>();

/** One optional load/install attempt per trusted instance, including failures.
 * Own the connection so concurrent ingests cannot close it under the loader. */
export function loadTrustedH3(instance: DuckDBInstance): Promise<boolean> {
  const existing = attempts.get(instance);
  if (existing) return existing;
  const attempt = (async () => {
    const conn = await instance.connect();
    try {
      try { await conn.run("LOAD h3"); }
      catch {
        await conn.run("INSTALL h3 FROM community");
        await conn.run("LOAD h3");
      }
      return true;
    } catch { return false; }
    finally { conn.disconnectSync(); }
  })().catch(() => false);
  attempts.set(instance, attempt);
  return attempt;
}
