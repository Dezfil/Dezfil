import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { GET as runRoute } from "@/app/api/operations/runs/[id]/route";
import { GET as tablesRoute } from "@/app/api/tables/route";
import { GET as tableRoute } from "@/app/api/tables/[name]/route";
import { resetQueryInstance } from "@/lib/duckdb";
import { resetLimiter } from "@/lib/geocode/limiter";
import { importFromUrl } from "@/lib/ingest/remote";
import { resetIsochroneLimiter } from "@/lib/isochrone/limiter";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getJob } from "@/lib/metadata/jobs";
import { importOsm } from "@/lib/osm/import";
import { resetSecretKeyCache } from "@/lib/secrets";
import { writeStoredSettings } from "@/lib/settings/store";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { laneSettled, resetLane } from "./lane";
import { startRun } from "./run";

/**
 * The service a provider run or an OpenStreetMap import reached is recorded
 * as scheme and host from now, and every read of a run's view or of its
 * output dataset's record gives scheme and host whenever the run was made:
 * a run and a dataset recorded before, with a key in the path, read as
 * scheme and host while their stored rows stay as they were written.
 */

// Every request here goes to a loopback fixture; one that went anywhere else
// fails its test before it leaves this machine.
keepRequestsOnThisMachine();

const SEED = "SEEDED-KEY-0001-PATH";
const ADDRESSES = "label,address\na,Alpha Street\nb,Beta Street\n";
const ORIGINS = "label,lon,lat\np,13.41,52.51\n";
const OVERPASS = { elements: [{ type: "node", id: 1, lat: 52.5, lon: 13.4, tags: { amenity: "cafe", name: "Corner" } }] };

let dir: string;
let server: Server;
let origin: string;

beforeEach(async () => {
  resetLane(); resetLimiter(); resetIsochroneLimiter();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-recorded-origin-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  vi.stubEnv("DEZFIL_GEOCODE_PACE_MS", "0");
  vi.stubEnv("DEZFIL_ISOCHRONE_PACE_MS", "0");
  for (const name of ["DEZFIL_GEOCODER_URL", "DEZFIL_ISOCHRONE_URL", "DEZFIL_OVERPASS_URL"]) vi.stubEnv(name, undefined);
  vi.stubEnv("DEZFIL_SECRET_KEY", "6a".repeat(32)); resetSecretKeyCache();
  closeMetadataDb(); resetQueryInstance();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://fixture");
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname.endsWith(".csv")) res.end(url.pathname.includes("origins") ? ORIGINS : ADDRESSES);
    else if (url.pathname.endsWith("/search")) res.end(JSON.stringify([{ display_name: "Somewhere", lat: "52.5", lon: "13.4", licence: "Fixture" }]));
    else if (url.pathname.endsWith("/api/interpreter")) res.end(JSON.stringify(OVERPASS));
    else {
      const { locations: [{ lon, lat }] } = JSON.parse(url.searchParams.get("json") ?? "{}") as { locations: { lon: number; lat: number }[] };
      res.end(JSON.stringify({ type: "FeatureCollection", features: [
        { type: "Feature", properties: { contour: 5 }, geometry: { type: "Polygon", coordinates: [[[lon - 0.01, lat - 0.01], [lon + 0.01, lat - 0.01], [lon + 0.01, lat + 0.01], [lon - 0.01, lat - 0.01]]] } },
        { type: "Feature", properties: { type: "snapped" }, geometry: { type: "MultiPoint", coordinates: [[lon, lat]] } },
      ] }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  resetLane(); resetLimiter(); resetIsochroneLimiter();
  closeMetadataDb(); resetQueryInstance();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs(); resetSecretKeyCache();
  await rm(dir, { recursive: true, force: true });
});

const scope = () => testAccountScope();
const stored = <T>(sql: string, ...args: unknown[]) => metadataDb().prepare(sql).get(...args) as T;
const storedDisclosure = (jobId: string) => JSON.parse(stored<{ disclosure: string }>("SELECT disclosure FROM operation_jobs WHERE id = ?", jobId).disclosure) as Record<string, unknown>;
const storedParams = (name: string) => JSON.parse(stored<{ source_params: string }>("SELECT source_params FROM data_tables WHERE name = ?", name).source_params) as Record<string, unknown>;

interface Recorded { name: string; sourceParams: { endpoint?: string; disclosure: { endpoint?: string } } }

/** The three reads a person or an agent has: the run's view, the dataset's
 * record, and the dataset list. */
async function reads(jobId: string | null, name: string) {
  const run = jobId === null ? null : await (await runRoute(testAccountRequest(new Request(`http://instance.test/api/operations/runs/${jobId}`)), { params: Promise.resolve({ id: jobId }) })).json();
  const table = await (await tableRoute(testAccountRequest(new Request(`http://instance.test/api/tables/${name}`)), { params: Promise.resolve({ name }) })).json();
  const list = await (await tablesRoute(testAccountRequest(new Request("http://instance.test/api/tables")))).json() as Recorded[];
  const listed = list.find(entry => entry.name === name);
  expect(listed).toBeDefined();
  return { run, table: table as Recorded, listed: listed! };
}

async function geocoded(name: string) {
  await importFromUrl(scope(), `${origin}/addresses.csv`, "addresses");
  writeStoredSettings({ geocoderUrl: `${origin}/${SEED}?key=SEEDED-KEY-0001-QUERY` }, metadataDb());
  const job = await startRun(scope(), { operation: "geocode_addresses", parameters: { input: "addresses", column: "address", name } });
  await laneSettled();
  expect(getJob(job.id)!.state, getJob(job.id)!.errorMessage ?? "").toBe("succeeded");
  return job.id;
}

async function travelled(name: string) {
  await importFromUrl(scope(), `${origin}/origins.csv`, "origins");
  writeStoredSettings({ isochroneUrl: `${origin}/${SEED}/isochrone?key=SEEDED-KEY-0001-QUERY` }, metadataDb());
  const job = await startRun(scope(), { operation: "isochrone", parameters: { input: "origins", travel_mode: "driving", bands: [5], name } });
  await laneSettled();
  expect(getJob(job.id)!.state, getJob(job.id)!.errorMessage ?? "").toBe("succeeded");
  return job.id;
}

describe("a provider run admitted from now", () => {
  it.each([["a geocoding run", geocoded], ["a travel-time run", travelled]] as const)("records its service as scheme and host: %s", async (_name, made) => {
    const jobId = await made("located");
    expect(storedDisclosure(jobId).endpoint).toBe(origin);
    expect((storedParams("located").disclosure as Record<string, unknown>).endpoint).toBe(origin);
    const { run, table, listed } = await reads(jobId, "located");
    expect(run.run.disclosure.endpoint).toBe(origin);
    expect(table.sourceParams.disclosure.endpoint).toBe(origin);
    expect(listed.sourceParams.disclosure.endpoint).toBe(origin);
    expect(JSON.stringify([run, table, listed])).not.toContain("SEEDED-KEY");
  });
});

describe("a provider run recorded before origins were", () => {
  it.each([["a geocoding run", geocoded], ["a travel-time run", travelled]] as const)("reads as scheme and host, its rows untouched: %s", async (_name, made) => {
    const jobId = await made("located");
    // The record as it was written before: host and path, the path holding a key.
    const before = `${origin}/${SEED}`;
    const disclosure = { ...storedDisclosure(jobId), endpoint: before };
    metadataDb().prepare("UPDATE operation_jobs SET disclosure = ? WHERE id = ?").run(JSON.stringify(disclosure), jobId);
    const params = storedParams("located");
    const written = JSON.stringify({ ...params, disclosure: { ...(params.disclosure as Record<string, unknown>), endpoint: before } });
    metadataDb().prepare("UPDATE data_tables SET source_params = ? WHERE name = ?").run(written, "located");

    const { run, table, listed } = await reads(jobId, "located");
    expect(run.run.disclosure.endpoint).toBe(origin);
    expect(table.sourceParams.disclosure.endpoint).toBe(origin);
    expect(listed.sourceParams.disclosure.endpoint).toBe(origin);
    expect(JSON.stringify([run, table, listed])).not.toContain(SEED);
    // Read, not rewritten.
    expect(storedDisclosure(jobId).endpoint).toBe(before);
    expect(stored<{ source_params: string }>("SELECT source_params FROM data_tables WHERE name = ?", "located").source_params).toBe(written);
  });
});

describe("an OpenStreetMap import", () => {
  async function imported() {
    writeStoredSettings({ overpassUrl: `${origin}/${SEED}/api/interpreter?key=SEEDED-KEY-0001-QUERY` }, metadataDb());
    const [created] = await importOsm(scope(), { bbox: [13.3, 52.4, 13.5, 52.6], selectors: ["amenity=cafe"], name: "cafes" });
    return created.name;
  }

  it("records the server it asked as scheme and host", async () => {
    const name = await imported();
    expect(storedParams(name).endpoint).toBe(origin);
    const { table, listed } = await reads(null, name);
    expect(table.sourceParams.endpoint).toBe(origin);
    expect(listed.sourceParams.endpoint).toBe(origin);
    expect(JSON.stringify([table, listed])).not.toContain("SEEDED-KEY");
  });

  it("reads one recorded before as scheme and host, its row untouched", async () => {
    const name = await imported();
    const written = JSON.stringify({ ...storedParams(name), endpoint: `${origin}/${SEED}/api/interpreter?key=SEEDED-KEY-0001-QUERY` });
    metadataDb().prepare("UPDATE data_tables SET source_params = ? WHERE name = ?").run(written, name);
    const { table, listed } = await reads(null, name);
    expect(table.sourceParams.endpoint).toBe(origin);
    expect(listed.sourceParams.endpoint).toBe(origin);
    expect(JSON.stringify([table, listed])).not.toContain("SEEDED-KEY");
    expect(stored<{ source_params: string }>("SELECT source_params FROM data_tables WHERE name = ?", name).source_params).toBe(written);
  });
});
