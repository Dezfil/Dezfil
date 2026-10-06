import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTING_CATALOGUE, TEST_WIRING, settingDefinition } from "./catalogue";
import { catalogueProblems, validateStoredValue } from "./validation";
import { DEFAULTS, EDITABLE_NUMBERS } from "../../../test-support/settings-fixtures";

describe("settings catalogue", () => {
  it("has one complete definition for each deployment variable and keeps test wiring separate", () => {
    const rows = [...readFileSync("README.md", "utf8").matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm)].map(match => match[1]);
    const deployment = SETTING_CATALOGUE.filter(d => d.scope === "instance" && d.environment);
    expect(deployment).toHaveLength(63);
    expect(TEST_WIRING).toHaveLength(3);
    expect([...deployment.map(d => d.environment), ...TEST_WIRING.map(d => d.environment)].sort()).toEqual(rows.sort());
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
    expect(SETTING_CATALOGUE.filter(d => d.scope === "platform").map(d => d.environment).sort()).toEqual(["DUCKDB_EXTENSION_DIR", "PORT"]);
  });

  it("defines every absent setting's default, including contextual default rules", () => {
    expect(Object.fromEntries(SETTING_CATALOGUE.map(d => [d.key, d.defaultValue]))).toEqual(DEFAULTS);
  });

  it.each([
    ["duplicate key", { key: "queryTimeoutS", environment: "DEZFIL_UNREAD_DUPLICATE" }],
    ["duplicate variable", { key: "duplicate", environment: "DEZFIL_QUERY_TIMEOUT_S" }],
    ["editable next-start", { key: "duplicate", environment: undefined, timing: "next-start" }],
    ["editable secret", { key: "duplicate", environment: undefined, secret: true }],
    ["account variable", { key: "duplicate", scope: "account", environment: "DEZFIL_ACCOUNT_PREF" }],
    ["missing validator", { key: "duplicate", environment: undefined, write: undefined }],
  ] as const)("rejects a seeded %s", (_name, change) => {
    const altered = { ...settingDefinition("queryTimeoutS"), ...change };
    expect(catalogueProblems([...SETTING_CATALOGUE, altered])).not.toEqual([]);
  });

  it("admits exactly the drawn numeric settings with complete whole-number write bounds", () => {
    const editable = SETTING_CATALOGUE.filter(d => d.kind === "number" && d.editable);
    expect(Object.fromEntries(editable.map(d => [d.key, d.write]))).toEqual(EDITABLE_NUMBERS);
    for (const definition of editable) {
      const { min, max } = EDITABLE_NUMBERS[definition.key as keyof typeof EDITABLE_NUMBERS];
      for (const value of [min, max]) expect(validateStoredValue(definition, value)).toEqual({ ok: true, value });
      for (const value of [min - 1, max + 1, min + 0.5, NaN, Infinity, "20", true, [], {}, undefined]) {
        expect(validateStoredValue(definition, value).ok, `${definition.key}: ${String(value)}`).toBe(false);
      }
      expect(validateStoredValue(definition, null)).toEqual({ ok: true, value: null });
    }
    expect(validateStoredValue(settingDefinition("renderCapFeatures"), 300_000).ok).toBe(false);
    expect(validateStoredValue(settingDefinition("queryMemoryMb"), null).ok).toBe(false);
  });

  it.each([["instanceName", 80, null], ["signInMessage", 280, null], ["lostPasswordContact", 120, null]] as const)(
    "%s trims text, bounds the normalized length and clears without a substitute string", (key, max, empty) => {
      const definition = settingDefinition(key);
      expect(validateStoredValue(definition, "  name  ")).toEqual({ ok: true, value: "name" });
      expect(validateStoredValue(definition, " ")).toEqual({ ok: true, value: empty });
      expect(validateStoredValue(definition, "x".repeat(max)).ok).toBe(true);
      for (const value of ["x".repeat(max + 1), 2, [], {}]) expect(validateStoredValue(definition, value).ok).toBe(false);
      expect(validateStoredValue(definition, null)).toEqual({ ok: true, value: null });
    },
  );

  it("pins the landing choices and every account preference without giving an account an environment variable", () => {
    const choices = {
      landingPage: ["home", "projects", "maps", "workflows", "data", "sql"],
      "maps.view": ["grid", "list"], "maps.sort": ["edited", "created", "name"],
      "data.view": ["grid", "list"], "data.sort": ["updated", "name", "rows", "size"],
      "workflows.view": ["grid", "list"], "workflows.sort": ["edited", "created", "name"],
      "projects.view": ["grid", "list"], "projects.sort": ["updated", "name", "largest"],
      sourceGrouping: ["person", "project"],
    };
    expect(SETTING_CATALOGUE.filter(d => d.scope === "account").map(d => d.key).sort()).toEqual(Object.keys(choices).filter(k => k !== "landingPage").sort());
    for (const [key, values] of Object.entries(choices)) {
      const definition = settingDefinition(key);
      expect(definition.environment).toBeUndefined();
      expect(definition.write).toEqual({ kind: "choice", values });
      for (const value of values) expect(validateStoredValue(definition, value)).toEqual({ ok: true, value });
      for (const value of ["unknown", "", 1, [], {}]) expect(validateStoredValue(definition, value).ok).toBe(false);
      if (definition.scope === "account") expect(validateStoredValue(definition, null).ok).toBe(false);
    }
  });
});
