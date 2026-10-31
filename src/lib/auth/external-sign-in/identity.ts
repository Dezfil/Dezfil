import type { Database } from "better-sqlite3";
import { getAccount, getAccountByEmail, normalizeEmail } from "@/lib/metadata/accounts";
import { requireAvailableEmail } from "../accounts";
import { AuthError } from "../errors";
import type { Ticket } from "./ticket";

/** Resolve without writing: a refused arrival may commit only its address charge. */
export function resolveTicketIdentity(ticket: Ticket, db: Database) {
  const bound = db.prepare("SELECT id FROM accounts WHERE external_identity = ?").get(ticket.sub) as { id: string } | undefined;
  const account = bound ? getAccount(bound.id, db) : getAccountByEmail(ticket.email, db);
  const unknown = () => new AuthError("account_not_invited", `There is no account for ${ticket.email} on this instance. Ask its admin for an invitation.`, 403);
  if (!account) throw unknown();
  const identity = db.prepare("SELECT external_identity FROM accounts WHERE id = ?").get(account.id) as { external_identity: string | null };
  if (identity.external_identity !== null && identity.external_identity !== ticket.sub) throw unknown();
  if (account.status === "deactivated") throw new AuthError("account_deactivated", "This account is deactivated. Contact an admin.", 403);
  requireAvailableEmail(ticket.email, account.id, db);
  const name = account.isOriginal && account.status === "invited" && !account.name
    ? ticket.name?.trim() || normalizeEmail(ticket.email) : account.name;
  return { account, name, email: normalizeEmail(ticket.email) };
}
