import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { limits } from "../limits";
import { rateLimit, resetRateLimits, tileMaxPerWindow } from "../publish/rate-limit";
import { resolveNumber, resolveNumericSetting, resolveBoolean } from "./resolver";
import { LIMIT_FIXTURES, ENVIRONMENT_CASES } from "../../../test-support/limits-fixtures";
import { DEFAULTS, EDITABLE_NUMBERS } from "../../../test-support/settings-fixtures";

afterEach(() => { vi.unstubAllEnvs(); resetRateLimits(); });

describe("limits facade equivalence", () => {
  it("covers every getter, including the switch", () => {
    expect(Object.keys(limits).sort()).toEqual([...LIMIT_FIXTURES.map(([getter]) => getter), "assistantAutoCheck"].sort());
  });
  it.each(LIMIT_FIXTURES)("preserves %s parsing, fallback and consumer units", (getter, key, variable, fallback, scale, parsing) => {
    for (const [raw, positive, integer, nonNegative] of ENVIRONMENT_CASES) {
      vi.stubEnv(variable, raw);
      const normalized = (parsing === "integer" ? integer : parsing === "non-negative" ? nonNegative : positive) ?? fallback;
      expect(limits[getter], `${getter}, ${String(raw)}`).toBe(normalized * scale);
      expect(resolveNumber(key)).toBe(normalized);
    }
  });
  it.each([
    [undefined, true], ["", true], ["0", false], ["false", false], ["off", false],
    [" OFF ", false], ["False", false], ["1", true], ["yes", true], ["invalid", true], ["  ", true],
  ] as const)("preserves the automatic-check switch for %s", (raw, expected) => {
    vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", raw);
    expect(limits.assistantAutoCheck).toBe(expected);
    expect(resolveBoolean("assistantAutoCheck")).toBe(expected);
  });
  it("re-reads variables after import instead of retaining a boot snapshot", () => {
    vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", "2.9"); expect(limits.queryTimeoutMs).toBe(2900);
    vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", "12"); expect(limits.queryTimeoutMs).toBe(12000);
    vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", ""); expect(limits.queryTimeoutMs).toBe(60000);
  });
});

describe("numeric environment precedence", () => {
  it.each(LIMIT_FIXTURES)("reports normalized environment state for %s", (_getter, key, variable, fallback, _scale, parsing) => {
    for (const [raw, positive, integer, nonNegative] of ENVIRONMENT_CASES) {
      const accepted = parsing === "integer" ? integer : parsing === "non-negative" ? nonNegative : positive;
      const present = raw !== undefined && raw !== "";
      const result = resolveNumericSetting(key, { environment: { [variable]: raw } });
      expect(result).toEqual({ key, value: accepted ?? fallback, source: present && accepted !== null ? "environment" : "default",
        locked: present, invalidOverride: present && accepted === null, storedValue: null });
      expect(JSON.stringify(result)).not.toContain("invalid-override-seed");
    }
  });
  it.each(Object.entries(EDITABLE_NUMBERS))("keeps %s stored values shadowed even by an invalid override", (key, { min, max }) => {
    const numericKey = key as Parameters<typeof resolveNumber>[0];
    const variable = key === "publicRateLimit" ? "DEZFIL_PUBLIC_RATE_LIMIT" : key === "publicTileRateLimit" ? "DEZFIL_PUBLIC_TILE_RATE_LIMIT"
      : LIMIT_FIXTURES.find(row => row[1] === key)![2];
    for (const raw of [undefined, "", "invalid-override-seed", "2.9", String(max + 1)]) {
      const result = resolveNumericSetting(numericKey, { environment: { [variable]: raw }, stored: { [key]: min } });
      if (raw === undefined || raw === "") expect(result).toMatchObject({ value: min, source: "stored", locked: false, invalidOverride: false, storedValue: min });
      else if (raw === "invalid-override-seed") expect(result).toMatchObject({ value: DEFAULTS[numericKey], source: "default", locked: true, invalidOverride: true, storedValue: min });
      else expect(result).toMatchObject({ value: raw === "2.9" ? ["operationConcurrency", "operationQueueMax", "exportRenderConcurrency"].includes(key) ? 2 : 2.9 : max + 1,
        source: "environment", locked: true, invalidOverride: false, storedValue: min });
      expect(JSON.stringify(result)).not.toContain("invalid-override-seed");
    }
    expect(resolveNumericSetting(numericKey, { environment: {}, stored: { [key]: null } })).toMatchObject({ source: "default", locked: false, storedValue: null });
  });
  it("normalizes whole-number consumers but retains fractional timeouts and environment values outside write bounds", () => {
    expect(resolveNumericSetting("operationConcurrency", { environment: { DEZFIL_OPERATION_CONCURRENCY: "2.9" } }).value).toBe(2);
    expect(resolveNumericSetting("queryTimeoutS", { environment: { DEZFIL_QUERY_TIMEOUT_S: "2.9" } }).value).toBe(2.9);
    expect(resolveNumericSetting("operationConcurrency", { environment: { DEZFIL_OPERATION_CONCURRENCY: "100" } }).value).toBe(100);
  });
  it("does not open storage or create a file when a limit is resolved", async () => {
    const root = process.env.DEZFIL_DATA_DIR!;
    const before = readdirSync(root);
    vi.stubEnv("DEZFIL_DATA_DIR", `${root}/not-created`);
    vi.resetModules();
    const fresh = await import("./resolver");
    expect(fresh.resolveNumericSetting("queryTimeoutS", { environment: {} }).value).toBe(60);
    expect(readdirSync(root)).toEqual(before);
  });
});

describe("public rate-reader equivalence", () => {
  it.each(ENVIRONMENT_CASES)("preserves view and tile budgets for %s", (raw, accepted) => {
    vi.stubEnv("DEZFIL_PUBLIC_RATE_LIMIT", raw); vi.stubEnv("DEZFIL_PUBLIC_TILE_RATE_LIMIT", raw);
    expect(resolveNumber("publicRateLimit")).toBe(accepted ?? 60);
    expect(tileMaxPerWindow()).toBe(accepted ?? 600);
    const budget = accepted ?? 60;
    const attempts = Math.min(Math.ceil(budget), 1000);
    for (let i = 0; i < attempts; i++) expect(rateLimit("equivalence", 1)).toBe(true);
    expect(rateLimit("equivalence", 1)).toBe(budget > attempts);
  });
});
