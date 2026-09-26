import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheKey, maintain, readAnswer, writeAnswer } from "./cache";

/**
 * The durable answer cache.
 *
 * **The two lifetimes are proven against a controlled clock**, not by waiting:
 * inspecting the keys would prove they are stored separately and nothing about
 * when either expires, which is the whole point of having two.
 */

let dir: string;
const ENDPOINT = "https://geocoder.example/search?key=secret";
const HOUR = 60 * 60 * 1000;

const answeredAgo = (hours: number) =>
  new Date(Date.now() - hours * HOUR).toISOString();

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-geocache-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_GEOCODE_MATCH_CACHE_HOURS = "720";
  process.env.DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS = "24";
});

afterEach(async () => {
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_GEOCODE_MATCH_CACHE_HOURS;
  delete process.env.DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS;
  delete process.env.DEZFIL_GEOCODE_CACHE_MB;
  await rm(dir, { recursive: true, force: true });
});

describe("what the cache keeps and for how long", () => {
  it("answers what it was given", async () => {
    await writeAnswer(ENDPOINT, "alexanderplatz 1", {
      outcome: "matched",
      lon: 13.413,
      lat: 52.522,
      display: "Alexanderplatz, Berlin",
      attribution: "© contributors",
      answeredAt: new Date().toISOString(),
    });
    const answer = await readAnswer(ENDPOINT, "alexanderplatz 1");
    expect(answer?.outcome).toBe("matched");
    expect(answer?.lon).toBeCloseTo(13.413, 5);
    expect(answer?.display).toBe("Alexanderplatz, Berlin");
  });

  it("expires a no-match long before a match", async () => {
    // Both written as if answered 48 hours ago: past the one-day no-match
    // life, nowhere near the thirty-day match life.
    await writeAnswer(ENDPOINT, "a matched one", {
      outcome: "matched",
      lon: 1,
      lat: 2,
      answeredAt: answeredAgo(48),
    });
    await writeAnswer(ENDPOINT, "an unmatched one", {
      outcome: "no_match",
      answeredAt: answeredAgo(48),
    });

    expect(await readAnswer(ENDPOINT, "a matched one")).not.toBeNull();
    expect(await readAnswer(ENDPOINT, "an unmatched one")).toBeNull();

    // Before its life is up, the no-match answers from cache like anything else.
    await writeAnswer(ENDPOINT, "a fresh miss", {
      outcome: "no_match",
      answeredAt: answeredAgo(2),
    });
    expect(await readAnswer(ENDPOINT, "a fresh miss")).not.toBeNull();
  });

  it("removes an entry that expired where it sat, rather than ignoring it", async () => {
    // Written fresh, so the write's own maintenance keeps it; then aged in
    // place, which is what actually happens to an entry nobody reads for a
    // day. Reading it is what discovers that, and the read unlinks rather than
    // leaving a file the cache will never serve.
    const cacheDir = path.join(dir, "data", "cache", "geocode");
    await writeAnswer(ENDPOINT, "gone soon", {
      outcome: "no_match",
      answeredAt: new Date().toISOString(),
    });
    expect(
      (await readdir(cacheDir)).filter((f) => f.endsWith(".json")),
    ).toHaveLength(1);

    await writeFile(
      path.join(cacheDir, `${cacheKey(ENDPOINT, "gone soon")}.json`),
      JSON.stringify({ outcome: "no_match", answeredAt: answeredAgo(48) }),
      "utf8",
    );
    expect(await readAnswer(ENDPOINT, "gone soon")).toBeNull();
    expect(
      (await readdir(cacheDir)).filter((f) => f.endsWith(".json")),
    ).toHaveLength(0);
  });

  it("survives a half-written entry", async () => {
    // What an in-place write leaves behind when a process dies mid-write. The
    // Overpass cache writes in place and keeps such a file forever; this one
    // renames into position, and reads what it cannot parse as absent.
    await writeAnswer(ENDPOINT, "good", {
      outcome: "matched",
      lon: 1,
      lat: 2,
      answeredAt: new Date().toISOString(),
    });
    const cacheDir = path.join(dir, "data", "cache", "geocode");
    await writeFile(
      path.join(cacheDir, `${cacheKey(ENDPOINT, "torn")}.json`),
      '{"outcome":"mat',
      "utf8",
    );
    expect(await readAnswer(ENDPOINT, "torn")).toBeNull();
    expect(await readAnswer(ENDPOINT, "good")).not.toBeNull();
  });
});

describe("the key", () => {
  it("never contains the endpoint's URL", async () => {
    // The configured URL may carry a credential, and a cache file name is a
    // thing that gets listed, backed up and pasted into an issue.
    const key = cacheKey(ENDPOINT, "somewhere");
    expect(key).not.toContain("secret");
    expect(key).not.toContain("geocoder.example");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates two endpoints answering about one address", async () => {
    expect(cacheKey("https://one.example/search", "same address")).not.toBe(
      cacheKey("https://two.example/search", "same address"),
    );
  });
});

describe("the budget", () => {
  it("evicts oldest-first when the cache outgrows it", async () => {
    process.env.DEZFIL_GEOCODE_CACHE_MB = "0.001"; // ~1 KB
    for (let i = 0; i < 12; i += 1) {
      await writeAnswer(ENDPOINT, `address ${i}`, {
        outcome: "matched",
        lon: i,
        lat: i,
        display: "x".repeat(120),
        answeredAt: new Date().toISOString(),
      });
      // Distinct mtimes, so oldest-first has an order to work with.
      await new Promise((resolve) => setTimeout(resolve, 6));
    }
    await maintain();
    const files = (
      await readdir(path.join(dir, "data", "cache", "geocode"))
    ).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThan(12);
    // The newest survives; the oldest does not.
    expect(await readAnswer(ENDPOINT, "address 11")).not.toBeNull();
    expect(await readAnswer(ENDPOINT, "address 0")).toBeNull();
  }, 30_000);
});
