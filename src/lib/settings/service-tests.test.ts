import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { POST } from "@/app/api/instance/services/[service]/test/route";
import { PATCH } from "@/app/api/instance/settings/route";
import { admits, admittedTools, POLICY_REFUSAL_CODE } from "@/lib/assistant/policy";
import { runAssistant, resumeAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { gateRequest } from "@/lib/auth/gate";
import { authenticateSession, createApiToken } from "@/lib/auth/credentials";
import { geocodeAddress } from "@/lib/geocode/provider";
import { resetLimiter } from "@/lib/geocode/limiter";
import { askIsochrone } from "@/lib/isochrone/provider";
import { resetIsochroneLimiter } from "@/lib/isochrone/limiter";
import { egressBlockedError } from "@/lib/net/egress";
import { keptReleaseList, resetReleaseCache } from "@/lib/overture/releases";
import { resetSecretKeyCache } from "@/lib/secrets";
import { TEST_PLACE, TEST_POINT } from "@/lib/settings/service-tests";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { testAccountScope } from "@/lib/test-support/accounts";
import { executeTool } from "@/lib/tools/execute";
import { buildTools } from "@/lib/tools/tools";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/**
 * A service's Test: one fixed request to the service at its address in
 * effect, the way the service's own requests go (the egress check with
 * redirects, the gap for the address finder and travel time), below its
 * cache. The answer is a closed shape: a pass with the time taken (Overture:
 * how many releases and the newest) or one reason from a closed list, never
 * a body, an address or a key. A second Test while one runs gets the same
 * answer from the same request; nothing is stored but the release list.
 * Admins only; the SQL and workflow assistants are never offered it, since
 * it reaches outside this server, and the embedded assistant asks first.
 */

// Every service is a loopback fixture; a request sent anywhere else fails
// its test before it leaves this machine.
keepRequestsOnThisMachine();

const ORIGIN = "http://instance.test";
const SERVICES = ["geocode", "isochrone", "overpass", "overture", "s3"] as const;
type Service = typeof SERVICES[number];
/** What the fixtures put in every body, and the key every address carries:
 * neither may reach an answer. */
const ECHO = "BODY-ECHO-0001";
const FORBIDDEN = [ECHO, "SEEDED-KEY-0001", "127.0.0.1", "/search", "/isochrone", "interpreter"];

let f: ReturnType<typeof instanceSettingsFixture>;
let fixtures: Server[] = [];
/** The requests the fixture saw: which service, when, and its path. */
let asked: { service: Service; at: number; path: string }[] = [];
let answer: (service: Service, req: IncomingMessage, res: ServerResponse) => void;
/** Every answer a Test gave in this file, searched after each test. */
let seen: unknown[] = [];

function serviceOf(pathname: string): Service {
  if (pathname.endsWith("/search")) return "geocode";
  if (pathname.endsWith("/isochrone")) return "isochrone";
  if (pathname.endsWith("/api/interpreter")) return "overpass";
  if (pathname.startsWith("/overturemaps-us-west-2/")) return "overture";
  return "s3";
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const html = (res: ServerResponse, status: number) => {
  res.writeHead(status, { "content-type": "text/html" });
  res.end(`<html><body>${ECHO}: not this service</body></html>`);
};

/** Each service's healthy answer to its Test. */
const HEALTHY: Record<Service, (req: IncomingMessage, res: ServerResponse) => void> = {
  geocode: (_req, res) => json(res, 200, [{ display_name: `${ECHO} Place`, lat: "48.8566", lon: "2.3522", licence: "Fixture" }]),
  isochrone: (req, res) => {
    const { locations: [{ lon, lat }] } = JSON.parse(new URL(req.url ?? "", "http://x").searchParams.get("json")!) as { locations: { lon: number; lat: number }[] };
    json(res, 200, { type: "FeatureCollection", features: [
      { type: "Feature", properties: { contour: 1, note: ECHO }, geometry: { type: "Polygon", coordinates: [[[lon - .01, lat - .01], [lon + .01, lat - .01], [lon + .01, lat + .01], [lon - .01, lat + .01], [lon - .01, lat - .01]]] } },
      { type: "Feature", properties: { type: "snapped" }, geometry: { type: "MultiPoint", coordinates: [[lon, lat]] } },
    ] });
  },
  overpass: (_req, res) => json(res, 200, { version: 0.6, generator: ECHO, elements: [] }),
  overture: (_req, res) => {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(`<ListBucketResult><Name>${ECHO}</Name>` + ["2026-08-20.0", "2026-09-17.0"].map(release => `<CommonPrefixes><Prefix>release/${release}/</Prefix></CommonPrefixes>`).join("") + "</ListBucketResult>");
  },
  // A healthy S3 store refuses an unsigned request at its root, in its own shape.
  s3: (_req, res) => {
    res.writeHead(403, { "content-type": "application/xml", "x-amz-request-id": ECHO });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>${ECHO}</Message></Error>`);
  },
};

beforeEach(async () => {
  f = instanceSettingsFixture();
  vi.stubEnv("DEZFIL_SECRET_KEY", "5c".repeat(32)); resetSecretKeyCache();
  vi.stubEnv("DEZFIL_GEOCODE_PACE_MS", "0"); vi.stubEnv("DEZFIL_ISOCHRONE_PACE_MS", "0");
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  resetLimiter(); resetIsochroneLimiter(); resetReleaseCache();
  asked = []; seen = [];
  answer = (service, req, res) => HEALTHY[service](req, res);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://fixture");
    const service = serviceOf(url.pathname);
    asked.push({ service, at: Date.now(), path: url.pathname });
    req.resume();
    req.on("end", () => answer(service, req, res));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  fixtures.push(server);
  point((server.address() as AddressInfo).port);
});
afterEach(async () => {
  // No answer a Test gave holds a body, an address or a key.
  const text = JSON.stringify(seen);
  for (const word of FORBIDDEN) expect(text, `an answer holds ${word}`).not.toContain(word);
  resetLimiter(); resetIsochroneLimiter(); resetReleaseCache();
  for (const server of fixtures) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  fixtures = [];
  f.close(); resetSecretKeyCache();
});

/** Every service's address in effect, through its variable, at one port. */
function point(port: number) {
  vi.stubEnv("DEZFIL_GEOCODER_URL", `http://127.0.0.1:${port}/geo-SEEDED-KEY-0001-PATH?key=SEEDED-KEY-0001-QUERY`);
  vi.stubEnv("DEZFIL_ISOCHRONE_URL", `http://127.0.0.1:${port}/iso-SEEDED-KEY-0001-PATH?key=SEEDED-KEY-0001-QUERY`);
  vi.stubEnv("DEZFIL_OVERPASS_URL", `http://127.0.0.1:${port}/osm-SEEDED-KEY-0001-PATH/api/interpreter?key=SEEDED-KEY-0001-QUERY`);
  vi.stubEnv("DEZFIL_OVERTURE_S3_ENDPOINT", `127.0.0.1:${port}`);
  vi.stubEnv("DEZFIL_S3_ENDPOINT", `http://127.0.0.1:${port}/s3-SEEDED-KEY-0001-PATH`);
}

const ADMIN = () => ({ cookie: `dezfil_session=${f.admin.secret}`, origin: ORIGIN });
function request(service: string, headers: Record<string, string> = ADMIN()) {
  return socketRequest(new Request(`${ORIGIN}/api/instance/services/${service}/test`, { method: "POST", headers }));
}
async function runTest(service: string, headers?: Record<string, string>) {
  const response = await POST(request(service, headers), { params: Promise.resolve({ service }) });
  const body = await response.json() as Record<string, unknown>;
  seen.push(body);
  return { status: response.status, cache: response.headers.get("cache-control"), body };
}
const askedOf = (service: Service) => asked.filter(entry => entry.service === service);

/** Every file in the data folder, with its content. */
function files(): Record<string, string> {
  return Object.fromEntries(readdirSync(f.dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => path.relative(f.dir, path.join(entry.parentPath, entry.name)))
    .map(file => [file, readFileSync(path.join(f.dir, file), "utf8")]).sort());
}
const stored = () => f.db.prepare("SELECT key, value FROM workspace_settings ORDER BY key").all();

describe("each Test passes against its healthy service", () => {
  it.each(SERVICES)("%s answers with the table's pass, private and no-store, after one request", async service => {
    const { status, cache, body } = await runTest(service);
    expect(status).toBe(200);
    expect(cache).toBe("private, no-store");
    expect(body).toEqual(service === "overture"
      ? { service, result: "passed", releases: 2, newest: "2026-09-17.0" }
      : { service, result: "passed", milliseconds: expect.any(Number) });
    if (service !== "overture") expect(body.milliseconds).toBeGreaterThanOrEqual(0);
    expect(askedOf(service)).toHaveLength(1);
    expect(asked).toHaveLength(1);
  });

  it("sends the fixed requests: a fixed place, the shortest band round a fixed point on foot, the smallest Overpass query, the listing, the store's root", async () => {
    const sent: Record<string, string> = {};
    answer = (service, req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      sent[service] = `${req.method} ${url.searchParams.get("q") ?? url.searchParams.get("json") ?? url.search}`;
      HEALTHY[service](req, res);
    };
    let posted = "";
    const listener = (req: IncomingMessage) => { if (req.method === "POST") req.on("data", (chunk: Buffer) => { posted += chunk.toString(); }); };
    fixtures[0].prependListener("request", listener);
    for (const service of SERVICES) await runTest(service);
    expect(sent.geocode).toBe(`GET ${TEST_PLACE}`);
    expect(JSON.parse(sent.isochrone.slice(4))).toEqual({ locations: [TEST_POINT], costing: "pedestrian", contours: [{ time: 1 }], polygons: true, show_locations: true });
    expect(sent.overpass).toBe("POST ?key=SEEDED-KEY-0001-QUERY");
    expect(decodeURIComponent(posted.replace(/^data=/, ""))).toBe("[out:json][timeout:10];out;");
    expect(sent.overture).toBe("GET ?list-type=2&prefix=release/&delimiter=/");
    expect(askedOf("s3")).toEqual([{ service: "s3", at: expect.any(Number), path: "/s3-SEEDED-KEY-0001-PATH/" }]);
    expect(sent.s3).toBe("GET ");
  });

  it("passes a travel-time service that answers no route from the point in its own words", async () => {
    answer = (_service, _req, res) => json(res, 400, { error_code: 171, error: `${ECHO} No suitable edges near location`, status_code: 400 });
    expect((await runTest("isochrone")).body).toEqual({ service: "isochrone", result: "passed", milliseconds: expect.any(Number) });
  });

  it("asks for the store's root under the S3 address's path, its query and credentials kept", async () => {
    const port = (fixtures[0].address() as AddressInfo).port;
    vi.stubEnv("DEZFIL_S3_ENDPOINT", `http://SEEDED-KEY-0001-USER:SEEDED-KEY-0001-PASS@127.0.0.1:${port}/s3-SEEDED-KEY-0001-PATH?key=SEEDED-KEY-0001-QUERY`);
    const received: { target?: string; credential?: string }[] = [];
    answer = (service, req, res) => { received.push({ target: req.url, credential: req.headers.authorization }); HEALTHY[service](req, res); };
    expect((await runTest("s3")).body).toEqual({ service: "s3", result: "passed", milliseconds: expect.any(Number) });
    expect(received).toEqual([{ target: "/s3-SEEDED-KEY-0001-PATH/?key=SEEDED-KEY-0001-QUERY",
      credential: `Basic ${Buffer.from("SEEDED-KEY-0001-USER:SEEDED-KEY-0001-PASS").toString("base64")}` }]);
  });

  it("passes a store that redirects its root in S3's own shape, and not a redirect from something else", async () => {
    answer = (_service, req, res) => {
      if (req.url === "/elsewhere") { html(res, 200); return; }
      res.writeHead(307, { location: "/elsewhere", "x-amz-request-id": ECHO });
      res.end();
    };
    expect((await runTest("s3")).body).toEqual({ service: "s3", result: "passed", milliseconds: expect.any(Number) });
    expect(asked.map(entry => entry.path)).toEqual(["/s3-SEEDED-KEY-0001-PATH/", "/elsewhere"]);
    answer = (_service, req, res) => {
      if (req.url === "/elsewhere") { html(res, 200); return; }
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    };
    expect((await runTest("s3")).body).toEqual({ service: "s3", result: "failed", reason: "unexpected_answer" });
  });

  it("uses the addresses an admin saved, and refuses at use once the check would", async () => {
    const port = (fixtures[0].address() as AddressInfo).port;
    for (const variable of ["DEZFIL_GEOCODER_URL", "DEZFIL_ISOCHRONE_URL", "DEZFIL_OVERPASS_URL", "DEZFIL_S3_ENDPOINT"]) vi.stubEnv(variable, undefined);
    const saved = await PATCH(socketRequest(new Request(`${ORIGIN}/api/instance/settings`, { method: "PATCH",
      headers: { ...ADMIN(), "content-type": "application/json" },
      body: JSON.stringify({ geocoderUrl: `http://127.0.0.1:${port}/geo-SEEDED-KEY-0001-PATH?key=SEEDED-KEY-0001-QUERY`,
        isochroneUrl: `http://127.0.0.1:${port}/iso-SEEDED-KEY-0001-PATH?key=SEEDED-KEY-0001-QUERY`,
        overpassUrl: `http://127.0.0.1:${port}/osm-SEEDED-KEY-0001-PATH/api/interpreter?key=SEEDED-KEY-0001-QUERY`,
        s3Endpoint: `http://127.0.0.1:${port}/s3-SEEDED-KEY-0001-PATH` }) })));
    expect(saved.status, await saved.clone().text()).toBe(200);
    for (const service of ["geocode", "isochrone", "overpass", "s3"] as const) {
      expect((await runTest(service)).body).toMatchObject({ service, result: "passed" });
    }
    expect(asked.map(entry => entry.path)).toEqual(["/geo-SEEDED-KEY-0001-PATH/search", "/iso-SEEDED-KEY-0001-PATH/isochrone",
      "/osm-SEEDED-KEY-0001-PATH/api/interpreter", "/s3-SEEDED-KEY-0001-PATH/"]);

    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
    for (const service of ["geocode", "isochrone", "overpass", "s3"] as const) {
      expect((await runTest(service)).body).toEqual({ service, result: "failed", reason: "refused", message: egressBlockedError().message });
    }
    expect(asked).toHaveLength(4);
  });
});

describe("each failure reason comes from its own fixture", () => {
  it("not set up: the address finder and travel time with no address, asking nothing", async () => {
    vi.stubEnv("DEZFIL_GEOCODER_URL", undefined); vi.stubEnv("DEZFIL_ISOCHRONE_URL", undefined);
    for (const service of ["geocode", "isochrone"] as const) {
      expect((await runTest(service)).body).toEqual({ service, result: "failed", reason: "not_set_up" });
    }
    expect(asked).toEqual([]);
  });

  it.each(SERVICES)("refused by the egress rules: %s gives the check's sentence and reaches nothing", async service => {
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
    expect((await runTest(service)).body).toEqual({ service, result: "failed", reason: "refused", message: egressBlockedError().message });
    expect(asked).toEqual([]);
  });

  it.each(SERVICES)("could not reach: %s at a closed port", async service => {
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", () => resolve()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    point(port);
    expect((await runTest(service)).body).toEqual({ service, result: "failed", reason: "unreachable" });
  });

  it.each(["geocode", "isochrone"] as const)("no answer within the time limit: %s at its one-second limit", async service => {
    vi.stubEnv("DEZFIL_GEOCODE_REQUEST_TIMEOUT_S", "1"); vi.stubEnv("DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S", "1");
    answer = () => { /* never answers */ };
    const started = Date.now();
    expect((await runTest(service)).body).toEqual({ service, result: "failed", reason: "timed_out" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it.each(SERVICES)("answered with a status: %s at 503, with its number and no body", async service => {
    answer = (_service, _req, res) => { res.writeHead(503, { "content-type": "text/plain" }); res.end(`${ECHO} unavailable`); };
    expect((await runTest(service)).body).toEqual({ service, result: "failed", reason: "status", status: 503 });
  });

  it("answered with a status: travel time's 400 that is not its protocol's refusal", async () => {
    answer = (_service, _req, res) => html(res, 400);
    expect((await runTest("isochrone")).body).toEqual({ service: "isochrone", result: "failed", reason: "status", status: 400 });
  });

  it.each(SERVICES)("answered, but not as the service does: %s with a page", async service => {
    answer = (_service, _req, res) => html(res, 200);
    expect((await runTest(service)).body).toEqual({ service, result: "failed", reason: "unexpected_answer" });
  });

  // Answers in the service's own format that its own reader refuses, as a
  // geocoding run, a travel-time run or an import would.
  const snapped = { type: "Feature", properties: { type: "snapped" }, geometry: { type: "MultiPoint", coordinates: [[TEST_POINT.lon, TEST_POINT.lat]] } };
  const around = (lon: number, lat: number) => [[[lon - .01, lat - .01], [lon + .01, lat - .01], [lon + .01, lat + .01], [lon - .01, lat + .01], [lon - .01, lat - .01]]];
  const MALFORMED: [Service, string, unknown][] = [
    ["geocode", "a list holding null", [null]],
    ["geocode", "a match with no coordinates", [{ display_name: `${ECHO} Place`, licence: "Fixture" }]],
    ["geocode", "a match off the globe", [{ display_name: `${ECHO} Place`, lat: "91", lon: "2.3522", licence: "Fixture" }]],
    ["isochrone", "the band's contour with no geometry", { type: "FeatureCollection", features: [{ type: "Feature", properties: { contour: 1 }, geometry: null }, snapped] }],
    ["isochrone", "the band's contour away from the point", { type: "FeatureCollection", features: [{ type: "Feature", properties: { contour: 1 }, geometry: { type: "Polygon", coordinates: around(0, 0) } }, snapped] }],
    ["isochrone", "the band's contour with an open ring", { type: "FeatureCollection", features: [{ type: "Feature", properties: { contour: 1 }, geometry: { type: "Polygon", coordinates: [around(TEST_POINT.lon, TEST_POINT.lat)[0].slice(0, 4)] } }, snapped] }],
    ["overpass", "elements holding null", { version: 0.6, generator: ECHO, elements: [null] }],
    ["overpass", "elements holding a number", { version: 0.6, generator: ECHO, elements: [1] }],
  ];
  it.each(MALFORMED)("answered, but not as the service does: %s with %s", async (service, _what, reply) => {
    answer = (_service, _req, res) => json(res, 200, reply);
    expect((await runTest(service)).body).toEqual({ service, result: "failed", reason: "unexpected_answer" });
    expect(askedOf(service)).toHaveLength(1);
  });

  it("refuses a stored address the instance's key no longer opens, reaching nothing", async () => {
    const port = (fixtures[0].address() as AddressInfo).port;
    vi.stubEnv("DEZFIL_GEOCODER_URL", undefined);
    const saved = await PATCH(socketRequest(new Request(`${ORIGIN}/api/instance/settings`, { method: "PATCH",
      headers: { ...ADMIN(), "content-type": "application/json" },
      body: JSON.stringify({ geocoderUrl: `http://127.0.0.1:${port}/geo-SEEDED-KEY-0001-PATH?key=SEEDED-KEY-0001-QUERY` }) })));
    expect(saved.status).toBe(200);
    vi.stubEnv("DEZFIL_SECRET_KEY", "6d".repeat(32)); resetSecretKeyCache();
    const { status, body } = await runTest("geocode");
    expect(status).toBe(400);
    expect(body).toEqual({ error: { code: "service_address_unreadable", message: expect.stringContaining("Address finder") } });
    expect(asked).toEqual([]);
  });

  it("answers 404 for a service it does not know, reaching nothing", async () => {
    const { status, body } = await runTest("tiles");
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: "not_found" } });
    expect(asked).toEqual([]);
  });
});

describe("the Test's road", () => {
  it("shares one in-flight request between concurrent Tests of a service", async () => {
    const held = Promise.withResolvers<void>();
    answer = (service, req, res) => { void held.promise.then(() => HEALTHY[service](req, res)); };
    const first = SERVICES.map(service => runTest(service));
    const second = SERVICES.map(service => runTest(service));
    await vi.waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(SERVICES.length));
    // Time for a second request to arrive, were one sent.
    await new Promise(resolve => setTimeout(resolve, 100));
    held.resolve();
    const answers = await Promise.all([...first, ...second]);
    for (const service of SERVICES) expect(askedOf(service), service).toHaveLength(1);
    for (const [index, service] of SERVICES.entries()) {
      expect(answers[index].body).toMatchObject({ service, result: "passed" });
      expect(answers[index + SERVICES.length].body).toEqual(answers[index].body);
    }
  });

  it("waits out the address finder's gap: a two-second gap between two Tests", async () => {
    vi.stubEnv("DEZFIL_GEOCODE_PACE_MS", "2000");
    await runTest("geocode");
    await runTest("geocode");
    const [one, two] = askedOf("geocode");
    expect(two.at - one.at).toBeGreaterThanOrEqual(1900);
  }, 10_000);

  it("reads and writes no cache and changes no setting; the Overture Test keeps the release list", async () => {
    // A cached answer for the Test's own question does not stand in for it.
    expect((await geocodeAddress(TEST_PLACE)).source).toBe("wire");
    expect((await askIsochrone(TEST_POINT, "walking", [1])).source).toBe("wire");
    mkdirSync(path.join(f.dir, "cache", "overpass"), { recursive: true });
    writeFileSync(path.join(f.dir, "cache", "overpass", "kept.json"), '{"elements":[]}');
    asked = [];
    const before = { files: files(), stored: stored() };
    expect(Object.keys(before.files).filter(file => file.startsWith("cache/"))).toHaveLength(3);
    expect(keptReleaseList()).toBeNull();

    for (const service of SERVICES) expect((await runTest(service)).body).toMatchObject({ result: "passed" });
    expect(asked.map(entry => entry.service)).toEqual([...SERVICES]);
    expect({ files: files(), stored: stored() }).toEqual(before);
    expect(keptReleaseList()).toEqual({ releases: ["2026-09-17.0", "2026-08-20.0"], listedAt: expect.any(Number) });
  });
});

describe("who may Test", () => {
  it.each(["anonymous", "member", "member-token", "cross-origin-cookie"])("refuses %s at the gate and the handler, reaching nothing", async mode => {
    const memberToken = () => createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret;
    const headers: Record<string, string> = mode === "anonymous" ? { origin: ORIGIN }
      : mode === "member" ? { cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN }
      : mode === "member-token" ? { authorization: `Bearer ${memberToken()}` }
      : { cookie: `dezfil_session=${f.admin.secret}`, origin: "https://elsewhere.test" };
    const status = mode === "anonymous" ? 401 : 403;
    const gate = gateRequest(request("overpass", headers));
    const handler = await POST(request("overpass", headers), { params: Promise.resolve({ service: "overpass" }) });
    for (const response of [gate, handler]) {
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: { code: status === 401 ? "authentication_required" : "forbidden", message: expect.any(String) } });
    }
    expect(asked).toEqual([]);
    expect(keptReleaseList()).toBeNull();
  });

  it("an admin's bearer token Tests directly", async () => {
    expect((await runTest("overpass", { authorization: `Bearer ${f.token.secret}` })).body).toMatchObject({ service: "overpass", result: "passed" });
  });
});

describe("the generated tool", () => {
  const tool = () => buildTools().find(candidate => candidate.name === "test_service")!;
  const dispatch = (secret: string) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const incoming = input instanceof Request ? input : new Request(String(input), init);
    const headers = new Headers(incoming.headers);
    headers.set("authorization", `Bearer ${secret}`);
    return dispatchAssistantTestRoute(socketRequest(new Request(incoming, { headers })));
  }) as typeof fetch;

  it("is read-only but reaches outside, confirmed, never offered to the SQL and workflow assistants, and takes only the service", async () => {
    expect(tool()).toMatchObject({ path: "/api/instance/services/{service}/test", method: "post", confirm: true,
      effects: { readOnly: true, writes: [], reachesOutside: true },
      mcp: { destructiveHint: false, openWorldHint: true },
      display: { verb: "Reached outside this server to test the {arg.service} service" } });
    expect(Object.keys(tool().inputSchema.properties)).toEqual(["service"]);
    expect(tool().description).toContain("reaches outside this server and stores nothing");
    expect(admits("read_only", tool())).toBe(false);
    // The mark alone keeps it out: unmarked and unconfirmed, it is admitted.
    expect(admits("read_only", { ...tool(), confirm: false })).toBe(false);
    expect(admits("read_only", { ...tool(), confirm: false, effects: { ...tool().effects, reachesOutside: undefined } })).toBe(true);
    expect(admittedTools("read_only")).not.toContain(tool());
    expect(admittedTools("full")).toContain(tool());

    const member = createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret;
    expect((await executeTool(tool(), { service: "overpass" }, ORIGIN, dispatch(member))).status).toBe(403);
    expect(asked).toEqual([]);
    const tested = await executeTool(tool(), { service: "overpass" }, ORIGIN, dispatch(f.token.secret));
    expect(tested.status).toBe(200);
    seen.push(tested.body);
    expect(tested.body).toMatchObject({ service: "overpass", result: "passed" });
  });

  const turn = async (context: Parameters<typeof runAssistant>[1]["context"]) => {
    const pending = new PendingActionStore();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "test-osm", name: "test_service", args: { service: "overpass" } }] },
      { text: "Done.", toolCalls: [] },
    ]);
    const sent: string[] = [];
    const deps = { scope: testAccountScope(f.db, "admin"), baseUrl: ORIGIN, pending,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const incoming = input instanceof Request ? input : new Request(String(input), init);
        sent.push(`${incoming.method} ${new URL(incoming.url).pathname}`);
        return dispatch(f.token.secret)(incoming);
      }) as typeof fetch };
    const events: AssistantEvent[] = [];
    for await (const event of runAssistant(provider, { message: "Test OpenStreetMap", history: [], ...(context ? { context } : {}) }, deps)) events.push(event);
    seen.push(events);
    return { events, sent, pending, deps };
  };

  it("is refused to the SQL and workflow assistants before any request", async () => {
    for (const context of [{ page: "sql", draft: "", selection: null, lastExecution: null }, { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }] as const) {
      const { events, sent } = await turn(context);
      expect(events.find(event => event.type === "tool_result")).toMatchObject({ tool: "test_service", ok: false, outcome: "refused",
        body: { error: { code: POLICY_REFUSAL_CODE } } });
      expect(sent.filter(call => call.includes("/api/instance/"))).toEqual([]);
    }
    expect(asked).toEqual([]);
  });

  it("is confirmed by the embedded assistant through its declared words before it reaches outside", async () => {
    const { events, sent, pending, deps } = await turn(undefined);
    const question = events.find(event => event.type === "confirm_required");
    if (question?.type !== "confirm_required") throw new Error("expected a confirmation");
    expect(question.confirmation).toEqual({ target: "Send a test request to the overpass service?",
      consequence: "This server sends one request to the service at its address in effect. Nothing is saved, except that a Test of Overture keeps the release list it finds." });
    expect(sent.filter(call => call.includes("/api/instance/"))).toEqual([]);
    expect(asked).toEqual([]);

    const parked = pending.claim(deps.scope, question.id, "approved")!;
    const done: AssistantEvent[] = [];
    for await (const event of resumeAssistant(parked, true, deps)) done.push(event);
    seen.push(done);
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "test_service", ok: true,
      body: expect.objectContaining({ service: "overpass", result: "passed" }) }));
    expect(sent).toContain("POST /api/instance/services/overpass/test");
    expect(askedOf("overpass")).toHaveLength(1);
  });
});
