import type { Database } from "better-sqlite3";
import type { AccountActor } from "@/lib/account-actor";
import { metadataDb } from "./db";

/** Resolve on read, without rewriting the facts that retain actor identity. */
export function accountActors(ids: Iterable<string | null>, db: Database = metadataDb()): Map<string, AccountActor> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))];
  if (!wanted.length) return new Map();
  const rows = db.prepare(`SELECT id, status, name, sql_name FROM accounts
    WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(wanted)) as
    { id: string; status: string; name: string | null; sql_name: string }[];
  return new Map(rows.map(row => [row.id, row.status === "deleted"
    ? { deleted: true } : { name: row.name!, sqlName: row.sql_name }]));
}
