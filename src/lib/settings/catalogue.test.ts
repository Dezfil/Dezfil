import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTING_CATALOGUE, TEST_WIRING, settingDefinition } from "./catalogue";
import { isInstanceDefault } from "./instance-defaults";
import { catalogueProblems, validateStoredValue } from "./validation";
import { lockedEnvironment } from "./resolver";
import type { SettingDefinition } from "./types";
import { DEFAULTS, EDITABLE_NUMBERS } from "../../../test-support/settings-fixtures";

describe("settings catalogue", () => {
  it("has one complete definition for each deployment variable and keeps test wiring separate", () => {
    const rows = [...readFileSync("README.md", "utf8").matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm)].map(match => match[1]);
    const deployment = SETTING_CATALOGUE.filter(d => d.scope === "instance" && d.environment);
    expect(deployment).toHaveLength(63);
    expect(TEST_WIRING).toHaveLength(4);
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
    // The numeric limits, each with its variable; the numbers new things
    // start with are held with the other defaults below.
    const editable = SETTING_CATALOGUE.filter(d => d.kind === "number" && d.editable && d.environment);
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

/** What new maps, new layers and three screens start with: each default's
 * values and the product's own value, as the approved table states them. */
const NEW_THINGS = {
  "newMap.basemap": [{ kind: "choice", values: ["auto", "dark", "light", "streets", "satellite"] }, "auto"],
  "newMap.latitude": [{ kind: "decimal", min: -85, max: 85 }, 40],
  "newMap.longitude": [{ kind: "decimal", min: -180, max: 180 }, 0],
  "newMap.zoom": [{ kind: "decimal", min: 0, max: 22 }, 1.3],
  "newMap.legendCorner": [{ kind: "choice", values: ["top-left", "top-right", "bottom-left", "bottom-right"] }, "bottom-left"],
  "newLayer.colorCycle": [{ kind: "choice", values: ["uber_viz_qualitative", "bold", "tab10", "paired", "dark2", "set3"] }, "uber_viz_qualitative"],
  "newLayer.pointOpacity": [{ kind: "integer", min: 10, max: 100 }, 72],
  "newLayer.lineOpacity": [{ kind: "integer", min: 10, max: 100 }, 95],
  "newLayer.areaOpacity": [{ kind: "integer", min: 10, max: 100 }, 50],
  "newLayer.lineWidth": [{ kind: "decimal", min: 0.5, max: 50 }, 2],
  "newLayer.pointRadius": [{ kind: "decimal", min: 0.5, max: 100 }, 3],
  "canvas.opens": [{ kind: "choice", values: ["full", "framed"] }, "full"],
  "canvas.minimap": [{ kind: "choice", values: ["auto", "always", "never"] }, "auto"],
  "canvas.resultsBand": [{ kind: "choice", values: ["closed", "open"] }, "closed"],
  "sqlConsole.textSize": [{ kind: "choice", values: ["11", "12", "13", "14", "16"] }, "12"],
  "sqlConsole.lineWrap": [{ kind: "switch" }, false],
  "imageExport.width": [{ kind: "choice", values: ["1280", "1920", "2560"] }, "1920"],
  "imageExport.shape": [{ kind: "choice", values: ["16:9", "4:3", "1:1"] }, "4:3"],
} as const;
const KIND_OF_WRITE = { choice: "choice", decimal: "number", integer: "number", switch: "boolean" } as const;

describe("the defaults for new things", () => {
  it("defines the eighteen with their values and product default, read by every signed-in account and changed by admins, with no variable, never secret and never locked", () => {
    expect(SETTING_CATALOGUE.filter(isInstanceDefault).map(d => d.key)).toEqual(Object.keys(NEW_THINGS));
    for (const [key, [write, defaultValue]] of Object.entries(NEW_THINGS)) {
      const definition = settingDefinition(key);
      expect(definition, key).toMatchObject({ scope: "instance", readBy: "signed-in", changedBy: "admin", kind: KIND_OF_WRITE[write.kind],
        timing: "live", secret: false, editable: true, defaultValue });
      expect(definition.write, key).toEqual(write);
      expect(definition.environment, key).toBeUndefined();
      expect(lockedEnvironment(definition), key).toBeUndefined();
      expect(validateStoredValue(definition, defaultValue), key).toEqual({ ok: true, value: defaultValue });
    }
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
  });

  it.each(Object.keys(NEW_THINGS).flatMap(key => [
    [key, "variable", { environment: "DEZFIL_DEFAULT_SEEDED", environmentTiming: "restart" }, "signed-in variable"],
    [key, "secret mark", { secret: true }, "signed-in secret"],
  ] as const))("%s fails the catalogue with a seeded %s", (key, _seed, change, problem) => {
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
    const seeded = SETTING_CATALOGUE.map(definition => definition.key === key ? { ...definition, ...change } : definition);
    expect(catalogueProblems(seeded)).toContain(`${key}: ${problem}`);
  });
});

/** How long sign-ins and links last, when failed sign-ins pause, the
 * shortest password, and who may create tokens, publish, embed, add
 * connections and import from links: each row's values, the product's own
 * default and who reads it, as the approved table states them. */
const SECURITY = {
  "security.sessionDays": [{ kind: "choice", values: ["1", "7", "30", "90"] }, "30", "admin"],
  "security.linkDays": [{ kind: "choice", values: ["1", "3", "7", "14"] }, "7", "admin"],
  "security.failedPerAccount": [{ kind: "integer", min: 3, max: 100 }, 5, "admin"],
  "security.failedPerAddress": [{ kind: "integer", min: 10, max: 1000 }, 20, "admin"],
  "security.passwordMin": [{ kind: "integer", min: 8, max: 64 }, 8, "public"],
  "tokens.create": [{ kind: "choice", values: ["everyone", "admins"] }, "everyone", "signed-in"],
  "tokens.expiry": [{ kind: "choice", values: ["never", "30d", "90d", "1y"] }, "never", "signed-in"],
  "publishing.publish": [{ kind: "choice", values: ["everyone", "admins", "none"] }, "everyone", "signed-in"],
  "publishing.embedding": [{ kind: "choice", values: ["any", "listed", "off"] }, "any", "signed-in"],
  "publishing.embedSites": [{ kind: "sites", maxSites: 50 }, [], "admin"],
  "connections.create": [{ kind: "choice", values: ["everyone", "admins"] }, "everyone", "signed-in"],
  "imports.links": [{ kind: "choice", values: ["everyone", "admins"] }, "everyone", "signed-in"],
} as const;
const KIND_OF_SECURITY_WRITE = { choice: "choice", integer: "number", sites: "list" } as const;
const SECURITY_GROUPS = ["security", "tokens", "publishing", "connections", "imports"];

describe("the security rows and the rules", () => {
  it("defines the twelve with their values, product default and reader, changed by admins, with no variable, never secret and never locked", () => {
    expect(SETTING_CATALOGUE.filter(d => SECURITY_GROUPS.includes(d.key.split(".")[0])).map(d => d.key)).toEqual(Object.keys(SECURITY));
    for (const [key, [write, defaultValue, readBy]] of Object.entries(SECURITY)) {
      const definition = settingDefinition(key);
      expect(definition, key).toMatchObject({ scope: "instance", readBy, changedBy: "admin", kind: KIND_OF_SECURITY_WRITE[write.kind],
        timing: "live", secret: false, editable: true, defaultValue });
      expect(definition.write, key).toEqual(write);
      expect(definition.label, key).not.toBe("");
      expect(definition.environment, key).toBeUndefined();
      expect(lockedEnvironment(definition), key).toBeUndefined();
      expect(validateStoredValue(definition, defaultValue).ok, key).toBe(true);
    }
    // None of them is what new things start with, so none enters the defaults.
    expect(Object.keys(SECURITY).filter(key => isInstanceDefault(settingDefinition(key)))).toEqual([]);
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
  });

  it("keeps each choice it offers and each whole number within bounds, as given, and refuses the rest", () => {
    for (const [key, [write]] of Object.entries(SECURITY)) {
      const definition = settingDefinition(key);
      if (write.kind === "choice") {
        for (const value of write.values) expect(validateStoredValue(definition, value), key).toEqual({ ok: true, value });
        for (const value of ["unknown", "", 30, true, [], {}]) expect(validateStoredValue(definition, value).ok, `${key}: ${String(value)}`).toBe(false);
      }
      if (write.kind === "integer") {
        for (const value of [write.min, write.max]) expect(validateStoredValue(definition, value), key).toEqual({ ok: true, value });
        for (const value of [write.min - 1, write.max + 1, write.min + 0.5, NaN, String(write.min), true, []]) {
          expect(validateStoredValue(definition, value).ok, `${key}: ${String(value)}`).toBe(false);
        }
      }
      expect(validateStoredValue(definition, null), key).toEqual({ ok: true, value: null });
    }
  });

  it.each(Object.keys(SECURITY))("%s fails the catalogue with a seeded variable", key => {
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
    const seeded = SETTING_CATALOGUE.map(definition => definition.key === key
      ? { ...definition, environment: "DEZFIL_SECURITY_SEEDED", environmentTiming: "restart" as const } : definition);
    expect(catalogueProblems(seeded)).toContain(`${key}: security variable`);
  });

  it("fails the catalogue with a seeded variable on a new row in one of their groups", () => {
    const added = { ...settingDefinition("security.passwordMin"), key: "security.seeded", environment: "DEZFIL_SECURITY_SEEDED", environmentTiming: "restart" as const };
    expect(catalogueProblems([...SETTING_CATALOGUE, added])).toEqual(["security.seeded: security variable"]);
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

/** The four service addresses an admin may store beside their variables. */
const SERVICE_ADDRESSES = {
  s3Endpoint: "DEZFIL_S3_ENDPOINT", overpassUrl: "DEZFIL_OVERPASS_URL",
  geocoderUrl: "DEZFIL_GEOCODER_URL", isochroneUrl: "DEZFIL_ISOCHRONE_URL",
} as const;
const ADDRESS_REFUSED = { ok: false, reason: "Expected an http or https address of at most 2048 characters." };

describe("the service addresses", () => {
  it("are editable beside their variables, write-only, read by admins and never secret", () => {
    // The four services' addresses and the satellite imagery's tile template.
    expect(SETTING_CATALOGUE.filter(d => d.kind === "address" && d.editable).map(d => d.key))
      .toEqual(["s3Endpoint", "overpassUrl", "satelliteUrl", "geocoderUrl", "isochroneUrl"]);
    for (const [key, environment] of Object.entries(SERVICE_ADDRESSES)) {
      expect(settingDefinition(key), key).toMatchObject({ scope: "instance", readBy: "admin", changedBy: "admin", kind: "address",
        environment, environmentTiming: "restart", timing: "live", secret: false, editable: true });
      expect(settingDefinition(key).write, key).toEqual({ kind: "address", maxLength: 2048 });
    }
    // The other addresses stay the deployment's alone.
    for (const key of ["basemapUrl", "overtureS3Endpoint"]) {
      expect(settingDefinition(key), key).toMatchObject({ editable: false, changedBy: "deployment", timing: "next-start" });
      expect(settingDefinition(key).write, key).toBeUndefined();
    }
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
  });

  it("keeps an http or https address as given once trimmed, its user information, port, path and query included", () => {
    const definition = settingDefinition("geocoderUrl");
    const seeded = "https://seed-user:SEEDED-KEY-0001-USER@geocoder.example:8443/SEEDED-KEY-0001-PATH/search?key=SEEDED-KEY-0001-QUERY";
    expect(validateStoredValue(definition, `  ${seeded}\n`)).toEqual({ ok: true, value: seeded });
    expect(validateStoredValue(definition, "HTTP://Router.Example")).toEqual({ ok: true, value: "HTTP://Router.Example" });
    const longest = `https://geocoder.example/${"a".repeat(2048 - "https://geocoder.example/".length)}`;
    expect(longest).toHaveLength(2048);
    expect(validateStoredValue(definition, ` ${longest} `)).toEqual({ ok: true, value: longest });
    expect(validateStoredValue(definition, null)).toEqual({ ok: true, value: null });
  });

  it.each([
    ["2,049 characters", `https://geocoder.example/${"a".repeat(2049 - "https://geocoder.example/".length)}?key=SEEDED-KEY-0001-QUERY`],
    ["another scheme", "ftp://seed-user:SEEDED-KEY-0001-USER@files.example/data"],
    ["a script address", "javascript:alert('SEEDED-KEY-0001-QUERY')"],
    ["a file address", "file:///etc/SEEDED-KEY-0001-PATH"],
    ["no scheme", "geocoder.example/search?key=SEEDED-KEY-0001-QUERY"],
    ["no host", "https:///SEEDED-KEY-0001-PATH"],
    ["a scheme alone", "https://"],
    ["a scheme without its slashes", "https:geocoder.example"],
    ["empty text", ""],
    ["blank text", "   "],
    ["a number", 42],
    ["a list", ["https://geocoder.example"]],
    ["an object", { url: "https://geocoder.example" }],
    ["a switch", true],
  ] as const)("refuses %s, repeating nothing of it", (_name, input) => {
    const result = validateStoredValue(settingDefinition("geocoderUrl"), input);
    expect(result).toEqual(ADDRESS_REFUSED);
    expect(JSON.stringify(result)).not.toContain("SEEDED-KEY");
  });

  it.each([
    ["a text write on an editable address", "geocoderUrl", { write: { kind: "text", maxLength: 2048, empty: "null" } }, "address not write-only"],
    ["an editable address every signed-in account reads", "overpassUrl", { readBy: "signed-in" }, "address not write-only"],
    ["an editable address anyone reads", "isochroneUrl", { readBy: "public" }, "address not write-only"],
    ["a secret mark on an editable address", "s3Endpoint", { secret: true }, "editable secret"],
    ["an address constraint on a text setting", "instanceName", { write: { kind: "address", maxLength: 2048 } }, "invalid address constraint"],
    ["an address constraint with no length", "geocoderUrl", { write: { kind: "address", maxLength: 0 } }, "invalid address constraint"],
    ["an address default that is not an address", "overpassUrl", { defaultValue: "overpass.example" }, "default fails validation"],
  ] as const)("fails the catalogue with %s", (_name, key, change, problem) => {
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
    const seeded = SETTING_CATALOGUE.map(definition => definition.key === key ? { ...definition, ...change } as SettingDefinition : definition);
    expect(catalogueProblems(seeded)).toContain(`${key}: ${problem}`);
  });
});

/** Which basemaps the instance offers where one is chosen, and whether a
 * map may take a style address of its own: switches an admin turns, on by
 * default, read by every signed-in account and set by no variable. */
const BASEMAP_SWITCHES = ["basemaps.dark", "basemaps.light", "basemaps.streets", "basemaps.satellite", "basemaps.singleMapStyles"] as const;

describe("the basemap switches", () => {
  it("are the five, on by default, changed by admins and read by every signed-in account, with no variable, never secret and never locked", () => {
    expect(SETTING_CATALOGUE.filter(d => d.key.startsWith("basemaps.")).map(d => d.key)).toEqual([...BASEMAP_SWITCHES]);
    for (const key of BASEMAP_SWITCHES) {
      const definition = settingDefinition(key);
      expect(definition, key).toMatchObject({ scope: "instance", readBy: "signed-in", changedBy: "admin", kind: "boolean",
        timing: "live", secret: false, editable: true, defaultValue: true, documentedDefault: "on" });
      expect(definition.write, key).toEqual({ kind: "switch" });
      expect(definition.label, key).not.toBe("");
      expect(definition.environment, key).toBeUndefined();
      expect(lockedEnvironment(definition), key).toBeUndefined();
      for (const value of [true, false]) expect(validateStoredValue(definition, value), key).toEqual({ ok: true, value });
      for (const value of ["on", "false", 1, 0, "", [], {}, undefined]) expect(validateStoredValue(definition, value).ok, `${key}: ${String(value)}`).toBe(false);
      expect(validateStoredValue(definition, null), key).toEqual({ ok: true, value: null });
    }
    // Neither what new things start with nor a rule.
    expect(BASEMAP_SWITCHES.filter(key => isInstanceDefault(settingDefinition(key)))).toEqual([]);
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
  });

  it.each(BASEMAP_SWITCHES.flatMap(key => [
    [key, "variable", { environment: "DEZFIL_BASEMAPS_SEEDED", environmentTiming: "restart" }, "signed-in variable"],
    [key, "secret mark", { secret: true }, "signed-in secret"],
  ] as const))("%s fails the catalogue with a seeded %s", (key, _seed, change, problem) => {
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
    const seeded = SETTING_CATALOGUE.map(definition => definition.key === key ? { ...definition, ...change } : definition);
    expect(catalogueProblems(seeded)).toContain(`${key}: ${problem}`);
  });
});

/** The satellite imagery's tile template and credit, as seeded keys would travel in them. */
const TEMPLATE = "https://seed-user:SEEDED-KEY-0002-USER@imagery.example/SEEDED-KEY-0002-PATH/{z}/{x}/{y}.jpg?key=SEEDED-KEY-0002-QUERY";

describe("the satellite rows", () => {
  it("keep their variables and become editable: the template write-only with its three placeholders, the credit text", () => {
    expect(settingDefinition("satelliteUrl")).toMatchObject({ scope: "instance", readBy: "admin", changedBy: "admin", kind: "address",
      environment: "DEZFIL_SATELLITE_URL", environmentTiming: "restart", timing: "live", secret: false, editable: true, defaultValue: null });
    expect(settingDefinition("satelliteUrl").write).toEqual({ kind: "address", maxLength: 2048, placeholders: ["{z}", "{x}", "{y}"], userInformation: "refused" });
    expect(settingDefinition("satelliteAttribution")).toMatchObject({ scope: "instance", readBy: "admin", changedBy: "admin", kind: "text",
      environment: "DEZFIL_SATELLITE_ATTRIBUTION", environmentTiming: "restart", timing: "live", secret: false, editable: true, defaultValue: null });
    expect(settingDefinition("satelliteAttribution").write).toEqual({ kind: "text", maxLength: 160, empty: "null" });
    expect(catalogueProblems(SETTING_CATALOGUE)).toEqual([]);
  });

  it("keeps a template holding {z}, {x} and {y} as given once trimmed, its user information, path and query included (the save refuses user information; one stored before is still read)", () => {
    const definition = settingDefinition("satelliteUrl");
    expect(validateStoredValue(definition, `  ${TEMPLATE}\n`)).toEqual({ ok: true, value: TEMPLATE });
    const query = "https://imagery.example/tile?z={z}&x={x}&y={y}&key=SEEDED-KEY-0002-QUERY";
    expect(validateStoredValue(definition, query)).toEqual({ ok: true, value: query });
    expect(validateStoredValue(definition, null)).toEqual({ ok: true, value: null });
  });

  it.each([
    ["{z}", TEMPLATE.replace("{z}", "7"), "{z} is missing"],
    ["{x}", TEMPLATE.replace("{x}", "7"), "{x} is missing"],
    ["{y}", TEMPLATE.replace("{y}", "7"), "{y} is missing"],
    ["{x} and {y}", TEMPLATE.replace("{x}", "7").replace("{y}", "7"), "{x} and {y} are missing"],
    ["all three", TEMPLATE.replace("/{z}/{x}/{y}", ""), "{z}, {x} and {y} are missing"],
    ["a placeholder in another case", TEMPLATE.replace("{z}", "{Z}"), "{z} is missing"],
  ])("refuses a template without %s, naming what is missing and repeating nothing of it", (_name, input, missing) => {
    const result = validateStoredValue(settingDefinition("satelliteUrl"), input);
    expect(result).toEqual({ ok: false, reason: `Expected {z}, {x} and {y} in the address; ${missing}.` });
    expect(JSON.stringify(result)).not.toContain("SEEDED-KEY");
  });

  it.each([
    ["another scheme", TEMPLATE.replace("https:", "ftp:")],
    ["2,049 characters", `https://imagery.example/{z}/{x}/{y}/${"a".repeat(2049 - "https://imagery.example/{z}/{x}/{y}/".length)}`],
    ["no host", "https:///{z}/{x}/{y}?key=SEEDED-KEY-0002-QUERY"],
  ])("refuses %s by the address kind's own reason before its placeholders", (_name, input) => {
    expect(String(input).length).toBeLessThanOrEqual(2049);
    const result = validateStoredValue(settingDefinition("satelliteUrl"), input);
    expect(result).toEqual(ADDRESS_REFUSED);
    expect(JSON.stringify(result)).not.toContain("SEEDED-KEY");
  });

  it("trims the credit, keeps 160 characters, refuses 161 and clears with empty text", () => {
    const definition = settingDefinition("satelliteAttribution");
    expect(validateStoredValue(definition, "  © Imagery Provider  ")).toEqual({ ok: true, value: "© Imagery Provider" });
    expect(validateStoredValue(definition, "c".repeat(160))).toEqual({ ok: true, value: "c".repeat(160) });
    expect(validateStoredValue(definition, "c".repeat(161))).toEqual({ ok: false, reason: "Expected at most 160 characters." });
    expect(validateStoredValue(definition, " ")).toEqual({ ok: true, value: null });
    expect(validateStoredValue(definition, null)).toEqual({ ok: true, value: null });
  });

  it.each([
    ["an empty placeholder list", { kind: "address", maxLength: 2048, placeholders: [] }],
    ["an empty placeholder", { kind: "address", maxLength: 2048, placeholders: ["{z}", ""] }],
  ])("fails the catalogue with %s", (_name, write) => {
    const seeded = SETTING_CATALOGUE.map(definition => definition.key === "satelliteUrl" ? { ...definition, write } as SettingDefinition : definition);
    expect(catalogueProblems(seeded)).toContain("satelliteUrl: invalid address constraint");
  });
});
