import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { limits } from "../limits";
import { readInstanceSettings } from "./read";
import { changeInstanceSettings } from "./change";
import { activateSettingsStore } from "./store";
import { serverSettingsRows } from "@/components/settings/system-table";
import { LIMITS_CARDS } from "@/components/settings/limits-table";

let f: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { f = instanceSettingsFixture(); activateSettingsStore(f.db); });
afterEach(() => f.close());
const read = () => readInstanceSettings(f.context, f.db).settings;
const change = (patch: unknown) => changeInstanceSettings(f.context, patch, f.db);

it("publishes resource defaults, units, authority and timing to settings consumers", () => {
  expect(read()).toMatchObject({
    trustedMemoryMb: { label: "Trusted engine memory", value: 3072, unit: "MB", environment: "DEZFIL_TRUSTED_MEMORY_MB", editable: false, locked: false, timing: "next-start", environmentTiming: "restart" },
    dataProcessingTimeoutS: { label: "Data processing time limit", value: 3600, unit: "seconds", environment: "DEZFIL_DATA_PROCESSING_TIMEOUT_S", editable: true, locked: false, timing: "live", environmentTiming: "restart", write: { kind: "integer", min: 60, max: 21600 } },
    renderCapBytes: { label: "Bytes drawn per layer", value: 134217728, unit: "bytes", environment: "DEZFIL_RENDER_CAP_BYTES", editable: false, locked: false, timing: "next-start", environmentTiming: "restart" },
  });
  expect(limits.trustedMemoryMb).toBe(3072);
  expect(limits.dataProcessingTimeoutMs).toBe(3_600_000);
  expect(limits.renderCapBytes).toBe(134_217_728);
});

it("shows trusted memory beside hardened memory and the two limits in their cards", () => {
  const rows = serverSettingsRows({ settings: read() });
  const index = rows.findIndex(row => row.key === "queryMemoryMb");
  expect(rows[index + 1]).toMatchObject({ key: "trustedMemoryMb", label: "Trusted engine memory", value: { text: "3,072 MB" } });
  expect(LIMITS_CARDS.find(card => card.title === "Imports")?.rows.map(row => row.key)).toContain("dataProcessingTimeoutS");
  const queries = LIMITS_CARDS.find(card => card.title === "Queries")!.rows;
  expect(queries[queries.findIndex(row => row.key === "renderCapFeatures") + 1]).toMatchObject({ key: "renderCapBytes", label: "Bytes drawn per layer" });
});

it.each([60, 21600])("applies %s whole seconds live and resets to the default", value => {
  change({ dataProcessingTimeoutS: value });
  expect(limits.dataProcessingTimeoutMs).toBe(value * 1000);
  expect(read().dataProcessingTimeoutS).toMatchObject({ value, source: "stored", storedValue: value });
  change({ dataProcessingTimeoutS: null });
  expect(limits.dataProcessingTimeoutMs).toBe(3_600_000);
  expect(read().dataProcessingTimeoutS).toMatchObject({ source: "default", storedValue: null });
});

it.each([59, 21601, 60.5, "60"])("refuses invalid processing time %s atomically", value => {
  expect(() => change({ dataProcessingTimeoutS: value, previewRows: 99 })).toThrow(/dataProcessingTimeoutS/);
  expect(limits.previewRows).toBe(1000);
});

it("keeps a stored time behind a deployment lock, including an invalid override", () => {
  change({ dataProcessingTimeoutS: 120 });
  vi.stubEnv("DEZFIL_DATA_PROCESSING_TIMEOUT_S", "240");
  expect(limits.dataProcessingTimeoutMs).toBe(240_000);
  expect(read().dataProcessingTimeoutS).toMatchObject({ locked: true, value: 240, storedValue: 120, source: "environment" });
  for (const value of [60, null]) expect(() => change({ dataProcessingTimeoutS: value })).toThrow(/Locked by DEZFIL_DATA_PROCESSING_TIMEOUT_S/);
  vi.stubEnv("DEZFIL_DATA_PROCESSING_TIMEOUT_S", "invalid");
  expect(read().dataProcessingTimeoutS).toMatchObject({ locked: true, value: 3600, storedValue: 120, invalidOverride: true });
  vi.stubEnv("DEZFIL_DATA_PROCESSING_TIMEOUT_S", "");
  expect(limits.dataProcessingTimeoutMs).toBe(120_000);
});

it.each([
  ["trustedMemoryMb", "DEZFIL_TRUSTED_MEMORY_MB", "4096"],
  ["renderCapBytes", "DEZFIL_RENDER_CAP_BYTES", "1048576"],
])("keeps %s fixed without an override and locked with one, refusing writes and resets", (key, environment, value) => {
  for (const override of [undefined, value]) {
    vi.stubEnv(environment, override);
    expect(read()[key]).toMatchObject({ editable: false, locked: override !== undefined, storedValue: null });
    for (const proposed of [1, null]) expect(() => change({ [key]: proposed })).toThrow(`${key}: Setting is read-only.`);
  }
  expect(read()[key].value).toBe(Number(value));
});
