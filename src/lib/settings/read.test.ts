import { readdirSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/instance/settings/route";
import { SETTING_CATALOGUE } from "./catalogue";
import { writeStoredSettings } from "./store";
import { readInstanceSettings } from "./read";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { buildTools } from "@/lib/tools/tools";
import { testClient } from "@/lib/mcp/test-client";
import * as secrets from "@/lib/secrets";
import { DISCLOSURE_SEEDS, FORBIDDEN_DISCLOSURE, instanceSettingsFixture } from "../../../test-support/instance-settings";
import manifest from "../../../package.json";
import { currentAssistantChoices } from "@/lib/assistant/catalogue-choices";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

let fixture: ReturnType<typeof instanceSettingsFixture>;
beforeEach(() => { fixture = instanceSettingsFixture(); });
afterEach(() => fixture.close());
const read = () => readInstanceSettings(fixture.context, fixture.db);

it("reports every instance and platform definition, defaults, stored values and normalized locks", () => {
  writeStoredSettings({ instanceName: "Field atlas", signInMessage: "Welcome", lostPasswordContact: "Ask Ada", landingPage: "maps",
    queryTimeoutS: 50, operationConcurrency: 3, remoteTimeoutS: 40 }, fixture.db);
  vi.stubEnv("DEZFIL_QUERY_TIMEOUT_S", "seed-invalid-number");
  vi.stubEnv("DEZFIL_OPERATION_CONCURRENCY", "2.9");
  vi.stubEnv("DEZFIL_REMOTE_TIMEOUT_S", "");
  vi.stubEnv("DEZFIL_EXPORT_RENDER_TIMEOUT_S", "2.9");
  const result = read();
  expect(Object.keys(result.settings).sort()).toEqual(SETTING_CATALOGUE.filter(d => d.scope !== "account").map(d => d.key).sort());
  expect(result.settings.queryTimeoutS).toMatchObject({ value: 60, source: "default", locked: true, invalidOverride: true, storedValue: 50 });
  expect(JSON.stringify(result)).not.toContain("seed-invalid-number");
  expect(result.settings.operationConcurrency).toMatchObject({ value: 2, source: "environment", locked: true, storedValue: 3 });
  expect(result.settings.remoteTimeoutS).toMatchObject({ value: 40, source: "stored", locked: false });
  expect(result.settings.exportRenderTimeoutS).toMatchObject({ value: 2.9, source: "environment", locked: true });
  expect(result.settings.uploadMaxMb).toMatchObject({ value: 5120, source: "default", locked: false });
  expect(result.settings.overpassUrl).toMatchObject({
    documentedDefault: "https://overpass-api.de/api/interpreter",
    defaultValue: { set: true, origin: "https://overpass-api.de" },
    value: { set: true, origin: "https://overpass-api.de" },
  });
  for (const [key, value] of Object.entries({ instanceName: "Field atlas", signInMessage: "Welcome", lostPasswordContact: "Ask Ada", landingPage: "maps" })) {
    expect(result.settings[key]).toMatchObject({ value, storedValue: value, source: "stored", locked: false });
  }
  expect(result.maxImageDimension).toBe(4096);
});

it("normalizes switches, assistant defaults and the distinct empty model-list meaning", () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "seed-provider-key");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "ANTHROPIC");
  vi.stubEnv("DEZFIL_AI_MODEL", "fixture-model");
  vi.stubEnv("DEZFIL_AI_MODELS_ANTHROPIC", "");
  vi.stubEnv("DEZFIL_AI_MODELS_OPENAI", " first, second,first ");
  vi.stubEnv("DEZFIL_ASSISTANT_AUTO_CHECK", " OFF ");
  vi.stubEnv("DEZFIL_OBJECT_STORE_CREDENTIALS", "YES");
  vi.stubEnv("DEZFIL_ASSISTANT_OFFER", "invalid-offer");
  const { settings } = read();
  expect(settings.aiProvider.value).toBe("anthropic");
  expect(settings.aiModelsAnthropic).toMatchObject({ value: ["fixture-model"], source: "environment", locked: true });
  expect(settings.aiModelsOpenai.value).toEqual(["fixture-model", "first", "second"]);
  expect(settings.assistantAutoCheck.value).toBe(false);
  expect(settings.objectStoreCredentials.value).toBe(true);
  expect(settings.assistantOffer).toMatchObject({ value: "subset", invalidOverride: true, locked: true });
});

it("omits seeded credentials from read, schema, defaults and generated tool results", async () => {
  for (const [key, value] of Object.entries(DISCLOSURE_SEEDS)) vi.stubEnv(key, value);
  const response = await GET(fixture.request());
  expect(response.status).toBe(200);
  const result = await response.json();
  for (const [key, origin] of Object.entries({ geocoderUrl: "https://geocoder.example", isochroneUrl: "https://router.example",
    satelliteUrl: "https://imagery.example", basemapUrl: "https://maps.example", overpassUrl: "https://osm.example", s3Endpoint: "https://objects.example" })) {
    expect(result.settings[key].value).toEqual({ set: true, origin });
  }
  expect(result.settings.overtureS3Endpoint.value).toEqual({ set: true, unreadable: true });
  expect(result.settings.anthropicApiKey.value).toEqual({ set: true });
  expect(result.settings.openaiApiKey.value).toEqual({ set: true });
  expect(result.settings.secretKey.value).toEqual({ status: "environment" });
  const client = await testClient(() => GET(fixture.request()));
  try {
    const toolResult = await client.callTool({ name: "get_instance_settings", arguments: {} });
    expect(toolResult.isError).not.toBe(true);
    const surfaces = JSON.stringify([result, buildOpenApiDocument(), buildTools(), toolResult]);
    for (const secret of FORBIDDEN_DISCLOSURE) expect(surfaces.includes(secret), "Seeded credential must be absent").toBe(false);
  } finally { await client.close(); }
});

it("reads local model additions and key-file presence without key access, writes, service requests or engines", async () => {
  writeFileSync(path.join(fixture.dir, "assistant-models.json"), JSON.stringify({
    anthropic: [{ id: "fixture-anthropic-model", name: "Local model", efforts: [] }],
    openai: [{ id: "fixture-openai-model", name: "Local model", efforts: [] }],
  }));
  const key = vi.spyOn(secrets, "secretKey").mockImplementation(() => { throw new Error("Key accessor called"); });
  const readFile = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof readFile>) => {
    if (String(args[0]).endsWith("secret.key")) throw new Error("Key contents read");
    return Reflect.apply(readFile, fs, args);
  });
  const engine = vi.spyOn(DuckDBInstance, "create");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const files = () => readdirSync(fixture.dir, { recursive: true }).map(name => {
    const stat = statSync(path.join(fixture.dir, String(name)));
    return [name, stat.size, stat.mtimeMs];
  });
  const before = files();
  const response = await GET(fixture.request());
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.settings.secretKey.value).toEqual({ status: "not-yet-present" });
  expect(result.settings.anthropicApiKey.value).toEqual({ set: false });
  expect(result.settings.openaiApiKey.value).toEqual({ set: false });
  for (const [provider, key, credential] of [
    ["anthropic", "aiModelsAnthropic", "ANTHROPIC_API_KEY"],
    ["openai", "aiModelsOpenai", "OPENAI_API_KEY"],
  ]) {
    expect(result.settings[key].value).toContain(`fixture-${provider}-model`);
    expect(result.settings[key]).toMatchObject({ source: "default", locked: false });
    vi.stubEnv("DEZFIL_AI_PROVIDER", provider);
    vi.stubEnv(credential, "seed-provider-key");
    const offered = currentAssistantChoices();
    expect(offered.enabled).toBe(true);
    if (!offered.enabled) throw new Error("Missing model offer");
    expect(result.settings[key].value).toEqual(offered.models);
  }
  expect(files()).toEqual(before);
  writeFileSync(path.join(fixture.dir, "secret.key"), "cd".repeat(32));
  const present = files();
  expect(read().settings.secretKey.value).toEqual({ status: "data-directory" });
  expect(JSON.stringify(read())).not.toContain("cd".repeat(32));
  expect(files()).toEqual(present);
  expect(key).not.toHaveBeenCalled(); expect(engine).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it("reports the package version and a stable process start across reads and route module reloads", async () => {
  const first = read();
  expect(first.version).toBe(manifest.version);
  expect(Date.parse(first.startedAt)).toBeLessThanOrEqual(Date.now());
  expect(Date.now() - Date.parse(first.startedAt)).toBeLessThan(process.uptime() * 1000 + 2000);
  await new Promise(resolve => setTimeout(resolve, 20));
  vi.resetModules();
  const reloaded = await import("./read");
  expect(reloaded.readInstanceSettings(fixture.context, fixture.db).startedAt).toBe(first.startedAt);
});
