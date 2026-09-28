import type { Database } from "better-sqlite3";
import puppeteer from "puppeteer-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { createFirstAccount } from "@/lib/auth/accounts";
import { authenticateSession, authenticateToken, createApiToken, revokeApiToken, signOut } from "@/lib/auth/credentials";
import { authenticateDelegation, delegateCredential } from "@/lib/auth/delegation";
import { admitRenderRequest } from "./render-guard";
import { renderRequestHeaders } from "./render-credentials";
import { puppeteerDriver } from "./render-driver";
import type { ExportImageDefinition } from "./image-definition";

vi.mock("puppeteer-core", () => ({ default: { launch: vi.fn() } }));
vi.mock("./render-guard", () => ({ admitRenderRequest: vi.fn() }));
const origin = "http://127.0.0.1:3216";
const definition: ExportImageDefinition = { viewport: { lng: 0, lat: 0, zoom: 2, pitch: 0, bearing: 0 }, size: { width: 512, height: 256 },
  mapScale: 1, legend: { visible: false, corner: "top-right", size: "m" }, widgets: [], title: null, appearance: "light" };
let db: Database, signed: Awaited<ReturnType<typeof createFirstAccount>>;
beforeEach(async () => {
  db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  signed = await createFirstAccount({ name: "Caller", email: "caller@example.test", password: "field notebooks at dawn" }, db);
  vi.mocked(admitRenderRequest).mockReset().mockImplementation(async url => new URL(url).hostname === "denied.test" ? "deny" : "allow");
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

// This fake deliberately carries prior headers into every redirected request.
// It drives the production driver's request listener without launching Chromium.
function browserFixture(urls: string[], afterRequest: (index: number) => void = () => {}) {
  const listeners = new Map<string, (request: unknown) => void>();
  const sent: { url: string; headers: Record<string, string> }[] = [], aborted: string[] = [];
  let inherited: Record<string, string> = { authorization: "Bearer untrusted", cookie: "dezfil_session=untrusted", "proxy-authorization": "Basic untrusted", accept: "*/*" };
  const page = {
    on: vi.fn((event: string, handler: (request: unknown) => void) => listeners.set(event, handler)),
    setRequestInterception: vi.fn(async () => {}), setViewport: vi.fn(async () => {}), evaluateOnNewDocument: vi.fn(async () => {}),
    goto: vi.fn(async () => {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        await new Promise<void>(resolve => listeners.get("request")!({
          url: () => url, headers: () => ({ ...inherited }), redirectChain: () => urls.slice(0, i),
          continue: (overrides?: { headers?: Record<string, string> }) => { inherited = overrides?.headers ?? inherited; sent.push({ url, headers: { ...inherited } }); resolve(); return Promise.resolve(); },
          abort: () => { aborted.push(url); resolve(); return Promise.resolve(); },
        }));
        afterRequest(i);
      }
    }),
    waitForFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async () => undefined), screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
  };
  vi.mocked(puppeteer.launch).mockResolvedValue({ newPage: async () => page, close: async () => {}, process: () => null } as never);
  return { page, sent, aborted };
}
async function render(credential: string) {
  const driver = await puppeteerDriver(), browser = await driver.launch("unused-test-browser", []);
  const input = { url: origin + "/render/map", width: 512, height: 256, definition, deadline: Date.now() + 10_000, requestBoundMs: 1000, credential };
  return browser.render(input);
}
it.each(["cookie", "token"])("injects %s identity only into exact-origin requests, including redirect hops", async mode => {
  const context = authenticateSession(signed.secret, db)!;
  const token = createApiToken(context, "Render", db);
  const credential = delegateCredential(mode === "cookie" ? context : authenticateToken(token.secret, db)!, db);
  const urls = [origin + "/render/map", origin + "/api/maps/map", "https://tiles.example.test/style.json", "https://tiles.example.test/redirect.json",
    "http://127.0.0.1:3217/tile", "https://127.0.0.1:3216/tile", "http://localhost:3216/tile", origin + "/api/layers/layer/data", "data:image/png;base64,AA=="];
  const fixture = browserFixture(urls); expect(await render(credential)).toHaveProperty("png");
  expect(fixture.aborted).toEqual([]); expect(fixture.sent).toHaveLength(urls.length);
  for (const { url, headers } of fixture.sent) {
    expect(headers.cookie).toBeUndefined(); expect(headers["proxy-authorization"]).toBeUndefined();
    if (new URL(url).origin === origin) {
      expect(headers.authorization).toBe(`Bearer ${credential}`);
      expect(authenticateDelegation(headers.authorization.slice(7), db)?.account.id).toBe(signed.account.id);
      expect(headers.authorization).not.toContain(token.secret);
    } else expect(headers.authorization).toBeUndefined();
  }
  expect(vi.mocked(admitRenderRequest).mock.calls.map(args => args[0])).toEqual(urls);
  const pageValues = JSON.stringify([fixture.page.goto.mock.calls, fixture.page.evaluateOnNewDocument.mock.calls, fixture.page.setViewport.mock.calls]);
  expect(pageValues).not.toContain(credential); expect(pageValues).not.toContain(signed.secret);
});
it.each(["revoked-session", "revoked-token", "expired", "deactivated"])("rechecks %s before the next private request", async mode => {
  const context = authenticateSession(signed.secret, db)!, token = createApiToken(context, "Render", db);
  const credential = delegateCredential(mode === "revoked-token" ? authenticateToken(token.secret, db)! : context, db);
  const urls = [origin + "/render/map", origin + "/api/maps/map"];
  const fixture = browserFixture(urls, index => {
    if (index !== 0) return;
    if (mode === "revoked-session") signOut(context, db);
    if (mode === "revoked-token") revokeApiToken(context, token.id, db);
    if (mode === "expired") db.prepare("UPDATE auth_sessions SET expires_at = 0 WHERE id = ?").run(context.credential.id);
    if (mode === "deactivated") db.prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(context.account.id);
  });
  expect(await render(credential)).toHaveProperty("failed");
  expect(fixture.sent.map(value => value.url)).toEqual([urls[0]]); expect(fixture.aborted).toEqual([urls[1]]);
  expect(fixture.page.screenshot).not.toHaveBeenCalled();
});
it("keeps egress denial ahead of readiness and refuses URL credentials", async () => {
  const fixture = browserFixture([origin + "/render/map", "https://denied.test/tile", "http://user:pass@127.0.0.1:3216/api/account"]);
  expect(await render(delegateCredential(authenticateSession(signed.secret, db)!, db))).toHaveProperty("failed");
  expect(fixture.sent).toHaveLength(1); expect(fixture.aborted).toHaveLength(2); expect(fixture.page.screenshot).not.toHaveBeenCalled();
});

it("refuses a failed credential lookup instead of continuing the request", () => {
  const credential = delegateCredential(authenticateSession(signed.secret, db)!, db);
  vi.mocked(metadata.metadataDb).mockImplementation(() => { throw new Error("Credential store unavailable"); });
  expect(renderRequestHeaders(origin + "/api/maps/map", origin, credential, {})).toBeNull();
});

it("refuses a durable token before it reaches the render browser", async () => {
  const token = createApiToken(authenticateSession(signed.secret, db)!, "Render", db);
  const fixture = browserFixture([origin + "/render/map"]);
  expect(await render(token.secret)).toHaveProperty("failed");
  expect(fixture.sent).toEqual([]);
  expect(fixture.page.screenshot).not.toHaveBeenCalled();
});
