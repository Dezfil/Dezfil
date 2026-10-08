import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine's own lookup, answered by a fixture resolver: one resolver
// serves the save and every use, as in the save-time check's test.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PATCH } from "@/app/api/instance/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { geocodeAddress } from "@/lib/geocode/provider";
import { resetLimiter } from "@/lib/geocode/limiter";
import { resolveRemoteSource } from "@/lib/ingest/remote";
import { askIsochrone } from "@/lib/isochrone/provider";
import { resetIsochroneLimiter } from "@/lib/isochrone/limiter";
import { egressBlockedError } from "@/lib/net/egress";
import { fetchOverpass } from "@/lib/osm/overpass";
import { resetSecretKeyCache } from "@/lib/secrets";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/**
 * A stored service address is checked again at every use, against the
 * address the request connects to. A name a fixture resolver answers
 * publicly at save and privately at use is refused with the egress refusal
 * by each of the four roads (the address finder, travel time, OpenStreetMap
 * and the S3 road for s3:// links), and nothing reaches the fixture; once
 * the allowlist names the host, the same road reaches it.
 */

// A road that went around the check, or to its public default, fails its
// test before anything leaves this machine.
keepRequestsOnThisMachine();

const PUBLIC = [{ address: "203.0.113.10", family: 4 }];
const PRIVATE = [{ address: "127.0.0.1", family: 4 }];
const HOSTS = { geocoderUrl: "geocoder.fixture.test", isochroneUrl: "router.fixture.test", overpassUrl: "overpass.fixture.test", s3Endpoint: "objects.fixture.test" };
const PATHS = { geocoderUrl: "/search", isochroneUrl: "/isochrone", overpassUrl: "/api/interpreter", s3Endpoint: "" };

const ROADS = [
  ["the address finder", "geocoderUrl", () => geocodeAddress("Alpha Street")],
  ["travel time", "isochroneUrl", () => askIsochrone({ lon: 13.4, lat: 52.5 }, "driving", [5])],
  ["OpenStreetMap", "overpassUrl", () => fetchOverpass("[out:json];node;out;")],
  ["the S3 road", "s3Endpoint", () => resolveRemoteSource("s3://bucket/points.csv")],
] as const;

let f: ReturnType<typeof instanceSettingsFixture>;
let server: Server;
let port: number;
let asked: string[];

beforeEach(async () => {
  f = instanceSettingsFixture();
  vi.stubEnv("DEZFIL_SECRET_KEY", "5b".repeat(32)); resetSecretKeyCache();
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  vi.stubEnv("DEZFIL_GEOCODE_PACE_MS", "0");
  vi.stubEnv("DEZFIL_ISOCHRONE_PACE_MS", "0");
  resetLimiter(); resetIsochroneLimiter();
  dns.lookup.mockReset();
  asked = [];
  // One fixture answers for all four services, as each would.
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://fixture");
    asked.push(`${req.headers.host?.split(":")[0]} ${url.pathname}`);
    if (url.pathname.endsWith("/search")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ display_name: "Alpha Street, Somewhere", lat: "52.5", lon: "13.4", licence: "Fixture" }]));
    } else if (url.pathname.endsWith("/isochrone")) {
      const { locations } = JSON.parse(url.searchParams.get("json") ?? "{}") as { locations: { lon: number; lat: number }[] };
      const [{ lon, lat }] = locations;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "FeatureCollection", features: [
        { type: "Feature", properties: { contour: 5 }, geometry: { type: "Polygon", coordinates: [[[lon - 0.01, lat - 0.01], [lon + 0.01, lat - 0.01], [lon + 0.01, lat + 0.01], [lon - 0.01, lat + 0.01], [lon - 0.01, lat - 0.01]]] } },
        { type: "Feature", properties: { type: "snapped" }, geometry: { type: "MultiPoint", coordinates: [[lon, lat]] } },
      ] }));
    } else if (url.pathname.endsWith("/api/interpreter")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"elements":[]}');
    } else {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end("name,lat,lon\nalpha,52.5,13.4\n");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  resetLimiter(); resetIsochroneLimiter();
  f.close(); resetSecretKeyCache();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

// The S3 address takes each object's path after its own, so it carries a
// key in its path and none in a query.
const address = (key: keyof typeof HOSTS) =>
  `http://${HOSTS[key]}:${port}/SEEDED-KEY-0001-PATH${PATHS[key]}${key === "s3Endpoint" ? "" : "?key=SEEDED-KEY-0001-QUERY"}`;

/** Saved through the page's operation, the resolver answering publicly. */
async function saveAll() {
  dns.lookup.mockResolvedValue(PUBLIC);
  const response = await PATCH(socketRequest(new Request("http://instance.test/api/instance/settings", { method: "PATCH",
    headers: { cookie: `dezfil_session=${f.admin.secret}`, origin: "http://instance.test", "content-type": "application/json" },
    body: JSON.stringify(Object.fromEntries(ROADS.map(([, key]) => [key, address(key)]))) })));
  expect(response.status, await response.clone().text()).toBe(200);
  expect(dns.lookup.mock.calls.map(([host]) => host).sort()).toEqual(Object.values(HOSTS).sort());
}

describe("a name answered publicly at save and privately at use", () => {
  it.each(ROADS)("is refused with the egress refusal by %s, reaching nothing", async (_name, key, use) => {
    await saveAll();
    dns.lookup.mockResolvedValue(PRIVATE);
    const refused = await use().then(() => null, (error: unknown) => error as { code: string; status: number; message: string });
    expect(refused).toMatchObject({ code: "egress_blocked", status: 403, message: egressBlockedError().message });
    expect(dns.lookup).toHaveBeenCalledWith(HOSTS[key], { all: true, verbatim: true });
    expect(asked).toEqual([]);
  });

  it.each(ROADS)("reaches the fixture by %s once the allowlist names the host", async (_name, key, use) => {
    await saveAll();
    dns.lookup.mockResolvedValue(PRIVATE);
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", HOSTS[key]);
    await use();
    expect(asked).toEqual([`${HOSTS[key]} /SEEDED-KEY-0001-PATH${PATHS[key]}${key === "s3Endpoint" ? "/bucket/points.csv" : ""}`]);
  });
});
