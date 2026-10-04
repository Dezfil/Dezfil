import { describe, expect, it, vi } from "vitest";

// This exercises the outside sampler without opening a listener.
import { sampleCompaction, runProofArms } from "../../../scripts/account-compaction-prober.mjs";

describe("outside compaction sampler", () => {
  it("counts connection refusals and timeouts as a gap and settles every attempt", async () => {
    vi.useFakeTimers();
    try {
      let healthy = false, now = 0;
      const measured = sampleCompaction({
        health: async () => { if (!healthy) throw new Error("connect ETIMEDOUT"); },
        compact: async () => { await new Promise(resolve => setTimeout(resolve, 6200)); now = 6200; healthy = true; return { intervalMs: 6200 }; },
        now: () => now,
        sampleSpace: () => {},
      });
      await vi.advanceTimersByTimeAsync(6400);
      const result = await measured;
      expect(result.pauseMs).toBeGreaterThanOrEqual(6200);
      expect(result.failedHealthAttempts).toBeGreaterThan(0);
      expect(result.healthSamples).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });
  it("runs later arms and cleanup even after a measured breach", async () => {
    const events: string[] = [];
    const failures = await runProofArms([
      async () => { events.push("host"); throw new Error("DECISION REQUIRED: 6.2 s"); },
      async () => { events.push("container"); },
    ], async () => { events.push("stop"); });
    expect(events).toEqual(["host", "stop", "container", "stop"]);
    expect((failures[0] as Error).message).toContain("6.2 s");
  });
});
