import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { resetQueryInstance } from "@/lib/duckdb";
import { importFromUrl } from "@/lib/ingest/remote";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getJob } from "@/lib/metadata/jobs";
import { resetLimiter } from "@/lib/geocode/limiter";
import { resetIsochroneLimiter } from "@/lib/isochrone/limiter";
import { writeStoredSettings } from "@/lib/settings/store";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { laneSettled, resetLane, submit } from "./lane";
import { startRun } from "./run";

/**
 * A geocoding or travel-time run keeps the gap between requests and the
 * answer time limit it was admitted with to its last request, as it keeps
 * its address: a value an admin stores while the run waits or works applies
 * to the runs admitted after it. Observed at a loopback fixture provider:
 * when each request arrived, and whether a slow answer was waited for.
 */

interface Provider { server: Server; base: string; asked: { text: string; at: number }[]; delayMs: number }

/** Each table's rows, by the name its file is served under. */
const TABLES: Record<string, string> = {
  "first-places": "label,address\na,First Street 1\nb,First Street 2\nc,First Street 3\n",
  "second-places": "label,address\na,Second Street 1\nb,Second Street 2\nc,Second Street 3\n",
  "slow-place": "label,address\na,First Lane\n",
  "other-slow-place": "label,address\na,Second Lane\n",
  "first-origins": "label,lon,lat\np,11.1,52.1\nq,11.2,52.2\nr,11.3,52.3\n",
  "second-origins": "label,lon,lat\np,12.1,52.1\nq,12.2,52.2\nr,12.3,52.3\n",
  "slow-origin": "label,lon,lat\np,11.5,52.5\n",
  "other-slow-origin": "label,lon,lat\np,12.5,52.5\n",
};

function square(lon: number, lat: number, minutes: number): number[][][] {
  const r = 0.01 + minutes * 0.001;
  return [[[lon - r, lat - r], [lon + r, lat - r], [lon + r, lat + r], [lon - r, lat + r], [lon - r, lat - r]]];
}

/** Serves the tables, answers a search with one place and a travel-time
 * request with an area round its origin, after `delayMs`. */
async function provider(): Promise<Provider> {
  const fixture = { asked: [] as Provider["asked"], delayMs: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    if (url.pathname.endsWith(".csv")) {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end(TABLES[url.pathname.slice(1, -4)]);
      return;
    }
    let body: unknown;
    if (url.pathname.endsWith("/search")) {
      fixture.asked.push({ text: `search ${url.searchParams.get("q")}`, at: Date.now() });
      body = [{ display_name: "A place, Somewhere", lat: "52.5", lon: "13.4", licence: "Fixture licence" }];
    } else {
      const request = JSON.parse(url.searchParams.get("json") ?? "{}") as { locations: { lon: number; lat: number }[]; contours: { time: number }[] };
      const origin = request.locations[0];
      fixture.asked.push({ text: `isochrone ${origin.lon},${origin.lat}`, at: Date.now() });
      body = { type: "FeatureCollection", features: [
        ...request.contours.map(contour => ({ type: "Feature", properties: { contour: contour.time },
          geometry: { type: "Polygon", coordinates: square(origin.lon, origin.lat, contour.time) } })),
        { type: "Feature", properties: { type: "snapped" }, geometry: { type: "MultiPoint", coordinates: [[origin.lon, origin.lat]] } },
      ] };
    }
    const answer = () => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (fixture.delayMs > 0) setTimeout(answer, fixture.delayMs); else answer();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  return Object.assign(fixture, { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
}

// A road that went to a public default instead of the fixture fails the
// test before anything leaves this machine.
keepRequestsOnThisMachine();

let dir: string;
let fixture: Provider;
const scope = () => testAccountScope();
const store = (patch: Record<string, number>) => writeStoredSettings(patch, metadataDb());

beforeEach(async () => {
  resetLane(); resetLimiter(); resetIsochroneLimiter();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-run-terms-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  // One run at a time, so a run admitted while the lane is held starts only
  // after the stored value has changed again.
  vi.stubEnv("DEZFIL_OPERATION_CONCURRENCY", "1");
  // No variable locks the numbers under test: the stored values apply.
  for (const name of ["DEZFIL_GEOCODE_PACE_MS", "DEZFIL_ISOCHRONE_PACE_MS", "DEZFIL_GEOCODE_REQUEST_TIMEOUT_S",
    "DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S"]) vi.stubEnv(name, undefined);
  closeMetadataDb(); resetQueryInstance();
  fixture = await provider();
  vi.stubEnv("DEZFIL_GEOCODER_URL", fixture.base);
  vi.stubEnv("DEZFIL_ISOCHRONE_URL", fixture.base);
});

afterEach(async () => {
  resetLane(); resetLimiter(); resetIsochroneLimiter();
  closeMetadataDb(); resetQueryInstance();
  fixture.server.closeAllConnections();
  await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Hold the lane's one slot, so runs are admitted and wait. */
function holdLane() {
  const held = Promise.withResolvers<void>();
  submit("held-by-the-test", () => held.promise);
  return () => held.resolve();
}

/** The gaps between the starts of the requests whose text holds `marker`. */
function gaps(marker: string): number[] {
  const starts = fixture.asked.filter(request => request.text.includes(marker)).map(request => request.at);
  expect(starts, `requests for ${marker}`).toHaveLength(3);
  return starts.slice(1).map((at, i) => at - starts[i]);
}

const SERVICES = [
  {
    service: "geocoding", operation: "geocode_addresses", gap: "geocodePaceMs", limit: "geocodeRequestTimeoutS", failure: "geocoder_failed",
    tables: { first: "first-places", second: "second-places", slow: "slow-place", otherSlow: "other-slow-place" },
    markers: { first: "search first", second: "search second" },
    parameters: (input: string) => ({ input, column: "address" }),
  },
  {
    service: "travel-time", operation: "isochrone", gap: "isochronePaceMs", limit: "isochroneRequestTimeoutS", failure: "isochrone_failed",
    tables: { first: "first-origins", second: "second-origins", slow: "slow-origin", otherSlow: "other-slow-origin" },
    markers: { first: "isochrone 11.", second: "isochrone 12." },
    parameters: (input: string) => ({ input, travel_mode: "driving", bands: [5] }),
  },
] as const;

describe.each(SERVICES)("a $service run", ({ operation, gap, limit, failure, tables, markers, parameters }) => {
  const table = (name: string) => name.replace(/-/g, "_");
  const load = async (...names: string[]) => { for (const name of names) await importFromUrl(scope(), `${fixture.base}/${name}.csv`, table(name)); };
  const run = (input: string, name: string) => startRun(scope(), { operation, parameters: { ...parameters(table(input)), name } });
  const GAP = 600;
  // The gap runs from one request's start in the app, but is read where the
  // fixture receives each request, so a request delayed on its way in
  // shortens the next gap: 58 ms on a busy hosted runner. Under half a gap,
  // so a kept gap still reads apart from the second run's none.
  const SLACK = 150;

  it("keeps the gap it was admitted with, and one admitted after takes the new gap", async () => {
    await load(tables.first, tables.second);
    store({ [gap]: GAP, [limit]: 10 });
    const release = holdLane();
    const first = await run(tables.first, "first");
    store({ [gap]: 0 });
    const second = await run(tables.second, "second");
    expect(fixture.asked).toEqual([]);
    release(); await laneSettled();
    for (const job of [first, second]) expect(getJob(job.id)!.state, getJob(job.id)!.errorMessage ?? "").toBe("succeeded");
    for (const between of gaps(markers.first)) expect(between, "the first run's requests keep its admitted gap").toBeGreaterThanOrEqual(GAP - SLACK);
    for (const between of gaps(markers.second)) expect(between, "the second run's requests take the gap stored before it").toBeLessThan(GAP / 2);
  }, 30_000);

  it("keeps the answer time limit it was admitted with, and one admitted after takes the new limit", async () => {
    await load(tables.slow, tables.otherSlow);
    // Every answer takes a second and a half: past one second, inside three.
    fixture.delayMs = 1500;
    store({ [gap]: 0, [limit]: 1 });
    const release = holdLane();
    const first = await run(tables.slow, "first");
    store({ [limit]: 3 });
    const second = await run(tables.otherSlow, "second");
    release(); await laneSettled();
    expect(getJob(first.id), "the first run waits one second for each answer, twice, and fails").toMatchObject({ state: "failed", errorCode: failure });
    expect(getJob(first.id)!.errorMessage).toContain("no answer inside the deadline");
    expect(getJob(second.id)!.state, getJob(second.id)!.errorMessage ?? "").toBe("succeeded");
    expect(fixture.asked.map(request => request.text.includes(markers.first) ? "first" : "second")).toEqual(["first", "first", "second"]);
  }, 30_000);
});
