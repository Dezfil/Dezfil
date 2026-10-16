import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { GET as status } from "@/app/api/users/deletions/[id]/route";
import { authenticateSession, issueSession } from "./credentials";
import { acceptAccountDeletion } from "./account-deletion";
import { admitAccountWork, drainAccountWork, type AccountWorkLease } from "./account-deletion-admission";

/**
 * A deletion's first stage waits for every read admitted before it to
 * settle. A read that is never released keeps it waiting for ever, so the
 * wait is told: the status of a pending deletion carries how many
 * admitted reads it still waits on, and the server log says so, once,
 * when the wait has lasted a minute.
 */

const scratch = process.env.DEZFIL_DATA_DIR!;
let directory: string, id: string, leaked: AccountWorkLease | null;
beforeEach(() => {
  directory = mkdtempSync(path.join(scratch, "deletion-waiting-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); closeMetadataDb();
  for (const account of ["admin", "target"]) testAccountScope(undefined, account);
  const db = metadataDb();
  db.exec("UPDATE accounts SET is_admin=1 WHERE id='admin'; UPDATE accounts SET status='deactivated' WHERE id='target'");
  // A read of the target's material admitted before the deletion, which
  // its consumer never releases.
  leaked = admitAccountWork(["target"]);
  const actor = authenticateSession(issueSession(getAccount("admin")!, db, Date.now()).secret)!;
  id = acceptAccountDeletion(actor, "target", () => {}).id;
});
afterEach(() => {
  leaked?.release();
  vi.useRealTimers(); vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const request = (url: string) => testAccountRequest(new Request(`http://instance.test${url}`), undefined, "admin");
const read = async () => (await status(request(`/api/users/deletions/${id}`), { params: Promise.resolve({ id }) })).json();

it("says in a pending deletion's status how many admitted reads it still waits on", async () => {
  expect(await read()).toEqual({ id, state: "pending", admittedReads: 1 });
  leaked!.release(); leaked = null;
  expect(await read()).toEqual({ id, state: "pending", admittedReads: 0 });
});

it("names the wait in the server log once it has lasted a minute, and only then", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let drained = false;
  const draining = drainAccountWork("target").then(() => { drained = true; });
  await vi.advanceTimersByTimeAsync(59_000);
  expect(warn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(drained).toBe(false);
  expect(warn.mock.calls).toEqual([["Account deletion has waited 60 s for 1 admitted read to settle"]]);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(warn).toHaveBeenCalledOnce();
  leaked!.release(); leaked = null;
  await draining;
  expect(drained).toBe(true);
});

it("logs nothing for a wait that ends in time", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const draining = drainAccountWork("target");
  await vi.advanceTimersByTimeAsync(10_000);
  leaked!.release(); leaked = null;
  await draining;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(warn).not.toHaveBeenCalled();
});
