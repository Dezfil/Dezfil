import type { Database } from "better-sqlite3";

/** Observe the native outer boundary, after COMMIT or ROLLBACK has finished.
 * A nested savepoint never publishes. Reading the final rows also handles a
 * caught inner rollback and a deferred constraint that fails during COMMIT. */
export function observeTransactionBoundary(db: Database, settled: () => void, closed: () => void): void {
  const transaction = db.transaction, exec = db.exec, close = db.close, prepare = db.prepare;
  const boundary = <T>(run: () => T): T => {
    try { return run(); } finally { if (db.open && !db.inTransaction) settled(); }
  };
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const native = transaction.call(db, fn);
    const variants = ["default", "deferred", "immediate", "exclusive"] as const;
    const wrapped = Object.fromEntries(variants.map(mode => [mode, function (this: unknown, ...args: unknown[]) {
      return boundary(() => Reflect.apply(native[mode], this, args));
    }]));
    const properties = Object.fromEntries(variants.map(mode => [mode, { value: wrapped[mode] }]));
    for (const mode of variants) Object.defineProperties(wrapped[mode], { ...properties, database: { value: db, enumerable: true } });
    return wrapped.default;
  }) as Database["transaction"];
  db.exec = (sql: string) => boundary(() => exec.call(db, sql));
  // Explicit transaction statements are uncommon, but have the same boundary
  // whether executed directly or prepared by a caller.
  db.prepare = ((sql: string) => {
    const statement = prepare.call(db, sql);
    if (/^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) {
      const run = statement.run;
      statement.run = (...args: unknown[]) => boundary(() => Reflect.apply(run, statement, args));
    }
    return statement;
  }) as Database["prepare"];
  db.close = () => { const result = close.call(db); closed(); return result; };
}
