import { currentStorageWriter, withStorageWrite } from "@/lib/system/storage-fence";
import { rethrowStorageFailure } from "@/lib/system/storage-errors";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { dataDir } from "@/lib/config";
import { metadataDb } from "@/lib/metadata/db";
import { getAccount, type Account } from "@/lib/metadata/accounts";
import { admitAccountWork } from "@/lib/auth/account-deletion-admission";
import { inDeletionWork } from "@/lib/auth/account-deletion-work";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { ownedFileRecords, registerAccountFile, removeAccountFile } from "@/lib/ingest/file-ownership";

/**
 * The profile pictures: one live file per account in `profile-pictures/`,
 * named `<account id>.<version>.webp`, the version a random token minted for
 * every picture set and kept on the account's row. A file is the account's
 * picture only while the row names its version; anything else in the folder
 * is left over, and the start-up sweep removes it.
 *
 * Every write to an account's picture (a person's own upload or removal, an
 * admin's removal) takes its place in the account's order when it is
 * admitted, before its body is read. Its work runs under the account work
 * lease that a deletion drains, and it publishes in the account's turn, one
 * at a time, only if no write admitted after it has published already. The
 * row's commit is the success boundary: a failure before it leaves the
 * previous picture and removes the new file; after it, removing the old file
 * is a cleanup obligation, kept by its ownership record when it fails.
 */
export const PICTURE_FOLDER = "profile-pictures";
const PARTIAL = ".part";

const folder = () => path.join(dataDir(), PICTURE_FOLDER);
/** The stored file's name for an account's picture version. */
export const pictureName = (accountId: string, version: string) => `${accountId}.${version}.webp`;
/** Where an account's picture version is stored. */
export const picturePath = (accountId: string, version: string) => path.join(folder(), pictureName(accountId, version));
/** Where a new picture's bytes land before they are put in place. */
const partialPath = (accountId: string, version: string) => path.join(folder(), pictureName(accountId, version) + PARTIAL);

/** A new version: random, so no address is guessable and the same bytes set
 * twice still make a new one. */
export function mintPictureVersion(): string {
  return randomBytes(16).toString("base64url");
}

interface AccountWrites {
  /** The order number the next admitted write takes. */
  admitted: number;
  /** The order number of the last write that published. */
  published: number;
  /** The writes admitted and not yet released. */
  readonly live: Set<number>;
  /** The publishing turn: the last write's publication, settled. */
  turn: Promise<void>;
}

// One order per account for the whole instance, shared by every compiled
// copy of the routes that write pictures. An account appears here only
// while one of its writes is admitted and unreleased, under a work lease.
const key = Symbol.for("dezfil.profile-picture-writes");
const host = globalThis as typeof globalThis & { [key]?: Map<string, AccountWrites> };
const pictureWrites = host[key] ??= new Map<string, AccountWrites>();

function accountWrites(): AccountWrites {
  return { admitted: 0, published: 0, live: new Set(), turn: Promise.resolve() };
}
const writesKey = (accountId: string, db: Database) => `${db.name}\0${accountId}`;

/** The accounts with picture writes admitted on this instance. */
export function pictureWriteAccounts(): string[] {
  return [...pictureWrites.keys()].map((entry) => entry.slice(entry.indexOf("\0") + 1)).sort();
}

/** One admitted write to one account's picture. */
export interface PictureWrite {
  readonly actorId: string;
  readonly subjectId: string;
  /** Its place in the subject's order, fixed at admission. */
  readonly sequence: number;
  /** Run work (reception, processing) under the write's work lease. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Give the place and the lease back, once everything has settled. */
  release(error?: unknown): void;
}

/** Admit a write to the subject's picture by the actor. Refused, as an
 * account that is not there, once the subject's or the actor's deletion has
 * been accepted. */
export function admitPictureWrite(actorId: string, subjectId: string, db: Database = metadataDb()): PictureWrite {
  const lease = admitAccountWork([actorId, subjectId], db);
  const at = writesKey(subjectId, db);
  const writes = pictureWrites.get(at) ?? accountWrites();
  pictureWrites.set(at, writes);
  writes.admitted += 1;
  const sequence = writes.admitted;
  writes.live.add(sequence);
  return {
    actorId, subjectId, sequence,
    run: (work) => inDeletionWork(lease, work),
    release(error) {
      if (!writes.live.delete(sequence)) return;
      if (!writes.live.size && pictureWrites.get(at) === writes) pictureWrites.delete(at);
      lease.release(error);
    },
  };
}

/** What a write's publication did. A write that lost to one admitted after
 * it changes nothing; either way the account is answered as it stands. */
export interface PictureOutcome {
  readonly outcome: "published" | "superseded";
  readonly account: Account;
}

/** Make `picture` the subject's picture, or remove it when null, in the
 * subject's turn. `authorize` runs inside the commit and throws when the
 * actor may no longer make the change. */
function publishPictureWork(write: PictureWrite, picture: Buffer | null, authorize: (db: Database) => void,
  db: Database = metadataDb()): Promise<PictureOutcome> {
  const writes = pictureWrites.get(writesKey(write.subjectId, db));
  if (!writes?.live.has(write.sequence)) return Promise.reject(new Error("The picture write has been released."));
  const publication = writes.turn.then(() => write.run(() => publishInTurn(write, writes, picture, authorize, db)));
  writes.turn = publication.then(() => undefined, () => undefined);
  return publication;
}

async function publishInTurn(write: PictureWrite, writes: AccountWrites, picture: Buffer | null,
  authorize: (db: Database) => void, db: Database): Promise<PictureOutcome> {
  if (writes.published > write.sequence) return { outcome: "superseded", account: standing(write, authorize, db) };
  const version = picture ? await placeCandidate(write.subjectId, picture) : null;
  const previous = await commit(write, version, authorize, db).catch(async (error: unknown) => {
    if (version) await discardCandidate(write.subjectId, version);
    rethrowStorageFailure(error);
    throw error;
  });
  writes.published = write.sequence;
  if (previous && previous !== version) await retire(write.subjectId, previous);
  return { outcome: "published", account: standing(write, authorize, db) };
}

/** The account as it stands, read only while the actor may still ask. */
function standing(write: PictureWrite, authorize: (db: Database) => void, db: Database): Account {
  return db.transaction(() => {
    authorize(db);
    const account = getAccount(write.subjectId, db);
    if (!account) throw resourceAbsent();
    return account;
  }).immediate();
}

/** The success boundary: the actor still allowed, the subject's material
 * still available, then the row names the new version. Answers the version
 * it replaced. */
async function commit(write: PictureWrite, version: string | null, authorize: (db: Database) => void, db: Database): Promise<string | null> {
  return db.transaction(() => {
    currentStorageWriter()?.assertCanCommit();
    authorize(db);
    const row = db.prepare("SELECT picture_version FROM accounts WHERE id = ? AND status NOT IN ('deleting', 'deleted')")
      .get(write.subjectId) as { picture_version: string | null } | undefined;
    if (!row) throw resourceAbsent();
    db.prepare("UPDATE accounts SET picture_version = ? WHERE id = ?").run(version, write.subjectId);
    return row.picture_version;
  }).immediate();
}

/** Write the new file beside the live one: both its names are registered to
 * the account before a byte is written, the bytes land under the partial
 * name, and a rename puts them in place. Answers the new version. */
async function placeCandidate(accountId: string, picture: Buffer): Promise<string> {
  const version = mintPictureVersion();
  try {
    registerAccountFile(accountId, partialPath(accountId, version));
    registerAccountFile(accountId, picturePath(accountId, version));
    await mkdir(folder(), { recursive: true });
    await writeFile(partialPath(accountId, version), picture, { flag: "wx", signal: currentStorageWriter()?.signal });
    currentStorageWriter()?.assertCanCommit();
    await rename(partialPath(accountId, version), picturePath(accountId, version));
    await removeAccountFile(partialPath(accountId, version));
  } catch (error) {
    await discardCandidate(accountId, version);
    rethrowStorageFailure(error);
    throw error;
  }
  return version;
}

/** Remove a new file that never became the picture, and its records. A
 * removal that fails keeps its record, which the start-up sweep and the
 * account's deletion act on. */
async function discardCandidate(accountId: string, version: string): Promise<void> {
  await Promise.allSettled([removeAccountFile(partialPath(accountId, version)), removeAccountFile(picturePath(accountId, version))]);
}

/** Remove the picture a commit replaced. The change has succeeded whatever
 * happens here: a failed removal keeps the file's ownership record. */
async function retire(accountId: string, version: string): Promise<void> {
  await removeAccountFile(picturePath(accountId, version)).catch((error: unknown) => {
    console.warn("A replaced profile picture could not be removed yet; it goes at the next start or with its account.", error);
  });
}

/** At start-up: remove every file in the folder that is not an account's
 * current picture (a replaced one whose removal failed, a partial write, a
 * new file whose commit never happened), and the ownership records of
 * pictures no longer there. Answers how many files went. */
export async function sweepProfilePictures(db: Database = metadataDb()): Promise<number> {
  const current = new Set((db.prepare("SELECT id, picture_version FROM accounts WHERE picture_version IS NOT NULL").all() as
    { id: string; picture_version: string }[]).map((row) => pictureName(row.id, row.picture_version)));
  const names = await readdir(folder()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    rethrowStorageFailure(error);
    throw error;
  });
  const leftovers = names.filter((name) => !current.has(name));
  for (const name of leftovers) await removeAccountFile(path.join(folder(), name), { recursive: true });
  const recorded = ownedFileRecords().filter((record) => record.file.startsWith(`${PICTURE_FOLDER}/`))
    .map((record) => record.file.slice(PICTURE_FOLDER.length + 1));
  for (const name of recorded) if (!current.has(name)) await removeAccountFile(path.join(folder(), name));
  if (leftovers.length) console.warn(`boot sweep: removed ${leftovers.length} profile picture ${leftovers.length === 1 ? "file" : "files"} no account names`);
  return leftovers.length;
}

export function publishPicture(...args: Parameters<typeof publishPictureWork>): Promise<PictureOutcome> {
  return args[1] === null ? publishPictureWork(...args) : withStorageWrite(() => publishPictureWork(...args), args[1].byteLength);
}
