import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "@/proxy";
import nextConfig from "../../../../next.config";
import { externalFixture } from "../../../../test-support/external-sign-in";
import { POST as start } from "@/app/api/auth/external/start/route";
import { POST as arrive } from "@/app/api/auth/external/arrive/route";
import { gateRequest } from "../gate";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { SESSION_COOKIE } from "../http";
let f: ReturnType<typeof externalFixture>;
beforeEach(() => { f = externalFixture(); });
afterEach(() => f.close());
it("keeps entry posts and the arrival address outside proxy body copying and admits anonymous entry", async () => {
  for (const [path, method] of [["/arrive", "GET"], ["/arrive", "HEAD"], ["/api/auth/external/start", "POST"], ["/api/auth/external/arrive", "POST"]]) {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig, url: path })).toBe(false);
    const input = socketRequest(new Request(`https://instance.test${path}`, { method, headers: { origin: "https://instance.test" } }));
    const before = f.snapshot(); expect(gateRequest(input).headers.get("x-middleware-next")).toBe("1"); expect(f.snapshot()).toEqual(before);
  }
  const request = socketRequest(new Request("https://instance.test/api/auth/external/start", { method: "POST", headers: { origin: "https://instance.test" } }));
  const before = f.snapshot(), response = await start(request);
  expect(response.status).toBe(303); expect(response.headers.get("location")).toMatch(/^https:\/\/door.example\/sign-in\?start=/); expect(f.snapshot()).toEqual(before);
});
it("refuses a large arrival within the handler bound and without an identity or credential write", async () => {
  let taken = 0;
  const stream = new ReadableStream({ pull(controller) { taken += 4096; controller.enqueue(new Uint8Array(4096).fill(32)); } });
  const request = socketRequest(new Request("https://instance.test/api/auth/external/arrive", { method: "POST", headers: { origin: "https://instance.test", "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit));
  const before = f.snapshot(), response = await arrive(request);
  expect(response.status).toBe(413); expect(taken).toBeLessThanOrEqual(8192 + 4 * 4096); expect(f.snapshot()).toEqual(before);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});
it("leaves a signed-in arrival page and its refusal entirely free of session renewal", async () => {
  const accepted = await arrive(f.request()); expect(accepted.status).toBe(200);
  const cookie = accepted.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
  const account = (await accepted.json()).account;
  const before = f.snapshot();
  const page = gateRequest(socketRequest(new Request("https://instance.test/arrive", { headers: { cookie } })));
  expect(page.headers.get("x-middleware-next")).toBe("1"); expect(page.headers.get("set-cookie")).toBeNull();
  const request = f.request(); request.headers.set("cookie", cookie); const body = vi.spyOn(request, "body", "get");
  const response = await arrive(request); expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "already_signed_in", account } });
  expect(body).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
});
