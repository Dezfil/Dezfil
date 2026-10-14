import { afterEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { canonicalIngress } from "./ingress.mjs";

vi.mock("@/lib/data-dir", () => ({ ensureDataDir: () => { throw new Error("Startup reached the data directory"); } }));
vi.mock("./security-settings", () => ({ securitySettings: () => ({ sessionMs: 86_400_000 }) }));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function instance(port?: string, override?: string) {
  vi.stubEnv("PORT", port);
  vi.stubEnv("DEZFIL_SESSION_COOKIE", override);
  vi.resetModules();
  return import("./http");
}

it.each([undefined, "3000"])("preserves the existing cookie on the default port %s", async port => {
  expect((await instance(port)).SESSION_COOKIE).toBe("dezfil_session");
});

it("keeps sessions on different listening ports separate when the browser sends both cookies", async () => {
  const first = await instance("3650");
  const second = await instance("3651");
  expect(first.SESSION_COOKIE).toBe("dezfil_session_3650");
  expect(second.SESSION_COOKIE).toBe("dezfil_session_3651");
  const response = NextResponse.json({});
  first.sessionCookie(response, "first-session", canonicalIngress({ headers: { host: "127.0.0.1:3650" }, socket: { remoteAddress: "127.0.0.1" } }));
  const issued = response.headers.get("set-cookie")!.split(";")[0];
  const request = new Request("http://127.0.0.1:3651", { headers: { cookie: issued } });
  expect(first.sessionSecret(request)).toBe("first-session");
  expect(second.sessionSecret(request)).toBeNull();
  request.headers.set("cookie", `${issued}; ${second.SESSION_COOKIE}=second-session`);
  expect(first.sessionSecret(request)).toBe("first-session");
  expect(second.sessionSecret(request)).toBe("second-session");
});

it.each(["3000", "3650"])("uses the override for reading, issuing and clearing on port %s", async port => {
  const server = await instance(port, "map_session");
  expect(server.SESSION_COOKIE).toBe("map_session");
  const response = NextResponse.json({});
  const ingress = canonicalIngress({ headers: { host: "maps.example.test" }, socket: { remoteAddress: "127.0.0.1", encrypted: true } });
  server.sessionCookie(response, "custom-session", ingress);
  expect(response.headers.get("set-cookie")).toContain("map_session=custom-session;");
  expect(server.sessionSecret(new Request(ingress.origin, { headers: { cookie: "map_session=custom-session" } }))).toBe("custom-session");
  server.sessionCookie(response, "", ingress, true);
  expect(response.headers.get("set-cookie")).toMatch(/^map_session=;.*Max-Age=0/);
});

it("accepts the full cookie-name token alphabet", async () => {
  const name = "letters0123456789!#$%&'*+-.^_`|~";
  expect((await instance("3650", name)).SESSION_COOKIE).toBe(name);
});

it("uses the configured cookie in authenticated request fixtures", async () => {
  const server = await instance("3650", "map_session");
  const { open } = await import("@/lib/metadata/db");
  const { testAccountRequest } = await import("@/lib/test-support/accounts");
  const db = open(":memory:");
  try {
    const request = testAccountRequest(new Request("http://127.0.0.1:3650/api/maps"), db);
    expect(request.headers.get("cookie")).toMatch(/^map_session=/);
    expect(server.requestAuth(request, db)?.account.id).toBe("test-account");
  } finally { db.close(); }
});

it.each(["", "has space", "bad;name", "bad=name", "bad,name", "bad\nname", "café", "bad/name", "trailing\n"])("refuses the invalid override %j at startup", async override => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("DEZFIL_SESSION_COOKIE", override);
  vi.resetModules();
  const { register } = await import("@/instrumentation");
  await expect(register()).rejects.toThrow("DEZFIL_SESSION_COOKIE must be a non-empty cookie-name token");
});
