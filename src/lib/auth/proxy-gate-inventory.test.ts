import path from "node:path";
import type { Database } from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { implementedRoutes, walk } from "../../../test-support/api-route-inventory";
import * as metadata from "@/lib/metadata/db";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { AUTH_SECURITY } from "@/lib/api/openapi-auth";
import { createFirstAccount } from "./accounts";
import { authenticateSession, createApiToken, revokeApiToken, signOut } from "./credentials";
import { gateRequest } from "./gate";

let db: Database;
const origin = "http://instance.test";
const publicOperations = new Set([
  "GET /api/health", "GET /api/auth/entry", "POST /api/auth/setup", "POST /api/auth/sign-in", "POST /api/auth/redeem", "POST /api/auth/external/start", "POST /api/auth/external/arrive",
  "GET /api/published/{token}", "POST /api/published/{token}/extent/{layerId}", "POST /api/published/{token}/widget-values",
  "POST /api/published/{token}/render/{layerId}", "GET /api/published/{token}/tiles/{layerId}/{z}/{x}/{y}",
  // A published page's satellite style and its tiles, under the token, as its layer tiles are.
  "GET /api/published/{token}/basemaps/satellite", "GET /api/published/{token}/basemaps/satellite/tiles/{z}/{x}/{y}",
]);
const routes = implementedRoutes();
const KEPT = ["/api/maps/{id}/thumbnail", "/api/accounts/{sqlName}/picture"];
const protectedRoutes = routes.filter(route => !publicOperations.has(`${route.method.toUpperCase()} ${route.path}`));
const input = (pathname: string, method = "GET", headers: Record<string, string> = {}) => new NextRequest(socketRequest(new Request(origin + pathname, { method, headers: { origin, ...headers } })));
beforeEach(() => { db = metadata.open(":memory:"); vi.spyOn(metadata, "metadataDb").mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

it.each(["anonymous", "invalid", "revoked-token", "revoked-cookie"])("refuses %s across the complete protected API inventory before dispatch", async mode => {
  const headers: Record<string, string> = {};
  if (mode !== "anonymous") {
    const signed = await createFirstAccount({ name: "Admin", email: "admin@example.test", password: "field notebooks at dawn" }, db);
    const context = authenticateSession(signed.secret, db)!;
    if (mode === "revoked-cookie") { signOut(context, db); headers.cookie = `dezfil_session=${signed.secret}`; }
    else {
      const token = createApiToken(context, "Fixture", db); revokeApiToken(context, token.id, db);
      headers.authorization = `Bearer ${mode === "invalid" ? "invalid" : token.secret}`;
    }
  }
  const before = db.serialize();
  expect(protectedRoutes.length).toBeGreaterThan(100);
  for (const route of protectedRoutes) {
    const response = gateRequest(input(route.path.replaceAll(/\{[^}]+\}/g, "fixture"), route.method.toUpperCase(), headers));
    expect.soft(response.status, `${route.method} ${route.path}`).toBe(401);
    expect.soft(response.headers.get("x-middleware-next"), route.path).toBeNull();
    expect.soft(response.headers.get("cache-control"), route.path).toBe("private, no-store");
  }
  expect(db.serialize()).toEqual(before);
});

it("redirects every private application page before and after setup, including unknown future routes", async () => {
  const pages = walk(path.join(process.cwd(), "src/app")).filter(file => file.endsWith("/page.tsx"))
    .map(file => "/" + path.relative("src/app", path.dirname(file)).split(path.sep).filter(segment => !segment.startsWith("(")).map(segment => segment.startsWith("[") ? "fixture" : segment).join("/"))
    .filter(page => !["/setup", "/sign-in", "/accept", "/arrive"].includes(page) && page !== "/v" && !page.startsWith("/v/"));
  // The render root's own addresses are private like a map's render page.
  expect(pages).toEqual(expect.arrayContaining(["/render", "/render/fixture", "/render/fixture/fixture"]));
  pages.push("/future-feature", "/private.json", "/_next/data/build/maps.json", "/_next/image?url=/api/maps");
  for (const destination of ["/setup", "/sign-in"]) {
    for (const pathname of pages) {
      const response = gateRequest(input(pathname));
      expect.soft(response.status, pathname).toBe(307);
      expect.soft(response.headers.get("location"), pathname).toBe(origin + destination);
      expect.soft(response.headers.get("cache-control"), pathname).toBe("private, no-store");
    }
    if (destination === "/setup") await createFirstAccount({ name: "Admin", email: "admin@example.test", password: "field notebooks at dawn" }, db);
  }
});

it("refuses cross-site cookie mutations across the protected inventory without rolling or writing", async () => {
  const signed = await createFirstAccount({ name: "Admin", email: "admin@example.test", password: "field notebooks at dawn" }, db);
  const before = db.serialize();
  for (const route of protectedRoutes.filter(route => route.method !== "get")) {
    const response = gateRequest(input(route.path.replaceAll(/\{[^}]+\}/g, "fixture"), route.method.toUpperCase(), { cookie: `dezfil_session=${signed.secret}`, origin: "https://unrelated.test" }));
    expect.soft(response.status, route.path).toBe(403);
    expect.soft(response.headers.get("x-middleware-next"), route.path).toBeNull();
  }
  expect(db.serialize()).toEqual(before);
});

it("allows only explicit anonymous methods and data-free assets, even with an invalid cookie", () => {
  const publicPaths = ["/api/health", "/api/auth/entry", "/accept", "/arrive", "/v/token", "/v/token?embed=1", "/v", "/v/token/extra", "/v/token/extra/more", "/_next/static/chunks/app.js", "/_next/static/media/font.woff2", "/icon.svg", "/shell-sheet-light.svg", "/entry/river-delta.webp", "/maki/marker.svg", "/workers/maplibre-gl-6.14.0/maplibre-gl-worker.mjs", "/workers/loaders.gl-mvt-worker-4.5.4.js"];
  for (const pathname of publicPaths) {
    const response = gateRequest(input(pathname, "GET", { cookie: "dezfil_session=invalid" }));
    expect.soft(response.headers.get("x-middleware-next"), pathname).toBe("1");
    expect(response.headers.get("set-cookie"), pathname).toBeNull();
  }
  for (const key of publicOperations) {
    const [method, template] = key.split(" ");
    const pathname = template.replaceAll(/\{[^}]+\}/g, "fixture");
    expect.soft(gateRequest(input(pathname, method)).headers.get("x-middleware-next"), key).toBe("1");
  }
  for (const pathname of ["/api/health", "/api/published/token", "/api/published/token/widget-values", "/api/published/token/basemaps/satellite", "/api/published/token/basemaps/satellite/tiles/1/2/3", "/v/token", "/v", "/v/token/extra", "/_next/static/chunks/app.js", "/maki/marker.svg"]) {
    const response = gateRequest(input(pathname, "DELETE"));
    expect.soft(response.headers.get("x-middleware-next"), pathname).toBeNull();
  }
  for (const pathname of ["/vault", "/viewer/token", "/render", "/render/token/extra", "/api/published/token/authoring", "/api/published/token/widget-values/extra", "/api/published/token/basemaps/streets", "/api/published/token/basemaps/satellite/extra", "/api/published/token/basemaps/satellite/tiles/1/2", "/api/published/token/basemaps/satellite/tiles/1/2/3/4", "/api/unknown.svg", "/maki/private.svg", "/workers/private.js", "/_next/server/private.js", "/_next/hmr"]) {
    expect.soft(gateRequest(input(pathname)).headers.get("x-middleware-next"), pathname).toBeNull();
  }
});

it("declares security and authentication refusal on every operation using the same public matrix", () => {
  const doc = buildOpenApiDocument();
  for (const [pathname, methods] of Object.entries(doc.paths)) for (const [method, value] of Object.entries(methods)) {
    const operation = value as { security?: unknown; responses: Record<string, unknown> };
    const anonymous = publicOperations.has(`${method === "head" ? "GET" : method.toUpperCase()} ${pathname}`);
    expect.soft(operation.security, `${method} ${pathname}`).toEqual(anonymous ? [] : AUTH_SECURITY);
    if (!anonymous) expect.soft(operation.responses, pathname).toHaveProperty("401");
  }
});

it("permits the HMR endpoint only in development and never exempts arbitrary internal endpoints", async () => {
  const { isAnonymousAsset } = await import("./public-assets");
  expect(isAnonymousAsset("/_next/hmr", "GET", true)).toBe(true);
  expect(isAnonymousAsset("/_next/hmr", "GET", false)).toBe(false);
  for (const pathname of ["/_next/data/build/maps.json", "/_next/image", "/_next/server/chunk.js"]) {
    expect(isAnonymousAsset(pathname, "GET", true)).toBe(false);
  }
});

it.each(["cookie", "token"])("admits a current %s on every protected operation with private responses", async kind => {
  const signed = await createFirstAccount({ name: "Admin", email: "admin@example.test", password: "field notebooks at dawn" }, db);
  const token = createApiToken(authenticateSession(signed.secret, db)!, "Fixture", db);
  const headers: Record<string, string> = kind === "cookie" ? { cookie: `dezfil_session=${signed.secret}` } : { authorization: `Bearer ${token.secret}` };
  for (const route of protectedRoutes) {
    const response = gateRequest(input(route.path.replaceAll(/\{[^}]+\}/g, "fixture"), route.method.toUpperCase(), headers));
    expect(response.headers.get("x-middleware-next"), route.path).toBe("1");
    // A map's picture and a person's are left to their routes, which let
    // the browser keep them and revalidate them; every other answer is
    // never kept.
    const revalidated = route.method === "get" && KEPT.includes(route.path);
    expect(response.headers.get("cache-control"), route.path).toBe(revalidated ? null : "private, no-store");
  }
  for (const path of KEPT) expect(protectedRoutes.some(route => route.method === "get" && route.path === path), path).toBe(true);
});
