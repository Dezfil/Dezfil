import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { inFlight, resetLimiter, takeSlot, waitingCount } from "./limiter";

/**
 * The pace, who gets the next slot, and how many exchanges may be out at once.
 *
 * **Times are measured, not mocked.** The thing under test is a scheduler, and
 * a fake clock would let a scheduler that never actually waits pass every
 * assertion here. The pace is set low enough that real waiting is cheap.
 */

const KEY = "endpoint-under-test";
const CONFIGURED_PACE_MS = 60;
// Keep the proof floor independent from the environment knob: changing only
// the configured pace to zero is the seeded defect, and must leave a failing
// assertion behind rather than editing the test's expectation with the input.
const PACE_FLOOR_MS = 60;
const PACE_SLACK_MS = 15;

beforeEach(() => {
  process.env.DEZFIL_GEOCODE_PACE_MS = String(CONFIGURED_PACE_MS);
  resetLimiter();
});

afterEach(() => {
  delete process.env.DEZFIL_GEOCODE_PACE_MS;
  resetLimiter();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the pace is the instance's, not a caller's", () => {
  it("spaces requests from two independent batches", async () => {
    // Two callers that know nothing about each other — which is what two
    // operation runs are, and what a limiter scoped to one job would fail to
    // pace at all.
    const starts: number[] = [];
    const batch = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        const release = await takeSlot(KEY, "batch");
        starts.push(Date.now());
        release();
      }
    };
    await Promise.all([batch(3), batch(3)]);

    expect(starts).toHaveLength(6);
    // Anchor every request to the first grant. Runner load can only add time
    // to each cumulative span, unlike adjacent gaps whose samples can bunch
    // after a stall. Every index therefore holds a cumulative per-index
    // spacing floor (one short gap can hide inside the slack; bunching
    // cannot). The small constant slack covers clock/sampling jitter and
    // stays far below one complete pace interval.
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[0]).toBeGreaterThanOrEqual(
        i * PACE_FLOOR_MS - PACE_SLACK_MS,
      );
    }
  }, 30_000);
});

/**
 * **One exchange at a time is the contract, not one per interval** (J7).
 *
 * A pacing-only limiter passes every timing assertion above and still lets two
 * requests be open at once whenever the provider takes longer to answer than
 * the interval — which is the concurrent issuance J7 declines, and what makes
 * cancellation have one thing to stop. Found at the cross-model review.
 */
describe("one request in flight", () => {
  it("grants no second slot while the first is held, however long it takes", async () => {
    const held: number[] = [];
    const first = await takeSlot(KEY, "batch");
    held.push(Date.now());

    let secondAt: number | null = null;
    const second = takeSlot(KEY, "batch").then((release) => {
      secondAt = Date.now();
      release();
    });

    // Four intervals go by with the slot held: a pacing-only limiter would
    // have granted the second one three intervals ago.
    await sleep(240);
    expect(secondAt).toBeNull();
    expect(inFlight(KEY)).toBe(true);

    const releasedAt = Date.now();
    first();
    await second;
    expect(secondAt).not.toBeNull();
    expect(secondAt!).toBeGreaterThanOrEqual(releasedAt - 5);
  }, 30_000);

  it("does not charge a caller an extra interval for a slow answer", async () => {
    // The provider's rule is start-to-start, so an exchange that already
    // outlasted the interval has served the wait — the next may start at once.
    const first = await takeSlot(KEY, "batch");
    await sleep(150); // longer than the 60 ms pace
    const asked = Date.now();
    const pending = takeSlot(KEY, "batch");
    first();
    const release = await pending;
    expect(Date.now() - asked).toBeLessThan(60);
    release();
  }, 30_000);

  it("frees the endpoint again if a caller releases twice", async () => {
    // A `finally` that runs after an early return may release a slot the
    // function already gave back; that must not free somebody else's.
    const release = await takeSlot(KEY, "batch");
    release();
    release();
    expect(inFlight(KEY)).toBe(false);
    const next = await takeSlot(KEY, "batch");
    expect(inFlight(KEY)).toBe(true);
    next();
  }, 30_000);
});

describe("interactive search takes the next slot", () => {
  it("goes ahead of a batch request already queued", async () => {
    /**
     * **This is the only situation priority governs, and it is worth being
     * exact about.** Requests are sequential (J7), so a batch has at most one
     * request waiting at a time. If a search arrives while the batch is *doing*
     * its request, it queues first and is served next without help. The case
     * that needs a rule is the other one: the batch has already asked for the
     * next slot and is waiting for it, and a search arrives behind it.
     */
    const order: string[] = [];
    // A request in flight — nothing can overtake this one.
    const inHand = await takeSlot(KEY, "batch");

    const batchNext = takeSlot(KEY, "batch").then((release) => {
      order.push("batch");
      release();
    });
    while (waitingCount(KEY) < 1) await sleep(5);
    const search = takeSlot(KEY, "interactive").then((release) => {
      order.push("search");
      release();
    });
    while (waitingCount(KEY) < 2) await sleep(5);
    inHand();

    await Promise.all([batchNext, search]);
    expect(order).toEqual(["search", "batch"]);
  }, 30_000);
});

describe("a caller that stops waiting leaves the queue", () => {
  it("rejects on abort and does not consume a slot", async () => {
    const controller = new AbortController();
    // Hold the first slot so the second genuinely queues.
    const inHand = await takeSlot(KEY, "batch");
    const abandoned = takeSlot(KEY, "batch", controller.signal);
    while (waitingCount(KEY) < 1) await sleep(5);
    controller.abort();
    await expect(abandoned).rejects.toThrow();
    expect(waitingCount(KEY)).toBe(0);

    // And the endpoint still works afterwards.
    inHand();
    const next = await takeSlot(KEY, "batch");
    next();
  }, 30_000);

  it("refuses immediately for a signal that already fired", async () => {
    await expect(
      takeSlot(KEY, "batch", AbortSignal.abort()),
    ).rejects.toThrow();
  });
});
