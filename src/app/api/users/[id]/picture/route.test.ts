import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { authenticateSession, issueSession } from "@/lib/auth/credentials";
import { requireAccountScope } from "@/lib/auth/scope";
import { gateRequest } from "@/lib/auth/gate";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { authenticatedRoute, TEST_ACCOUNT_ID } from "@/lib/assistant/testing/account";
import { testClient } from "@/lib/mcp/test-client";
import { removeUserPicture } from "@/lib/profile-pictures/admin";
import { admitPictureWrite, publishPicture } from "@/lib/profile-pictures/store";
import { DELETE } from "./route";

/**
 * An admin removes another person's picture. Ada, Dee (deactivated) and Gil
 * (under deletion) each have a picture; Bo is a member with a picture of
 * their own; Admin and Second are admins. An admin removes a picture and
 * never sets one; a member is refused with every picture kept; an account
 * under deletion, or nobody, answers as not there.
 */
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(async () => {
  directory = mkdtempSync(path.join(root, "admin-picture-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb();
  for (const id of ["admin", "second", "ada", "dee", "gil", "bo"]) testAccountScope(undefined, id);
  metadataDb().exec("UPDATE accounts SET is_admin = 1 WHERE id IN ('admin', 'second'); UPDATE accounts SET last_sign_in_at = 'time'");
  for (const id of ["ada", "dee", "gil", "bo"]) await set(id);
  metadataDb().exec("UPDATE accounts SET status = 'deactivated' WHERE id = 'dee'; UPDATE accounts SET status = 'deleting' WHERE id = 'gil'");
});
afterEach(() => { closeMetadataDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

async function set(id: string) {
  const write = admitPictureWrite(id, id);
  try { await publishPicture(write, Buffer.from(`${id}-picture`), (db) => { requireAccountScope(testAccountScope(db, id), db); }); }
  finally { write.release(); }
}
const version = (id: string) => (metadataDb().prepare("SELECT picture_version FROM accounts WHERE id = ?").get(id) as { picture_version: string | null } | undefined)?.picture_version ?? null;
const stored = () => readdirSync(path.join(directory, "profile-pictures")).sort();
const remove = (id: string, account = "admin") =>
  DELETE(testAccountRequest(new Request(`http://instance.test/api/users/${id}/picture`, { method: "DELETE" }), undefined, account), { params: Promise.resolve({ id }) });
async function answer(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return await response.json() as { account?: { id: string; pictureVersion?: string }; error?: { code: string } };
}

describe("an admin's removal", () => {
  it("removes an active and a deactivated person's picture, the old address serving nothing, and a second removal changes nothing", async () => {
    for (const id of ["ada", "dee"]) {
      const removed = await answer(await remove(id), 200);
      expect(removed.account).toMatchObject({ id });
      expect(removed.account).not.toHaveProperty("pictureVersion");
      expect(version(id)).toBeNull();
      expect((await answer(await remove(id), 200)).account).not.toHaveProperty("pictureVersion");
    }
    expect(stored().map((name) => name.split(".")[0])).toEqual(["bo", "gil"]);
    expect(getAccount("dee")?.status).toBe("deactivated");
  });

  it("answers a person under deletion, or nobody, as not there", async () => {
    const before = version("gil");
    expect((await answer(await remove("gil"), 404)).error?.code).toBe("not_found");
    expect(version("gil")).toBe(before);
    expect((await answer(await remove("nobody"), 404)).error?.code).toBe("not_found");
  });

  it("refuses a member at the gate and in the route, every picture kept", async () => {
    const signed = issueSession(getAccount("bo")!, metadataDb(), Date.now());
    const gated = gateRequest(new NextRequest(socketRequest(new Request("http://instance.test/api/users/ada/picture",
      { method: "DELETE", headers: { cookie: `dezfil_session=${signed.secret}`, origin: "http://instance.test" } }))));
    expect(gated.status).toBe(403);
    const before = stored();
    expect((await answer(await remove("ada", "bo"), 403)).error?.code).toBe("forbidden");
    expect((await answer(await remove("bo", "bo"), 403)).error?.code).toBe("forbidden");
    expect(stored()).toEqual(before);
    expect(version("ada")).not.toBeNull(); expect(version("bo")).not.toBeNull();
  });

  it("refuses a member before anything else is asked, whichever account the member names", async () => {
    const member = authenticateSession(issueSession(getAccount("bo")!, metadataDb(), Date.now()).secret)!;
    for (const id of ["ada", "gil", "nobody"]) await expect(removeUserPicture(member, id)).rejects.toMatchObject({ code: "forbidden" });
    expect(version("ada")).not.toBeNull(); expect(version("gil")).not.toBeNull();
  });

  it("changes nothing when the admin is no longer one as the change commits", async () => {
    const admin = authenticateSession(issueSession(getAccount("admin")!, metadataDb(), Date.now()).secret)!;
    const before = version("ada");
    const removing = removeUserPicture(admin, "ada");
    metadataDb().exec("UPDATE accounts SET is_admin = 0 WHERE id = 'admin'");
    await expect(removing).rejects.toMatchObject({ code: "forbidden" });
    expect(version("ada")).toBe(before);
  });

  it("offers no way to set another person's picture", () => {
    const signed = issueSession(getAccount("admin")!, metadataDb(), Date.now());
    for (const method of ["PUT", "POST", "PATCH", "GET"]) {
      const gated = gateRequest(new NextRequest(socketRequest(new Request("http://instance.test/api/users/ada/picture",
        { method, headers: { cookie: `dezfil_session=${signed.secret}`, origin: "http://instance.test" } }))));
      expect(gated.status, method).toBe(405);
      expect(gated.headers.get("allow")).toBe("DELETE, OPTIONS");
    }
  });
});

describe("for an agent", () => {
  it("removes a person's picture through the real transport, and refuses one under deletion", async () => {
    const route = authenticatedRoute(DELETE);
    const client = await testClient((request) => route(request, { params: Promise.resolve({ id: new URL(request.url).pathname.split("/").at(-2)! }) }));
    try {
      const removed = await client.callTool({ name: "remove_user_picture", arguments: { id: "ada" } });
      expect(removed.isError ?? false).toBe(false);
      expect(version("ada")).toBeNull();
      expect(getAccount(TEST_ACCOUNT_ID)?.isAdmin).toBe(true);
      const refused = await client.callTool({ name: "remove_user_picture", arguments: { id: "gil" } });
      expect(refused.isError).toBe(true);
      expect(version("gil")).not.toBeNull();
    } finally { await client.close(); }
  });
});
