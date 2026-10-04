import type { Database } from "better-sqlite3";
import { getAccount } from "@/lib/metadata/accounts";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { requireAdmin } from "./admin";
import type { AuthContext } from "./credentials";
import { journalForAccount } from "./account-deletion-journal";
import { AuthError } from "./errors";

/** Authorize first, then apply self precedence and the pending reservation
 * before looking for a profile that finalization may already have removed. */
export function deletionEligibility(context: AuthContext, accountId: string, db: Database) {
  const actor = requireAdmin(context, db, Date.now());
  if (actor.id === accountId) throw new AuthError("self_change_refused", ERROR_CATALOGUE.self_change_refused, 409);
  const pending = journalForAccount(accountId);
  if (pending) return { actor, pending, account: null };
  const account = getAccount(accountId, db);
  if (!account) throw new AuthError("not_found", "Account not found.", 404);
  if (account.status === "active") throw new AuthError("account_not_deactivated", ERROR_CATALOGUE.account_not_deactivated, 409);
  return { actor, pending: null, account };
}
