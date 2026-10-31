import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Duplex, Readable } from "node:stream";
import { getCloneableBody } from "next/dist/server/body-streams";
import { installIngress } from "./ingress.mjs";
import { gateRequest } from "./gate";
import * as metadata from "@/lib/metadata/db";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken, revokeApiToken, signOut } from "./credentials";
import { config } from "@/proxy";
import nextConfig from "../../../next.config";
import * as tables from "@/app/api/tables/route";
import * as picture from "@/app/api/account/picture/route";
import * as widgets from "@/app/api/published/[token]/widget-values/route";
import * as render from "@/app/api/published/[token]/render/[layerId]/route";
import * as extent from "@/app/api/published/[token]/extent/[layerId]/route";
import * as signIn from "@/app/api/auth/sign-in/route";
import * as setup from "@/app/api/auth/setup/route";
import * as externalStart from "@/app/api/auth/external/start/route";
import * as externalArrival from "@/app/api/auth/external/arrive/route";
import * as redeem from "@/app/api/auth/redeem/route";

const origin = "http://instance.test";
// The router invokes the proxy if either spelling matches, in both server modes.
// This helper reparses the decoded path as a URL, so an encoded ? or # inside a
// segment can appear proxied here even though the router treats it as path text
// and excludes it. No inventory row depends on that case; handler gates cover
// either outcome.
function routerMatches(input: Parameters<typeof unstable_doesMiddlewareMatch>[0]): boolean {
  const pathname = new URL(input.url, origin).pathname;
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { /* Keep malformed escapes raw. */ }
  return unstable_doesMiddlewareMatch({ ...input, url: pathname })
    || unstable_doesMiddlewareMatch({ ...input, url: decoded });
}
const methods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"];
const excluded = [
  { path: "/api/tables", handlers: tables, allowed: ["GET", "HEAD", "OPTIONS", "POST"] },
  { path: "/api/account/picture", handlers: picture, allowed: ["DELETE", "OPTIONS", "PUT"] },
  { path: "/api/published/fixture/widget-values", handlers: widgets, allowed: ["OPTIONS", "POST"] },
  { path: "/api/published/fixture/render/fixture", handlers: render, allowed: ["OPTIONS", "POST"] },
  { path: "/api/published/fixture/extent/fixture", handlers: extent, allowed: ["OPTIONS", "POST"] },
  { path: "/api/auth/sign-in", handlers: signIn, allowed: ["OPTIONS", "POST"] },
  { path: "/api/auth/setup", handlers: setup, allowed: ["OPTIONS", "POST"] },
  { path: "/api/auth/redeem", handlers: redeem, allowed: ["OPTIONS", "POST"] },
  { path: "/api/auth/external/start", handlers: externalStart, allowed: ["OPTIONS", "POST"] },
  { path: "/api/auth/external/arrive", handlers: externalArrival, allowed: ["OPTIONS", "POST"] },
];
// Posts any caller may send: the handler's own gate admits them anonymously.
const anonymousPost = (path: string) => path.startsWith("/api/published/") || path.startsWith("/api/auth/");
let db: Database;
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const input = (path: string, method: string, headers: Record<string, string> = {}) => socketRequest(new Request(origin + path, { method, headers: { origin, ...headers } }));

it("excludes exactly the streaming upload and entry paths and admits the full workflow tier to dispatch", () => {
  for (const { path: url } of excluded) expect(routerMatches({ config, nextConfig, url })).toBe(false);
  for (const url of ["/api/tables/id", "/api/tables-extra", "/api/auth/sign-out", "/api/auth/session", "/api/recipes",
    "/api/account", "/api/account/picture/extra", "/api/account/pictures", "/api/accounts/name/picture"]) {
    expect(routerMatches({ config, nextConfig, url }), url).toBe(true);
  }
  expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(17 * 1024 * 1024);
});

// The bytes a caller can make the instance take off the wire before its post
// is answered. Where the router runs the proxy, the framework copies the body
// for it and holds the answer until the whole body has arrived; elsewhere the
// handler reads what its own bound admits and answers.
const LARGE_POST = 4 * 1024 * 1024;
async function bytesTakenBeforeAnswer(path: string, post: (request: Request) => Promise<Response>, headers: Record<string, string>) {
  let taken = 0;
  const body = (counted: boolean) => Readable.from((function* () {
    for (let sent = 0; sent < LARGE_POST; sent += 4096) { if (counted) taken += 4096; yield Buffer.alloc(4096, 32); }
  })(), { objectMode: false, highWaterMark: 4096 });
  const request = (stream: Readable) => socketRequest(new Request(origin + path, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: Readable.toWeb(stream) as ReadableStream, duplex: "half",
  } as RequestInit));
  let wire = body(true);
  if (routerMatches({ config, nextConfig, url: path })) {
    const copy = getCloneableBody(wire as never, nextConfig.experimental?.proxyClientMaxBodySize as number);
    const gate = gateRequest(request(copy.cloneBodyStream()));
    await copy.finalize();
    if (gate.headers.get("x-middleware-next") !== "1") return { status: gate.status, taken };
    // The route then reads the copy the framework kept: the same bytes, none
    // of them still on the wire.
    wire = body(false);
  }
  const response = await post(request(wire));
  return { status: response.status, taken };
}

it.each([
  ["same-origin", { origin }, 413],
  ["cross-site", { origin: "https://elsewhere.test" }, 403],
] as const)("answers a large anonymous %s entry post having taken at most its handler's bound", async (_label, headers, status) => {
  for (const [path, handlers] of [["/api/auth/sign-in", signIn], ["/api/auth/setup", setup], ["/api/auth/redeem", redeem]] as const) {
    const answer = await bytesTakenBeforeAnswer(path, handlers.POST, headers);
    expect.soft(answer.status, path).toBe(status);
    // The 64 KiB handler bound plus a few 4 KiB chunks of read-ahead.
    expect.soft(answer.taken, path).toBeLessThanOrEqual(65_536 + 4 * 4096);
  }
});

it("exports all dispatchable methods on each excluded path", () => {
  for (const { handlers } of excluded) expect(Object.keys(handlers).sort()).toEqual([...methods].sort());
});

it.each(["anonymous", "invalid", "revoked-token", "revoked-cookie"])("gates actual excluded handlers for %s without body work or writes", async mode => {
  const headers: Record<string, string> = {};
  if (mode !== "anonymous") {
    const signed = await createFirstAccount({ name: "Admin", email: "admin@example.test", password: "field notebooks at dawn" }, db);
    const context = authenticateSession(signed.secret, db)!;
    if (mode === "revoked-cookie") { signOut(context, db); headers.cookie = `dezfil_session=${signed.secret}`; }
    else { const token = createApiToken(context, "Fixture", db); revokeApiToken(context, token.id, db); headers.authorization = `Bearer ${mode === "invalid" ? "invalid" : token.secret}`; }
  }
  const before = db.serialize();
  for (const { path, handlers } of excluded) for (const method of methods) {
    if (anonymousPost(path) && method === "POST") continue;
    const request = input(path, method, headers);
    const body = vi.spyOn(request, "body", "get");
    const handler = (handlers as unknown as Record<string, (request: Request) => Promise<Response>>)[method];
    expect(handler, `${method} ${path}`).toBeTypeOf("function");
    const response = await handler(request);
    expect(response.status, `${method} ${path}`).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).not.toHaveBeenCalled();
  }
  expect(db.serialize()).toEqual(before);
});

it("preserves successful private answers, rolling cookies, origin and account checks on final responses", async () => {
  const signed = await createFirstAccount({ name: "Admin", email: "admin@example.test", password: "field notebooks at dawn" }, db);
  const cookie = `dezfil_session=${signed.secret}`;
  const response = await tables.GET(input("/api/tables", "GET", { cookie }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("set-cookie")).toContain(cookie);
  expect(await response.json()).toEqual([]);
  for (const headers of [{ cookie, origin: "https://elsewhere.test" }, { cookie, "x-dezfil-account": "wrong" }] as Record<string, string>[]) {
    const request = input("/api/tables", "POST", headers);
    const body = vi.spyOn(request, "body", "get");
    const result = await tables.POST(request);
    expect(result.status).toBe(headers.origin ? 403 : 401);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(body).not.toHaveBeenCalled();
  }
});

it("keeps authenticated wrong-method answers and OPTIONS behind the gate", async () => {
  const signed = await createFirstAccount({ name: "Admin", email: "admin@example.test", password: "field notebooks at dawn" }, db);
  for (const { path, handlers, allowed } of excluded) for (const method of methods.filter(method => !allowed.includes(method) || method === "OPTIONS")) {
    const request = input(path, method, { cookie: `dezfil_session=${signed.secret}` });
    const response = await (handlers as unknown as Record<string, (request: Request) => Promise<Response>>)[method](request);
    expect(response.status).toBe(method === "OPTIONS" ? 204 : 405);
    expect(response.headers.get("allow")?.split(", ").sort()).toEqual(allowed);
    expect(response.headers.get("set-cookie")).toContain(`dezfil_session=${signed.secret}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    if (method !== "OPTIONS" && method !== "HEAD") expect(await response.json()).toEqual({ error: { code: "method_not_allowed", message: "This method is not allowed for this path." } });
    else expect(await response.text()).toBe("");
  }
});

it("answers TRACE in the product ingress before a handler or body read", () => {
  installIngress();
  for (const pathname of [...excluded.map(row => row.path), "/api/maps"]) {
    for (const event of ["request", "checkContinue", "checkExpectation"]) {
      const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
      Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
      const incoming = new IncomingMessage(socket as Socket);
      incoming.method = "TRACE"; incoming.url = pathname;
      incoming.headers = { host: "instance.test", "content-length": "4194304" };
      incoming.rawHeaders = ["Host", "instance.test", "Content-Length", "4194304"];
      const response = new ServerResponse(incoming), reached = vi.fn();
      const read = vi.spyOn(incoming, "read"), end = vi.spyOn(response, "end"), head = vi.spyOn(response, "writeHead");
      try {
        new Server().on(event, reached).emit(event, incoming, response);
        expect(response.statusCode).toBe(400);
        expect(head).toHaveBeenCalledExactlyOnceWith(400, { "cache-control": "private, no-store", "content-length": "0", connection: "close" });
        expect(end).toHaveBeenCalledExactlyOnceWith();
        expect(reached).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
      } finally { incoming.destroy(); socket.destroy(); }
    }
  }
});

it("detects a removed fallback and resource work disguised as a fallback", async () => {
  const { routeExports } = await import("../../../test-support/api-route-inventory");
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/app/api/tables/route.ts", "utf8");
  const assertInventory = (text: string) => expect(routeExports(text).map(row => row.method.toUpperCase()).sort()).toEqual([...methods].sort());
  assertInventory(source);
  expect(() => assertInventory(source.replace(/export async function PUT[^\n]+/, ""))).toThrow();
  const resources = (text: string) => routeExports(text).filter(row => !row.transport).map(row => row.method).sort();
  expect(resources(source)).toEqual(["get", "post"]);
  for (const seeded of [source.replace("return gateOnly(request);", "return upload(request);"),
    source.replace("return gateOnly(request);", "await upload(request); return gateOnly(request);")]) {
    expect(resources(seeded)).not.toEqual(["get", "post"]);
  }
});

it("detects a seeded missing handler gate on an otherwise authenticated resource", async () => {
  const { withRouteGate } = await import("./route-gate");
  const work = vi.fn(async () => Response.json({ ok: true }));
  const check = async (handler: (request: Request) => Promise<Response>) => {
    const response = await handler(input("/api/tables", "GET"));
    expect(response.status).toBe(401);
    expect(work).not.toHaveBeenCalled();
  };
  await expect(check(() => work())).rejects.toThrow();
  work.mockClear();
  await check(request => withRouteGate(request, work));
});

it("retains public POST access with invalid credentials and cross-site origin, and private refusals", async () => {
  for (const { path, handlers } of excluded.filter(row => row.path.startsWith("/api/published/"))) {
    const request = input(path, "POST", { cookie: "dezfil_session=invalid", origin: "https://elsewhere.test" });
    const response = await handlers.POST(request, { params: Promise.resolve({ token: "missing", layerId: "missing" }) });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});

it("preserves cookie origin checks and final rolling cookies on every excluded shape", async () => {
  const signed = await createFirstAccount({ name: "Admin", email: "admin@example.test", password: "field notebooks at dawn" }, db);
  for (const { path, handlers } of excluded) {
    for (const originValue of ["", "https://elsewhere.test"]) {
      const response = await handlers.PUT(input(path, "PUT", { cookie: `dezfil_session=${signed.secret}`, origin: originValue }));
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  }
  const response = await tables.POST(input("/api/tables", "POST", { cookie: `dezfil_session=${signed.secret}` }));
  expect(response.status).toBe(400);
  expect(response.headers.get("set-cookie")).toContain(`dezfil_session=${signed.secret}`);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});


it("holds one closed exclusion inventory against the literal compiled matcher and router path decoding", () => {
  const expected = "/((?!" + [...excluded.map(({ path }) => path.slice(1).replaceAll("fixture", "[^/]+") + "/?$"), "arrive/?$"].join("|") + ").*)";
  expect(config.matcher).toEqual([expected]);
  for (const { path } of excluded) for (const suffix of ["", "/", "?query=1"]) {
    expect(routerMatches({ config, nextConfig, url: path + suffix }), `${path}${suffix}`).toBe(false);
  }
  for (const url of ["/arrive/extra", "/arrive.json", "/api/auth/external/start/extra", "/api/auth/external/arrive/extra", "/api/%74ables", "/api/tables.json", "/api/tables/extra", "/api/tables-extra",
    "/api/published/token", "/api/published/token/render", "/api/published/token/render/id/extra",
    "/api/published/token/widget-values/extra", "/api/published/token/tiles/layer/0/0/0",
    "/api/published/token/%72ender/id", "/api/auth/sign-out", "/api/auth/session", "/api/auth/entry",
    "/api/auth/sign-in/extra", "/api/auth/sign-inx", "/api/auth/%73etup", "/api/auth/setup.json",
    "/api/published/t%2Foken/widget-values", "/api/published/%74oken/render/l%2Fayer",
    "/api/account", "/api/account/picture/extra", "/api/account/%70icture", "/api/account/picture.webp"]) {
    expect(routerMatches({ config, nextConfig, url }), url).toBe(true);
  }
  expect(routerMatches({ config, nextConfig, url: "/api/published/token/extent/%6cayer/" })).toBe(false);
  const seeded = { matcher: [expected.replace("(?!", "(?!api/maps/?$|")] };
  expect(seeded.matcher).not.toEqual([expected]);
  expect(routerMatches({ config: seeded, nextConfig, url: "/api/maps" })).toBe(false);
});
