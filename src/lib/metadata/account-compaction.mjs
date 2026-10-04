import { statSync } from "node:fs";

/** Internal maintenance primitive. Call only after admitted readers/writers
 * have drained. Keeping VACUUM and checkpoint in one synchronous turn excludes
 * application statements across bundle copies in this process; outside readers
 * are bounded by the lock wait and must release before retry can finish.
 * This never declares an account deletion complete. */
export function compactMetadataStore(db) {
  if (db.inTransaction || db.memory || db.readonly) throw new Error("Compaction requires an open writable file store outside a transaction.");
  if (db.pragma("journal_mode", { simple: true }) !== "wal") throw new Error("Compaction requires the live WAL store.");
  const timeout = db.pragma("busy_timeout", { simple: true });
  const started = performance.now();
  try {
    db.pragma("busy_timeout = 250");
    db.exec("VACUUM");
    const result = db.pragma("wal_checkpoint(TRUNCATE)");
    if (result.length !== 1 || result[0].busy !== 0 || result[0].log !== 0 || result[0].checkpointed !== 0) {
      throw new Error("Account erasure is unfinished: WAL checkpoint did not truncate.");
    }
    const walBytes = statSync(`${db.name}-wal`).size;
    if (walBytes !== 0) throw new Error("Account erasure is unfinished: live WAL bytes remain.");
    return { elapsedMs: performance.now() - started, walBytes };
  } finally {
    db.pragma(`busy_timeout = ${timeout}`);
  }
}
