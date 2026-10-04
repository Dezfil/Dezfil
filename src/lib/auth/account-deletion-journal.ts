import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { dataDir } from "@/lib/config";
import { metadataDb } from "@/lib/metadata/db";
import type { AccountContentCapture } from "@/lib/metadata/account-erasure-content";
import { AuthError } from "./errors";

export interface DeletionJournal {
  version: 1; id: string; accountId: string; actorId: string; invited: boolean;
  identity: { name: string; email: string; isAdmin: boolean };
  content: AccountContentCapture;
  files: { accountId: string; file: string; directory: boolean }[];
  next: number; state: "pending" | "needs-retry";
}
const folder = () => path.join(dataDir(), "account-deletions");
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
function journalPath(id: string) {
  if (!validId(id)) throw new AuthError("not_found", "Deletion not found.", 404);
  return path.join(folder(), `${id}.json`);
}
function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function emptyFolder(): void {
  if (readdirSync(folder()).length === 0) { rmdirSync(folder()); syncDirectory(dataDir()); }
}
/** A journal is durable before the acceptance transaction can commit. A
 * partial write never replaces the last durable progress record. */
export function writeDeletionJournal(journal: DeletionJournal): void {
  mkdirSync(folder(), { recursive: true, mode: 0o700 });
  const target = journalPath(journal.id), temp = `${target}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "w", 0o600); writeFileSync(fd, JSON.stringify(journal)); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, target); syncDirectory(folder()); syncDirectory(dataDir());
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export function readDeletionJournal(id: string): DeletionJournal {
  let value: DeletionJournal;
  try { value = JSON.parse(readFileSync(journalPath(id), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AuthError("not_found", "Deletion not found.", 404); throw error; }
  if (value.version !== 1 || value.id !== id || !value.accountId || !value.actorId ||
    !Number.isInteger(value.next) || value.next < 0 || value.next > 11 ||
    !["pending", "needs-retry"].includes(value.state) || !value.identity?.email ||
    !Array.isArray(value.content?.datasets) || !Array.isArray(value.files)) throw new Error("Invalid account deletion journal.");
  return value;
}
export function deletionJournals(): DeletionJournal[] {
  let names: string[];
  try { names = readdirSync(folder()); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.filter(name => name.endsWith(".json")).map(name => readDeletionJournal(name.slice(0, -5)));
}
export function journalForAccount(id: string): DeletionJournal | null { return deletionJournals().find(j => j.accountId === id) ?? null; }
export function removeDeletionJournal(id: string): void {
  const journal = readDeletionJournal(id);
  try { unlinkSync(journalPath(id)); syncDirectory(folder()); emptyFolder(); }
  catch (error) { writeDeletionJournal(journal); throw error; }
}
/** A refused transaction leaves exactly the directory listing it found. */
export function discardPreparedJournal(id: string): void {
  for (const file of [journalPath(id), `${journalPath(id)}.tmp`]) {
    try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  try { emptyFolder(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
/** Startup only: no deletion is executed here. Accepted work is made visible
 * for continuation; rolled-back preparations and interrupted writes disappear. */
export function discoverAccountDeletions(db: Database = metadataDb()): void {
  for (const journal of deletionJournals()) {
    const account = db.prepare("SELECT status FROM accounts WHERE id = ?").get(journal.accountId) as { status: string } | undefined;
    if (account?.status === "deleting" || account?.status === "deleted" || !account && journal.invited && journal.next >= 9) {
      writeDeletionJournal({ ...journal, state: "needs-retry" });
    } else discardPreparedJournal(journal.id);
  }
  let names: string[];
  try { names = readdirSync(folder()); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names) if (name.endsWith(".tmp")) unlinkSync(path.join(folder(), name));
  emptyFolder();
}
