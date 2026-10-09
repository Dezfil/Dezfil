import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DELETE } from "@/app/api/instance/caches/route";
import { GET } from "@/app/api/instance/settings/route";
import { gateRequest } from "@/lib/auth/gate";
import { authenticateSession, createApiToken } from "@/lib/auth/credentials";
import { admittedTools, POLICY_REFUSAL_CODE } from "@/lib/assistant/policy";
import { runAssistant, resumeAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { geocodeAddress } from "@/lib/geocode/provider";
import { resetLimiter } from "@/lib/geocode/limiter";
import { askIsochrone } from "@/lib/isochrone/provider";
import { resetIsochroneLimiter } from "@/lib/isochrone/limiter";
import { listOvertureReleases, resetReleaseCache } from "@/lib/overture/releases";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { testAccountScope } from "@/lib/test-support/accounts";
import { executeTool } from "@/lib/tools/execute";
import { buildTools } from "@/lib/tools/tools";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";

/**
 * The services' caches as the configuration read reports them, and the Clear
 * that empties one or all three: through the purge's generation fence, so an
 * answer whose request began before the Clear is not kept, while a request to
 * another service keeps its answer; every file outside the cleared cache is
 * left as it was. Admins only, on every road; the SQL and workflow assistants
 * are never offered it and the embedded assistant asks first.
 */

// The providers and the release mirror are loopback fixtures; a request
// sent anywhere else fails its test before it leaves this machine.
keepRequestsOnThisMachine();

const ORIGIN = "http://instance.test";
/** Files a data folder holds, by path inside it, each with its content. */
const SEEDED: Record<string, string> = {
  "cache/geocode/a1.json": JSON.stringify({ outcome: "no_match", answeredAt: "2026-10-01T00:00:00.000Z" }),
  "cache/geocode/a2.json": "g".repeat(300),
  "cache/geocode/.a3.landing.tmp": "a write still landing",
  "cache/isochrone/b1.json": "i".repeat(1200),
  "cache/overpass/c1.json": "o".repeat(5000),
  "cache/overpass/c2.json": "{}",
  "cache/basemaps/kept.json": "not a provider's cache",
  "tables/places.parquet": "PAR1 places PAR1",
  "settings-note.txt": "an operator's own file",
};

let f: ReturnType<typeof instanceSettingsFixture>;
let fixtures: Server[] = [];

beforeEach(() => {
  f = instanceSettingsFixture();
  resetLimiter(); resetIsochroneLimiter(); resetReleaseCache();
});
afterEach(async () => {
  resetLimiter(); resetIsochroneLimiter(); resetReleaseCache();
  for (const server of fixtures) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  fixtures = [];
  f.close();
});

function seed() {
  for (const [file, content] of Object.entries(SEEDED)) {
    mkdirSync(path.dirname(path.join(f.dir, file)), { recursive: true });
    writeFileSync(path.join(f.dir, file), content);
  }
}

/** Every file in the data folder, with its content. */
function files(): Record<string, string> {
  return Object.fromEntries(readdirSync(f.dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => path.relative(f.dir, path.join(entry.parentPath, entry.name)))
    .map(file => [file, readFileSync(path.join(f.dir, file), "utf8")]).sort());
}
const without = (all: Record<string, string>, ...folders: string[]) =>
  Object.fromEntries(Object.entries(all).filter(([file]) => !folders.some(folder => file.startsWith(`cache/${folder}/`))));
const answers = (cache: string) => Object.keys(files()).filter(file => file.startsWith(`cache/${cache}/`) && file.endsWith(".json"));

function request(query = "", headers: Record<string, string> = { cookie: `dezfil_session=${f.admin.secret}`, origin: ORIGIN }, method = "DELETE", pathname = "/api/instance/caches") {
  return socketRequest(new Request(`${ORIGIN}${pathname}${query}`, { method, headers }));
}

async function read() {
  const response = await GET(request("", { authorization: `Bearer ${f.token.secret}` }, "GET", "/api/instance/settings"));
  expect(response.status).toBe(200);
  return (await response.json()) as { services: Record<string, unknown> };
}

describe("the configuration read", () => {
  it("reports each cache's bytes, answers and budget in MB, and the release list kept, or not yet", async () => {
    vi.stubEnv("DEZFIL_GEOCODE_CACHE_MB", "32");
    vi.stubEnv("DEZFIL_ISOCHRONE_CACHE_MB", "16");
    vi.stubEnv("DEZFIL_OVERPASS_CACHE_MB", "512");
    seed();
    expect((await read()).services).toEqual({
      // The landing write is not an answer yet.
      geocode: { bytes: SEEDED["cache/geocode/a1.json"].length + 300, answers: 2, budgetMb: 32 },
      isochrone: { bytes: 1200, answers: 1, budgetMb: 16 },
      overpass: { bytes: 5002, answers: 2, budgetMb: 512 },
      overture: { listed: false },
    });

    // A listing the pane made is the list kept.
    const mirror = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(["2026-08-20.0", "2026-09-17.0"].map(release => `<CommonPrefixes><Prefix>release/${release}/</Prefix></CommonPrefixes>`).join(""));
    });
    await new Promise<void>(resolve => mirror.listen(0, "127.0.0.1", () => resolve()));
    fixtures.push(mirror);
    vi.stubEnv("DEZFIL_OVERTURE_S3_ENDPOINT", `127.0.0.1:${(mirror.address() as AddressInfo).port}`);
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
    const before = Date.now();
    await listOvertureReleases();
    const { overture } = (await read()).services as { overture: { listedAt: string } };
    expect(overture).toEqual({ listed: true, releases: 2, newest: "2026-09-17.0", listedAt: expect.any(String) });
    expect(Date.parse(overture.listedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(overture.listedAt)).toBeLessThanOrEqual(Date.now());
  });
});

describe("Clear", () => {
  it("empties exactly the named cache, then all three, every other file intact", async () => {
    seed();
    const before = files();
    const one = await DELETE(request("?service=geocode"));
    expect(one.status).toBe(200);
    expect(one.headers.get("cache-control")).toBe("private, no-store");
    expect(await one.json()).toEqual({ cleared: ["geocode"] });
    expect(files()).toEqual(without(before, "geocode"));

    const all = await DELETE(request());
    expect(await all.json()).toEqual({ cleared: ["geocode", "isochrone", "overpass"] });
    expect(files()).toEqual(without(before, "geocode", "isochrone", "overpass"));
    expect(files()).toEqual({ "cache/basemaps/kept.json": SEEDED["cache/basemaps/kept.json"],
      "settings-note.txt": SEEDED["settings-note.txt"], "tables/places.parquet": SEEDED["tables/places.parquet"] });
    expect((await read()).services).toMatchObject({ geocode: { bytes: 0, answers: 0 }, isochrone: { bytes: 0, answers: 0 }, overpass: { bytes: 0, answers: 0 } });

    // An empty cache clears the same.
    expect(await (await DELETE(request("?service=overpass"))).json()).toEqual({ cleared: ["overpass"] });
  });

  it.each(["?service=tiles", "?service=geocode&service=isochrone", "?cache=geocode"])("refuses %s, clearing nothing", async query => {
    seed();
    const before = files();
    const response = await DELETE(request(query));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(files()).toEqual(before);
  });

  it("keeps no answer whose request began before the Clear of its cache, and keeps another cache's", async () => {
    // A provider that holds every answer until the test lets it go.
    const held = Promise.withResolvers<void>();
    let asked = 0;
    const out = Promise.withResolvers<void>();
    const provider = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      if (++asked === 2) out.resolve();
      void held.promise.then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        if (url.pathname.endsWith("/search")) { res.end(JSON.stringify([{ display_name: "Fence Street", lat: "52.5", lon: "13.4", licence: "Fixture" }])); return; }
        const { locations: [{ lon, lat }] } = JSON.parse(url.searchParams.get("json")!) as { locations: { lon: number; lat: number }[] };
        res.end(JSON.stringify({ type: "FeatureCollection", features: [
          { type: "Feature", properties: { contour: 5 }, geometry: { type: "Polygon", coordinates: [[[lon - .01, lat - .01], [lon + .01, lat - .01], [lon + .01, lat + .01], [lon - .01, lat + .01], [lon - .01, lat - .01]]] } },
          { type: "Feature", properties: { type: "snapped" }, geometry: { type: "MultiPoint", coordinates: [[lon, lat]] } },
        ] }));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", () => resolve()));
    fixtures.push(provider);
    const base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    vi.stubEnv("DEZFIL_GEOCODER_URL", base); vi.stubEnv("DEZFIL_ISOCHRONE_URL", base);
    vi.stubEnv("DEZFIL_GEOCODE_PACE_MS", "0"); vi.stubEnv("DEZFIL_ISOCHRONE_PACE_MS", "0");
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");

    const address = geocodeAddress("1 Fence Street");
    const area = askIsochrone({ lon: 13.4, lat: 52.5 }, "driving", [5]);
    await out.promise; // both requests are out, neither answered
    expect(await (await DELETE(request("?service=geocode"))).json()).toEqual({ cleared: ["geocode"] });
    held.resolve();
    expect((await address).source).toBe("wire");
    expect((await area).source).toBe("wire");
    expect(answers("geocode"), "an answer whose request began before the Clear is not kept").toEqual([]);
    expect(answers("isochrone"), "another cache's answer is kept").toHaveLength(1);

    // Asked again: the address goes to its provider, the area is cached.
    expect((await geocodeAddress("1 Fence Street")).source).toBe("wire");
    expect((await askIsochrone({ lon: 13.4, lat: 52.5 }, "driving", [5])).source).toBe("cache");
    expect(answers("geocode")).toHaveLength(1);
    expect(asked).toBe(3);
  });
});

describe("who may Clear", () => {
  it.each(["anonymous", "member", "member-token", "cross-origin-cookie"])("refuses %s, at the gate and the handler, changing and reading nothing", async mode => {
    seed();
    const before = files();
    const memberToken = () => createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret;
    const headers: Record<string, string> = mode === "anonymous" ? { origin: ORIGIN }
      : mode === "member" ? { cookie: `dezfil_session=${f.member.secret}`, origin: ORIGIN }
      : mode === "member-token" ? { authorization: `Bearer ${memberToken()}` }
      : { cookie: `dezfil_session=${f.admin.secret}`, origin: "https://elsewhere.test" };
    const status = mode === "anonymous" ? 401 : 403;
    for (const response of [gateRequest(request("?service=geocode", headers)), await DELETE(request("?service=geocode", headers))]) {
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: { code: status === 401 ? "authentication_required" : "forbidden", message: expect.any(String) } });
    }
    if (mode !== "cross-origin-cookie") {
      // Nor do they read what the caches hold.
      const reading = await GET(request("", headers, "GET", "/api/instance/settings"));
      expect(reading.status).toBe(status);
      expect(Object.keys(await reading.json())).toEqual(["error"]);
    }
    expect(files()).toEqual(before);
  });
});

describe("the generated tool", () => {
  const tool = () => buildTools().find(candidate => candidate.name === "clear_service_caches")!;
  const dispatch = (secret: string) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const incoming = input instanceof Request ? input : new Request(String(input), init);
    const headers = new Headers(incoming.headers);
    headers.set("authorization", `Bearer ${secret}`);
    return dispatchAssistantTestRoute(socketRequest(new Request(incoming, { headers })));
  }) as typeof fetch;

  it("is a confirmed write on the caches, never offered to the SQL and workflow assistants, and clears for an admin alone", async () => {
    expect(tool()).toMatchObject({ path: "/api/instance/caches", method: "delete", confirm: true,
      effects: { readOnly: false, writes: [{ resource: "caches", collection: true }] },
      mcp: { destructiveHint: true, openWorldHint: false, idempotentHint: true } });
    expect(tool().description).toContain("Removes cached answers only");
    expect(tool().confirmation?.consequence).toContain("removes cached answers only");
    expect(admittedTools("read_only")).not.toContain(tool());
    expect(admittedTools("full")).toContain(tool());

    seed();
    const before = files();
    const member = createApiToken(authenticateSession(f.member.secret, f.db)!, "Member", f.db).secret;
    const refused = await executeTool(tool(), { service: "overpass" }, ORIGIN, dispatch(member));
    expect(refused.status).toBe(403);
    expect(files()).toEqual(before);
    const unknown = await executeTool(tool(), { service: "tiles" }, ORIGIN, dispatch(f.token.secret));
    expect(unknown.status).toBe(400);
    expect(files()).toEqual(before);
    const cleared = await executeTool(tool(), { service: "overpass" }, ORIGIN, dispatch(f.token.secret));
    expect(cleared.status).toBe(200);
    expect(files()).toEqual(without(before, "overpass"));
  });

  const turn = async (context: Parameters<typeof runAssistant>[1]["context"]) => {
    const pending = new PendingActionStore();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "clear-all", name: "clear_service_caches", args: {} }] },
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
    for await (const event of runAssistant(provider, { message: "Clear the caches", history: [], ...(context ? { context } : {}) }, deps)) events.push(event);
    return { events, sent, pending, deps };
  };

  it("is refused to the SQL and workflow assistants before any request", async () => {
    seed();
    const before = files();
    for (const context of [{ page: "sql", draft: "", selection: null, lastExecution: null }, { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }] as const) {
      const { events, sent } = await turn(context);
      expect(events.find(event => event.type === "tool_result")).toMatchObject({ tool: "clear_service_caches", ok: false, outcome: "refused",
        body: { error: { code: POLICY_REFUSAL_CODE } } });
      expect(sent.filter(call => call.includes("/api/instance/"))).toEqual([]);
    }
    expect(files()).toEqual(before);
  });

  it("is confirmed by the embedded assistant before it clears", async () => {
    seed();
    const before = files();
    const { events, sent, pending, deps } = await turn(undefined);
    const question = events.find(event => event.type === "confirm_required");
    if (question?.type !== "confirm_required") throw new Error("expected a confirmation");
    expect(question.confirmation).toMatchObject({ target: "Clear cached service answers?" });
    expect(sent.filter(call => call.includes("/api/instance/"))).toEqual([]);
    expect(files()).toEqual(before);

    const parked = pending.claim(deps.scope, question.id, "approved")!;
    const done: AssistantEvent[] = [];
    for await (const event of resumeAssistant(parked, true, deps)) done.push(event);
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "clear_service_caches", ok: true }));
    expect(sent).toContain("DELETE /api/instance/caches");
    expect(files()).toEqual(without(before, "geocode", "isochrone", "overpass"));
  });
});
