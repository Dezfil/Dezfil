import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import * as compaction from "@/lib/metadata/account-compaction.mjs";
import { testAccountScope } from "@/lib/test-support/accounts";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { replenishStorageReserve, STORAGE_RELEASE_BYTES, STORAGE_RESERVE_BYTES, STORAGE_RESERVE_NAME } from "@/lib/system/storage-reserve";
import { readStorageState, STORAGE_FULL_BYTES } from "@/lib/system/storage-state";
import { POST as finish } from "@/app/api/users/deletions/[id]/finish/route";
import { acceptAccountDeletion, finishAccountDeletion } from "./account-deletion";
import * as journals from "./account-deletion-journal";
import { authenticateSession, issueSession, type AuthContext } from "./credentials";
import { signIn } from "./accounts";
import { hashPassword } from "./passwords";
import { SESSION_COOKIE } from "./http";

const disk = vi.hoisted(() => ({ full: false }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, statfsSync: (...args: Parameters<typeof actual.statfsSync>) => {
    const reading = actual.statfsSync(...args);
    return disk.full ? { ...reading, bavail: 0 } : reading;
  } };
});

const root = process.env.DEZFIL_DATA_DIR!, password = "paper cranes after midnight";
const full = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
let directory: string, actor: AuthContext;
const reserveBytes = () => statSync(path.join(directory, STORAGE_RESERVE_NAME)).size;
beforeEach(async () => {
  directory = mkdtempSync(path.join(root, "deletion-storage-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); closeMetadataDb();
  for (const id of ["admin", "target"]) testAccountScope(undefined, id);
  const db = metadataDb();
  db.exec("UPDATE accounts SET is_admin=1 WHERE id='admin'; UPDATE accounts SET status='deactivated',last_sign_in_at='time' WHERE id='target'");
  db.prepare("UPDATE accounts SET password_hash=? WHERE id='admin'").run(await hashPassword(password));
  actor = authenticateSession(issueSession(getAccount("admin")!, db, Date.now()).secret)!;
  await replenishStorageReserve(() => ({ full: false, free: 4 * STORAGE_FULL_BYTES, total: 8 * STORAGE_FULL_BYTES, threshold: STORAGE_FULL_BYTES }));
  disk.full = true;
});
afterEach(() => {
  disk.full = false; vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("preserves the reserve after refused compaction, permits sign-in while full and finishes after space returns", async () => {
  const refused = vi.spyOn(compaction, "compactMetadataStore").mockImplementation(() => { throw full; });
  const accepted = acceptAccountDeletion(actor, "target", () => {});
  expect(await finishAccountDeletion(actor, accepted.id)).toEqual({ id: accepted.id, state: "needs-retry" });
  expect(journals.readDeletionJournal(accepted.id)).toMatchObject({ next: 10, state: "needs-retry" });
  expect.soft(reserveBytes()).toBe(STORAGE_RESERVE_BYTES);
  expect.soft(refused).toHaveBeenCalledTimes(1);
  await replenishStorageReserve();
  expect(readStorageState()).toMatchObject({ full: true, free: 0 });
  expect.soft(reserveBytes()).toBe(STORAGE_RESERVE_BYTES);

  const db = metadataDb(), held = reserveBytes();
  let denied = 0;
  // A fresh session needs a new slice, even if compaction spent earlier ones.
  // SQLite refuses the allocation itself; no real filesystem is filled here.
  db.function("reserve_held", () => {
    if (reserveBytes() < held) return 0;
    denied++;
    return 1;
  });
  db.exec(`CREATE TABLE full_write (bytes BLOB);
    CREATE TRIGGER full_session BEFORE INSERT ON auth_sessions WHEN reserve_held()
    BEGIN INSERT INTO full_write VALUES(zeroblob(1048576)); END;`);
  db.pragma(`max_page_count = ${db.pragma("page_count", { simple: true })}`);
  const session = await signIn(getAccount("admin")!.email, password, db);
  expect(authenticateSession(session.secret)?.account.id).toBe("admin");
  expect(denied).toBe(2);
  expect(reserveBytes()).toBe(STORAGE_RESERVE_BYTES - STORAGE_RELEASE_BYTES);
  expect(db.prepare("SELECT count(*) AS n FROM full_write").get()).toEqual({ n: 0 });

  disk.full = false; refused.mockRestore();
  db.exec("DROP TRIGGER full_session"); db.pragma("max_page_count = 4294967294");
  const origin = "http://instance.test";
  const response = await finish(socketRequest(new Request(`${origin}/api/users/deletions/${accepted.id}/finish`, {
    method: "POST", headers: { origin, cookie: `${SESSION_COOKIE}=${session.secret}` },
  })), { params: Promise.resolve({ id: accepted.id }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: accepted.id, state: "completed" });
  expect(journals.deletionJournals()).toEqual([]);
});

it.each([false, true])("recovers the journal write after compaction (refused: %s)", async refused => {
  const compact = vi.spyOn(compaction, "compactMetadataStore");
  if (refused) compact.mockImplementation(() => { throw full; });
  const accepted = acceptAccountDeletion(actor, "target", () => {});
  const write = journals.writeDeletionJournal;
  let denied = 0;
  vi.spyOn(journals, "writeDeletionJournal").mockImplementation(journal => {
    const afterCompaction = refused ? journal.state === "needs-retry" : journal.next === 11;
    if (afterCompaction && reserveBytes() === STORAGE_RESERVE_BYTES) {
      denied++;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    write(journal);
  });
  expect(await finishAccountDeletion(actor, accepted.id)).toEqual({ id: accepted.id, state: refused ? "needs-retry" : "completed" });
  expect(denied).toBe(2);
  expect(compact).toHaveBeenCalledTimes(1);
  expect(reserveBytes()).toBe(STORAGE_RESERVE_BYTES - STORAGE_RELEASE_BYTES);
  if (refused) expect(journals.readDeletionJournal(accepted.id)).toMatchObject({ next: 10, state: "needs-retry" });
  else expect(journals.deletionJournals()).toEqual([]);
});
