import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { getAccount, insertAccount, setupComplete } from "@/lib/metadata/accounts";
import { testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, issueSession, type AuthContext } from "./credentials";
import { acceptAccountDeletion, finishAccountDeletion, pendingAccountDeletion } from "./account-deletion";
import { journalForAccount } from "./account-deletion-journal";
import { changeAccountAccess, inviteAccount } from "./admin";
import { requireAvailableEmail } from "./accounts";
import { issueLink } from "./link-issuance.mjs";
import { redeemSignInLink } from "./links";
import * as compaction from "@/lib/metadata/account-compaction.mjs";
import * as query from "@/lib/query/account-erasure-query";
import * as providers from "./account-erasure-provider-caches";
import * as passwords from "./passwords";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string, admin: AuthContext;
beforeEach(() => {
  directory = mkdtempSync(path.join(root, "deletion-eligibility-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb();
  for (const id of ["target", "control", "admin"]) testAccountScope(undefined, id);
  const db = metadataDb(); db.exec("UPDATE accounts SET last_sign_in_at='time'; UPDATE accounts SET is_admin=1 WHERE id='admin'");
  admin = authenticateSession(issueSession(getAccount("admin")!, db, Date.now()).secret)!;
});
afterEach(() => { vi.restoreAllMocks(); closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; rmSync(directory, { recursive: true, force: true }); });
const deactivate = () => changeAccountAccess(admin, "target", { status: "deactivated" });
const accept = () => acceptAccountDeletion(admin, "target", () => {});
it("refuses self before the active-target condition and refuses another active target without effects", () => {
  const before = readdirSync(directory, { recursive: true }).sort();
  expect(() => acceptAccountDeletion(admin, "admin", () => {})).toThrow(expect.objectContaining({ code: "self_change_refused", message: "Another admin must change your admin flag, deactivate your account or delete it." }));
  expect(() => accept()).toThrow(expect.objectContaining({ code: "account_not_deactivated", status: 409 }));
  expect(readdirSync(directory, { recursive: true }).sort()).toEqual(before);
  expect(getAccount("target")?.status).toBe("active");
});
it("accepts a deactivated admin without demotion and retains only the original identity and SQL name", async () => {
  metadataDb().exec("UPDATE accounts SET is_admin=1 WHERE id='target'"); deactivate();
  const accepted = accept(); expect(journalForAccount("target")?.identity.isAdmin).toBe(true);
  expect(await finishAccountDeletion(admin, accepted.id)).toMatchObject({ state: "completed" });
  expect(setupComplete()).toBe(true);
  const replacement = inviteAccount(admin, { name: "target", email: "target@example.test" }).account;
  expect(replacement.id).not.toBe("target"); expect(replacement.sqlName).not.toBe("target");
});
it("uses pending lookup before erased profile lookup for duplicate deletion, reactivation and email reservation", async () => {
  deactivate(); const accepted = accept(), confirmation = vi.fn();
  expect(acceptAccountDeletion(admin, "target", confirmation)).toEqual(accepted); expect(confirmation).not.toHaveBeenCalled();
  expect(() => changeAccountAccess(admin, "target", { status: "active" })).toThrow(expect.objectContaining({ code: "deletion_in_progress", status: 409 }));
  vi.spyOn(compaction, "compactMetadataStore").mockImplementationOnce(() => { throw new Error("blocked checkpoint"); });
  expect(await finishAccountDeletion(admin, accepted.id)).toMatchObject({ state: "needs-retry" });
  expect(getAccount("target")).toBeNull();
  expect(journalForAccount("target")?.identity).toMatchObject({ name: "target", email: "target@example.test" });
  expect(acceptAccountDeletion(admin, "target", confirmation)).toEqual({ id: accepted.id, state: "needs-retry" });
  expect(() => changeAccountAccess(admin, "target", { status: "active" })).toThrow(expect.objectContaining({ code: "deletion_in_progress" }));
  for (const check of [() => requireAvailableEmail(" TARGET@example.test ", null, metadataDb(), true), () => inviteAccount(admin, { name: "New target", email: "target@example.test" })]) {
    expect(check).toThrow(expect.objectContaining({ code: "email_taken", extra: {} }));
  }
  expect(pendingAccountDeletion("target")).toMatchObject({ state: "needs-retry" });
  expect(await finishAccountDeletion(admin, accepted.id)).toMatchObject({ state: "completed" });
  expect(() => requireAvailableEmail("target@example.test", null, metadataDb(), true)).not.toThrow();
  expect(() => finishAccountDeletion(admin, accepted.id)).toThrow(expect.objectContaining({ code: "not_found" }));
});
it.each(["invite", "reset", "recovery"] as const)("refuses the old %s link after acceptance", async kind => {
  const db = metadataDb(), link = db.transaction(() => issueLink("target", kind === "recovery" ? "reset" : kind, db, Date.now(), kind === "recovery" ? 15 * 60_000 : undefined)).immediate();
  deactivate(); const accepted = accept();
  await expect(redeemSignInLink(link.secret, "field notebooks at dawn")).rejects.toMatchObject({ code: "invalid_link" });
  expect(await finishAccountDeletion(admin, accepted.id)).toMatchObject({ state: "completed" });
  await expect(redeemSignInLink(link.secret, "field notebooks at dawn")).rejects.toMatchObject({ code: "invalid_link" });
});
it.each(["invited", "deactivated"] as const)("removes a never-redeemed %s invitation whole without cache invalidation", async state => {
  const db = metadataDb(); insertAccount({ id: "invitation", name: "Reserved name", email: "reserved@example.test", passwordHash: null, status: state, isAdmin: true, now: new Date().toISOString() }, db);
  const original = getAccount("invitation")!;
  const queryPurge = vi.spyOn(query, "eraseAccountQueryState"), providerPurge = vi.spyOn(providers, "eraseProviderCaches");
  mkdirSync(path.join(directory, "cache/geocode"), { recursive: true }); const file = path.join(directory, "cache/geocode/control.json"); writeFileSync(file, "independent cached answer");
  const accepted = acceptAccountDeletion(admin, original.id, () => {});
  expect(await finishAccountDeletion(admin, accepted.id)).toMatchObject({ state: "completed" });
  expect(db.prepare("SELECT * FROM accounts WHERE id=?").get(original.id)).toBeUndefined();
  expect(queryPurge).not.toHaveBeenCalled(); expect(providerPurge).not.toHaveBeenCalled();
  expect(readFileSync(file, "utf8")).toBe("independent cached answer");
  const replacement = inviteAccount(admin, { name: original.name, email: original.email }).account;
  expect(replacement.sqlName).toBe(original.sqlName); expect(replacement.id).not.toBe(original.id);
});
it("refuses an invitation redemption already hashing when deletion is accepted", async () => {
  const db = metadataDb(); const invitation = inviteAccount(admin, { name: "Waiting", email: "waiting@example.test" });
  const hold = Promise.withResolvers<string>(); vi.spyOn(passwords, "hashPassword").mockReturnValueOnce(hold.promise);
  const redeemed = redeemSignInLink(invitation.secret, "field notebooks at dawn").then(() => null, error => error);
  const accepted = acceptAccountDeletion(admin, invitation.account.id, () => {});
  hold.resolve("not-committed-hash"); expect(await redeemed).toMatchObject({ code: "invalid_link" });
  expect(db.prepare("SELECT status,password_hash FROM accounts WHERE id=?").get(invitation.account.id)).toEqual({ status: "deleting", password_hash: null });
  expect(await finishAccountDeletion(admin, accepted.id)).toMatchObject({ state: "completed" });
});
it("requires a current active admin before looking up a target or its pending identity", () => {
  deactivate(); const db = metadataDb();
  const member = authenticateSession(issueSession(getAccount("control")!, db, Date.now()).secret)!;
  expect(() => acceptAccountDeletion(member, "target", () => {})).toThrow(expect.objectContaining({ code: "forbidden" }));
  db.exec("UPDATE accounts SET status='deactivated' WHERE id='admin'");
  expect(() => acceptAccountDeletion(admin, "target", () => {})).toThrow(expect.objectContaining({ code: "authentication_required" }));
  expect(pendingAccountDeletion("target")).toBeNull();
});
