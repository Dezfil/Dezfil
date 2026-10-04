import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { insertAccount } from "@/lib/metadata/accounts";
import { secretKey, resetSecretKeyCache, encryptSecret, decryptSecret } from "@/lib/secrets";
import { providerCacheGeneration } from "@/lib/provider-cache-generation";
import { writeAnswer, cacheKey as geocodeKey } from "@/lib/geocode/cache";
import { writeIsochrone } from "@/lib/isochrone/cache";
import { fetchOverpass, cacheKey as overpassKey } from "@/lib/osm/overpass";
import { eraseProviderCaches } from "./account-erasure-provider-caches";
import { erasureInventory } from "./account-erasure-inventory";
import { discoverFiles } from "../../../test-support/account-erasure-discovery";
import { proveErasure } from "../../../test-support/account-erasure-proof";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string;
const endpoint = "https://provider.invalid/search", overpass = "https://overpass.invalid/interpreter";
beforeEach(async () => {
  directory = await mkdtemp(path.join(root, "provider-caches-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); resetSecretKeyCache(); testAccountScope(undefined, "target");
  vi.stubEnv("DEZFIL_SECRET_KEY", ""); vi.stubEnv("DEZFIL_OVERPASS_URL", overpass);
  metadataDb().exec("INSERT INTO workspace_settings VALUES ('fixture', 'instance setting', 'time'); INSERT INTO custom_palettes VALUES ('fixture', 'instance palette', '[]', 'time', 'time')");
  secretKey(); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ elements: [{ id: "private answer" }] })));
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); closeMetadataDb(); resetSecretKeyCache(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
async function populate() {
  const ledger: Record<string, { target: string[]; control: string[] }> = {};
  for (const name of ["geocode", "isochrone", "overpass"]) ledger[`file:${name}`] = { target: [], control: [] };
  for (const owner of ["target", "control"] as const) {
    await writeAnswer(endpoint, owner, { outcome: "matched", display: `${owner} private answer`, lat: 1, lon: 2, answeredAt: new Date().toISOString() }, providerCacheGeneration());
    await writeIsochrone(owner, { bands: [{ minutes: 5, wkt: "POLYGON((0 0, 1 0, 1 1, 0 0))" }], snappedLon: 0, snappedLat: 0, answeredAt: new Date().toISOString() }, providerCacheGeneration());
    await fetchOverpass(`node[name="${owner}"];out;`);
    ledger["file:geocode"][owner].push(`cache/geocode/${geocodeKey(endpoint, owner)}.json`);
    ledger["file:isochrone"][owner].push(`cache/isochrone/${owner}.json`);
    ledger["file:overpass"][owner].push(`cache/overpass/${overpassKey(overpass, `node[name="${owner}"];out;`)}.json`);
    for (const name of ["geocode", "isochrone", "overpass"]) { const file = `cache/${name}/.${owner}.abandoned.tmp`; await writeFile(path.join(directory, file), `${owner} abandoned bytes`); ledger[`file:${name}`][owner].push(file); }
  }
  return ledger;
}
async function outside() { return { key: await readFile(path.join(directory, "secret.key"), "utf8"), cachedKey: secretKey().toString("hex"), settings: metadataDb().prepare("SELECT * FROM workspace_settings ORDER BY key").all(), palettes: metadataDb().prepare("SELECT * FROM custom_palettes ORDER BY name").all() }; }
it("purges all three populated cache inventories whole while preserving instance keys, settings and palettes", async () => {
  const ledger = await populate(), controls = await outside(), secret = encryptSecret("independent connection secret"), before = discoverFiles(directory);
  const ids = Object.keys(ledger), stores = Object.fromEntries(ids.map(id => [id, erasureInventory.stores[id as keyof typeof erasureInventory.stores]]));
  const probes = Object.fromEntries(ids.map(id => [id, { populate() {}, dispose() {}, observe() {
    const files = discoverFiles(directory); return { target: ledger[id].target.filter(f => files.includes(f)), control: ledger[id].control.filter(f => files.includes(f)), outsideControl: { store: "table:workspace_settings", entries: metadataDb().prepare("SELECT * FROM workspace_settings ORDER BY key").all().map(r => JSON.stringify(r)) } };
  } }]));
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  await proveErasure({ ...erasureInventory, stores }, probes, () => eraseProviderCaches("target", metadataDb()));
  expect(discoverFiles(directory)).toEqual(before.filter(f => !f.startsWith("cache/"))); expect(await outside()).toEqual(controls); expect(decryptSecret(secret)).toBe("independent connection secret");
  await eraseProviderCaches("target", metadataDb()); expect(await outside()).toEqual(controls);
});
it("invitation deletion leaves every cache byte and its generation intact", async () => {
  insertAccount({ id: "invited", name: "Invited", email: "invited@example.test", passwordHash: null, isAdmin: false, status: "invited", now: "time" });
  await populate(); const before = discoverFiles(directory), files = before.filter(f => f.startsWith("cache/")), bytes = await Promise.all(files.map(f => readFile(path.join(directory, f)))), generation = providerCacheGeneration(), controls = await outside();
  await eraseProviderCaches("invited", metadataDb());
  expect(providerCacheGeneration()).toBe(generation); expect(discoverFiles(directory)).toEqual(before); expect(await Promise.all(files.map(f => readFile(path.join(directory, f))))).toEqual(bytes); expect(await outside()).toEqual(controls);
});
it.each(["active", "deactivated"])("refuses %s before any cache or generation effect", async status => {
  await populate(); metadataDb().prepare("UPDATE accounts SET status = ? WHERE id = 'target'").run(status); const before = discoverFiles(directory), generation = providerCacheGeneration();
  await expect(eraseProviderCaches("target", metadataDb())).rejects.toThrow("deleting"); expect(discoverFiles(directory)).toEqual(before); expect(providerCacheGeneration()).toBe(generation);
});
