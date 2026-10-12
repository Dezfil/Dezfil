import type { Database } from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { getAccount } from "@/lib/metadata/accounts";
import { accountViewPrefs, setAccountViewPrefs } from "@/lib/metadata/account-preferences";
import { instanceName, setInstanceName } from "@/lib/metadata/settings";
import { GET, PATCH } from "@/app/api/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken, signOut } from "./credentials";
import { inviteAccount, changeAccountAccess } from "./admin";
import { redeemSignInLink } from "./links";

let db: Database, admin: Awaited<ReturnType<typeof createFirstAccount>>, member: typeof admin;
const password = "field notebooks at dawn";
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  admin = await createFirstAccount({ name: "Admin", email: "admin@example.test", password }, db);
  const invite = inviteAccount(authenticateSession(admin.secret, db)!, { name: "Member", email: "member@example.test" }, db);
  member = await redeemSignInLink(invite.secret, password, db);
  setInstanceName("Field atlas", db);
  setAccountViewPrefs(admin.account.id, { maps: { view: "list", sort: "name" } }, db);
  setAccountViewPrefs(member.account.id, { maps: { view: "grid", sort: "created" } }, db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const cookie = (secret: string) => `dezfil_session=${secret}`;
function request(body?: unknown, headers: Record<string, string> = {}) {
  return socketRequest(new Request("http://instance.test/api/settings", { method: body === undefined ? "GET" : "PATCH",
    headers: { ...(body === undefined ? {} : { origin: "http://instance.test", "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
const read = (headers: Record<string, string> = {}) => Reflect.apply(GET, null, [request(undefined, headers)]) as Promise<Response>;
const patch = (body: unknown, secret = member.secret, headers: Record<string, string> = {}) => PATCH(request(body, { cookie: cookie(secret), ...headers }));
const state = () => ["accounts", "account_preferences", "workspace_settings"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

it.each(["anonymous", "invalid", "revoked", "invalid bearer with valid cookie"])("refuses %s settings reads without exposing identity", async mode => {
  const headers: Record<string, string> = mode === "anonymous" ? {} : { cookie: cookie(mode === "invalid" ? "invalid" : member.secret) };
  if (mode === "revoked") signOut(authenticateSession(member.secret, db)!, db);
  if (mode === "invalid bearer with valid cookie") headers.authorization = "Bearer invalid";
  const response = await read(headers);
  expect.soft(response.status).toBe(401); expect.soft(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).not.toHaveProperty("displayName");
});
it.each(["cookie", "token"])("refuses a non-admin mixed instance/personal patch via %s before every write", async kind => {
  const before = state();
  const headers = kind === "token" ? { authorization: `Bearer ${createApiToken(authenticateSession(member.secret, db)!, "Fixture", db).secret}` } : {};
  const response = await patch({ displayName: "Changed", instanceName: "Hijacked", viewPrefs: { maps: { view: "list" } } }, member.secret, headers as Record<string, string>);
  expect.soft(response.status).toBe(403); expect(state()).toEqual(before);
});
it.each([
  { displayName: "Changed", instanceName: "Changed", viewPrefs: { maps: { view: "invalid" } } },
  { displayName: "Changed", instanceName: 4 },
  { displayName: "Changed", instanceName: "Changed", viewPrefs: { maps: { view: "list" } }, look: { color: "harbor", rail: "sideways" } },
  { displayName: "Changed", instanceName: "Changed", sourceGrouping: "project", look: { glow: "on" } },
])("validates the whole admin patch before writing any field", async body => {
  const before = state(); const response = await patch(body, admin.secret);
  expect.soft(response.status).toBe(400); expect(state()).toEqual(before);
});
it("refuses a cross-site preference mutation before writes", async () => {
  const before = state(); const response = await patch({ viewPrefs: { maps: { sort: "name" } } }, member.secret, { origin: "https://unrelated.test" });
  expect.soft(response.status).toBe(403); expect(state()).toEqual(before);
});
it("projects the caller and ignores submitted identity when writing only their name and preferences", async () => {
  const response = await patch({ accountId: admin.account.id, displayName: "My new name", viewPrefs: { maps: { sort: "name" }, data: { sort: "size" } } }, member.secret,
    { "x-account-id": admin.account.id, "x-account-admin": "true" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ displayName: "My new name", instanceName: "Field atlas", viewPrefs: { maps: { view: "grid", sort: "name" }, data: { sort: "size" } },
    sourceGrouping: "person", look: { color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover", panels: "glass",
      liquidChrome: "on", liquidPanels: "on", liquidMap: "on", liquidButtons: "on",
      liquidCards: "off", liquidInner: "off", liquidMenus: "off", liquidDialogs: "off" } });
  expect(getAccount(admin.account.id, db)?.name).toBe("Admin");
  expect(accountViewPrefs(admin.account.id, db)).toEqual({ maps: { view: "list", sort: "name" } });
  expect(instanceName(db)).toBe("Field atlas");
  const own = await read({ cookie: cookie(member.secret), "x-account-id": admin.account.id });
  expect(own.headers.get("cache-control")).toBe("private, no-store");
  expect((await own.json()).displayName).toBe("My new name");
});
it("rechecks demoted authority and deactivated access on the next request", async () => {
  const adminContext = authenticateSession(admin.secret, db)!;
  changeAccountAccess(adminContext, member.account.id, { isAdmin: true }, db);
  expect((await patch({ instanceName: "Allowed" })).status).toBe(200);
  changeAccountAccess(adminContext, member.account.id, { isAdmin: false }, db);
  const before = state();
  expect.soft((await patch({ instanceName: "Refused" })).status).toBe(403);expect.soft(state()).toEqual(before);
  changeAccountAccess(adminContext, member.account.id, { status: "deactivated" }, db);
  expect((await read({ cookie: cookie(member.secret) })).status).toBe(401);
});
