import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldProvider, until, pause } from "../../../scripts/held-provider.mjs";
import { searchPlaces } from "@/lib/search/provider";
import { resetLimiter } from "@/lib/geocode/limiter";
import { inspectStyle } from "./inspect-style";

// Real listener proof: run outside environments that forbid listening sockets.
let fixture: Awaited<ReturnType<typeof heldProvider>> | undefined;
beforeEach(async () => {
  fixture = await heldProvider(0);
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  vi.stubEnv("DEZFIL_GEOCODER_URL", fixture.origin);
  vi.stubEnv("DEZFIL_GEOCODE_PACE_MS", "0");
  resetLimiter();
});
afterEach(async () => { await fixture?.close(); fixture = undefined; resetLimiter(); vi.unstubAllEnvs(); });

describe("provider seams with a real listener", () => {
  for (const road of ["search", "inspect"] as const) {
    it(`${road} opens no socket for a pre-aborted call, then recovers`, async () => {
      const cancelled = fixture!.arm(road, "normal", "cancelled");
      const call = (id: string, url: string, signal?: AbortSignal) => road === "search"
        ? Reflect.apply(searchPlaces, null, [id, signal])
        : Reflect.apply(inspectStyle, null, [url, undefined, signal]);
      const before = fixture!.connections();
      await Promise.resolve(call(cancelled.id, cancelled.url, AbortSignal.abort())).catch(() => {});
      await pause(100);
      expect(fixture!.connections()).toBe(before);
      expect(cancelled.requests).toHaveLength(0);
      const normal = fixture!.arm(road, "normal", "normal");
      const answer = await call(normal.id, normal.url);
      expect(answer).toMatchObject(road === "search" ? { state: "ok", attribution: "Fixture credit" } : { verdict: "valid", name: "Fixture style" });
      await until(() => normal.requests.length === 1, "recovery did not contact provider");
      expect(fixture!.connections()).toBeGreaterThan(before);
    });
  }
});
