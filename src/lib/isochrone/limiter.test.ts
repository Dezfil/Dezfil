import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isochroneInFlight,
  resetIsochroneLimiter,
  takeIsochroneSlot,
} from "./limiter";
import { resetLimiter, takeSlot } from "@/lib/geocode/limiter";

/**
 * The isochrone endpoint's own pace.
 *
 * **Times are measured, not mocked** — the thing under test is a scheduler,
 * and a fake clock would let one that never waits pass everything. The pace
 * is set low enough that real waiting is cheap.
 */

const KEY = "isochrone-endpoint-under-test";
const CONFIGURED_PACE_MS = 60;
// The proof floor is held apart from the setting, so a pace of zero set
// through the setting alone leaves a failing assertion behind.
const PACE_FLOOR_MS = 60;
const PACE_SLACK_MS = 15;

beforeEach(() => {
  process.env.DEZFIL_ISOCHRONE_PACE_MS = String(CONFIGURED_PACE_MS);
  process.env.DEZFIL_GEOCODE_PACE_MS = "60";
  resetIsochroneLimiter();
  resetLimiter();
});

afterEach(() => {
  delete process.env.DEZFIL_ISOCHRONE_PACE_MS;
  delete process.env.DEZFIL_GEOCODE_PACE_MS;
  resetIsochroneLimiter();
  resetLimiter();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("one exchange at a time, at the endpoint's pace", () => {
  it("spaces starts by the pace across independent callers", async () => {
    const starts: number[] = [];
    const caller = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        const release = await takeIsochroneSlot(KEY);
        starts.push(Date.now());
        release();
      }
    };
    await Promise.all([caller(2), caller(2)]);
    expect(starts).toHaveLength(4);
    starts.sort((a, b) => a - b);
    // Every start is held to the first, at a floor that grows with its
    // index. A start sampled late on a loaded machine only lengthens its
    // own span from the first, while two adjacent samples can bunch after
    // one stall; the small slack covers clock and sampling jitter and stays
    // far below one whole pace.
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[0]).toBeGreaterThanOrEqual(i * PACE_FLOOR_MS - PACE_SLACK_MS);
    }
  });

  it("holds the slot for the whole exchange — a slow answer blocks the next start", async () => {
    // The provider takes 3x the pace to answer. Pacing alone would let a
    // second exchange start mid-flight; the held slot must not.
    const release = await takeIsochroneSlot(KEY);
    let secondStarted = false;
    const second = takeIsochroneSlot(KEY).then((releaseSecond) => {
      secondStarted = true;
      releaseSecond();
    });
    await sleep(180);
    expect(isochroneInFlight(KEY)).toBe(true);
    expect(secondStarted).toBe(false);
    release();
    await second;
    expect(secondStarted).toBe(true);
  });

  it("a cancelled caller stops queueing, not merely stops after its turn", async () => {
    const release = await takeIsochroneSlot(KEY);
    const controller = new AbortController();
    const queued = takeIsochroneSlot(KEY, controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow(/abandoned/);
    release();
  });
});

describe("the pace is this endpoint's own (K4, the rule's second half)", () => {
  it("a geocoding exchange in flight neither delays nor is delayed by an isochrone slot", async () => {
    // Hold the geocoder's slot open — a shared limiter would now block the
    // isochrone caller behind a provider it never speaks to.
    const releaseGeocode = await takeSlot("geocoder-endpoint", "batch");
    const before = Date.now();
    const releaseIsochrone = await takeIsochroneSlot(KEY);
    expect(Date.now() - before).toBeLessThan(40);
    // And the other direction: the held isochrone slot does not stop a
    // second geocode exchange from starting.
    releaseGeocode();
    const releaseGeocodeAgain = await takeSlot("geocoder-endpoint", "batch");
    releaseGeocodeAgain();
    releaseIsochrone();
  });
});
