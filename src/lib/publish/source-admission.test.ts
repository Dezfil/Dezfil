import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { GET as view } from "@/app/api/published/[token]/route";
import { POST as widgets } from "@/app/api/published/[token]/widget-values/route";
import { POST as render } from "@/app/api/published/[token]/render/[layerId]/route";
import { POST as extent } from "@/app/api/published/[token]/extent/[layerId]/route";
import { GET as tiles } from "@/app/api/published/[token]/tiles/[layerId]/[z]/[x]/[y]/route";
import { rateLimitEntryCount, resetRateLimits, rateLimit, tileMaxPerWindow } from "./rate-limit";

const resolution = vi.hoisted(() => vi.fn());
vi.mock("./publish-service", () => ({ getPublishedView: async (token: string) => { resolution(token); return token === "valid" ? {} : null; } }));
vi.mock("./publication-scope", () => ({ resolvePublication: (token: string) => { resolution(token); return null; } }));
vi.mock("@/lib/tiles/published", () => ({ currentPublishedTile: (token: string) => { resolution(token); return null; } }));
const lanes = [
  { handler: view, method: "GET", suffix: "" },
  { handler: widgets, method: "POST", suffix: "/widget-values" },
  { handler: render, method: "POST", suffix: "/render/layer" },
  { handler: extent, method: "POST", suffix: "/extent/layer" },
  { handler: tiles, method: "GET", suffix: "/tiles/layer/0/0/0" },
];
function request(lane: typeof lanes[number], token: string) {
  return new Request(`http://instance.test/api/published/${token}${lane.suffix}`, { method: lane.method,
    ...(lane.method === "POST" ? { body: "{}" } : {}) });
}
const call = (lane: typeof lanes[number], req: Request, token = "unknown") => lane.handler(req,
  { params: Promise.resolve({ token, layerId: "layer", z: "0", x: "0", y: "0" }) });
beforeEach(() => { resetRateLimits(); resolution.mockClear(); vi.spyOn(Date, "now").mockReturnValue(1000); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetRateLimits(); });

it.each(lanes)("refuses absent and forged provenance before body or publication work: $suffix", async lane => {
  for (const forged of [false, true]) {
    const req = request(lane, "unknown");
    if (forged) { req.headers.set("x-dezfil-ingress", "forged"); req.headers.set("x-forwarded-for", "192.0.2.1"); }
    const body = vi.spyOn(req, "body", "get");
    const response = await call(lane, req);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "ingress_unavailable", message: "The instance cannot serve published maps yet." } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).not.toHaveBeenCalled(); expect(resolution).not.toHaveBeenCalled();
    expect(rateLimitEntryCount()).toBe(0);
  }
});

it("charges all view lanes across tokens, including unknown ones, independently of tiles", async () => {
  vi.stubEnv("DEZFIL_PUBLIC_RATE_LIMIT", "4"); vi.stubEnv("DEZFIL_PUBLIC_TILE_RATE_LIMIT", "2");
  for (const [i, lane] of lanes.slice(0, 4).entries()) {
    const token = i === 0 ? "valid" : "unknown";
    expect((await call(lane, socketRequest(request(lane, token)), token)).status).toBe(i === 0 ? 200 : 404);
  }
  for (const lane of lanes.slice(0, 4)) {
    const req = socketRequest(request(lane, "valid")); req.headers.set("x-forwarded-for", "192.0.2.99");
    const response = await call(lane, req, "valid");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { code: "rate_limited", message: "Too many requests. Please slow down." } });
  }
  expect((await call(lanes[4], socketRequest(request(lanes[4], "unknown")))).status).toBe(404);
  expect((await call(lanes[4], socketRequest(request(lanes[4], "unknown")))).status).toBe(404);
  expect((await call(lanes[4], socketRequest(request(lanes[4], "unknown")))).status).toBe(429);
  expect(rateLimitEntryCount()).toBe(2);
  // Handler admission control, not a claim about real socket delivery.
  expect((await call(lanes[0], socketRequest(request(lanes[0], "unknown"), "127.0.0.2"))).status).toBe(404);
  expect((await call(lanes[0], socketRequest(request(lanes[0], "unknown"), "::ffff:127.0.0.1"))).status).toBe(429);
  vi.mocked(Date.now).mockReturnValue(11_000);
  expect((await call(lanes[0], socketRequest(request(lanes[0], "unknown")))).status).toBe(404);
  expect(rateLimitEntryCount()).toBe(1);
});

it("bounds every admission above ten thousand verified sources across valid and unknown tokens and both buckets", async () => {
  for (let i = 0; i < 10_020; i++) {
    const lane = lanes[i % 2 ? 4 : 0], token = i % 4 ? "unknown" : "valid";
    const peer = `10.${i >>> 16}.${(i >>> 8) & 255}.${i & 255}`;
    const response = await call(lane, socketRequest(request(lane, token), peer), token);
    expect(response.status).toBe(token === "valid" ? 200 : 404);
    expect(rateLimitEntryCount()).toBe(Math.min(i + 1, 10_000));
  }
});

it("expires on ordinary hits before capacity eviction and refreshes LRU even on refusal", () => {
  rateLimit("pub:expired", 0, 1);
  for (let i = 0; i < 9999; i++) rateLimit(`tile:${i}`, 1, 1);
  expect(rateLimit("tile:0", 10_000, 1)).toBe(false);
  expect(rateLimitEntryCount()).toBe(9999);
  rateLimit("pub:new", 10_000, 1);
  rateLimit("pub:overflow", 10_000, 1);
  expect(rateLimitEntryCount()).toBe(10_000);
  expect(rateLimit("tile:0", 10_000, 1)).toBe(false);
  expect(rateLimit("tile:1", 10_000, 1)).toBe(true); // evicted, fresh window
});

it("retains the default sixty and six hundred budgets", () => {
  vi.stubEnv("DEZFIL_PUBLIC_RATE_LIMIT", ""); vi.stubEnv("DEZFIL_PUBLIC_TILE_RATE_LIMIT", "");
  for (let i = 0; i < 60; i++) expect(rateLimit("pub:default", 1)).toBe(true);
  expect(rateLimit("pub:default", 1)).toBe(false);
  expect(tileMaxPerWindow()).toBe(600);
  for (let i = 0; i < 600; i++) expect(rateLimit("tile:default", 1, tileMaxPerWindow())).toBe(true);
  expect(rateLimit("tile:default", 1, tileMaxPerWindow())).toBe(false);
});

it("shares the same state after another route bundle loads the module", async () => {
  expect(rateLimit("pub:shared", 1, 1)).toBe(true);
  vi.resetModules();
  const other = await import("./rate-limit");
  expect(other.rateLimit("pub:shared", 1, 1)).toBe(false);
  expect(other.rateLimitEntryCount()).toBe(1);
});

it("documents provenance refusal on every anonymous published operation", async () => {
  const { buildOpenApiDocument } = await import("@/lib/api/openapi");
  const operations = Object.entries(buildOpenApiDocument().paths).filter(([path]) => path.startsWith("/api/published/"));
  expect(operations).toHaveLength(5);
  for (const [, methods] of operations) for (const [method, operation] of Object.entries(methods)) {
    if (!["get", "post"].includes(method)) continue;
    const description = operation as { description: string; responses: Record<string, { description: string }> };
    expect(description.description).toContain("Verified ingress source");
    expect(description.responses["503"].description).toContain("The instance cannot serve published maps yet.");
  }
});

it("sweeps at most once per second across route bundles while expiring the requested key", async () => {
  const windows = (process as unknown as Record<symbol, Map<string, unknown>>)[Symbol.for("dezfil.publication-windows")];
  const sweep = vi.spyOn(windows, Symbol.iterator);
  rateLimit("pub:one", 0, 1);
  rateLimit("pub:two", 1, 1);
  expect(rateLimit("pub:one", 999, 1)).toBe(false);
  expect(sweep).toHaveBeenCalledTimes(1);
  vi.resetModules();
  const other = await import("./rate-limit");
  other.rateLimit("tile:three", 999, 1);
  expect(sweep).toHaveBeenCalledTimes(1);
  other.rateLimit("tile:three", 1000, 1);
  expect(sweep).toHaveBeenCalledTimes(2);
  rateLimit("pub:one", 10_000, 1);
  expect(sweep).toHaveBeenCalledTimes(3);
  // This key expires inside the sweep interval, so its own lookup must renew it.
  expect(rateLimit("pub:two", 10_001, 1)).toBe(true);
  expect(rateLimit("pub:two", 10_002, 1)).toBe(false);
  expect(sweep).toHaveBeenCalledTimes(3);
  rateLimit("pub:one", 11_000, 1);
  expect(sweep).toHaveBeenCalledTimes(4);
});

it("renews an expired key between sweeps at capacity without evicting another live key", () => {
  rateLimit("pub:expired", 1, 1);
  for (let i = 0; i < 9999; i++) rateLimit(`tile:${i}`, 2, 1);
  expect(rateLimit("pub:expired", 3, 1)).toBe(false); // Expired key is newest in the LRU.
  expect(rateLimit("tile:9998", 10_000, 1)).toBe(false); // Sweep before any expiry.
  expect(rateLimit("pub:expired", 10_001, 1)).toBe(true);
  expect(rateLimitEntryCount()).toBe(10_000);
  expect(rateLimit("tile:0", 10_001, 1)).toBe(false);
});
