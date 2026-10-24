import type { Database } from "better-sqlite3";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { normalizeEmail, personLabel, type PersonLabel } from "@/lib/metadata/accounts";
import { DIRECTORY_LIMIT, DIRECTORY_QUERY_MAX } from "./directory-bounds";
import { requireAccountScope, type AccountScope } from "./scope";

/**
 * The directory: how a signed-in person finds someone to share a project
 * with. It is the one deliberate exception to account reads being an
 * admin's, and it is kept minimal: active accounts other than the caller,
 * found by any part of their display name or by their exact email, each
 * answered as a display name, a SQL name and, while they have a picture,
 * its version, and nothing else.
 */

export type DirectoryPerson = PersonLabel;

type Row = { name: string; email: string; sql_name: string; picture_version: string | null };

/** Active people matching the query, an exact email first, then by name. An
 * empty query answers nobody. */
export function findAccounts(scope: AccountScope, query: string | null, db: Database = metadataDb()): DirectoryPerson[] {
  const me = requireAccountScope(scope, db);
  const text = (query ?? "").trim();
  if (text.length > DIRECTORY_QUERY_MAX) {
    throw new ApiError("invalid_request", `"q" must be at most ${DIRECTORY_QUERY_MAX} characters.`, 400);
  }
  if (text === "") return [];
  const part = text.toLowerCase();
  const email = normalizeEmail(text);
  const rows = db.prepare("SELECT name, email, sql_name, picture_version FROM accounts WHERE status = 'active' AND id <> ?").all(me) as Row[];
  const byEmail = (row: Row) => (row.email === email ? 0 : 1);
  const key = (row: Row) => row.name.toLowerCase();
  return rows
    .filter(row => row.email === email || row.name.toLowerCase().includes(part))
    .sort((a, b) => byEmail(a) - byEmail(b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) ||
      (a.sql_name < b.sql_name ? -1 : a.sql_name > b.sql_name ? 1 : 0))
    .slice(0, DIRECTORY_LIMIT)
    .map(row => personLabel(row.name, row.sql_name, row.picture_version));
}
