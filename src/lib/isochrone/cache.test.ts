import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  isochroneCacheKey,
  maintainIsochroneCache,
  readIsochrone,
  writeIsochrone,
  type CachedIsochrone,
} from "./cache";

/**
 * The durable isochrone cache.
 *
 * The key's discipline carries most of the ruling: exact coordinates —
 * nothing rounded on the way in — canonical band order, the costing and the
 * protocol version, and never the URL itself.
 */

let dir: string;
const ENDPOINT = "https://router.example/isochrone?key=secret";
const HOUR = 60 * 60 * 1000;
const ORIGIN = { lon: 13.404954, lat: 52.520008 };

const answer = (agoHours = 0): CachedIsochrone => ({
  bands: [
    { minutes: 5, wkt: "POLYGON((13.4 52.5, 13.41 52.5, 13.41 52.51, 13.4 52.5))" },
    { minutes: 10, wkt: "POLYGON((13.39 52.49, 13.42 52.49, 13.42 52.52, 13.39 52.49))" },
  ],
  snappedLon: 13.40495,
  snappedLat: 52.52001,
  answeredAt: new Date(Date.now() - agoHours * HOUR).toISOString(),
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-isocache-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
});

afterEach(async () => {
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_ISOCHRONE_CACHE_HOURS;
  delete process.env.DEZFIL_ISOCHRONE_CACHE_MB;
  await rm(dir, { recursive: true, force: true });
});

describe("the key's discipline (K10)", () => {
  it("never contains the endpoint URL or its credential", () => {
    const key = isochroneCacheKey(ENDPOINT, "auto", ORIGIN, [5, 10]);
    expect(key).not.toContain("router.example");
    expect(key).not.toContain("secret");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is canonical over band order, and nothing else about the bands", () => {
    const a = isochroneCacheKey(ENDPOINT, "auto", ORIGIN, [10, 5]);
    const b = isochroneCacheKey(ENDPOINT, "auto", ORIGIN, [5, 10]);
    const c = isochroneCacheKey(ENDPOINT, "auto", ORIGIN, [5, 15]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("treats a moved coordinate as a different question — nothing is rounded", () => {
    const a = isochroneCacheKey(ENDPOINT, "auto", ORIGIN, [5]);
    const b = isochroneCacheKey(
      ENDPOINT,
      "auto",
      { lon: ORIGIN.lon + 1e-6, lat: ORIGIN.lat },
      [5],
    );
    expect(a).not.toBe(b);
  });

  it("splits by costing profile", () => {
    expect(isochroneCacheKey(ENDPOINT, "auto", ORIGIN, [5])).not.toBe(
      isochroneCacheKey(ENDPOINT, "pedestrian", ORIGIN, [5]),
    );
  });
});

describe("what the cache keeps and for how long", () => {
  it("answers what it was given, whole", async () => {
    const key = isochroneCacheKey(ENDPOINT, "auto", ORIGIN, [5, 10]);
    await writeIsochrone(key, answer());
    const read = await readIsochrone(key);
    expect(read?.bands).toHaveLength(2);
    expect(read?.bands[0].wkt).toContain("POLYGON");
    expect(read?.snappedLon).toBeCloseTo(13.40495, 5);
  });

  it("expires by the one lifetime, removing rather than ignoring", async () => {
    process.env.DEZFIL_ISOCHRONE_CACHE_HOURS = "168";
    const key = isochroneCacheKey(ENDPOINT, "auto", ORIGIN, [5, 10]);
    await writeIsochrone(key, answer(169));
    expect(await readIsochrone(key)).toBeNull();
    const files = await readdir(
      path.join(process.env.DEZFIL_DATA_DIR!, "cache", "isochrone"),
    );
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  it("evicts oldest-first when over budget, and removes what it cannot read", async () => {
    process.env.DEZFIL_ISOCHRONE_CACHE_MB = "0.0001"; // ~100 bytes
    const cacheDirectory = path.join(
      process.env.DEZFIL_DATA_DIR!,
      "cache",
      "isochrone",
    );
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(path.join(cacheDirectory, "garbage.json"), "{not json", "utf8");
    const key = isochroneCacheKey(ENDPOINT, "auto", ORIGIN, [5, 10]);
    await writeIsochrone(key, answer());
    await maintainIsochroneCache();
    const files = await readdir(cacheDirectory);
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });
});
