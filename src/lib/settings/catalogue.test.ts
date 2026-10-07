import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTING_CATALOGUE, TEST_WIRING, settingDefinition } from "./catalogue";
import { catalogueProblems, validateStoredValue } from "./validation";
import { lockedEnvironment } from "./resolver";
import type { SettingDefinition } from "./types";
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
      ...LOOK,
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

/** The look's six picks, today's value first: the account's own choices. */
const LOOK = {
  "look.color": ["kelp", "harbor", "heather", "slate"],
  "look.contrast": ["standard", "more"],
  "look.font": ["inter", "system"],
  "look.background": ["atlantic", "plain", "graticule", "hex"],
  "look.corners": ["rounded", "soft"],
  "look.rail": ["hover", "open", "icons"],
};

describe("the look's six picks", () => {
  it("are account choices defaulting to today's value, with no variable, never secret and never locked", () => {
    for (const [key, values] of Object.entries(LOOK)) {
      const definition = settingDefinition(key);
      expect(definition, key).toMatchObject({ scope: "account", readBy: "account", changedBy: "account", kind: "choice",
        timing: "live", secret: false, editable: true, defaultValue: values[0], write: { kind: "choice", values } });
      expect(definition.label, key).not.toBe("");
      expect(definition.environment, key).toBeUndefined();
      expect(lockedEnvironment(definition), key).toBeUndefined();
    }
  });

  it.each(Object.keys(LOOK).flatMap(key => [
    [key, "variable", { environment: "DEZFIL_LOOK_SEEDED" }, "account variable"],
    [key, "secret mark", { secret: true }, "editable secret"],
  ] as const))("%s fails the catalogue with a seeded %s", (key, _seed, change, problem) => {
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
    const seeded = SETTING_CATALOGUE.map(definition => definition.key === key ? { ...definition, ...change } : definition);
    expect(catalogueProblems(seeded)).toContain(`${key}: ${problem}`);
  });
});

/** A stored instance setting of each newer value kind, built on an
 * existing stored definition so only the kind differs. */
const decimal: SettingDefinition = { ...settingDefinition("landingPage"), key: "seeded.zoom", label: "Seeded zoom",
  purpose: "A number kept as given.", kind: "number", defaultValue: 1.3, documentedDefault: "1.3",
  write: { kind: "decimal", min: 0, max: 22 } };
const toggle: SettingDefinition = { ...settingDefinition("landingPage"), key: "seeded.wrap", label: "Seeded wrap",
  purpose: "On or off.", kind: "boolean", defaultValue: false, documentedDefault: "off", write: { kind: "switch" } };

describe("the decimal and switch value kinds", () => {
  it("keeps a finite decimal within its inclusive bounds exactly as given", () => {
    for (const value of [0, 22, 1.3, 0.1 + 0.2, 21.999999999, -0]) expect(validateStoredValue(decimal, value)).toEqual({ ok: true, value });
    for (const value of [-0.000001, 22.000001, NaN, Infinity, -Infinity, "1.3", true, [], {}, undefined]) {
      expect(validateStoredValue(decimal, value), String(value)).toEqual({ ok: false, reason: "Expected a number from 0 to 22." });
    }
    expect(validateStoredValue(decimal, null)).toEqual({ ok: true, value: null });
  });

  it("keeps only true or false for a switch", () => {
    for (const value of [true, false]) expect(validateStoredValue(toggle, value)).toEqual({ ok: true, value });
    for (const value of ["true", "false", "on", 0, 1, "", [], {}, undefined]) {
      expect(validateStoredValue(toggle, value), String(value)).toEqual({ ok: false, reason: "Expected true or false." });
    }
    expect(validateStoredValue(toggle, null)).toEqual({ ok: true, value: null });
  });

  it("admits a well-formed decimal and switch definition", () => {
    expect(catalogueProblems([...SETTING_CATALOGUE, decimal, toggle])).toEqual([]);
  });

  it.each([
    ["a decimal constraint on a choice definition", { ...decimal, kind: "choice" }, "invalid decimal constraint"],
    ["a decimal constraint with crossed bounds", { ...decimal, write: { kind: "decimal", min: 22, max: 0 } }, "invalid decimal constraint"],
    ["a decimal constraint with an unbounded end", { ...decimal, write: { kind: "decimal", min: 0, max: Infinity } }, "invalid decimal constraint"],
    ["a decimal default outside its bounds", { ...decimal, defaultValue: 22.5 }, "default fails validation"],
    ["a switch constraint on a number definition", { ...toggle, kind: "number" }, "invalid switch constraint"],
    ["a switch default that is not true or false", { ...toggle, defaultValue: "off" }, "default fails validation"],
  ] as [string, SettingDefinition, string][])("fails the catalogue with %s", (_name, seeded, problem) => {
    expect(catalogueProblems([...SETTING_CATALOGUE, seeded])).toContain(`${seeded.key}: ${problem}`);
  });
});
