import { blockCrossSiteDEV } from "next/dist/server/lib/router-utils/block-cross-site-dev";
import { afterEach, expect, it, vi } from "vitest";
import nextConfig from "../../../next.config";
import { selfBaseUrl } from "@/lib/self-url";

// The development server's own check, as it runs for the reload socket and
// every other development resource, given an allowance.
function refused(origin: string, allowed: string[] | undefined) {
  const response = { statusCode: 200, end: vi.fn() };
  return blockCrossSiteDEV({ url: "/_next/hmr", headers: { origin } } as never, response as never, allowed, undefined);
}
afterEach(() => vi.unstubAllEnvs());

it("allows exactly the host the image renderer opens its pages at", () => {
  vi.stubEnv("PORT", "");
  const hosts = new Set([
    selfBaseUrl(),
    selfBaseUrl(new Request("http://localhost:3631/api/maps/map/export/image")),
    selfBaseUrl(new Request("http://192.0.2.7:3631/api/maps/look")),
  ].map(base => new URL(base).hostname));
  vi.stubEnv("PORT", "3631");
  hosts.add(new URL(selfBaseUrl()).hostname);
  expect([...hosts]).toEqual(["127.0.0.1"]);
  expect(nextConfig.allowedDevOrigins).toEqual(["127.0.0.1"]);
});

it("lets the render page's reload socket through the development server's origin check", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Refused without the allowance: the page then never starts.
  expect(refused("http://127.0.0.1:3631", undefined)).toBe(true);
  expect(refused("http://127.0.0.1:3631", nextConfig.allowedDevOrigins)).toBe(false);
  // Nothing broader: other hosts stay refused, localhost was always allowed.
  for (const origin of ["http://127.0.0.2:3631", "http://[::1]:3631", "http://192.0.2.7:3631", "http://example.test"]) {
    expect(refused(origin, nextConfig.allowedDevOrigins), origin).toBe(true);
  }
  expect(refused("http://localhost:3631", undefined)).toBe(false);
});
