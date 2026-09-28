import { afterEach, expect, it, vi } from "vitest";
import { journeyApi } from "../../../scripts/journey-http.mjs";

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

it.each([true, false])("provisions through real entry/session/token contracts (setup=%s)", async setupRequired => {
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
      return Response.json({ account: { id: "first" } }, { status: 200, headers: { "set-cookie": "dezfil_session=fixture-cookie; HttpOnly; Path=/" } });
    }
    expect(path).toBe("/api/account/tokens");
    expect(request.headers.get("cookie")).toBe("dezfil_session=fixture-cookie");
    expect(request.headers.get("origin")).toBe("http://instance.test");
    return Response.json({ id: "token", secret: "fixture-token" }, { status: 201 });
  });
  const result = await provisionJourney("http://instance.test");
  expect(result).toMatchObject({ account: { id: "first" }, token: "fixture-token", cookie: "dezfil_session=fixture-cookie", setupRequired });
  expect(seen).toHaveLength(3);
});
