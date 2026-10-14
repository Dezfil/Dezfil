import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { dataDir } from "@/lib/config";
import { normalizeEmail } from "@/lib/metadata/accounts";
import { metadataDb } from "@/lib/metadata/db";
import type { AccountContentCapture } from "@/lib/metadata/account-erasure-content";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { AuthError } from "./errors";

export interface DeletionJournal {
  version: 1; id: string; accountId: string; actorId: string; invited: boolean;
  identity: { name: string; email: string; isAdmin: boolean };
  content: AccountContentCapture;
  files: { accountId: string; file: string; directory: boolean }[];
  next: number; state: "pending" | "needs-retry";
}
export interface UnreadableDeletionJournal { id: string; state: "unreadable" }

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
  const target = journalPath(journal.id), temp = `${target}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "w", 0o600); writeFileSync(fd, JSON.stringify(journal)); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, target); syncDirectory(folder()); syncDirectory(dataDir());
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function readable(value: unknown, id: string): value is DeletionJournal {
  if (!object(value) || value.version !== 1 || value.id !== id ||
    typeof value.accountId !== "string" || !value.accountId || typeof value.actorId !== "string" || !value.actorId ||
    typeof value.invited !== "boolean" || !Number.isInteger(value.next) || Number(value.next) < 0 || Number(value.next) > 11 ||
    !["pending", "needs-retry"].includes(String(value.state))) return false;
  const identity = value.identity, content = value.content;
  if (!object(identity) || typeof identity.name !== "string" || typeof identity.email !== "string" || !identity.email ||
    typeof identity.isAdmin !== "boolean" || !object(content)) return false;
  if (!["maps", "workflows", "steps", "runs", "jobs", "connections"].every(key => strings(content[key]))) return false;
  if (!Array.isArray(content.datasets) || !content.datasets.every(item => object(item) &&
    typeof item.id === "string" && typeof item.file === "string" && typeof item.source === "string" &&
    (item.sourceParams === null || typeof item.sourceParams === "string"))) return false;
  if (!Array.isArray(content.layers) || !content.layers.every(item => object(item) && typeof item.id === "string" && typeof item.mapId === "string")) return false;
  return Array.isArray(value.files) && value.files.every(item => object(item) &&
    typeof item.accountId === "string" && typeof item.file === "string" && typeof item.directory === "boolean");
}
export function readDeletionJournal(id: string): DeletionJournal {
  const file = journalPath(id);
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (readable(value, id)) return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AuthError("not_found", "Deletion not found.", 404);
  }
  throw new AuthError("deletion_unreadable", ERROR_CATALOGUE.deletion_unreadable, 409);
}
export function deletionJournals(): (DeletionJournal | UnreadableDeletionJournal)[] {
  let names: string[];
  try { names = readdirSync(folder()); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.filter(name => name.endsWith(".json")).flatMap((name): (DeletionJournal | UnreadableDeletionJournal)[] => {
    const id = name.slice(0, -5);
    if (!validId(id)) return [{ id, state: "unreadable" }];
    try { return [readDeletionJournal(id)]; }
    catch (error) {
      if (error instanceof AuthError && error.code === "not_found") return [];
      if (error instanceof AuthError && error.code === "deletion_unreadable") return [{ id, state: "unreadable" }];
      throw error;
    }
  });
}
export function journalForAccount(id: string): DeletionJournal | null {
  return deletionJournals().find((journal): journal is DeletionJournal => journal.state !== "unreadable" && journal.accountId === id) ?? null;
}
export function deletionReservesEmail(email: string): boolean {
  return deletionJournals().some(journal => journal.state !== "unreadable" && normalizeEmail(journal.identity.email) === normalizeEmail(email));
}
export function removeDeletionJournal(id: string): void {
  const journal = readDeletionJournal(id);
  try { unlinkSync(journalPath(id)); syncDirectory(folder()); emptyFolder(); }
  catch (error) { writeDeletionJournal(journal); throw error; }
}
/** A refused transaction leaves exactly the directory listing it found. */
export function discardPreparedJournal(id: string): void {
  try { unlinkSync(journalPath(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { emptyFolder(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
/** Startup only: no deletion is executed here. Accepted work is made visible
 * for continuation; readable rolled-back preparations disappear. Unreadable
 * journals and interrupted temporary files remain for repair. */
export function discoverAccountDeletions(db: Database = metadataDb()): void {
  for (const journal of deletionJournals()) {
    if (journal.state === "unreadable") continue;
    const account = db.prepare("SELECT status FROM accounts WHERE id = ?").get(journal.accountId) as { status: string } | undefined;
    if (account?.status === "deleting" || account?.status === "deleted" || !account && journal.invited && journal.next >= 9) {
      writeDeletionJournal({ ...journal, state: "needs-retry" });
    } else removeDeletionJournal(journal.id);
  }
  try { emptyFolder(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
