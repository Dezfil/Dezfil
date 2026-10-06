import { afterEach, beforeEach, expect, it } from "vitest";
import { GET } from "@/app/api/instance/settings/route";
import { gateRequest } from "@/lib/auth/gate";
import { authenticateSession, createApiToken, revokeApiToken, signOut } from "@/lib/auth/credentials";
import { readInstanceSettings } from "./read";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); });
afterEach(() => f.close());
it.each(["anonymous", "member", "member-token", "demoted-cookie", "demoted-token", "deactivated-cookie", "deactivated-token", "revoked-cookie", "revoked-token"])(
  "refuses %s at the shared gate and handler without any configuration", async mode => {
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
    for (const response of [gateRequest(f.request(headers)), await GET(f.request(headers))]) {
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: { code: status === 401 ? "authentication_required" : "forbidden", message: expect.any(String) } });
    }
  },
);
it.each(["cookie", "token"])("admits the current admin via %s and keeps reads private", async kind => {
  const headers: Record<string, string> = kind === "cookie" ? { cookie: `dezfil_session=${f.admin.secret}`, origin: "https://elsewhere.test" } : { authorization: `Bearer ${f.token.secret}` };
  const request = f.request(headers);
  expect(gateRequest(request).headers.get("x-middleware-next")).toBe("1");
  const response = await GET(request);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toHaveProperty("settings");
});
it.each(["demotion", "deactivation", "revocation"])("rechecks a captured context inside the read transaction after %s", mode => {
  if (mode === "demotion") f.db.prepare("UPDATE accounts SET is_admin = 0 WHERE id = 'admin'").run();
  if (mode === "deactivation") f.db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = 'admin'").run();
  if (mode === "revocation") signOut(f.context, f.db);
  expect(() => readInstanceSettings(f.context, f.db)).toThrow();
});
it("uses the shared origin rule and private method refusals for unsupported cookie mutations", async () => {
  const crossSite = gateRequest(f.request({ cookie: `dezfil_session=${f.admin.secret}`, origin: "https://elsewhere.test" }, "PATCH"));
  expect(crossSite.status).toBe(403); expect(crossSite.headers.get("cache-control")).toBe("private, no-store");
  const unsupported = gateRequest(f.request({ authorization: `Bearer ${f.token.secret}` }, "PATCH"));
  expect(unsupported.status).toBe(405); expect(unsupported.headers.get("cache-control")).toBe("private, no-store");
  const options = gateRequest(f.request(undefined, "OPTIONS"));
  expect(options.status).toBe(204); expect(options.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  expect(options.headers.get("cache-control")).toBe("private, no-store");
});
