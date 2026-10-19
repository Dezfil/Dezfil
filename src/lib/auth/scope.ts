import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { requireCurrentActor, type AuthContext } from "./credentials";
import { AuthError } from "./errors";

const accountScopeBrand: unique symbol = Symbol("account scope");
export interface AccountScope {
  readonly accountId: string;
  readonly workKey?: string;
  readonly [accountScopeBrand]: true;
}

/** Only authenticated entry points mint scopes. Request bodies never do. */
export function accountScope(context: AuthContext, db: Database = metadataDb()): AccountScope {
  const account = requireCurrentActor(context, db);
  return Object.freeze({ accountId: account.id, ...(context.workKey ? { workKey: context.workKey } : {}), [accountScopeBrand]: true as const });
}

/** Recheck activity at commit, including work that outlives its request. */
export function requireAccountScope(scope: AccountScope, db: Database = metadataDb()): string {
  if (!scope || scope[accountScopeBrand] !== true || getAccount(scope.accountId, db)?.status !== "active") {
    throw new AuthError("authentication_required", "Sign in to continue.", 401);
  }
  return scope.accountId;
}

/** A server attempt authenticates from its narrow, expiring row. Ordinary
 * bearer and session authentication never call this entry point. */
export function pictureWorkScope(secret: string, db: Database = metadataDb(), now = Date.now()): { scope: AccountScope; mapId: string } {
  const workKey = createHash("sha256").update(secret).digest("hex");
  const row = db.prepare(`SELECT p.map_id AS mapId, m.owner_id AS ownerId FROM map_pictures p
    JOIN maps m ON m.id = p.map_id JOIN accounts a ON a.id = m.owner_id
    WHERE p.work_key = ? AND p.work_expires_at > ? AND p.work_owner = m.owner_id AND a.status = 'active'`).get(workKey, now) as { mapId: string; ownerId: string } | undefined;
  if (!secret.startsWith("dz_picture_") || !row) throw new AuthError("authentication_required", "Sign in to continue.", 401);
  return { mapId: row.mapId, scope: Object.freeze({ accountId: row.ownerId, workKey, [accountScopeBrand]: true as const }) };
}
