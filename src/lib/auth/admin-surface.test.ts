import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { open } from "@/lib/metadata/db";
import { createFirstAccount } from "./accounts";
import { authenticateSession, type AuthContext } from "./credentials";
import { changeAccountAccess, inviteAccount } from "./admin";
let db: Database, admin: AuthContext;
beforeEach(async () => {
  db = open(":memory:");
  const first = await createFirstAccount({ name: "Admin", email: "admin@example.test", password: "field notebooks at dawn" }, db);
  admin = authenticateSession(first.secret, db)!;
});
afterEach(() => db.close());
it("reactivates an unaccepted invitation as invited, retaining its identity", () => {
  const invitation = inviteAccount(admin, { name: "Pending", email: "pending@example.test" }, db);
  changeAccountAccess(admin, invitation.account.id, { status: "deactivated" }, db);
  expect(changeAccountAccess(admin, invitation.account.id, { status: "active" }, db)).toMatchObject({ id: invitation.account.id, status: "invited" });
});
it("can explicitly grant admin when inviting while leaving the default invitation non-admin", () => {
  const invited = inviteAccount(admin, { name: "Delegate", email: "delegate@example.test", isAdmin: true }, db);
  expect(invited.account).toMatchObject({ status: "invited", isAdmin: true, isOriginal: false });
  expect(inviteAccount(admin, { name: "Member", email: "member@example.test" }, db).account.isAdmin).toBe(false);
});
