import type { Database } from "better-sqlite3";

export function sqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_"));
}

/** Connection-local and synchronous: restore the caller's wait on every exit. */
export function withBusyTimeout<T>(db: Database, milliseconds: number, action: () => T): T {
  const before = db.pragma("busy_timeout", { simple: true }) as number;
  try {
    db.pragma(`busy_timeout = ${milliseconds}`);
    return action();
  } finally { db.pragma(`busy_timeout = ${before}`); }
}

/** SQLite can refuse a WAL switch without invoking its busy handler. Retry
 * within the connection's existing wait budget, including each native wait. */
export function enableWal(db: Database): void {
  const timeout = db.pragma("busy_timeout", { simple: true }) as number;
  const deadline = performance.now() + timeout;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const remaining = Math.max(0, Math.floor(deadline - performance.now()));
    try {
      withBusyTimeout(db, remaining, () => db.pragma("journal_mode = WAL"));
      return;
    } catch (error) {
      if (!sqliteBusy(error) || performance.now() >= deadline) throw error;
      Atomics.wait(sleeper, 0, 0, Math.min(10, deadline - performance.now()));
    }
  }
}
