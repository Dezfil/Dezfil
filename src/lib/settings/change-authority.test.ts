import { afterEach, beforeEach, expect, it } from "vitest";
import { PATCH } from "@/app/api/instance/settings/route";
import { gateRequest } from "@/lib/auth/gate";
import { authenticateSession, createApiToken, revokeApiToken, signOut } from "@/lib/auth/credentials";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { changeInstanceSettings } from "./change";
import { readStoredSettings } from "./store";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); });
afterEach(() => f.close());
it.each(["anonymous", "member", "member-token", "demoted-cookie", "demoted-token", "deactivated-cookie", "deactivated-token", "revoked-cookie", "revoked-token", "cross-origin"])(
  "refuses %s at the shared gate and write handler without changing storage", async mode => {
    let headers: Record<string, string> = { cookie: `dezfil_session=${f.admin.secret}` }, status = 401;
    if (mode === "anonymous") headers = {};
    if (mode === "member") { headers = { cookie: `dezfil_session=${f.member.secret}` }; status = 403; }
    if (mode === "member-token") {
      headers = { authorization: `Bearer ${createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret}` }; status = 403;
    }
    if (mode.endsWith("token") && mode !== "member-token") headers = { authorization: `Bearer ${f.token.secret}` };
    if (mode.startsWith("demoted")) { f.db.prepare("UPDATE accounts SET is_admin = 0 WHERE id = 'admin'").run(); status = 403; }
    if (mode.startsWith("deactivated")) f.db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'admin'").run();
    if (mode === "revoked-cookie") signOut(f.context, f.db);
    if (mode === "revoked-token") revokeApiToken(f.context, f.token.id, f.db);
    if (mode === "cross-origin") status = 403;
    const request = () => socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
      headers: { ...headers, origin: mode === "cross-origin" ? "https://elsewhere.test" : "http://instance.test", "content-type": "application/json" },
      body: JSON.stringify({ previewRows: 200 }) }));
    for (const response of [gateRequest(request()), await PATCH(request())]) {
      expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: { code: status === 401 ? "authentication_required" : "forbidden", message: expect.any(String) } });
      expect(readStoredSettings(f.db)).toEqual({});
    }
  },
);
it.each(["cookie", "token"])("admits the active admin via %s with no extra token scope", async kind => {
  const headers: Record<string, string> = kind === "cookie" ? { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test" } : { authorization: `Bearer ${f.token.secret}` };
  const request = socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: '{"previewRows":200}' }));
  expect(gateRequest(request).headers.get("x-middleware-next")).toBe("1");
  const response = await PATCH(request);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(readStoredSettings(f.db)).toEqual({ previewRows: 200 });
});
it.each(["anonymous", "member", "member-token", "cross-origin"])(
  "refuses a %s write of the sign-in, token, publishing, connection and import rows without changing storage", async mode => {
    let headers: Record<string, string> = {}, status = 401;
    if (mode === "member") { headers = { cookie: `dezfil_session=${f.member.secret}` }; status = 403; }
    if (mode === "member-token") {
      headers = { authorization: `Bearer ${createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret}` }; status = 403;
    }
    if (mode === "cross-origin") { headers = { cookie: `dezfil_session=${f.admin.secret}` }; status = 403; }
    const body = { "security.sessionDays": "1", "security.failedPerAccount": 3, "security.failedPerAddress": 10, "security.passwordMin": 12,
      "tokens.create": "admins", "tokens.expiry": "30d", "publishing.publish": "none", "publishing.embedding": "listed",
      "publishing.embedSites": ["https://portal.example"], "connections.create": "admins", "imports.links": "admins" };
    const request = () => socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
      headers: { ...headers, origin: mode === "cross-origin" ? "https://elsewhere.test" : "http://instance.test", "content-type": "application/json" },
      body: JSON.stringify(body) }));
    for (const response of [gateRequest(request()), await PATCH(request())]) {
      expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: { code: status === 401 ? "authentication_required" : "forbidden", message: expect.any(String) } });
      expect(readStoredSettings(f.db)).toEqual({});
    }
    // The same body from the admin, by cookie from the instance's own origin, is kept whole.
    const admitted = await PATCH(socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
      headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test", "content-type": "application/json" }, body: JSON.stringify(body) })));
    expect(admitted.status).toBe(200);
    expect(readStoredSettings(f.db)).toEqual(body);
  },
);
it.each(["demotion", "deactivation", "revocation"])("rechecks a captured actor before writing after %s", mode => {
  if (mode === "demotion") f.db.prepare("UPDATE accounts SET is_admin = 0 WHERE id = 'admin'").run();
  if (mode === "deactivation") f.db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'admin'").run();
  if (mode === "revocation") signOut(f.context, f.db);
  expect(() => changeInstanceSettings(f.context, { previewRows: 200 }, f.db)).toThrow();
  expect(readStoredSettings(f.db)).toEqual({});
});
