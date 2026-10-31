import { describe, expect, it } from "vitest";
import { SETTING_CATALOGUE, settingDefinition } from "./catalogue";
import { consumptionInventory, consumptionProblems, productionSources, scanConsumption } from "../../../test-support/settings-consumption";

describe("settings consumption inventory", () => {
  const sources = () => productionSources(process.cwd());
  it("covers every deployment definition in both directions using actual reads", () => {
    const inventory = consumptionInventory(SETTING_CATALOGUE, sources());
    expect(consumptionProblems(SETTING_CATALOGUE, sources())).toEqual([]);
    expect(inventory).toHaveLength(77); // Deployment settings and the two platform facts.
    expect(inventory.filter(row => row.consumers.some(c => c.kind === "resolver"))).toHaveLength(49);
    // Each service address is read through its resolver, in its service's
    // own module alone, never from the environment directly.
    const addresses: Record<string, string[]> = {
      geocoderUrl: ["src/lib/geocode/endpoint.ts", "src/lib/geocode/endpoint.ts"],
      isochroneUrl: ["src/lib/isochrone/endpoint.ts", "src/lib/isochrone/endpoint.ts"],
      overpassUrl: ["src/lib/osm/overpass.ts"],
      s3Endpoint: ["src/lib/ingest/remote.ts"],
      satelliteUrl: ["src/lib/basemap-satellite.ts"],
      templatesCatalogueUrl: ["src/lib/templates/catalogue-address.ts"],
    };
    for (const row of inventory.filter(row => row.consumers.some(c => c.kind === "resolver"))) {
      if (row.key in addresses) {
        expect(row.consumers.map(c => [c.kind, c.file]), row.key).toEqual(addresses[row.key].map(file => ["resolver", file]));
        continue;
      }
      expect(row.consumers.map(c => c.kind), row.key).toEqual(["resolver"]);
      expect(row.consumers[0].file, row.key).toBe(row.key.startsWith("public") ? "src/lib/publish/rate-limit.ts" : "src/lib/limits.ts");
    }
  });
  it("rejects a seeded deployment read without a definition", () => {
    const seeded = { ...sources(), "src/lib/new-consumer.ts": "export const value = process.env.DEZFIL_UNDEFINED_SETTING;" };
    expect(consumptionProblems(SETTING_CATALOGUE, seeded)).toEqual(["Undefined variable: DEZFIL_UNDEFINED_SETTING"]);
  });
  it("rejects a seeded definition without a consumer", () => {
    const definitions = [...SETTING_CATALOGUE, { ...settingDefinition("queryTimeoutS"), key: "unusedSetting", environment: "DEZFIL_UNUSED_SETTING" }];
    expect(consumptionProblems(definitions, sources())).toEqual(["Unconsumed definition: unusedSetting"]);
  });
  it("rejects a removed consumer even when its key and variable remain in a message", () => {
    const seeded = sources();
    seeded["src/lib/limits.ts"] = seeded["src/lib/limits.ts"].replace('resolveNumber("uploadMaxMb")', '5120 /* uploadMaxMb DEZFIL_UPLOAD_MAX_MB */');
    seeded["src/lib/message.ts"] = 'export const hint = "uploadMaxMb DEZFIL_UPLOAD_MAX_MB";';
    expect(consumptionProblems(SETTING_CATALOGUE, seeded)).toEqual(["Unconsumed definition: uploadMaxMb"]);
  });
  it("counts direct and computed reads, environment aliases and resolver imports, never text or writes", () => {
    const source = `
      import { resolveNumber as number } from "@/lib/settings/resolver";
      import { resolveServiceAddress as address } from "@/lib/settings/service-address";
      const names = { first: "FIRST_API_KEY", second: "SECOND_API_KEY" };
      function read(env = process.env) { return env[names[provider]] + env.DEZFIL_DIRECT; }
      const value = process.env["DEZFIL_QUOTED"];
      const chosen = number("queryTimeoutS");
      const finder = address("geocoderUrl");
      const hint = "process.env.DEZFIL_MENTION"; // process.env.DEZFIL_COMMENT
      process.env.DEZFIL_WRITE = "1"; delete process.env.DEZFIL_DELETE;
    `;
    expect(scanConsumption("src/lib/example.ts", source).map(c => [c.kind, c.name])).toEqual([
      ["environment", "FIRST_API_KEY"], ["environment", "SECOND_API_KEY"], ["environment", "DEZFIL_DIRECT"],
      ["environment", "DEZFIL_QUOTED"], ["resolver", "queryTimeoutS"], ["resolver", "geocoderUrl"],
    ]);
  });
  it("refuses unknown resolver keys and untraceable dynamic environment reads", () => {
    const seeded = { ...sources(), "src/lib/new-consumer.ts": 'import { resolveNumber } from "@/lib/settings/resolver"; resolveNumber("missingKey"); process.env[unknownName];' };
    expect(consumptionProblems(SETTING_CATALOGUE, seeded)).toEqual([
      "Unknown resolved key: missingKey", "Unresolved environment read: src/lib/new-consumer.ts:1",
    ]);
  });
  it("keeps catalogue and resolver imports inside the settings data boundary", () => {
    const boundary = ["catalogue", "numeric", "instance-defaults", "instance-security", "types", "validation", "resolver", "state"];
    for (const name of boundary) {
      const source = readFileSync(`src/lib/settings/${name}.ts`, "utf8");
      for (const match of source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)/g)) {
        expect(boundary.map(module => `./${module}`), name).toContain(match[1]);
      }
    }
  });
});
import { readFileSync } from "node:fs";
