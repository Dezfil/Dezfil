import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { resetQueryInstance } from "@/lib/duckdb";
import { importFromUrl } from "@/lib/ingest/remote";
import { refreshTable } from "@/lib/ingest/refresh";
import { resetRefreshFences } from "@/lib/ingest/fence";
import { closeMetadataDb } from "@/lib/metadata/db";
import { getJob } from "@/lib/metadata/jobs";
import { edgesForStep } from "@/lib/metadata/lineage";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { getTableByName } from "@/lib/metadata/tables";
import { executeQuery } from "@/lib/query/execute";
import { resetIsochroneLimiter } from "@/lib/isochrone/limiter";
import { laneSettled, resetLane } from "./lane";
import { readStep } from "./recipe-view";
import { startRun } from "./run";
import { startStepRun } from "./step-execution";

/**
 * Isochrones end to end, through the real lane against a fixture provider
 * (the run-lane halves).
 *
 * Everything asserted here is asserted at the fixture or in the registry,
 * never inferred from the job's own story.
 */

let dir: string;
let server: Server;
let base: string;
/** Every isochrone request the provider saw, parsed from its json param. */
let asked: {
  locations: { lon: number; lat: number }[];
  costing: string;
  contours: { time: number }[];
  polygons: unknown;
  show_locations: unknown;
  raw: string;
  at: number;
}[];
let held: Socket[];
let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null;
/** The most isochrone exchanges open at once. */
let openNow: number;
let openMax: number;

/** Three ordinary origins; the repeat shares b's coordinates. */
const ORIGINS = () =>
  [
    "label,lon,lat",
    "a,13.4,52.5",
    "b,13.5,52.55",
    "repeat,13.5,52.55",
  ].join("\n") + "\n";

/** Three genuinely distinct origins (the rule's own fixture). */
const THREE = () =>
  [
    "label,lon,lat",
    "p,13.41,52.51",
    "q,13.42,52.52",
    "r,13.43,52.53",
  ].join("\n") + "\n";

/** Behaviour keyed by longitude: 13.9 has no route; 13.8 gets only its
 * first band; 13.7 answers a line; the empty row has no point at all. */
const OUTCOMES = () =>
  [
    "label,lon,lat",
    "ok,13.4,52.5",
    "noroute,13.9,52.5",
    "halfband,13.8,52.5",
    "line,13.7,52.5",
    "nopoint,,",
  ].join("\n") + "\n";

/** A stated square around a location, scaled a little by the band. */
function square(lon: number, lat: number, minutes: number): number[][][] {
  const r = 0.01 + minutes * 0.001;
  return [
    [
      [lon - r, lat - r],
      [lon + r, lat - r],
      [lon + r, lat + r],
      [lon - r, lat + r],
      [lon - r, lat - r],
    ],
  ];
}

function answerFor(request: (typeof asked)[number]): string {
  const origin = request.locations[0];
  const features: unknown[] = [];
  const snapped = {
    type: "Feature",
    properties: { type: "snapped" },
    geometry: {
      type: "MultiPoint",
      coordinates: [[origin.lon + 0.0004, origin.lat + 0.0004]],
    },
  };
  if (origin.lon === 13.9) {
    // No route from here: locations, but no contours.
    return JSON.stringify({ type: "FeatureCollection", features: [snapped] });
  }
  if (origin.lon === 13.7) {
    // A line contour, though polygons were mandatory.
    features.push({
      type: "Feature",
      properties: { contour: request.contours[0]?.time ?? 0 },
      geometry: {
        type: "LineString",
        coordinates: [
          [13.7, 52.5],
          [13.71, 52.51],
        ],
      },
    });
    features.push(snapped);
    return JSON.stringify({ type: "FeatureCollection", features });
  }
  const bands =
    origin.lon === 13.8 ? request.contours.slice(0, 1) : request.contours;
  for (const contour of bands) {
    features.push({
      type: "Feature",
      properties: { contour: contour.time },
      geometry: {
        type: "Polygon",
        coordinates: square(origin.lon, origin.lat, contour.time),
      },
    });
  }
  features.push(snapped);
  return JSON.stringify({ type: "FeatureCollection", features });
}

beforeEach(async () => {
  resetLane();
  resetIsochroneLimiter();
  resetRefreshFences();
  asked = [];
  held = [];
  handler = null;
  openNow = 0;
  openMax = 0;
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-iso-runs-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.DEZFIL_EGRESS_ALLOWLIST = "127.0.0.1";
  process.env.DEZFIL_ISOCHRONE_PACE_MS = "0";
  closeMetadataDb();
  resetQueryInstance();

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    if (url.pathname.endsWith(".csv")) {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end(
        url.pathname.includes("outcomes")
          ? OUTCOMES()
          : url.pathname.includes("three")
            ? THREE()
            : ORIGINS(),
      );
      return;
    }
    const raw = url.searchParams.get("json") ?? "{}";
    const parsed = JSON.parse(raw) as (typeof asked)[number];
    const request = { ...parsed, raw, at: Date.now() };
    asked.push(request);
    openNow += 1;
    openMax = Math.max(openMax, openNow);
    const done = () => {
      openNow -= 1;
    };
    if (handler) {
      res.on("close", done);
      handler(req, res);
      return;
    }
    res.on("close", done);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(answerFor(request));
  });
  server.on("connection", (socket) => {
    held.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.DEZFIL_ISOCHRONE_URL = `${base}?key=SECRETTOKEN`;
  await importFromUrl(testAccountScope(), `${base}/origins.csv`, "origins");
});

afterEach(async () => {
  resetLane();
  resetIsochroneLimiter();
  closeMetadataDb();
  resetQueryInstance();
  for (const socket of held) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_EGRESS_ALLOWLIST;
  delete process.env.DEZFIL_ISOCHRONE_URL;
  delete process.env.DEZFIL_ISOCHRONE_PACE_MS;
  delete process.env.DEZFIL_OPERATION_CONCURRENCY;
  await rm(dir, { recursive: true, force: true });
});

async function run(parameters: Record<string, unknown>) {
  const job = await startRun(testAccountScope(), { operation: "isochrone", parameters });
  await laneSettled();
  return getJob(job.id)!;
}

const good = {
  input: "origins",
  travel_mode: "driving",
  bands: [5, 10],
  name: "reachable",
};

async function stages(): Promise<string[]> {
  const entries = await readdir(path.join(dataDir(), "tables")).catch(() => []);
  return entries.filter((name) => name.startsWith("isochrone-stage-"));
}

describe("one row per origin per band", () => {
  it("answers rows x bands with the documented schema and one geometry column", async () => {
    const job = await run(good);
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");

    const columns = (
      await executeQuery("SELECT * FROM (DESCRIBE SELECT * FROM reachable)")
    ).preview.map((r) => [String(r.column_name), String(r.column_type)]);
    // The exact list: the input's non-geometry columns, then the nine —
    // and exactly one geometry column among them.
    expect(columns.map(([n]) => n)).toEqual([
      "label",
      "lon",
      "lat",
      "geom",
      "origin_lon",
      "origin_lat",
      "snapped_lon",
      "snapped_lat",
      "travel_mode",
      "band_minutes",
      "isochrone_status",
      "isochrone_source",
    ]);
    expect(
      columns.filter(([, t]) => t.toUpperCase().startsWith("GEOMETRY")),
      JSON.stringify(columns),
    ).toHaveLength(1);

    const rows = (
      await executeQuery(
        `SELECT label, band_minutes, isochrone_status, isochrone_source,
                geom IS NOT NULL AS drawn
         FROM reachable ORDER BY label, band_minutes`,
      )
    ).preview as Record<string, unknown>[];
    // Three source rows x two bands.
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.isochrone_status === "answered")).toBe(true);

    // All of one origin's bands travelled together: two distinct origins,
    // two requests — the repeated coordinate cost nothing.
    expect(asked).toHaveLength(2);
    for (const request of asked) {
      expect(request.contours).toEqual([{ time: 5 }, { time: 10 }]);
      expect(request.polygons).toBe(true);
      expect(request.show_locations).toBe(true);
      expect(request.costing).toBe("auto");
    }
  });

  it("three distinct origins are three requests, the cache empty first", async () => {
    await importFromUrl(testAccountScope(), `${base}/three.csv`, "three");
    // The cache asserted empty before the run, as the criterion demands —
    // a warm entry would make this count a cache fact, not a pacing one.
    const cacheFiles = await readdir(
      path.join(dataDir(), "cache", "isochrone"),
    ).catch(() => []);
    expect(cacheFiles).toEqual([]);
    const job = await run({ ...good, input: "three", name: "three_out" });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    expect(asked).toHaveLength(3);
  });

  it("a second run makes no provider requests at all", async () => {
    await run(good);
    const before = asked.length;
    const again = await run({ ...good, name: "reachable_again" });
    expect(again.state).toBe("succeeded");
    expect(asked.length).toBe(before);
    const sources = (
      await executeQuery(
        "SELECT DISTINCT isochrone_source FROM reachable_again",
      )
    ).preview.map((r) => r.isochrone_source);
    expect(sources).toEqual(["cache"]);
  });

  it("minutes are minutes on the literal wire (the rule's request half)", async () => {
    await run({ ...good, bands: [7, 23] });
    const raw = JSON.parse(asked[0].raw) as { contours: unknown };
    expect(raw.contours).toEqual([{ time: 7 }, { time: 23 }]);
  });
});

describe("each row outcome, on its own", () => {
  it("unreachable, absent band, unreadable and no-origin rows on one succeeding run", async () => {
    await importFromUrl(testAccountScope(), `${base}/outcomes.csv`, "outcomes");
    const job = await run({ ...good, input: "outcomes", name: "mixed" });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");

    const rows = (
      await executeQuery(
        `SELECT label, band_minutes, isochrone_status,
                geom IS NOT NULL AS drawn
         FROM mixed ORDER BY label, band_minutes`,
      )
    ).preview as Record<string, unknown>[];
    expect(rows).toHaveLength(10);
    const by = (label: string) =>
      rows.filter((r) => r.label === label).map((r) => r.isochrone_status);
    expect(by("ok")).toEqual(["answered", "answered"]);
    // No route: the provider answered, and its answer was no contours.
    expect(by("noroute")).toEqual(["unreachable", "unreachable"]);
    // The absent band is unreachable; the answered one still lands.
    expect(by("halfband")).toEqual(["answered", "unreachable"]);
    // A line where polygons were mandatory: unreadable for every band.
    expect(by("line")).toEqual(["unreadable_answer", "unreadable_answer"]);
    // No usable point: never asked about.
    expect(by("nopoint")).toEqual(["no_origin", "no_origin"]);
    expect(
      rows.every((r) => (r.isochrone_status === "answered") === (r.drawn === true)),
    ).toBe(true);
  });
});

describe("the area is the provider's (the engine half)", () => {
  it("publishes the stated square exactly, and a hole stays a hole", async () => {
    handler = (req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      const request = JSON.parse(url.searchParams.get("json") ?? "{}") as {
        locations: { lon: number; lat: number }[];
        contours: { time: number }[];
      };
      const origin = request.locations[0];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { contour: 5 },
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [13.39, 52.49],
                    [13.41, 52.49],
                    [13.41, 52.51],
                    [13.39, 52.51],
                    [13.39, 52.49],
                  ],
                  [
                    [13.398, 52.498],
                    [13.402, 52.498],
                    [13.402, 52.502],
                    [13.398, 52.502],
                    [13.398, 52.498],
                  ],
                ],
              },
            },
            {
              type: "Feature",
              properties: { type: "snapped" },
              geometry: {
                type: "MultiPoint",
                coordinates: [[origin.lon + 0.0004, origin.lat - 0.003]],
              },
            },
          ],
        }),
      );
    };
    const job = await run({
      ...good,
      bands: [5],
      name: "holed",
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const facts = (
      await executeQuery(
        `SELECT ST_AsText(geom) AS wkt,
                ST_Contains(geom, ST_Point(13.4, 52.5)) AS centre_in_hole,
                ST_Contains(geom, ST_Point(13.4, 52.503)) AS ring_body
         FROM holed WHERE label = 'a'`,
      )
    ).preview[0] as Record<string, unknown>;
    expect(String(facts.wkt)).toContain("13.39 52.49");
    // The point inside the hole is outside the published geometry, while the ring's body contains
    // an ordinary point.
    expect(facts.centre_in_hole).toBe(false);
    expect(facts.ring_body).toBe(true);
  });
});

describe("the provider's structured refusal is a row's business", () => {
  it("a 400 with the protocol's error shape reads unreachable, and the run succeeds", async () => {
    handler = (req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      const request = JSON.parse(
        url.searchParams.get("json") ?? "{}",
      ) as (typeof asked)[number];
      // The second origin is off the routing network: Valhalla answers a
      // structured 400, not a feature collection.
      if (request.locations[0].lon === 13.5) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error_code: 171,
            error: "No suitable edges near location",
            status_code: 400,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(answerFor({ ...request, raw: "", at: 0 }));
    };
    const job = await run({ ...good, name: "edged" });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");
    const rows = (
      await executeQuery(
        `SELECT label, isochrone_status FROM edged ORDER BY label, band_minutes`,
      )
    ).preview as Record<string, unknown>[];
    expect(rows.filter((r) => r.label === "a").every((r) => r.isochrone_status === "answered")).toBe(true);
    expect(rows.filter((r) => r.label === "b").every((r) => r.isochrone_status === "unreachable")).toBe(true);
    // One ask per origin — the refusal was an answer, never retried.
    expect(asked).toHaveLength(2);
  });
});

describe("an origin off the earth never leaves the house", () => {
  it("a finite but out-of-range point reads no_origin with zero requests for it", async () => {
    // A SQL step mints a point at (181, 0) — finite, legal to store,
    // nowhere on the earth.
    const mint = await startRun(testAccountScope(), {
      operation: "sql_step",
      parameters: {
        sql: `SELECT 'off' AS label, ST_Point(181, 0) AS geom`,
        name: "off_earth",
      },
    });
    await laneSettled();
    expect(getJob(mint.id)!.state).toBe("succeeded");
    asked = [];
    const job = await startRun(testAccountScope(), {
      operation: "isochrone",
      parameters: { ...good, input: "off_earth", name: "off_out" },
    });
    await laneSettled();
    const settled = getJob(job.id)!;
    expect(settled.state, settled.errorMessage ?? "").toBe("succeeded");
    const rows = (
      await executeQuery(`SELECT isochrone_status FROM off_out`)
    ).preview as Record<string, unknown>[];
    expect(rows.map((r) => r.isochrone_status)).toEqual([
      "no_origin",
      "no_origin",
    ]);
    expect(asked).toHaveLength(0);
  });
});

describe("a transport failure fails the run", () => {
  it("two attempts, a coded error carrying no URL, no output, no stage", async () => {
    handler = (_req, res) => {
      res.destroy();
    };
    const job = await run(good);
    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("isochrone_failed");
    // Exactly two attempts, counted at the fixture.
    expect(asked).toHaveLength(2);
    // No part of the configured URL — host, port or credential.
    expect(job.errorMessage ?? "").not.toContain("127.0.0.1");
    expect(job.errorMessage ?? "").not.toContain("SECRETTOKEN");
    expect(getTableByName("reachable")).toBeFalsy();
    expect(await stages()).toEqual([]);
  });

  it("a redirect failure is translated the same way", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://:bad" });
      res.end();
    };
    const job = await run(good);
    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("isochrone_failed");
    expect(job.errorMessage ?? "").not.toContain("127.0.0.1");
    expect(job.errorMessage ?? "").not.toContain("SECRETTOKEN");
  });
});

describe("one exchange at a time", () => {
  it("holds the in-flight maximum at one with the lane's concurrency raised", async () => {
    process.env.DEZFIL_OPERATION_CONCURRENCY = "2";
    resetLane();
    handler = (req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      const request = JSON.parse(url.searchParams.get("json") ?? "{}") as (typeof asked)[number];
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(answerFor({ ...request, raw: "", at: 0 }));
      }, 60);
    };
    const first = await startRun(testAccountScope(), {
      operation: "isochrone",
      parameters: { ...good, name: "lane_one" },
    });
    const second = await startRun(testAccountScope(), {
      operation: "isochrone",
      parameters: { ...good, name: "lane_two" },
    });
    await laneSettled();
    expect(getJob(first.id)!.state).toBe("succeeded");
    expect(getJob(second.id)!.state).toBe("succeeded");
    // Measured as held exchanges, not start times (the spec's own caveat).
    expect(openMax).toBe(1);
  });
});

describe("lineage is the source's, and the fence holds", () => {
  it("marks the output stale when the source refreshes, and refuses a mid-run change plainly", async () => {
    const job = await run(good);
    expect(job.state).toBe("succeeded");
    const source = getTableByName("origins")!;
    const output = getTableByName("reachable")!;
    const provenance = output.sourceParams as Record<string, unknown>;
    // The published lineage names the source table, not the stage — and
    // carries no SQL at all (J9's inheritance).
    expect(provenance.inputs).toEqual([{ id: source.id, name: source.name }]);
    expect(provenance.sql).toBeUndefined();
    expect(JSON.stringify(provenance)).not.toContain("isochrone-stage-");
  });

  it("records the edge at the source's exact artifact, and goes stale with it", async () => {
    const recipe = createRecipe(testAccountScope(), "R");
    const step = addStep(recipe.id, {
      operation: "isochrone",
      parameters: good,
    });
    const job = await startStepRun(testAccountScope(), step.id).then(async (j) => {
      await laneSettled();
      return getJob(j.id)!;
    });
    expect(job.state, job.errorMessage ?? "").toBe("succeeded");

    const before = getTableByName("origins")!.file;
    const edges = edgesForStep(step.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].boundArtifact).toBe(before);
    expect((await readStep(recipe.id, step.id)).condition.primary).toBe(
      "current",
    );

    await refreshTable(testAccountScope(), "origins");
    expect(getTableByName("origins")!.file).not.toBe(before);
    const condition = (await readStep(recipe.id, step.id)).condition;
    expect(condition.primary).toBe("stale");
    expect(condition.causes.map((c) => c.reason)).toContain("source_changed");
  });

  it("a source replaced mid-run refuses with the plain input_changed and publishes nothing", async () => {
    // The provider is held long enough for the source to change underneath
    // the run: the fence must fire at publication, with the plain code —
    // this verb carries no measurement for a projection-flavoured refusal
    // to speak about (the rule's second half).
    let release: (() => void) | null = null;
    const firstRequestSeen = new Promise<void>((resolve) => {
      handler = (req, res) => {
        const url = new URL(req.url ?? "", "http://x");
        const request = JSON.parse(
          url.searchParams.get("json") ?? "{}",
        ) as (typeof asked)[number];
        resolve();
        release = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(answerFor({ ...request, raw: "", at: 0 }));
        };
      };
    });
    const job = await startRun(testAccountScope(), {
      operation: "isochrone",
      parameters: { ...good, name: "fenced" },
    });
    await firstRequestSeen;
    // The source's generation moves while the provider is still thinking.
    await refreshTable(testAccountScope(), "origins");
    handler = null;
    release!();
    await laneSettled();
    const settled = getJob(job.id)!;
    expect(settled.state).toBe("failed");
    expect(settled.errorCode).toBe("input_changed");
    expect(getTableByName("fenced")).toBeFalsy();
    expect(await stages()).toEqual([]);
  });
});

describe("nothing leaks the endpoint's query string", () => {
  it("the disclosure is present, and the seeded key appears on no surface", async () => {
    const job = await run(good);
    expect(job.state).toBe("succeeded");
    const output = getTableByName("reachable")!;
    const provenance = JSON.stringify(output.sourceParams ?? {});
    // Present first: the disclosure carries the identity and the question.
    expect(provenance).toContain("travelMode");
    expect(provenance).toContain(`http://127.0.0.1`);
    expect(provenance).toContain('"minutes"');
    expect(provenance).toContain("departureTime");
    // Then absent: the query string, where the credential travels.
    expect(provenance).not.toContain("SECRETTOKEN");
    expect(JSON.stringify(getJob(job.id))).not.toContain("SECRETTOKEN");
    const cacheFiles = await readdir(
      path.join(dataDir(), "cache", "isochrone"),
    ).catch(() => []);
    expect(cacheFiles.length).toBeGreaterThan(0);
    expect(cacheFiles.join(" ")).not.toContain("SECRETTOKEN");
  });
});

describe("the dry run and the warning's two roads", () => {
  it("answers origins x bands with zero requests, and says the assumed CRS on both roads", async () => {
    const { compileOperation } = await import("./compile");
    const compiled = await compileOperation("isochrone", good, {
      requireName: false,
    });
    expect(compiled.preview).toMatchObject({
      rowCount: 6,
      geometryType: "POLYGON",
    });
    expect(asked).toHaveLength(0);
    // The CSV import guessed WGS84, and the verb says so on its own route —
    // it carries no measurement record to say it through (K7b).
    expect(getTableByName("origins")!.crsAssumed).toBe(true);
    expect(compiled.assumedCrs).toEqual(["origins"]);
    expect(compiled.measurement).toBeUndefined();

    // The accepting road: the run's answer carries the warning too, and the
    // disclosure records the assumption.
    const job = await run(good);
    expect(job.state).toBe("succeeded");
    const provenance = JSON.stringify(
      getTableByName("reachable")!.sourceParams ?? {},
    );
    expect(provenance).toContain('"assumedCrs":["origins"]');
  });
});
