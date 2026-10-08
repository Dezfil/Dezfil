import https from "node:https";
import type { ClientRequest } from "node:http";
import { EventEmitter } from "node:events";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { writeStoredSettings } from "../src/lib/settings/store";
import { ApiError } from "../src/lib/api/errors";
import { dataDir } from "../src/lib/config";
import * as network from "../src/lib/net/remote-fetch";
import { providerCacheGeneration } from "../src/lib/provider-cache-generation";
import { resetLimiter, takeSlot } from "../src/lib/geocode/limiter";
import { geocodeAddress } from "../src/lib/geocode/provider";
import { readAnswer, writeAnswer } from "../src/lib/geocode/cache";
import { resetIsochroneLimiter, takeIsochroneSlot } from "../src/lib/isochrone/limiter";
import { askIsochrone } from "../src/lib/isochrone/provider";
import { readIsochrone, writeIsochrone } from "../src/lib/isochrone/cache";
import { cacheKey as overpassCacheKey, fetchOverpass } from "../src/lib/osm/overpass";

/**
 * The services' numbers, each observed where its service reads it: the gap
 * at the limiter, the answer limit and the Overpass time budget at the
 * exchange's own deadline, the freshness at a cached answer's next use.
 * Each probe stores one value, observes it, stores another and observes
 * that at the next request, with no restart between. The services' hosts
 * are reserved names and every exchange stalls at a stubbed transport, so
 * nothing leaves this machine.
 */

type Probe = (db: Database) => Promise<void>;
const HOUR = 60 * 60 * 1000;
const GEOCODER = "https://geocoder.example/search";
const ROUTER = "https://router.example";

// Taken before any probe fakes the clock: a real turn of the event loop,
// for the disk reads a provider makes before its first request.
const realImmediate = setImmediate;
const realTurn = () => new Promise<void>(resolve => realImmediate(resolve));

/** Every request the engine opens stalls until its deadline destroys it. */
function stallRequests() {
  let issued = 0;
  vi.spyOn(https, "request").mockImplementation((() => {
    const request = Object.assign(new EventEmitter(), {
      end() { issued += 1; },
      destroy(error?: Error) { if (error) request.emit("error", error); },
    });
    return request as unknown as ClientRequest;
  }) as unknown as typeof https.request);
  return () => issued;
}

/** Until the first exchange is out, without moving the fake clock: the
 * provider reads its cache from disk, then takes its slot at once. */
async function firstRequest(issued: () => number) {
  for (let turn = 0; issued() === 0; turn++) {
    if (turn > 1000) throw new Error("The provider never sent its request.");
    await vi.advanceTimersByTimeAsync(0);
    await realTurn();
  }
}

/** Refused at exactly `milliseconds` on the fake clock, not before. */
async function refusedAt(pending: Promise<unknown>, milliseconds: number, expected: Record<string, unknown>) {
  let outcome: unknown;
  const observed = pending.then(value => { outcome = value; }, error => { outcome = error; });
  await vi.advanceTimersByTimeAsync(milliseconds - 1);
  expect(outcome, "the exchange must stay open before its stored deadline").toBeUndefined();
  await vi.advanceTimersByTimeAsync(2);
  expect(outcome, "the stored deadline must end the exchange").toMatchObject(expected);
  await observed;
}

/** The second request on one endpoint waits the stored gap after the first. */
async function gapBetween(take: () => Promise<() => void>, gap: number) {
  const first = take();
  await vi.advanceTimersByTimeAsync(0);
  (await first)();
  let opened = false;
  const second = take().then(release => { opened = true; return release; });
  await vi.advanceTimersByTimeAsync(gap - 1);
  expect(opened, "the next request must wait the stored gap").toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  expect(opened, "the next request must start once the stored gap is over").toBe(true);
  (await second)();
}

function gap(key: "geocodePaceMs" | "isochronePaceMs", take: (endpoint: string) => Promise<() => void>): Probe {
  return async db => {
    vi.useFakeTimers();
    // A fresh endpoint per value: each pair starts from an idle slot.
    writeStoredSettings({ [key]: 5000 }, db);
    await gapBetween(() => take(`${key}-first`), 5000);
    writeStoredSettings({ [key]: 2000 }, db);
    await gapBetween(() => take(`${key}-second`), 2000);
    resetLimiter(); resetIsochroneLimiter();
  };
}

/** One address or origin, asked twice (the retry) with no gap between:
 * refused at twice the stored answer limit. */
function answerLimit(key: "geocodeRequestTimeoutS" | "isochroneRequestTimeoutS", gapKey: "geocodePaceMs" | "isochronePaceMs",
  ask: (attempt: number) => Promise<unknown>, code: string): Probe {
  return async db => {
    for (const [attempt, seconds] of [[1, 1], [2, 3]] as const) {
      // The slot starts idle on the real clock each time.
      resetLimiter(); resetIsochroneLimiter();
      writeStoredSettings({ [gapKey]: 0, [key]: seconds }, db);
      const issued = stallRequests();
      vi.useFakeTimers();
      const pending = ask(attempt);
      void pending.catch(() => {});
      await firstRequest(issued);
      await refusedAt(pending, 2 * seconds * 1000, { code });
      expect(issued(), "the retry is the second request").toBe(2);
      vi.mocked(https.request).mockRestore();
      vi.useRealTimers();
    }
    resetLimiter(); resetIsochroneLimiter();
  };
}

const matched = (answeredAt: number) => ({ outcome: "matched" as const, lon: 13.4, lat: 52.5, display: "Fixture", attribution: null,
  answeredAt: new Date(answeredAt).toISOString() });
const area = (answeredAt: number) => ({ bands: [{ minutes: 5, wkt: "POLYGON((13 52, 13.1 52, 13.1 52.1, 13 52))" }],
  snappedLon: 13.05, snappedLat: 52.05, answeredAt: new Date(answeredAt).toISOString() });

/** Kept through its stored freshness and gone one millisecond past it,
 * for two stored values, the second read at the cache's next use. */
async function freshness(db: Database, key: string, values: readonly [number, number],
  cached: (hours: number) => Promise<{ kept: boolean; past: boolean }>) {
  for (const hours of values) {
    writeStoredSettings({ [key]: hours }, db);
    expect(await cached(hours), `${key} at ${hours} h`).toEqual({ kept: true, past: false });
  }
}

const OVERPASS_QL = "[out:json];node(52.5,13.4,52.6,13.5)[amenity=cafe];out;";

export const SERVICE_NUMBER_PROBES: Record<string, Probe> = {
  geocodePaceMs: gap("geocodePaceMs", endpoint => takeSlot(endpoint, "batch")),
  isochronePaceMs: gap("isochronePaceMs", endpoint => takeIsochroneSlot(endpoint)),
  geocodeRequestTimeoutS: answerLimit("geocodeRequestTimeoutS", "geocodePaceMs",
    attempt => geocodeAddress(`${attempt} Fixture Street`, { endpoint: GEOCODER }), "geocoder_failed"),
  isochroneRequestTimeoutS: answerLimit("isochroneRequestTimeoutS", "isochronePaceMs",
    attempt => askIsochrone({ lon: 13 + attempt / 10, lat: 52 }, "driving", [5], { endpoint: ROUTER }), "isochrone_failed"),
  geocodeMatchCacheHours: db => freshness(db, "geocodeMatchCacheHours", [24, 48], async hours => {
    const answered = Date.now(), address = `fixture street ${hours}`;
    await writeAnswer(GEOCODER, address, matched(answered), providerCacheGeneration());
    const kept = await readAnswer(GEOCODER, address, answered + hours * HOUR) !== null;
    const past = await readAnswer(GEOCODER, address, answered + hours * HOUR + 1) !== null;
    return { kept, past };
  }),
  isochroneCacheHours: db => freshness(db, "isochroneCacheHours", [24, 48], async hours => {
    const answered = Date.now(), key = `fixture-origin-${hours}`;
    await writeIsochrone(key, area(answered), providerCacheGeneration());
    const kept = await readIsochrone(key, answered + hours * HOUR) !== null;
    const past = await readIsochrone(key, answered + hours * HOUR + 1) !== null;
    return { kept, past };
  }),
  overpassCacheHours: async db => {
    // The service's reserved name; the exchange a miss would open is refused
    // before any socket, so a miss reads as that refusal.
    vi.stubEnv("DEZFIL_OVERPASS_URL", "https://overpass.example/api/interpreter");
    const refusal = new ApiError("egress_blocked", "Fixture refusal: the cache was missed.", 403);
    const asked = vi.spyOn(network, "openRemote").mockRejectedValue(refusal);
    const file = path.join(dataDir(), "cache", "overpass", `${overpassCacheKey("https://overpass.example/api/interpreter", OVERPASS_QL)}.json`);
    const aged = async (minutes: number) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ elements: [] }));
      const at = new Date(Date.now() - minutes * 60 * 1000);
      await utimes(file, at, at);
    };
    await freshness(db, "overpassCacheHours", [1, 2], async hours => {
      await aged(hours * 60 - 1);
      const kept = (await fetchOverpass(OVERPASS_QL)).fromCache;
      await aged(hours * 60 + 1);
      const past = await fetchOverpass(OVERPASS_QL).then(answer => answer.fromCache, error => {
        expect(error).toBe(refusal);
        return false;
      });
      return { kept, past };
    });
    expect(asked).toHaveBeenCalledTimes(2);
  },
  overpassTimeoutS: async db => {
    // The query's own budget and thirty seconds for its answer: the
    // exchange's deadline, and the refusal that names it.
    vi.stubEnv("DEZFIL_OVERPASS_URL", "https://overpass.example/api/interpreter");
    for (const seconds of [10, 20]) {
      writeStoredSettings({ overpassTimeoutS: seconds }, db);
      const issued = stallRequests();
      vi.useFakeTimers();
      const pending = fetchOverpass(OVERPASS_QL, { bypassCache: true });
      void pending.catch(() => {});
      await firstRequest(issued);
      await refusedAt(pending, (seconds + 30) * 1000, { code: "remote_fetch_failed", message: expect.stringContaining(`within ${seconds + 30} s`) });
      vi.mocked(https.request).mockRestore();
      vi.useRealTimers();
    }
  },
};
