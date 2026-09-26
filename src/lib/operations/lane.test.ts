import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
  submit,
  cancel,
  isExecuting,
  laneDepth,
  laneSettled,
  resetLane,
} from "./lane";

/**
 * The lane's own contract, proven against a fake unit of work.
 *
 * Nothing here sleeps or races: each fake unit is a promise the test resolves
 * by hand, so "did it enter execution" is an observed fact rather than a guess
 * about timing. Criterion 7 — that the engine really stops — cannot be proven
 * this way and is proven against a real engine separately.
 */

/** A unit of work the test starts, observes and finishes deliberately. */
function gate() {
  let release!: () => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const entered: { yes: boolean; signal?: AbortSignal } = { yes: false };
  const work = async (signal: AbortSignal) => {
    entered.yes = true;
    entered.signal = signal;
    await promise;
  };
  return { work, entered, release, fail };
}

const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  resetLane();
  vi.unstubAllEnvs();
});
afterEach(() => {
  resetLane();
  vi.unstubAllEnvs();
});

describe("concurrency", () => {
  it("runs one at a time by default, and the second does not enter execution", async () => {
    const first = gate();
    const second = gate();
    submit("a", first.work);
    submit("b", second.work);
    await settle();

    expect(first.entered.yes).toBe(true);
    // The criterion's substance: not "b started later" by timestamp, but that
    // b's execution was never entered while a held the slot.
    expect(second.entered.yes).toBe(false);
    expect(isExecuting("b")).toBe(false);

    first.release();
    await settle();
    expect(second.entered.yes).toBe(true);

    second.release();
    await laneSettled();
  });

  it("honours a raised cap", async () => {
    vi.stubEnv("DEZFIL_OPERATION_CONCURRENCY", "2");
    const a = gate();
    const b = gate();
    const c = gate();
    submit("a", a.work);
    submit("b", b.work);
    submit("c", c.work);
    await settle();

    expect(a.entered.yes).toBe(true);
    expect(b.entered.yes).toBe(true);
    expect(c.entered.yes).toBe(false);

    a.release();
    b.release();
    await settle();
    expect(c.entered.yes).toBe(true);
    c.release();
    await laneSettled();
  });
});

describe("the queue", () => {
  it("is FIFO — admitted earlier is executed earlier", async () => {
    const blocker = gate();
    submit("blocker", blocker.work);
    await settle();

    const order: string[] = [];
    const gates = ["one", "two", "three"].map((id) => {
      const g = gate();
      const work = async (s: AbortSignal) => {
        order.push(id);
        return g.work(s);
      };
      submit(id, work);
      return g;
    });
    await settle();
    expect(order).toEqual([]); // all still queued behind the blocker

    blocker.release();
    // Drain them in turn; each releases the slot for the next.
    for (const g of gates) {
      await settle();
      g.release();
    }
    await laneSettled();

    // Last-in-first-out would give three, two, one — this is the assertion
    // that distinguishes the two.
    expect(order).toEqual(["one", "two", "three"]);
  });

  it("refuses a run past the queue maximum, coded, and admits again once drained", async () => {
    vi.stubEnv("DEZFIL_OPERATION_QUEUE_MAX", "2");
    const blocker = gate();
    submit("blocker", blocker.work);
    await settle();

    const q1 = gate();
    const q2 = gate();
    submit("q1", q1.work);
    submit("q2", q2.work);
    expect(laneDepth()).toEqual({ executing: 1, waiting: 2 });

    const overflow = gate();
    let thrown: unknown;
    try {
      submit("q3", overflow.work);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe("operation_queue_full");
    expect((thrown as ApiError).status).toBe(503);
    // A refused run never entered the lane at all.
    expect(overflow.entered.yes).toBe(false);
    expect(laneDepth().waiting).toBe(2);

    blocker.release();
    await settle();
    q1.release();
    await settle();
    // A slot freed — the lane admits again rather than staying poisoned.
    expect(() => submit("q4", gate().work)).not.toThrow();
    resetLane();
  });

  it("refuses to hold the same run twice", () => {
    const g = gate();
    submit("dup", g.work);
    expect(() => submit("dup", gate().work)).toThrow(ApiError);
  });
});

describe("cancellation", () => {
  it("signals a running job but keeps its slot until the work settles", async () => {
    const running = gate();
    const next = gate();
    submit("run", running.work);
    submit("next", next.work);
    await settle();

    expect(cancel("run")).toBe(true);
    expect(running.entered.signal!.aborted).toBe(true);
    await settle();

    // The slot is NOT released by the cancel. Releasing here is how a lane
    // starts new work against an engine still busy with the old.
    expect(next.entered.yes).toBe(false);
    expect(laneDepth().executing).toBe(1);

    running.release(); // the work has genuinely stopped
    await settle();
    expect(next.entered.yes).toBe(true);
    next.release();
    await laneSettled();
  });

  it("keeps the slot even when the cancelled work fails rather than resolving", async () => {
    const running = gate();
    const next = gate();
    submit("run", running.work);
    submit("next", next.work);
    await settle();

    cancel("run");
    await settle();
    expect(next.entered.yes).toBe(false);

    running.fail(new Error("interrupted"));
    await settle();
    expect(next.entered.yes).toBe(true);
    next.release();
    await laneSettled();
  });

  it("a queued job cancelled before its turn never executes", async () => {
    const blocker = gate();
    const queued = gate();
    submit("blocker", blocker.work);
    submit("queued", queued.work);
    await settle();

    expect(cancel("queued")).toBe(true);
    blocker.release();
    await laneSettled();

    // Drained the whole lane, and it never ran.
    expect(queued.entered.yes).toBe(false);
  });

  it("frees a queue slot immediately, so a full queue admits again", async () => {
    vi.stubEnv("DEZFIL_OPERATION_QUEUE_MAX", "1");
    const blocker = gate();
    submit("blocker", blocker.work);
    await settle();
    submit("waiter", gate().work);
    expect(() => submit("rejected", gate().work)).toThrow(ApiError);

    cancel("waiter");
    expect(() => submit("admitted", gate().work)).not.toThrow();
    resetLane();
  });

  it("reports an unknown run rather than pretending", () => {
    expect(cancel("never-existed")).toBe(false);
  });
});
