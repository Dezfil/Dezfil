import type { Database } from "better-sqlite3";
import { secretHash } from "../link-issuance.mjs";
import { accountingSource } from "../source-group";
import { securitySettings } from "../security-settings";
import { LOGIN_WINDOW_MS } from "../login-limits";
import { AuthError } from "../errors";
interface Budget { bucket: string; window_started_at: number; failures: number; pending: number }
/** Synchronous arrivals need no pending reservation. Call under an immediate transaction. */
export function addressBudget(source: string, db: Database, now: number): Budget {
  const bucket = `source:${secretHash(accountingSource(source))}`;
  const stored = db.prepare("SELECT * FROM auth_login_limits WHERE bucket = ?").get(bucket) as Budget | undefined;
  const row = stored && now < stored.window_started_at + LOGIN_WINDOW_MS ? stored : { bucket, window_started_at: now, failures: 0, pending: 0 };
  if (row.failures + row.pending >= securitySettings(db).failedPerAddress) {
    const retryAt = row.window_started_at + LOGIN_WINDOW_MS;
    throw new AuthError("rate_limited", "Too many sign-in attempts. Try again later.", 429,
      { retryAfter: Math.max(1, Math.ceil((retryAt - now) / 1000)), retryAt: new Date(retryAt).toISOString() });
  }
  return row;
}
export function recordAddressAttempt(row: Budget, failed: boolean, db: Database): void {
  db.prepare(`INSERT INTO auth_login_limits (bucket, window_started_at, failures, pending)
    VALUES (@bucket, @window_started_at, @failures, @pending)
    ON CONFLICT (bucket) DO UPDATE SET window_started_at=excluded.window_started_at,
      failures=excluded.failures,pending=excluded.pending`).run({ ...row, failures: row.failures + Number(failed) });
}
