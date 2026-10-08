import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { resetQueryInstance } from "@/lib/duckdb";
import { importFromUrl, parseRemoteUrl, resolveRemoteSource, translateObjectUrl } from "@/lib/ingest/remote";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getJob } from "@/lib/metadata/jobs";
import { executeQuery } from "@/lib/query/execute";
import { resetLimiter } from "@/lib/geocode/limiter";
import { resetIsochroneLimiter } from "@/lib/isochrone/limiter";
import { fetchOverpass } from "@/lib/osm/overpass";
import { searchPlaces } from "@/lib/search/provider";
import { resetSecretKeyCache } from "@/lib/secrets";
import { writeStoredSettings } from "@/lib/settings/store";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { expectSettingRemedy } from "../../../test-support/setting-remedy";
import { withAvailability } from "./capability";
import { compileOperation } from "./compile";
import { OPERATIONS } from "./catalog";
import { laneSettled, resetLane, submit } from "./lane";
import { startRun } from "./run";

/**
 * The geocoder and travel time read their address through the settings'
 * resolver, and a run keeps the address it was admitted with to its end:
 * every answer of a run admitted before an address change comes from the
 * first provider, every answer of one admitted after from the second, and
 * neither is served the other's cached answers. Asserted at the fixtures.
 */

interface Provider { server: Server; base: string; asked: string[] }
const SNAP: Record<string, number> = { A: 0.0004, B: 0.0008 };

const ADDRESSES = "label,address\na,Alpha Street\nb,Beta Street\nrepeat,Alpha Street\nc,Gamma Street\n";
const ORIGINS = "label,lon,lat\np,13.41,52.51\nq,13.42,52.52\n";

function square(lon: number, lat: number, minutes: number): number[][][] {
  const r = 0.01 + minutes * 0.001;
  return [[[lon - r, lat - r], [lon + r, lat - r], [lon + r, lat + r], [lon - r, lat + r], [lon - r, lat - r]]];
}

/** One fixture provider: geocoding answers name it, travel-time answers
 * snap by its own offset, and it serves the source files. */
async function provider(name: "A" | "B"): Promise<Provider> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    if (url.pathname.endsWith(".csv")) {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end(url.pathname.includes("origins") ? ORIGINS : ADDRESSES);
      return;
    }
    if (url.pathname.endsWith("/search")) {
      asked.push(`search ${url.searchParams.get("q")}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ display_name: `Provider ${name}, Somewhere`, lat: "52.5", lon: "13.4", licence: `Licence ${name}` }]));
      return;
    }
    const request = JSON.parse(url.searchParams.get("json") ?? "{}") as { locations: { lon: number; lat: number }[]; contours: { time: number }[] };
    const origin = request.locations[0];
    asked.push(`isochrone ${origin.lon},${origin.lat}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "FeatureCollection", features: [
      ...request.contours.map(contour => ({ type: "Feature", properties: { contour: contour.time },
        geometry: { type: "Polygon", coordinates: square(origin.lon, origin.lat, contour.time) } })),
      { type: "Feature", properties: { type: "snapped" },
        geometry: { type: "MultiPoint", coordinates: [[origin.lon + SNAP[name], origin.lat + SNAP[name]]] } },
    ] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

// A road that went to its public default instead of a fixture fails the
// test before anything leaves this machine.
keepRequestsOnThisMachine();

let dir: string;
let a: Provider, b: Provider;
const scope = () => testAccountScope();
const store = (patch: Record<string, string | null>) => writeStoredSettings(patch, metadataDb());

beforeEach(async () => {
  resetLane(); resetLimiter(); resetIsochroneLimiter();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-address-runs-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  vi.stubEnv("DEZFIL_GEOCODE_PACE_MS", "0");
  vi.stubEnv("DEZFIL_ISOCHRONE_PACE_MS", "0");
  // One run at a time, so a run admitted while the lane is held starts only
  // after the address has changed.
  vi.stubEnv("DEZFIL_OPERATION_CONCURRENCY", "1");
  for (const name of ["DEZFIL_GEOCODER_URL", "DEZFIL_ISOCHRONE_URL", "DEZFIL_OVERPASS_URL", "DEZFIL_S3_ENDPOINT"]) vi.stubEnv(name, undefined);
  vi.stubEnv("DEZFIL_SECRET_KEY", "4d".repeat(32)); resetSecretKeyCache();
  closeMetadataDb(); resetQueryInstance();
  [a, b] = [await provider("A"), await provider("B")];
});

afterEach(async () => {
  resetLane(); resetLimiter(); resetIsochroneLimiter();
  closeMetadataDb(); resetQueryInstance();
  for (const fixture of [a, b]) await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  vi.unstubAllEnvs(); vi.restoreAllMocks(); resetSecretKeyCache();
  await rm(dir, { recursive: true, force: true });
});

/** Hold the lane's one slot, so runs are admitted and wait. */
function holdLane() {
  const held = Promise.withResolvers<void>();
  submit("held-by-the-test", () => held.promise);
  return () => held.resolve();
}

async function rows(table: string, columns: string) {
  return (await executeQuery(scope(), `SELECT ${columns} FROM ${table} ORDER BY label`)).preview as Record<string, unknown>[];
}

describe("a geocoding run", () => {
  const run = (name: string) => startRun(scope(), { operation: "geocode_addresses", parameters: { input: "addresses", column: "address", name } });
  const DISTINCT = ["search alpha street", "search beta street", "search gamma street"];
  const answers = async (table: string) => (await rows(table, "label, geocode_match, geocode_source"))
    .map(row => [row.geocode_match, row.geocode_source]);

  it("keeps the address it was admitted with, and no answer crosses between addresses", async () => {
    await importFromUrl(scope(), `${a.base}/addresses.csv`, "addresses");
    store({ geocoderUrl: `${a.base}/?key=SEEDED-KEY-0001-QUERY` });
    const release = holdLane();
    const first = await run("first");
    store({ geocoderUrl: `${b.base}/?key=SEEDED-KEY-0002-QUERY` });
    const second = await run("second");
    expect([a.asked, b.asked]).toEqual([[], []]);
    release(); await laneSettled();
    for (const job of [first, second]) expect(getJob(job.id)!.state, getJob(job.id)!.errorMessage ?? "").toBe("succeeded");
    // Each provider was asked every distinct address once: the run admitted
    // under A asked only A, and the run admitted under B was not served A's answers.
    expect(a.asked.sort()).toEqual(DISTINCT);
    expect(b.asked.sort()).toEqual(DISTINCT);
    expect(await answers("first")).toEqual(Array(4).fill(["Provider A, Somewhere", "wire"]));
    expect(await answers("second")).toEqual(Array(4).fill(["Provider B, Somewhere", "wire"]));

    // Admitted under B again: B's own cache, nobody asked.
    await run("third"); await laneSettled();
    expect(await answers("third")).toEqual(Array(4).fill(["Provider B, Somewhere", "cache"]));
    // And under A: A's cache, never B's.
    store({ geocoderUrl: `${a.base}/?key=SEEDED-KEY-0001-QUERY` });
    await run("fourth"); await laneSettled();
    expect(await answers("fourth")).toEqual(Array(4).fill(["Provider A, Somewhere", "cache"]));
    expect([a.asked.length, b.asked.length]).toEqual([3, 3]);
  });

  it("is refused at admission when the stored address cannot be read, reaching no provider", async () => {
    await importFromUrl(scope(), `${a.base}/addresses.csv`, "addresses");
    store({ geocoderUrl: `${a.base}/?key=SEEDED-KEY-0001-QUERY` });
    vi.stubEnv("DEZFIL_SECRET_KEY", "5e".repeat(32)); resetSecretKeyCache();
    await expect(run("refused")).rejects.toMatchObject({ code: "service_address_unreadable", status: 400 });
    await laneSettled();
    expect(a.asked).toEqual([]);
    // Place search answers with the same sentence, and asks nobody either.
    const places = await searchPlaces("alpha street");
    expect(places).toMatchObject({ state: "failed", message: expect.stringContaining('The saved address for "Address finder" cannot be read') });
    expect(JSON.stringify(places)).not.toContain("SEEDED-KEY");
    expect(a.asked).toEqual([]);
  });
});

describe("a travel-time run", () => {
  const run = (name: string) => startRun(scope(), { operation: "isochrone",
    parameters: { input: "origins", travel_mode: "driving", bands: [5, 10], name } });
  const DISTINCT = ["isochrone 13.41,52.51", "isochrone 13.42,52.52"];
  const snapped = async (table: string) => (await rows(table, "label, band_minutes, snapped_lon, isochrone_source"))
    .map(row => [Number((Number(row.snapped_lon) - (row.label === "p" ? 13.41 : 13.42)).toFixed(4)), row.isochrone_source]);

  it("keeps the address it was admitted with, and no answer crosses between addresses", async () => {
    await importFromUrl(scope(), `${a.base}/origins.csv`, "origins");
    store({ isochroneUrl: `${a.base}/?key=SEEDED-KEY-0001-QUERY` });
    const release = holdLane();
    const first = await run("first");
    store({ isochroneUrl: `${b.base}/?key=SEEDED-KEY-0002-QUERY` });
    const second = await run("second");
    release(); await laneSettled();
    for (const job of [first, second]) expect(getJob(job.id)!.state, getJob(job.id)!.errorMessage ?? "").toBe("succeeded");
    expect(a.asked.sort()).toEqual(DISTINCT);
    expect(b.asked.sort()).toEqual(DISTINCT);
    expect(await snapped("first")).toEqual(Array(4).fill([SNAP.A, "wire"]));
    expect(await snapped("second")).toEqual(Array(4).fill([SNAP.B, "wire"]));
    await run("third"); await laneSettled();
    expect(await snapped("third")).toEqual(Array(4).fill([SNAP.B, "cache"]));
    expect([a.asked.length, b.asked.length]).toEqual([2, 2]);
  });
});

describe("a refusal that says where to set an address", () => {
  const compile = (operation: string, params: Record<string, unknown>) => compileOperation(scope(), operation, params, { requireName: false });

  it.each([false, true])("names the setting while no variable locks it, and the variable and a restart while one does (locked=%s)", async locked => {
    if (locked) { vi.stubEnv("DEZFIL_GEOCODER_URL", "  "); vi.stubEnv("DEZFIL_ISOCHRONE_URL", "  "); }
    await importFromUrl(scope(), `${a.base}/addresses.csv`, "addresses");
    await importFromUrl(scope(), `${a.base}/origins.csv`, "origins");
    for (const [operation, params, label, variable, code] of [
      ["geocode_addresses", { input: "addresses", column: "address" }, "Address finder", "DEZFIL_GEOCODER_URL", "geocoder_unconfigured"],
      ["isochrone", { input: "origins", travel_mode: "driving", bands: [5] }, "Travel-time endpoint", "DEZFIL_ISOCHRONE_URL", "isochrone_unconfigured"],
    ] as const) {
      let refusal: unknown;
      try { await compile(operation, params); } catch (error) { refusal = error; }
      expect(refusal).toMatchObject({ code, status: 400 });
      expectSettingRemedy((refusal as Error).message, label, variable, locked);
      const reason = withAvailability(OPERATIONS.filter(o => o.id === operation))[0].availability!.reason!;
      expectSettingRemedy(reason, label, variable, locked);
    }
  });

  it.each([false, true])("is said by OpenStreetMap's rate limit as by the others (locked=%s)", async locked => {
    const limited = createServer((_req, res) => { res.writeHead(429); res.end(); });
    await new Promise<void>(resolve => limited.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/SEEDED-KEY-0001-PATH?key=SEEDED-KEY-0001-QUERY`;
      if (locked) vi.stubEnv("DEZFIL_OVERPASS_URL", address); else store({ overpassUrl: address });
      let refusal: unknown;
      try { await fetchOverpass("[out:json];node;out;"); } catch (error) { refusal = error; }
      expect(refusal).toMatchObject({ code: "rate_limited", status: 429 });
      expectSettingRemedy((refusal as Error).message, "Overpass endpoint", "DEZFIL_OVERPASS_URL", locked);
      expect((refusal as Error).message).toContain(`The Overpass endpoint http://127.0.0.1:${(limited.address() as AddressInfo).port} rate-limited`);
      expect((refusal as Error).message).not.toContain("SEEDED-KEY");
    } finally { await new Promise<void>(resolve => limited.close(() => resolve())); }
  });
});

describe("a stored address the instance's key no longer opens", () => {
  it("refuses OpenStreetMap and cloud storage alike, never reaching the public server or Amazon's", async () => {
    store({ overpassUrl: `${a.base}/api/interpreter?key=SEEDED-KEY-0001-QUERY`, s3Endpoint: `${a.base}/?key=SEEDED-KEY-0001-QUERY` });
    vi.stubEnv("DEZFIL_SECRET_KEY", "6f".repeat(32)); resetSecretKeyCache();
    for (const [attempt, label] of [
      [() => fetchOverpass("[out:json];way;out;"), "Overpass endpoint"],
      [() => resolveRemoteSource("s3://bucket/dir/points.csv"), "S3 endpoint"],
    ] as const) {
      let refusal: unknown;
      try { await attempt(); } catch (error) { refusal = error; }
      expect(refusal).toMatchObject({ code: "service_address_unreadable", status: 400 });
      expect((refusal as Error).message).toContain(`"${label}"`);
      expect((refusal as Error).message).not.toContain("SEEDED-KEY");
    }
    expect(a.asked).toEqual([]);
    // A gs:// link never reads the S3 address, so it is not refused for it.
    expect(translateObjectUrl(parseRemoteUrl("gs://open-data/f.csv"))).toBe("https://storage.googleapis.com/open-data/f.csv");
  });
});
