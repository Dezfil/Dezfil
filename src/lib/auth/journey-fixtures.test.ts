import { afterEach, expect, it, vi } from "vitest";
import { journeyApi } from "../../../scripts/journey-http.mjs";
import { assertSetupClosed } from "../../../scripts/deletion-recovery-checks.mjs";
import { recoverRemainingAdmin } from "../../../scripts/deletion-journey-recovery.mjs";

afterEach(() => vi.unstubAllGlobals());
it("carries the supplied credential on JSON, multipart and raw journey requests", async () => {
  const seen: Request[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    seen.push(new Request(input, init));
    return Response.json({ ok: true });
  });
  const api = journeyApi("http://instance.test", { token: "fixture-secret" });
  await api("GET", "/api/config");
  await api("POST", "/api/query", { body: { sql: "SELECT 1" } });
  const form = new FormData(); form.set("file", "fixture");
  await api("POST", "/api/tables", { form });
  expect((await api("GET", "/api/maps/map/export", { raw: true })).status).toBe(200);
  for (const request of seen) {
    expect(request.headers.get("authorization")).toBe("Bearer fixture-secret");
    expect(request.redirect).toBe("manual");
  }
});
it("keeps an explicitly anonymous journey free of credentials", async () => {
  vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => {
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(new Headers(init.headers).has("cookie")).toBe(false);
    return Response.json({ status: "ready" });
  });
  await journeyApi("http://instance.test")("GET", "/api/health");
});
it("sends the instance origin on cookie-authenticated journey posts", async () => {
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const request = new Request(input, init);
    expect(request.method).toBe("POST");
    expect(request.headers.get("origin")).toBe("http://127.0.0.1:3403");
    expect(request.headers.get("cookie")).toBe("dezfil_session=fixture");
    expect(request.headers.has("authorization")).toBe(false);
    return Response.json({ state: "completed" });
  });
  await journeyApi("http://127.0.0.1:3403", { cookie: "dezfil_session=fixture" })("POST", "/api/users/deletions/held/finish");
});
it("sends the instance origin on anonymous deletion-journey recovery and keeps the credential controls", async () => {
  const base = "http://127.0.0.1:3403", seen: Request[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const request = new Request(input, init); seen.push(request);
    if (request.method === "POST") {
      expect(new URL(request.url).pathname).toBe("/api/auth/redeem");
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      if (request.headers.get("origin") !== base) return Response.json({ error: { code: "forbidden" } }, { status: 403 });
      expect(await request.json()).toEqual({ secret: "dz_link_fixture", password: "recovered paper cranes before sunrise" });
      return Response.json({ account: { id: "admin", isAdmin: true } });
    }
    if (new URL(request.url).pathname === "/api/maps") {
      expect(request.headers.get("cookie")).toBe("dezfil_session=old");
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    expect(new URL(request.url).pathname).toBe("/api/maps/independent");
    expect(request.headers.get("authorization")).toBe("Bearer control-token");
    return Response.json({ id: "independent" });
  });
  await recoverRemainingAdmin(base, {
    admin: { account: { id: "admin" }, cookie: "dezfil_session=old" },
    fixture: { control: { token: "control-token" }, controlMap: { id: "independent" } },
  }, `${base}/accept#secret=dz_link_fixture`);
  expect(seen).toHaveLength(3);
});
it("sends the instance origin on the anonymous setup-closure check", async () => {
  const base = "http://127.0.0.1:3389", seen: Request[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const request = new Request(input, init); seen.push(request);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("cookie")).toBe(false);
    if (request.method === "GET") return Response.json({ setupRequired: false });
    if (request.headers.get("origin") !== base) return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    expect(new URL(request.url).pathname).toBe("/api/auth/setup");
    return Response.json({ error: { code: "setup_complete" } }, { status: 409 });
  });
  const anonymous = journeyApi(base, { origin: new URL(base).origin });
  await assertSetupClosed((method: string, route: string, body?: object) => anonymous(method, route, { body }));
  expect(seen).toHaveLength(2);
  expect(seen[1].headers.get("origin")).toBe(base);
});

it.each([true, false].flatMap(setupRequired => ["dezfil_session", "dezfil_session_3650", "map_session"].map(name => ({ setupRequired, name }))))("provisions through real entry/session/token contracts (setup=$setupRequired, cookie=$name)", async ({ setupRequired, name }) => {
  const { provisionJourney, journeyAccount } = await import("../../../scripts/journey-auth.mjs");
  const seen: Request[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const request = new Request(input, init); seen.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/entry") {
      expect(request.headers.has("authorization")).toBe(false);
      return Response.json({ setupRequired });
    }
    if (path === `/api/auth/${setupRequired ? "setup" : "sign-in"}`) {
      expect(request.headers.get("origin")).toBe("http://instance.test");
      expect(await request.json()).toEqual(setupRequired ? journeyAccount : { email: journeyAccount.email, password: journeyAccount.password });
      return Response.json({ account: { id: "first" } }, { status: 200, headers: { "set-cookie": `${name}=fixture-cookie; HttpOnly; Path=/` } });
    }
    expect(path).toBe("/api/account/tokens");
    expect(request.headers.get("cookie")).toBe(`${name}=fixture-cookie`);
    expect(request.headers.get("origin")).toBe("http://instance.test");
    return Response.json({ id: "token", secret: "fixture-token" }, { status: 201 });
  });
  const result = await provisionJourney("http://instance.test");
  expect(result).toMatchObject({ account: { id: "first" }, token: "fixture-token", cookie: `${name}=fixture-cookie`, setupRequired });
  expect(seen).toHaveLength(3);
});
