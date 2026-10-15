import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { AuthError, AuthenticationCancelled, requireAuthenticationWanted } from "./errors";
import { securitySettings } from "./security-settings";

/** Fixed, as sign-in's: the stored count says how many failures, never for how long. */
export const PASSWORD_CHECK_WINDOW_MS = 15 * 60 * 1000;

/** The bucket that counts one account's current-password checks. It is
 * apart from sign-in accounting: neither resets nor charges the other. */
export const passwordCheckBucket = (accountId: string) => `check:${accountId}`;

interface Bucket { bucket: string; window_started_at: number; failures: number; pending: number; }
type Outcome = "success" | "failure" | "started-cancellation" | "refund";

/** Run one current-password check under its account's allowance: the same
 * number of failures as sign-in allows one account, in the same fixed
 * window. A check reserves its place before it waits for password work, so
 * concurrent checks never exceed what is left. A wrong or missing current
 * password counts; busy or failing password work and a caller who leaves
 * before the work starts count nothing; a caller who leaves after it starts
 * keeps that place taken until the window ends. A right password clears the
 * failures. */
export async function withPasswordCheckLimit<T>(accountId: string, check: (onStart: () => void) => Promise<T>,
  signal?: AbortSignal, db: Database = metadataDb(), clock: () => number = Date.now): Promise<T> {
  requireAuthenticationWanted(signal);
  const now = clock();
  const bucket = passwordCheckBucket(accountId);
  const row = db.transaction(() => {
    // Read on every check, so a changed count applies to the next one.
    const limit = securitySettings(db).failedPerAccount;
    const stored = db.prepare("SELECT * FROM auth_login_limits WHERE bucket = ?").get(bucket) as Bucket | undefined;
    const current = stored && now < stored.window_started_at + PASSWORD_CHECK_WINDOW_MS
      ? stored : { bucket, window_started_at: now, failures: 0, pending: 0 };
    if (current.failures + current.pending >= limit) {
      const retryAt = current.window_started_at + PASSWORD_CHECK_WINDOW_MS;
      throw new AuthError("rate_limited", "Too many wrong current passwords. Try again later.", 429,
        { retryAfter: Math.max(1, Math.ceil((retryAt - now) / 1000)), retryAt: new Date(retryAt).toISOString() });
    }
    db.prepare(`INSERT INTO auth_login_limits (bucket, window_started_at, failures, pending) VALUES (?, ?, ?, ?)
      ON CONFLICT (bucket) DO UPDATE SET window_started_at = excluded.window_started_at,
      failures = excluded.failures, pending = excluded.pending`)
      .run(bucket, current.window_started_at, current.failures, current.pending + 1);
    return current;
  }).immediate();
  const finish = (outcome: Outcome) => {
    // A started check whose caller left keeps its place until the window ends.
    if (outcome === "started-cancellation") return;
    db.prepare(`UPDATE auth_login_limits SET pending = MAX(0, pending - 1),
      failures = CASE WHEN ? THEN 0 ELSE failures + ? END
      WHERE bucket = ? AND window_started_at = ?`)
      .run(Number(outcome === "success"), Number(outcome === "failure"), bucket, row.window_started_at);
  };
  let started = false;
  let result: T;
  try { result = await check(() => { started = true; }); }
  catch (error) {
    finish(error instanceof AuthError && error.code === "current_password_required" ? "failure"
      : error instanceof AuthenticationCancelled && (error.derivationStarted || started) ? "started-cancellation" : "refund");
    throw error;
  }
  finish("success");
  return result;
}
