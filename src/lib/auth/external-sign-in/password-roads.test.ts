import { gateRequest } from "../gate";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import * as metadata from "@/lib/metadata/db";
import { createFirstAccount, signIn, changeOwnPassword, updateOwnProfile } from "../accounts";
import { inviteAccount, issueSignInLink } from "../admin";
import { authenticateSession, createApiToken, type AuthContext } from "../credentials";
import { redeemSignInLink } from "../links";
import { enter } from "../entry";
import { POST as passwordRoute } from "@/app/api/account/password/route";
import { POST as linkRoute } from "@/app/api/users/[id]/sign-in-link/route";
import { PATCH as profileRoute } from "@/app/api/account/route";
import { issueLink } from "../link-issuance.mjs";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { SESSION_COOKIE } from "../http";
let db: Database, context: AuthContext, session: string, invitation: string, recovery: string;
const password = "folded maps by the river";
const resetMode = () => Reflect.deleteProperty(process, Symbol.for("dezfil.external-sign-in"));
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); resetMode();
  const signed = await createFirstAccount({ name: "Owner", email: "owner@example.test", password }, db); session = signed.secret;
  context = authenticateSession(session, db)!; createApiToken(context, "Existing", db);
  invitation = inviteAccount(context, { name: "Invited", email: "invited@example.test" }, db).secret!;
  recovery = db.transaction(() => issueLink(context.account.id, "reset", db, Date.now(), 900_000).secret).immediate();
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_KEYS", generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!);
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE", "instance"); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_URL", "https://door.example/sign-in"); resetMode();
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetMode(); });
const snapshot = () => ["accounts", "auth_sessions", "auth_tokens", "auth_links", "auth_login_limits"].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
const request = (path: string, body: unknown = {}, method = "POST") => socketRequest(new Request(`https://instance.test${path}`, { method,
  headers: { origin: "https://instance.test", "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
it("refuses every password service without changing stored credentials, and restores password sign-in when switched off", async () => {
  const before = snapshot();
  const roads = [() => signIn("owner@example.test", password, db), () => redeemSignInLink(invitation, password, db),
    () => redeemSignInLink(recovery, password, db), () => changeOwnPassword(context, password, "a changed long password", db),
    () => updateOwnProfile(context, { email: "changed@example.test", currentPassword: password }, db),
    () => Promise.resolve(issueSignInLink(context, context.account.id, db))];
  for (const road of roads) {
    await expect(async () => road()).rejects.toMatchObject({ code: "external_sign_in_only", status: 403 }); expect(snapshot()).toEqual(before);
  }
  vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_KEYS", ""); vi.stubEnv("DEZFIL_EXTERNAL_SIGN_IN_AUDIENCE", ""); resetMode();
  expect((await signIn("owner@example.test", password, db)).account.id).toBe(context.account.id);
});
it("refuses entry, password and link-issuance routes before reading a body or renewing the session", async () => {
  const roads = [
    ...(["setup", "sign-in", "redeem"] as const).map(action => (input: Request) => enter(input, action)),
    passwordRoute, (input: Request) => linkRoute(input, { params: Promise.resolve({ id: context.account.id }) }),
  ];
  for (const road of roads) {
    const before = snapshot(), input = request("/api/account/password"), body = vi.spyOn(input, "body", "get");
    const response = await road(input); expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("external_sign_in_only");
    expect(body).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
  }
});
it("refuses an email patch before any change while allowing the same route to edit a name", async () => {
  const before = snapshot();
  const refused = await profileRoute(request("/api/account", { name: "Unchanged", email: "changed@example.test", currentPassword: password }, "PATCH"));
  expect(refused.status).toBe(403); expect((await refused.json()).error.code).toBe("external_sign_in_only"); expect(snapshot()).toEqual(before);
  const renamed = await profileRoute(request("/api/account", { name: "Renamed" }, "PATCH"));
  expect(renamed.status).toBe(200); expect((await renamed.json()).account.name).toBe("Renamed");
});

it("refuses password operation addresses at the proxy gate before credential renewal", async () => {
  for (const path of ["/api/auth/setup", "/api/auth/sign-in", "/api/auth/redeem", "/api/account/password", `/api/users/${context.account.id}/sign-in-link`]) {
    const before = snapshot(), input = request(path), body = vi.spyOn(input, "body", "get");
    const response = gateRequest(input); expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("external_sign_in_only");
    expect(body).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
  }
});
