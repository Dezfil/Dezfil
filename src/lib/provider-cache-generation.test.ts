import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "./metadata/db";
import { testAccountScope } from "./test-support/accounts";
import { geocodeAddress } from "./geocode/provider";
import { askIsochrone } from "./isochrone/provider";
import { resetLimiter } from "./geocode/limiter";
import { resetIsochroneLimiter } from "./isochrone/limiter";
import { fetchOverpass } from "./osm/overpass";
import { writeAnswer } from "./geocode/cache";
import { providerCacheWritersForTests, providerCacheGeneration } from "./provider-cache-generation";
import { eraseProviderCaches } from "./auth/account-erasure-provider-caches";
import { erasureInventory } from "./auth/account-erasure-inventory";
import { discoverFiles } from "../../test-support/account-erasure-discovery";
import { proveErasure } from "../../test-support/account-erasure-proof";
const hooks = vi.hoisted(() => ({ write: undefined as undefined | ((file: string) => Promise<void>), remove: undefined as undefined | ((file: string) => Promise<void>), fail: false }));
const remote = vi.hoisted(() => vi.fn());
vi.mock("@/lib/net/remote-fetch", () => ({ openRemote: remote }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, writeFile: async (...args: Parameters<typeof real.writeFile>) => { await hooks.write?.(String(args[0])); return real.writeFile(...args); }, rm: async (...args: Parameters<typeof real.rm>) => {
    await hooks.remove?.(String(args[0])); if (hooks.fail && String(args[0]).endsWith("/cache/isochrone")) throw new Error("injected cache removal failure"); return real.rm(...args);
  } };
});
const root = process.env.DEZFIL_DATA_DIR!; let directory: string, calls: string[], networkHold: Promise<void> | undefined, arrived: (() => void) | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(root, "cache-generation-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); resetLimiter(); resetIsochroneLimiter();
  testAccountScope(undefined, "target"); testAccountScope(undefined, "control"); calls = []; networkHold = undefined; arrived = undefined;
  vi.stubEnv("DEZFIL_GEOCODER_URL", "https://geocoder.invalid/search"); vi.stubEnv("DEZFIL_ISOCHRONE_URL", "https://router.invalid"); vi.stubEnv("DEZFIL_OVERPASS_URL", "https://overpass.invalid/interpreter"); vi.stubEnv("DEZFIL_GEOCODE_PACE_MS", "0"); vi.stubEnv("DEZFIL_ISOCHRONE_PACE_MS", "0");
  remote.mockImplementation(async (url: string) => {
    const parsed = new URL(url), routing = parsed.hostname === "router.invalid"; calls.push(routing ? "isochrone" : "geocode"); arrived?.(); await networkHold;
    const location = routing ? JSON.parse(parsed.searchParams.get("json")!).locations[0] : { lon: 1, lat: 2 };
    const { lon, lat } = location;
    const body = routing ? { type: "FeatureCollection", features: [
      { type: "Feature", properties: { contour: 5 }, geometry: { type: "Polygon", coordinates: [[[lon-.01,lat-.01],[lon+.01,lat-.01],[lon+.01,lat+.01],[lon-.01,lat+.01],[lon-.01,lat-.01]]] } },
      { type: "Feature", properties: { type: "snapped" }, geometry: { type: "MultiPoint", coordinates: [[lon,lat]] } },
    ] } : [{ lon: "1", lat: "2", display_name: "private provider answer", licence: "fixture" }];
    return { statusCode: 200, body: Readable.from([Buffer.from(JSON.stringify(body))]) };
  });
  vi.stubGlobal("fetch", vi.fn(async () => { calls.push("overpass"); arrived?.(); await networkHold; return Response.json({ elements: [{ id: "private overpass answer" }] }); }));
});
afterEach(async () => { hooks.write = undefined; hooks.remove = undefined; hooks.fail = false; vi.unstubAllGlobals(); vi.unstubAllEnvs(); closeMetadataDb(); resetLimiter(); resetIsochroneLimiter(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
const ask = (key: number) => Promise.all([geocodeAddress(`address ${key}`), askIsochrone({ lon: 1 + key / 10, lat: 2 }, "walking", [5]), fetchOverpass(`node[id=${key}];out;`)]);
const cacheFiles = () => discoverFiles(directory).filter(f => f.startsWith("cache/"));
const deleting = () => metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
it("fresh requests hit all three deterministic providers after purge and held old answers cannot repopulate across module graphs", async () => {
  const first = await ask(1); expect(first[0].source).toBe("wire"); expect(first[1].bands[0].status).toBe("answered"); expect(first[2].fromCache).toBe(false);
  const hit = await ask(1); expect(hit[0].source).toBe("cache"); expect(hit[1].source).toBe("cache"); expect(hit[2].fromCache).toBe(true); expect(calls).toHaveLength(3); expect(cacheFiles()).toHaveLength(3);
  const hold = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(); networkHold = hold.promise; arrived = () => { if (calls.length === 6) ready.resolve(); };
  const late = ask(2); await ready.promise; deleting(); vi.resetModules();
  const other = await import("./auth/account-erasure-provider-caches");
  try { await other.eraseProviderCaches("target", metadataDb()); expect(cacheFiles()).toEqual([]); }
  finally { hold.resolve(); await late; networkHold = undefined; arrived = undefined; }
  expect(cacheFiles()).toEqual([]); const fresh = await ask(1);
  expect(fresh[0].source).toBe("wire"); expect(fresh[1].source).toBe("wire"); expect(fresh[2].fromCache).toBe(false); expect(calls).toHaveLength(9); expect(cacheFiles()).toHaveLength(3);
});
it("drains real cache writer leases and temporary siblings before whole-store completion", async () => {
  await ask(1); const hold = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(); const entered: string[] = [];
  hooks.write = async file => { if (file.includes("/cache/")) { entered.push(file); if (entered.length === 3) ready.resolve(); await hold.promise; } };
  const writing = ask(2); await ready.promise; expect(providerCacheWritersForTests()).toBe(3); deleting();
  const id = "memory:provider-cache-writers", removing: string[] = []; let purging: Promise<void> | undefined;
  hooks.remove = async file => { if (file.includes("/cache/")) removing.push(file); };
  try {
    await proveErasure({ ...erasureInventory, stores: { [id]: erasureInventory.stores[id as keyof typeof erasureInventory.stores] } }, { [id]: { populate() {}, dispose() {}, observe() {
      const count = providerCacheWritersForTests(); return { target: count ? [entered[0]] : [], control: count ? entered.slice(1) : [], outsideControl: { store: "table:accounts", entries: metadataDb().prepare("SELECT id,status FROM accounts WHERE id = 'control'").all().map(r => JSON.stringify(r)) } };
    } } }, async () => {
      vi.resetModules(); const other = await import("./auth/account-erasure-provider-caches"); let done = false;
      const erased = purging = other.eraseProviderCaches("target", metadataDb()).then(() => { done = true; }); void erased.catch(() => {});
      await new Promise(r => setImmediate(r)); expect(removing).toEqual([]); expect(done).toBe(false);
      hold.resolve(); await writing; await erased; expect(cacheFiles()).toEqual([]);
    });
  } finally { hold.resolve(); await Promise.allSettled([writing, purging]); hooks.write = undefined; hooks.remove = undefined; }
});
it("reports a removal failure only after other filesystem work settles, and retries the complete purge", async () => {
  await ask(1); deleting(); hooks.fail = true;
  const hold = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  hooks.remove = async file => { if (file.endsWith("/cache/overpass")) { entered.resolve(); await hold.promise; } };
  let settled = false; const erased = eraseProviderCaches("target", metadataDb()).then(() => { settled = true; }, error => { settled = true; throw error; }); const result = expect(erased).rejects.toThrow("injected cache removal failure");
  try { await entered.promise; await new Promise(r => setImmediate(r)); expect(settled).toBe(false); } finally { hold.resolve(); await result; }
  expect(cacheFiles().some(f => f.startsWith("cache/isochrone/"))).toBe(true);
  hooks.fail = false; hooks.remove = undefined; await eraseProviderCaches("target", metadataDb()); expect(cacheFiles()).toEqual([]);
});
it("queues a fresh generation's write behind a held purge without discarding the new answer", async () => {
  await mkdir(path.join(directory, "cache", "geocode"), { recursive: true }); await writeFile(path.join(directory, "cache", "geocode", "old.json"), "old answer"); deleting();
  const hold = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); hooks.remove = async file => { if (file.endsWith("/cache/geocode")) { entered.resolve(); await hold.promise; } };
  const erased = eraseProviderCaches("target", metadataDb()); await entered.promise;
  let written = false; const fresh = writeAnswer("https://new.invalid", "new address", { outcome: "no_match", answeredAt: new Date().toISOString() }, providerCacheGeneration()).then(() => { written = true; });
  await new Promise(r => setImmediate(r)); expect(written).toBe(false); hold.resolve(); await erased; await fresh;
  expect(cacheFiles()).toHaveLength(1); expect(cacheFiles()[0]).not.toContain("old.json");
});

it("overlapping purges invalidate requests admitted between their generations", async () => {
  deleting(); const hold = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let removals = 0;
  hooks.remove = async file => { if (file.endsWith("/cache/geocode") && ++removals === 1) { entered.resolve(); await hold.promise; } };
  const first = eraseProviderCaches("target", metadataDb()); await entered.promise;
  const between = providerCacheGeneration();
  const second = eraseProviderCaches("target", metadataDb());
  const stale = writeAnswer("https://new.invalid", "between purges", { outcome: "no_match", answeredAt: new Date().toISOString() }, between);
  hold.resolve(); await Promise.all([first, second, stale]); expect(cacheFiles()).toEqual([]);
});
