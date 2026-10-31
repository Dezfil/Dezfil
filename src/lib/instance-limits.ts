import type { Database } from "better-sqlite3";
import { metadataDb } from "./metadata/db";
import { deletionJournals } from "./auth/account-deletion-journal";

export interface InstanceCounts { maps: number; projects: number; people: number }

/** Counts span every owner. Installed templates occupy no map or project row.
 * A deletion keeps its place until its journal is removed, even after profile
 * erasure. The union counts an account and its journal just once. */
export function instanceCounts(db: Database = metadataDb()): InstanceCounts {
  return db.transaction(() => {
    const people = new Set((db.prepare("SELECT id FROM accounts WHERE status <> 'deleted'").all() as { id: string }[]).map(row => row.id));
    for (const journal of deletionJournals()) {
      // Unreadable records expose no identity. Their existing repair flow
      // leaves unrelated invitations and access changes available.
      if (journal.state !== "unreadable") people.add(journal.accountId);
    }
    return {
      maps: (db.prepare("SELECT count(*) AS n FROM maps").get() as { n: number }).n,
      projects: (db.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n,
      people: people.size,
    };
  })();
}
