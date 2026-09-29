import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { requireCurrentActor, type AuthContext } from "./credentials";
import { AuthError } from "./errors";

const accountScopeBrand: unique symbol = Symbol("account scope");
export interface AccountScope {
  readonly accountId: string;
  readonly [accountScopeBrand]: true;
}

/** Only authenticated entry points mint scopes. Request bodies never do. */
export function accountScope(context: AuthContext, db: Database = metadataDb()): AccountScope {
  const account = requireCurrentActor(context, db);
  return Object.freeze({ accountId: account.id, [accountScopeBrand]: true as const });
}

/** Recheck activity at commit, including work that outlives its request. */
export function requireAccountScope(scope: AccountScope, db: Database = metadataDb()): string {
  if (!scope || scope[accountScopeBrand] !== true || getAccount(scope.accountId, db)?.status !== "active") {
    throw new AuthError("authentication_required", "Sign in to continue.", 401);
  }
  return scope.accountId;
}
