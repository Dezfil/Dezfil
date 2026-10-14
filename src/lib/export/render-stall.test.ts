import { describe, expect, it } from "vitest";
import { limits } from "@/lib/limits";
import {
  renderRequestBoundMs,
  RenderRequestLedger,
  stalledExternalRequests,
  STALL_GRACE_MS,
  type InflightRequest,
} from "./render-stall";

/**
 * A check that bounds its own wait abandoned a stalled external request
 * at the export road's bound, which left the check no time to settle
 * inside its budget. The bound is now resolved from the call's own
 * budget; the export road's is untouched.
 */
const tile = (started: number, host = "tiles.example.org"): InflightRequest => ({
  started,
  host,
  external: true,
});
const own = (started: number): InflightRequest => ({
  started,
  host: "127.0.0.1",
  external: false,
});

describe("request accounting", () => {
  const now = 100_000;

  it("two starts under one network id and one finish leave no ghost holding the cut", () => {
    const ledger = new RenderRequestLedger();
    ledger.start({ id: "tile" }, tile(0));
    ledger.start({ id: "font" }, own(0));
    const secondPause = { id: "font" };
    ledger.start(secondPause, own(10));
    ledger.finish(secondPause);
    expect(ledger.abandon(now, 10_000)).toEqual(["tiles.example.org"]);
    expect(ledger.abandon(now, 10_000)).toEqual([]);
  });

  it("a distinct outstanding app request still holds the cut", () => {
    const ledger = new RenderRequestLedger();
    ledger.start({ id: "tile" }, tile(0));
    ledger.start({ id: "font-1" }, own(0));
    ledger.start({ id: "font-2" }, own(0));
    ledger.finish({ id: "font-1" });
    expect(ledger.abandon(now, 10_000)).toEqual([]);
    ledger.finish({ id: "font-2" });
    expect(ledger.abandon(now, 10_000)).toEqual(["tiles.example.org"]);
  });

  it("keeps the first start time when a request is paused again", () => {
    const ledger = new RenderRequestLedger();
    ledger.start({ id: "tile" }, tile(0));
    ledger.start({ id: "tile" }, tile(now - 1));
    expect(ledger.abandon(now, 10_000)).toEqual(["tiles.example.org"]);
  });

  it("keeps requests without a network id separate until their own finish", () => {
    const ledger = new RenderRequestLedger();
    const first = {}, second = {};
    ledger.start({ id: "tile" }, tile(0));
    ledger.start(first, own(0));
    ledger.start(second, own(0));
    ledger.finish(first);
    expect(ledger.abandon(now, 10_000)).toEqual([]);
    ledger.finish(second);
    expect(ledger.abandon(now, 10_000)).toEqual(["tiles.example.org"]);
  });
});

describe("the per-request bound", () => {
  it("is the export road's documented bound when the call sets none", () => {
    expect(renderRequestBoundMs()).toBe(limits.exportRequestTimeoutMs);
    expect(limits.exportRequestTimeoutMs).toBe(20_000);
  });

  it("fits inside the check's own budget, leaving twice the bound to settle", () => {
    const budget = limits.assistantLookTimeoutMs;
    expect(budget).toBe(30_000);
    const bound = renderRequestBoundMs(budget);
    expect(bound).toBe(10_000);
    expect(budget - bound).toBeGreaterThan(2 * STALL_GRACE_MS + bound);
  });

  it("never exceeds the export road's bound, however large the call's budget", () => {
    expect(renderRequestBoundMs(90_000)).toBe(limits.exportRequestTimeoutMs);
    expect(renderRequestBoundMs(600_000)).toBe(limits.exportRequestTimeoutMs);
  });

  it("stays positive for a budget too small to divide", () => {
    expect(renderRequestBoundMs(1)).toBe(1);
  });
});

describe("the abandonment decision", () => {
  const now = 100_000;

  it("abandons a stalled tile at the check's bound, where the export's bound would still wait", () => {
    const inflight: [string, InflightRequest][] = [["a", tile(now - 11_000)]];
    expect(stalledExternalRequests(inflight, now, renderRequestBoundMs(30_000))).toEqual(["a"]);
    expect(stalledExternalRequests(inflight, now, renderRequestBoundMs())).toEqual([]);
  });

  it("waits while the youngest external request is inside the grace", () => {
    const inflight: [string, InflightRequest][] = [
      ["old", tile(now - 25_000)],
      ["young", tile(now - 500)],
    ];
    expect(stalledExternalRequests(inflight, now, renderRequestBoundMs())).toEqual([]);
  });

  it("cuts every external request together once the grace has passed", () => {
    const inflight: [string, InflightRequest][] = [
      ["old", tile(now - 25_000)],
      ["other", tile(now - 3_000, "other.example.org")],
    ];
    expect(stalledExternalRequests(inflight, now, renderRequestBoundMs())).toEqual(["old", "other"]);
  });

  it("never cuts while an app-origin request is in flight", () => {
    const inflight: [string, InflightRequest][] = [
      ["old", tile(now - 25_000)],
      ["app", own(now - 25_000)],
    ];
    expect(stalledExternalRequests(inflight, now, renderRequestBoundMs())).toEqual([]);
  });

  it("cuts nothing while every request is inside the bound", () => {
    const inflight: [string, InflightRequest][] = [["a", tile(now - 9_000)]];
    expect(stalledExternalRequests(inflight, now, renderRequestBoundMs(30_000))).toEqual([]);
  });
});
