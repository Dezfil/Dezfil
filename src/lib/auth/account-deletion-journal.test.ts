import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { writeStoredSettings } from "@/lib/settings/store";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { GET as users } from "@/app/api/users/route";
import { GET as status } from "@/app/api/users/deletions/[id]/route";
import { POST as finish } from "@/app/api/users/deletions/[id]/finish/route";
import { authenticateSession, issueSession, type AuthContext } from "./credentials";
import { changeAccountAccess, inviteAccount } from "./admin";
import * as compaction from "@/lib/metadata/account-compaction.mjs";
import { requireAvailableEmail } from "./accounts";
import { acceptAccountDeletion, finishAccountDeletion } from "./account-deletion";
import { deletionReservesEmail, discoverAccountDeletions, readDeletionJournal } from "./account-deletion-journal";

const scratch = process.env.DEZFIL_DATA_DIR!;
let directory: string, id: string, file: string, control: string, actor: AuthContext;
beforeEach(() => {
  directory = mkdtempSync(path.join(scratch, "unreadable-deletion-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); closeMetadataDb();
  for (const account of ["admin", "target", "control", "other"]) testAccountScope(undefined, account);
  const db = metadataDb();
  db.exec("UPDATE accounts SET is_admin=1 WHERE id='admin'; UPDATE accounts SET status='deactivated' WHERE id IN ('target','control')");
  actor = authenticateSession(issueSession(getAccount("admin")!, db, Date.now()).secret)!;
  id = acceptAccountDeletion(actor, "target", () => {}).id;
  control = acceptAccountDeletion(actor, "control", () => {}).id;
  file = path.join(directory, "account-deletions", `${id}.json`);
});
afterEach(() => { vi.restoreAllMocks(); closeMetadataDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const request = (url: string, method = "GET") => testAccountRequest(new Request(`http://instance.test${url}`, { method }), undefined, "admin");
const corruptions = ["{", "null", '{"version":1}'];

it.each(corruptions)("isolates an unreadable deletion from Users, invitations and access changes: %s", async text => {
  writeFileSync(file, text);
  const response = await users(request("/api/users"));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.deletions).toContainEqual({ id, state: "unreadable" });
  expect(body.deletions).toContainEqual(expect.objectContaining({ id: control, state: "pending", account: expect.objectContaining({ id: "control" }) }));
  expect(body.users.map((user: { id: string }) => user.id).sort()).toEqual(["admin", "other"]);
  expect(deletionReservesEmail("fresh@example.test")).toBe(false);
  writeStoredSettings({ peopleLimit: 5 }, metadataDb());
  expect(inviteAccount(actor, { name: "Fresh", email: "fresh@example.test" }).account.email).toBe("fresh@example.test");
  expect(changeAccountAccess(actor, "other", { isAdmin: true }).isAdmin).toBe(true);
  expect(metadataDb().prepare("SELECT status,email FROM accounts WHERE id='target'").get()).toEqual({ status: "deleting", email: "target@example.test" });
  expect(() => requireAvailableEmail("target@example.test", null, metadataDb())).toThrow(expect.objectContaining({ code: "email_taken" }));
  expect(() => changeAccountAccess(actor, "target", { status: "active" })).toThrow(expect.objectContaining({ code: "deletion_in_progress" }));
  expect(readFileSync(file, "utf8")).toBe(text);
});

it("refuses status and continuation of the unreadable deletion with a private coded error", async () => {
  writeFileSync(file, "null");
  for (const [method, route, suffix] of [["GET", status, ""], ["POST", finish, "/finish"]] as const) {
    const response = await route(request(`/api/users/deletions/${id}${suffix}`, method), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ error: { code: "deletion_unreadable" } });
  }
  expect(readFileSync(file, "utf8")).toBe("null");
});

it("preserves unreadable records and removes interrupted writes on discovery", () => {
  writeFileSync(file, "{");
  const partial = path.join(directory, "account-deletions", `${control}.json.tmp`);
  writeFileSync(partial, "unreadable interrupted write");
  const randomPartial = `${file}.11111111-1111-4111-8111-111111111111.tmp`;
  writeFileSync(randomPartial, "partial write");
  expect(() => discoverAccountDeletions()).not.toThrow();
  expect(readFileSync(file, "utf8")).toBe("{");
  expect(existsSync(partial)).toBe(false);
  expect(existsSync(randomPartial)).toBe(false);
  expect(readDeletionJournal(control).state).toBe("needs-retry");
});

it("rejects malformed identity and inventory fields before unrelated checks read them", () => {
  const original = JSON.parse(readFileSync(file, "utf8"));
  for (const malformed of [
    { ...original, identity: { ...original.identity, email: 17 } },
    { ...original, content: { ...original.content, jobs: null } },
    { ...original, files: [{ accountId: "target", file: 17, directory: false }] },
  ]) {
    writeFileSync(file, JSON.stringify(malformed));
    expect(() => readDeletionJournal(id)).toThrow(expect.objectContaining({ code: "deletion_unreadable" }));
    expect(deletionReservesEmail("unrelated@example.test")).toBe(false);
  }
});

it("skips an unreadable reservation even after the account profile has been erased", async () => {
  vi.spyOn(compaction, "compactMetadataStore").mockImplementationOnce(() => { throw new Error("compaction unavailable"); });
  expect(await finishAccountDeletion(actor, id)).toMatchObject({ state: "needs-retry" });
  expect(metadataDb().prepare("SELECT email FROM accounts WHERE id='target'").get()).toBeUndefined();
  expect(deletionReservesEmail("target@example.test")).toBe(true);
  writeFileSync(file, "{");
  expect(() => requireAvailableEmail("target@example.test", null, metadataDb())).not.toThrow();
});


it("ignores foreign JSON names without exposing or deleting them", async () => {
  const foreign = path.join(directory, "account-deletions", "private-notes.json");
  writeFileSync(foreign, "foreign contents");
  writeFileSync(file, "{");
  const response = await users(request("/api/users"));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.deletions.map((entry: { id: string }) => entry.id).sort()).toEqual([id, control].sort());
  discoverAccountDeletions();
  expect(readFileSync(foreign, "utf8")).toBe("foreign contents");
  expect(readFileSync(file, "utf8")).toBe("{");
});
