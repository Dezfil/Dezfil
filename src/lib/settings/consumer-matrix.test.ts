import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTING_CATALOGUE } from "./catalogue";
import { activateSettingsStore } from "./store";
import { consumptionInventory, consumptionProblems, productionSources } from "../../../test-support/settings-consumption";
import { numericConsumerProbes } from "../../../test-support/settings-consumer-probes";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { limits } from "@/lib/limits";
import { resetQueryInstance } from "@/lib/duckdb";
import { resetLane } from "@/lib/operations/lane";
import { resetRateLimits } from "@/lib/publish/rate-limit";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";

// The services' probes stall at a stubbed transport; a probe whose stub
// missed fails here instead of reaching a service.
keepRequestsOnThisMachine();

// The numbers an admin may store beside their variables; the service
// addresses are held where their services read them.
const definitions = SETTING_CATALOGUE.filter(d => d.editable && d.environment && d.kind === "number");
const sources = productionSources(process.cwd());
const inventory = consumptionInventory(definitions, sources);
const matrix = Object.keys(numericConsumerProbes).sort().map(key => ({ key,
  consumer: key.startsWith("public") ? "src/lib/publish/rate-limit.ts" : "src/lib/limits.ts",
  observe: numericConsumerProbes[key],
}));

function coverage(input = sources) {
  expect(consumptionProblems(SETTING_CATALOGUE, input)).toEqual([]);
  const reads = consumptionInventory(definitions, input);
  expect(reads.map(row => row.key).sort()).toEqual(matrix.map(row => row.key));
  for (const row of reads) {
    expect(row.consumers.map(c => ({ file: c.file, kind: c.kind })), row.key).toEqual([
      { file: matrix.find(item => item.key === row.key)!.consumer, kind: "resolver" },
    ]);
  }
}

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); activateSettingsStore(f.db); resetLane(); resetRateLimits(); });
afterEach(() => { resetQueryInstance(); resetLane(); resetRateLimits(); vi.useRealTimers(); f.close(); });

describe("editable numeric consumer matrix", () => {
  it("covers every editable deployment setting and every inventoried consumer", () => {
    coverage();
    expect(inventory).toHaveLength(22);
    expect(inventory.flatMap(row => row.consumers)).toHaveLength(22);
  });
  it("rejects an additional consumer with no observation in the matrix", () => {
    expect(() => coverage({ ...sources, "src/lib/extra-consumer.ts":
      'import { resolveNumber } from "@/lib/settings/resolver"; export const rows = () => resolveNumber("previewRows");',
    })).toThrow();
  });
  it.each(matrix)("$key via $consumer observes its stored boundary", async row => {
    await row.observe(f.db);
  });
  it("turns the previewRows row red when its consumer ignores the stored value", async () => {
    const reverted = vi.spyOn(limits, "previewRows", "get").mockReturnValue(1000);
    try { await expect(numericConsumerProbes.previewRows(f.db)).rejects.toThrow(/previewTruncated/); }
    finally { reverted.mockRestore(); }
    await numericConsumerProbes.previewRows(f.db);
  });
});
