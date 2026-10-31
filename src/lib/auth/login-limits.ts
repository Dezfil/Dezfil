import { withStorageRecovery } from "@/lib/system/storage-reserve";
import { requirePasswordSignIn } from "./external-sign-in/refusal";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { normalizeEmail } from "@/lib/metadata/accounts";
import { signIn } from "./accounts";
import { requireIngress } from "./ingress.mjs";
import { accountingSource } from "./source-group";
import { secretHash } from "./credentials";
import { AuthError, AuthenticationCancelled } from "./errors";
import { securitySettings } from "./security-settings";

/** Fixed: the stored counts say how many failures, never for how long. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
interface Bucket { bucket: string; window_started_at: number; failures: number; pending: number; }

export async function withLoginLimit<T>(email: string, source: string, operation: () => Promise<T>,
  db: Database = metadataDb(), clock: () => number = Date.now): Promise<T> {
  const now = clock();
  const accountKey = `account:${secretHash(normalizeEmail(email))}`;
  // An IPv6 source shares its address budget with the rest of its /64; a
  // NAT64 source is charged as the IPv4 client it carries.
  const sourceKey = `source:${secretHash(accountingSource(source))}`;
  const reservations = await withStorageRecovery(() => db.transaction(() => {
    // Read inside the reservation on every attempt, so a lowered count pauses
    // the next attempt and a raised one admits it, with no restart.
    const { failedPerAccount, failedPerAddress } = securitySettings(db);
    const buckets = [[accountKey, failedPerAccount], [sourceKey, failedPerAddress]] as const;
    const rows = buckets.map(([bucket, limit]) => {
      const stored = db.prepare("SELECT * FROM auth_login_limits WHERE bucket = ?").get(bucket) as Bucket | undefined;
      const row = stored && now < stored.window_started_at + LOGIN_WINDOW_MS
        ? stored : { bucket, window_started_at: now, failures: 0, pending: 0 };
      return { row, limit };
    });
    const sourceBucket = rows.find(({ row }) => row.bucket === sourceKey)!.row;
    // Account failures must not lock out a source that has not failed itself.
    // Both reservations still record failures; source capacity always applies.
    const blocked = rows.filter(({ row, limit }) => row.failures + row.pending >= limit
      && (row.bucket === sourceKey || sourceBucket.failures > 0));
    if (blocked.length) {
      const retryAt = Math.max(...blocked.map(({ row }) =>
        Math.min(row.window_started_at, sourceBucket.window_started_at) + LOGIN_WINDOW_MS));
      throw new AuthError("rate_limited", "Too many sign-in attempts. Try again later.", 429,
        { retryAfter: Math.max(1, Math.ceil((retryAt - now) / 1000)), retryAt: new Date(retryAt).toISOString() });
    }
    db.prepare("DELETE FROM auth_login_limits WHERE window_started_at <= ?").run(now - LOGIN_WINDOW_MS);
    for (const { row } of rows) {
      db.prepare(`INSERT INTO auth_login_limits (bucket, window_started_at, failures, pending) VALUES (?, ?, ?, ?)
        ON CONFLICT (bucket) DO UPDATE SET window_started_at = excluded.window_started_at,
        failures = excluded.failures, pending = excluded.pending`)
        .run(row.bucket, row.window_started_at, row.failures, row.pending + 1);
    }
    return rows.map(({ row }) => row);
  }).immediate());
  const finish = (outcome: "success" | "failure" | "started-cancellation" | "refund") => db.transaction(() => {
    for (const row of reservations) {
      // Started cancellations keep source capacity reserved until its window expires.
      if (outcome === "started-cancellation" && row.bucket === sourceKey) continue;
      db.prepare(`UPDATE auth_login_limits SET pending = MAX(0, pending - 1),
        failures = CASE WHEN ? THEN 0 ELSE failures + ? END
        WHERE bucket = ? AND window_started_at = ?`)
        .run(Number(outcome === "success" && row.bucket === accountKey), Number(outcome === "failure"), row.bucket, row.window_started_at);
    }
  }).immediate();
  let result: T;
  try { result = await operation(); }
  catch (error) {
    await withStorageRecovery(() => finish(error instanceof AuthError && ["invalid_credentials", "account_deactivated"].includes(error.code) ? "failure"
      : error instanceof AuthenticationCancelled && error.derivationStarted ? "started-cancellation" : "refund"));
    throw error;
  }
  await withStorageRecovery(() => finish("success"));
  return result;
}

/** Entry routes get their source from verified socket provenance, never a caller header. */
export async function signInFromRequest(request: Request, email: string, password: string,
  db: Database = metadataDb()) {
  requirePasswordSignIn();
  let source: string;
  try { source = requireIngress(request.headers).source; }
  catch { throw new AuthError("ingress_unavailable", "The instance cannot accept sign-ins yet.", 503); }
  return withLoginLimit(email, source, () => signIn(email, password, db, undefined, request.signal), db);
}
