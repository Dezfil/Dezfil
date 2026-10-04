import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { reportPause } from "../../../scripts/account-compaction-prober.mjs";

// Only the pure sampler and verdict run in this process. No store or listener.
function proof({ seed = "", failure = "", interrupted = false, duration = 6200 } = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { sampleCompaction, reportPause, runProofArms, assertProofSucceeded } from './scripts/account-compaction-prober.mjs';
    let clock = 0;
    const failures = await runProofArms([async () => {
      const measured = await sampleCompaction({ seed: ${JSON.stringify(seed)},
        now: () => clock, health: async () => {}, sampleSpace: () => {},
        compact: async () => { clock = ${duration}; return { ok: true, intervalMs: clock }; },
      });
      reportPause({ mode: 'host', mib: 1024, trial: 2, ...measured },
        row => console.log(JSON.stringify(row)), console.log);
    }, async () => { if (${JSON.stringify(failure)}) throw new Error(${JSON.stringify(failure)}); }], async () => {});
    try { assertProofSucceeded(failures, ${interrupted}); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `], { encoding: "utf8", env: process.env });
}

it("reports a pause above the reference mark per size and trial and exits zero", () => {
  const result = proof();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("host 1024 MiB trial 2 pause 6.200 s: above 5.0 s reference mark");
  expect(result.stdout).toContain('"pauseMs":6200');
  expect(result.stdout + result.stderr).not.toContain("DECISION REQUIRED");
});

it.each([4999, 5000])("reports %i ms at or below the reference mark and exits zero", duration => {
  const result = proof({ duration });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("at or below 5.0 s reference mark");
});

it("keeps the pause seed red when the outside probe loses its observation", () => {
  const result = proof({ seed: "pause" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("outside probe must observe the pause");
});

it.each(["live bytes retained", "former values missing", "busy reader reported success", "temporary exhaustion reported success", "control lost"])("still exits nonzero for %s", failure => {
  const result = proof({ failure });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(failure);
});

it("still exits nonzero when interrupted", () => {
  const result = proof({ interrupted: true });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Proof interrupted");
});

const measured = { mode: "container", mib: 64, trial: 1, result: { intervalMs: 200 }, healthSamples: 2, maxGapMs: 210, maxHealthLatencyMs: 10, pauseMs: 210 };
it.each([
  { ...measured, healthSamples: 0 },
  { ...measured, maxGapMs: 3000, pauseMs: 3000 },
  { ...measured, result: { intervalMs: 3000 }, pauseMs: 3000 },
  { ...measured, pauseMs: 0 },
  { ...measured, maxGapMs: NaN },
])("rejects missing, inconsistent or unreported pause evidence %#", row => {
  expect(() => reportPause(row, () => {}, () => {})).toThrow();
});
