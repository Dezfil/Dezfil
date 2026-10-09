import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { format } from "node:util";
import type { InstanceRead } from "@/components/settings/instance-read";
import { settingsDeclarations } from "@/components/settings/settings-index";
import { buildSearchIndex } from "@/components/settings/settings-search";
import { runAssistant, resumeAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import { PendingActionStore } from "@/lib/assistant/pending";
import { stubProvider } from "@/lib/assistant/providers/stub";
import { runStream } from "@/lib/assistant/run-stream";
import { assistantRuns } from "@/lib/assistant/runs";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { resetQueryInstance } from "@/lib/duckdb";
import { resetLimiter } from "@/lib/geocode/limiter";
import { resetIsochroneLimiter } from "@/lib/isochrone/limiter";
import type { Account } from "@/lib/metadata/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { resetReleaseCache } from "@/lib/overture/releases";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { keepRequestsOnThisMachine } from "@/lib/test-support/outside-requests";
import { executeTool } from "@/lib/tools/execute";
import { buildTools } from "@/lib/tools/tools";
import { secretForms } from "./address-secrets";
import { SETTING_CATALOGUE } from "./catalogue";

/**
 * The secrecy battery. A service address may carry a key in its user
 * information, its path and its query. Here one is set from the page, by
 * the variable, through the generated tool and through the embedded
 * assistant, and then searched for in everything the server says or keeps
 * afterwards: every read, change answer and refusal, the assistant's
 * confirmation, events, pending receipt and stored record (a call giving
 * an address as a list or an object, and its refusal, among them), the Test answers
 * and Clear's, the settings search's index, OpenStreetMap's and cloud
 * storage's refusals (a page not found and an error remark that repeat
 * the request among them), the answer, view and record of each geocoding and
 * travel-time run admitted after the save (a failed one's too), every log
 * line the server writes while the battery runs, and at the end every file
 * in the data folder, the metadata database first. Where the surface names
 * the service, it still gives its scheme and host. A run and its dataset,
 * and an OpenStreetMap import, recorded before the server recorded origins
 * read as scheme and host too, while their rows stay as written.
 *
 * The search knows a key as written, percent-encoded, in base64 and
 * base64url, in hex and in UTF-16, and the user information also as the
 * pair a Basic credential encodes.
 *
 * The steps run in order on one instance, one data folder and one set of
 * console sinks: each searches what it made, and the last two search what
 * the whole run wrote.
 */

// Every service is a loopback fixture; a request sent anywhere else fails
// its step before it leaves this machine.
keepRequestsOnThisMachine();

type Seeds = readonly [user: string, path: string, query: string];
/** The keys the battery sets. */
const SAVED: Seeds = ["SEEDED-KEY-SAVED-USER", "SEEDED-KEY-SAVED-PATH", "SEEDED-KEY-SAVED-QUERY"];
/** The keys a record written before origins were holds. */
const EARLIER: Seeds = ["SEEDED-KEY-EARLIER-USER", "SEEDED-KEY-EARLIER-PATH", "SEEDED-KEY-EARLIER-QUERY"];

const BASE = "http://instance.test";
const ADMIN = "test-account";
const MEMBER = "member";
const KEYS = ["geocoderUrl", "isochroneUrl", "overpassUrl", "s3Endpoint"] as const;
type AddressKey = typeof KEYS[number];
const SLUG: Record<AddressKey, string> = { geocoderUrl: "geo", isochroneUrl: "iso", overpassUrl: "osm", s3Endpoint: "s3" };
const VARIABLE: Record<AddressKey, string> = {
  geocoderUrl: "DEZFIL_GEOCODER_URL", isochroneUrl: "DEZFIL_ISOCHRONE_URL", overpassUrl: "DEZFIL_OVERPASS_URL", s3Endpoint: "DEZFIL_S3_ENDPOINT",
};
/** The console's sinks the server writes its log lines to. */
const SINKS = ["log", "info", "warn", "error", "debug", "trace"] as const;
const ACCOUNT = { id: ADMIN, name: "Ada Okafor", email: "ada@example.test", sqlName: "ada_okafor", isAdmin: true } as Account;

/** Each form of each key the text holds. */
function leaks(text: string, seeds: Seeds = SAVED): string[] {
  return [...seeds, `seed-user:${seeds[0]}`].flatMap(secret => secretForms(secret).filter(form => text.includes(form)));
}

let dir: string;
let server: Server;
let port: number;
let origin: string;
/** The table the OpenStreetMap import made. */
let imported: string;
/** Everything the console's sinks were handed while the battery ran. */
const lines: string[] = [];
/** How many surfaces the battery searched. */
let searchedCount = 0;

/** How a fixture service fails: down, a page not found, an error remark. */
type Fault = "down" | "missing" | "remark";

/** A service's address on the fixture, its key in all three places. */
function address(key: AddressKey, options: { seeds?: Seeds; at?: number; fault?: Fault; host?: string } = {}): string {
  const { seeds = SAVED, at = port, fault, host = "127.0.0.1" } = options;
  const tail = key === "overpassUrl" ? "/api/interpreter" : "";
  return `http://seed-user:${seeds[0]}@${host}:${at}/${fault ? `${fault}-` : ""}${SLUG[key]}-${seeds[1]}${tail}?key=${seeds[2]}`;
}

/** Search one surface: no key in any form, and, where it names the
 * service, its scheme and host. */
function searched(where: string, value: unknown, options: { origin?: string; seeds?: Seeds } = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(leaks(text, options.seeds), `${where} holds a seeded key`).toEqual([]);
  if (options.origin) expect(text, `${where} gives the service as scheme and host`).toContain(options.origin);
  searchedCount += 1;
}

type As = "page" | "token" | "member";
interface Answer { status: number; text: string; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

/** One request to the instance's own routes: from the page (the admin's
 * cookie, same origin), with the admin's token, or from a member's page. */
async function ask(method: string, route: string, body?: unknown, as: As = "page"): Promise<Answer> {
  const request = new Request(`${BASE}${route}`, body === undefined ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const sent = as === "token" ? socketRequest(request) : testAccountRequest(request, metadataDb(), as === "member" ? MEMBER : ADMIN);
  const response = await dispatchAssistantTestRoute(sent);
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, text, body: parsed };
}

/** The events of a streamed assistant run, in order. */
const streamed = async (response: Response) =>
  (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as AssistantEvent);

/** The generated tools' road: the admin's token through the shipped routes. */
const toolFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
  dispatchAssistantTestRoute(socketRequest(input instanceof Request ? input : new Request(String(input), init)))) as typeof fetch;
const tool = (name: string) => buildTools().find(candidate => candidate.name === name)!;

const save = (body: Record<string, unknown>) => ask("PATCH", "/api/instance/settings", body);
const saveAll = (options: Parameters<typeof address>[1] = {}) => save(Object.fromEntries(KEYS.map(key => [key, address(key, options)])));

/** The configuration read by cookie and by token, the runtime read by an
 * admin and by a member, and the settings search's index over the read. */
async function reads(where: string, source: "stored" | "environment") {
  const read = await ask("GET", "/api/instance/settings");
  expect(read.status).toBe(200);
  for (const key of KEYS) expect(read.body.settings[key], key).toMatchObject({ value: { set: true, origin }, source, storedValue: null });
  searched(`${where}: the configuration read`, read.text, { origin });
  const byToken = await ask("GET", "/api/instance/settings", undefined, "token");
  expect(byToken.status).toBe(200);
  searched(`${where}: the configuration read by token`, byToken.text, { origin });
  for (const as of ["page", "member"] as const) {
    const runtime = await ask("GET", "/api/config", undefined, as);
    expect(runtime.status).toBe(200);
    searched(`${where}: the runtime read (${as})`, runtime.text);
  }
  const index = buildSearchIndex(settingsDeclarations({ account: ACCOUNT, tokens: null, look: null, instance: read.body as InstanceRead,
    entry: null, health: null, assistant: null }, true), true);
  searched(`${where}: the settings search`, index, { origin });
}

/** A run through the run operation, settled: its answer, then its view. */
async function run(operation: string, parameters: Record<string, unknown>) {
  const accepted = await ask("POST", "/api/operations/run", { operation, parameters });
  expect(accepted.status, accepted.text).toBe(202);
  searched(`the ${operation} run's answer`, accepted.text);
  await laneSettled();
  const view = await ask("GET", `/api/operations/runs/${accepted.body.run.id}`);
  expect(view.status).toBe(200);
  return { id: accepted.body.run.id as string, view };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** The fixture: every service at one port, told apart by path. A service
 * that is down echoes what it was asked, its credential included; one that
 * finds no page echoes the request's path in hex and its credential; one
 * with an error remark repeats the whole address it was asked at and the
 * credential. */
function answer(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "", "http://fixture");
  const credential = req.headers.authorization ?? "";
  if (url.pathname.includes("/down-")) {
    res.writeHead(503, { "content-type": "text/html" });
    res.end(`<html><body><p><strong>Unavailable: ${req.url} ${credential}</strong></p></body></html>`);
  } else if (url.pathname.includes("/missing-")) {
    res.writeHead(404, { "content-type": "text/html" });
    res.end(`<html><body><p><strong>Not found: ${Buffer.from(req.url ?? "").toString("hex")} ${credential}</strong></p></body></html>`);
  } else if (url.pathname.includes("/remark-")) {
    const user = Buffer.from(credential.replace(/^Basic /, ""), "base64").toString("utf8");
    json(res, 200, { version: 0.6, elements: [], remark: `runtime error: at http://${user}@${req.headers.host}${req.url} as ${credential}` });
  } else if (url.pathname.includes("/s3-")) {
    // An S3 store refuses an unsigned request in its own shape, at its root
    // and for every object under it.
    res.writeHead(403, { "content-type": "application/xml" });
    res.end('<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
  } else if (url.pathname.endsWith(".csv")) {
    res.writeHead(200, { "content-type": "text/csv" });
    res.end(url.pathname.includes("origins") ? "label,lon,lat\np,13.41,52.51\n" : "label,address\na,Alpha Street\nb,Beta Street\n");
  } else if (url.pathname.endsWith("/search")) {
    json(res, 200, [{ display_name: "Somewhere", lat: "52.5", lon: "13.4", licence: "Fixture" }]);
  } else if (url.pathname.endsWith("/isochrone")) {
    const { locations: [{ lon, lat }] } = JSON.parse(url.searchParams.get("json") ?? "{}") as { locations: { lon: number; lat: number }[] };
    json(res, 200, { type: "FeatureCollection", features: [
      { type: "Feature", properties: { contour: 5 }, geometry: { type: "Polygon", coordinates: [[[lon - .01, lat - .01], [lon + .01, lat - .01], [lon + .01, lat + .01], [lon - .01, lat + .01], [lon - .01, lat - .01]]] } },
      { type: "Feature", properties: { type: "snapped" }, geometry: { type: "MultiPoint", coordinates: [[lon, lat]] } },
    ] });
  } else if (url.pathname.endsWith("/api/interpreter")) {
    json(res, 200, { version: 0.6, elements: [{ type: "node", id: 1, lat: 52.5, lon: 13.4, tags: { amenity: "cafe", name: "Corner" } }] });
  } else if (url.pathname.startsWith("/overturemaps-us-west-2/")) {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end("<ListBucketResult>" + ["2026-08-20.0", "2026-09-17.0"].map(release => `<CommonPrefixes><Prefix>release/${release}/</Prefix></CommonPrefixes>`).join("") + "</ListBucketResult>");
  } else {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("No such fixture service.");
  }
}

beforeAll(async () => {
  for (const definition of SETTING_CATALOGUE) if (definition.environment) vi.stubEnv(definition.environment, undefined);
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-secrecy-battery-"));
  vi.stubEnv("DEZFIL_DATA_DIR", path.join(dir, "data"));
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  vi.stubEnv("DEZFIL_GEOCODE_PACE_MS", "0");
  vi.stubEnv("DEZFIL_ISOCHRONE_PACE_MS", "0");
  vi.stubEnv("DEZFIL_SECRET_KEY", "4d".repeat(32)); resetSecretKeyCache();
  closeMetadataDb(); resetQueryInstance();
  resetLane(); resetLimiter(); resetIsochroneLimiter(); resetReleaseCache(); assistantRuns.resetForTests();
  server = createServer((req, res) => { req.resume(); req.on("end", () => answer(req, res)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  vi.stubEnv("DEZFIL_OVERTURE_S3_ENDPOINT", `127.0.0.1:${port}`);
  const db = metadataDb();
  testAccountScope(db, ADMIN);
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = ?").run(ADMIN);
  testAccountScope(db, MEMBER);
  // The console's sinks, for the whole run: every line is kept and searched at the end.
  for (const sink of SINKS) {
    vi.spyOn(console, sink).mockImplementation((...args: unknown[]) => { lines.push(`${sink}: ${format(...args)}`); });
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  resetLane(); resetLimiter(); resetIsochroneLimiter(); resetReleaseCache(); assistantRuns.resetForTests();
  closeMetadataDb(); resetQueryInstance();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs(); resetSecretKeyCache();
  await rm(dir, { recursive: true, force: true });
});

describe("a service address carrying a key", () => {
  it("saved from the page: the change answer, both configuration reads, the runtime read and the settings search", async () => {
    const saved = await saveAll();
    expect(saved.status, saved.text).toBe(200);
    for (const key of KEYS) expect(saved.body.settings[key].value).toEqual({ set: true, origin });
    searched("the page's change answer", saved.text, { origin });
    await reads("saved from the page", "stored");
  });

  it("refused: blocked space, a scheme the kind refuses, past the length, not an address, a member's change and read", async () => {
    const refused = [
      ["blocked space", await save({ geocoderUrl: address("geocoderUrl", { host: "10.0.0.7" }) })],
      ["a refused scheme", await save({ isochroneUrl: address("isochroneUrl").replace(/^http:/, "ftp:") })],
      ["past the length", await save({ overpassUrl: `${address("overpassUrl")}&pad=${"x".repeat(4096)}` })],
      ["not an address", await save({ s3Endpoint: address("s3Endpoint").replace("http://", "") })],
      ["a member's change", await ask("PATCH", "/api/instance/settings", { geocoderUrl: address("geocoderUrl") }, "member")],
      ["a member's read", await ask("GET", "/api/instance/settings", undefined, "member")],
    ] as const;
    for (const [what, answer] of refused) {
      expect(answer.status, what).toBeGreaterThanOrEqual(400);
      searched(`the refusal: ${what}`, answer.text);
    }
    // Nothing refused was kept.
    await reads("after the refusals", "stored");
  });

  it("geocoding and travel-time runs admitted after the save, and an OpenStreetMap import: answers, views, records and lists", async () => {
    for (const name of ["addresses", "origins"]) {
      const imported = await ask("POST", "/api/imports/url", { url: `${origin}/${name}.csv`, name });
      expect(imported.status, imported.text).toBeLessThan(300);
    }
    const geocoded = await run("geocode_addresses", { input: "addresses", column: "address", name: "located" });
    const travelled = await run("isochrone", { input: "origins", travel_mode: "driving", bands: [5], name: "areas" });
    for (const { view } of [geocoded, travelled]) {
      expect(view.body.run.state, view.text).toBe("succeeded");
      expect(view.body.run.disclosure.endpoint).toBe(origin);
      searched(`the ${view.body.run.operation} run's view`, view.text, { origin });
    }
    const osm = await ask("POST", "/api/imports/osm", { bbox: [13.3, 52.4, 13.5, 52.6], selectors: ["amenity=cafe"], name: "cafes" });
    expect(osm.status, osm.text).toBeLessThan(300);
    searched("the OpenStreetMap import's answer", osm.text, { origin });
    imported = osm.body.tables[0].name;
    searched("the run list", (await ask("GET", "/api/operations/runs")).text, { origin });
    for (const name of ["located", "areas", imported]) {
      const record = await ask("GET", `/api/tables/${name}`);
      expect(record.status).toBe(200);
      searched(`the dataset record of ${name}`, record.text, { origin });
    }
    searched("the dataset list", (await ask("GET", "/api/tables")).text, { origin });
  });

  it("at a service that fails: the runs' views, OpenStreetMap's refusal, cloud storage's refusals, a run refused at use", async () => {
    const down = await save(Object.fromEntries((["geocoderUrl", "isochroneUrl", "overpassUrl"] as const).map(key => [key, address(key, { fault: "down" })])));
    expect(down.status, down.text).toBe(200);
    searched("the change answer to a service that is down", down.text, { origin });
    for (const [operation, parameters] of [
      ["geocode_addresses", { input: "addresses", column: "address", name: "located_again" }],
      ["isochrone", { input: "origins", travel_mode: "driving", bands: [5], name: "areas_again" }],
    ] as const) {
      const { view } = await run(operation, parameters);
      expect(view.body.run.state, view.text).toBe("failed");
      searched(`the failed ${operation} run's view`, view.text);
    }
    const osm = await ask("POST", "/api/imports/osm", { bbox: [13.3, 52.4, 13.5, 52.6], selectors: ["amenity=cafe"], name: "cafes_again" });
    expect(osm.status, osm.text).toBe(502);
    searched("OpenStreetMap's refusal", osm.text, { origin });
    // A page not found that repeats the request in other forms, and an
    // answer whose error remark repeats the whole address and its credential.
    for (const [fault, what] of [["missing", "a page not found repeating the request"], ["remark", "an error remark repeating the address"]] as const) {
      const moved = await save({ overpassUrl: address("overpassUrl", { fault }) });
      expect(moved.status, moved.text).toBe(200);
      const refused = await ask("POST", "/api/imports/osm", { bbox: [13.3, 52.4, 13.5, 52.6], selectors: ["amenity=cafe"], name: `cafes_${fault}` });
      expect(refused.status, refused.text).toBe(502);
      searched(`OpenStreetMap's refusal: ${what}`, refused.text, { origin });
    }

    // Cloud storage refuses in the person's own link, never the address it reached.
    const link = "s3://open-bucket/places.csv";
    const denied = await ask("POST", "/api/imports/url", { url: link, name: "places" });
    expect(denied.status, denied.text).toBe(502);
    expect(denied.body.error.message).toContain(link);
    searched("cloud storage's refusal", denied.text);
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", () => resolve()));
    const nowhere = (closed.address() as AddressInfo).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    const moved = await save({ s3Endpoint: address("s3Endpoint", { at: nowhere }) });
    expect(moved.status, moved.text).toBe(200);
    searched("the change answer to an unreachable store", moved.text, { origin: `http://127.0.0.1:${nowhere}` });
    const unreachable = await ask("POST", "/api/imports/url", { url: link, name: "places" });
    expect(unreachable.status, unreachable.text).toBe(502);
    expect(unreachable.body.error.message).toContain(link);
    searched("cloud storage's refusal when unreachable", unreachable.text);

    // Kept while the allowlist named it, refused at use once it does not.
    const restored = await saveAll();
    expect(restored.status, restored.text).toBe(200);
    const emptied = await ask("DELETE", "/api/instance/caches?service=geocode");
    expect(emptied.status, emptied.text).toBe(200);
    searched("Clear's answer for one service", emptied.text);
    vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
    try {
      const { view } = await run("geocode_addresses", { input: "addresses", column: "address", name: "located_blocked" });
      expect(view.body.run.state, view.text).toBe("failed");
      searched("a run refused at use", view.text);
    } finally { vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1"); }
  });

  it("Tested from the page and through the generated tool, failing and passing, and Clear's answers", async () => {
    for (const service of ["geocode", "isochrone", "overpass", "overture", "s3"]) {
      const tested = await ask("POST", `/api/instance/services/${service}/test`);
      expect(tested.body, tested.text).toMatchObject({ service, result: "passed" });
      searched(`the ${service} Test's answer`, tested.text);
    }
    const byTool = await executeTool(tool("test_service"), { service: "geocode" }, BASE, toolFetch);
    expect(byTool.body).toMatchObject({ service: "geocode", result: "passed" });
    searched("the generated tool's Test answer", byTool.body);
    await save({ geocoderUrl: address("geocoderUrl", { fault: "down" }) });
    const failed = await ask("POST", "/api/instance/services/geocode/test");
    expect(failed.body, failed.text).toMatchObject({ service: "geocode", result: "failed", reason: "status", status: 503 });
    searched("a failed Test's answer", failed.text);
    await save({ geocoderUrl: address("geocoderUrl") });
    const cleared = await ask("DELETE", "/api/instance/caches");
    expect(cleared.status, cleared.text).toBe(200);
    searched("Clear's answer", cleared.text);
    const clearedByTool = await executeTool(tool("clear_service_caches"), {}, BASE, toolFetch);
    expect(clearedByTool.status).toBe(200);
    searched("the generated tool's Clear answer", clearedByTool.body);
  });

  it("set through the generated tool: its answer and its refusal", async () => {
    const kept = await executeTool(tool("update_instance_settings"), { overpassUrl: address("overpassUrl") }, BASE, toolFetch);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    searched("the generated tool's change answer", kept.body, { origin });
    const refused = await executeTool(tool("update_instance_settings"), { geocoderUrl: address("geocoderUrl", { host: "10.0.0.7" }) }, BASE, toolFetch);
    expect(refused.status).toBe(400);
    searched("the generated tool's refusal", refused.body);
    await reads("set through the generated tool", "stored");
  });

  it("set through the embedded assistant: its confirmation, events, pending receipt and stored record, read back", async () => {
    const scope = testAccountScope(metadataDb(), ADMIN);
    const pending = new PendingActionStore();
    const provider = stubProvider([
      { text: "", toolCalls: [{ id: "point-travel-time", name: "update_instance_settings", args: { isochroneUrl: address("isochroneUrl") } }] },
      { text: "Done.", toolCalls: [] },
    ]);
    const message = "Use our routing service";
    const receipt = assistantRuns.reserve(scope);
    assistantRuns.bind(scope, receipt.id, { message });
    const deps = { scope, baseUrl: BASE, pending, fetchImpl: toolFetch, runId: receipt.id };

    const asked = await streamed(runStream(scope, runAssistant(provider, { message, history: [] }, deps), receipt.id));
    const question = asked.find(event => event.type === "confirm_required");
    if (question?.type !== "confirm_required") throw new Error("expected a confirmation");
    searched("the assistant's confirmation", question, { origin });
    expect(question.args).toEqual({ isochroneUrl: origin });
    searched("the assistant's events before the decision", asked, { origin });
    const waiting = await ask("GET", "/api/assistant/pending");
    expect(waiting.status).toBe(200);
    searched("the pending receipt", waiting.text, { origin });

    const parked = pending.claim(scope, question.id, "approved")!;
    assistantRuns.resume(scope, receipt.id, "approved");
    const done = await streamed(runStream(scope, resumeAssistant(parked, true, deps), receipt.id));
    expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "update_instance_settings", ok: true }));
    searched("the assistant's events after the decision", done, { origin });
    const record = await ask("GET", `/api/assistant/runs/${receipt.id}`);
    expect(record.status).toBe(200);
    expect(record.body.confirmations).toEqual([expect.objectContaining({ decision: "approved", args: { isochroneUrl: origin } })]);
    searched("the assistant's stored record", record.text, { origin });
    await reads("set through the embedded assistant", "stored");
  });

  it("given to the embedded assistant as a list and as an object: its confirmation, events, pending receipt, refusal and stored record", async () => {
    const scope = testAccountScope(metadataDb(), ADMIN);
    for (const [what, given] of [["a list", [address("geocoderUrl")]], ["an object", { address: address("geocoderUrl") }]] as const) {
      const pending = new PendingActionStore();
      const provider = stubProvider([
        { text: "", toolCalls: [{ id: "point-the-finder", name: "update_instance_settings", args: { geocoderUrl: given } }] },
        { text: "Refused.", toolCalls: [] },
      ]);
      const message = `Use our address finder, given as ${what}`;
      const receipt = assistantRuns.reserve(scope);
      assistantRuns.bind(scope, receipt.id, { message });
      const deps = { scope, baseUrl: BASE, pending, fetchImpl: toolFetch, runId: receipt.id };

      const asked = await streamed(runStream(scope, runAssistant(provider, { message, history: [] }, deps), receipt.id));
      const question = asked.find(event => event.type === "confirm_required");
      if (question?.type !== "confirm_required") throw new Error("expected a confirmation");
      searched(`the assistant's confirmation of an address given as ${what}`, question);
      expect(question.args).toEqual({ geocoderUrl: "not an address" });
      searched(`the assistant's events before the decision on ${what}`, asked);
      const waiting = await ask("GET", "/api/assistant/pending");
      expect(waiting.status).toBe(200);
      searched(`the pending receipt of ${what}`, waiting.text);

      const parked = pending.claim(scope, question.id, "approved")!;
      assistantRuns.resume(scope, receipt.id, "approved");
      const done = await streamed(runStream(scope, resumeAssistant(parked, true, deps), receipt.id));
      expect(done).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "update_instance_settings", ok: false }));
      searched(`the assistant's events after the decision on ${what}, its refusal among them`, done);
      const record = await ask("GET", `/api/assistant/runs/${receipt.id}`);
      expect(record.status).toBe(200);
      searched(`the assistant's stored record of ${what}`, record.text);
    }
    // Nothing refused was kept.
    await reads("after the assistant's refused calls", "stored");
  });

  it("set by the variable: the reads, the search, the locked refusal, a Test and a run admitted under it", async () => {
    for (const key of KEYS) vi.stubEnv(VARIABLE[key], address(key));
    try {
      await reads("set by the variable", "environment");
      const locked = await save({ geocoderUrl: address("geocoderUrl") });
      expect(locked.status).toBe(409);
      expect(locked.text).toContain(VARIABLE.geocoderUrl);
      searched("the locked refusal", locked.text);
      const tested = await ask("POST", "/api/instance/services/geocode/test");
      expect(tested.body, tested.text).toMatchObject({ service: "geocode", result: "passed" });
      searched("a Test under the variable", tested.text);
      const { view } = await run("geocode_addresses", { input: "addresses", column: "address", name: "located_by_variable" });
      expect(view.body.run.state, view.text).toBe("succeeded");
      searched("a run's view under the variable", view.text, { origin });
    } finally {
      for (const key of KEYS) vi.stubEnv(VARIABLE[key], undefined);
    }
  });

  it("recorded before origins were: a run, its dataset and an OpenStreetMap import read as scheme and host, their rows untouched", async () => {
    const db = metadataDb();
    const job = db.prepare("SELECT id, disclosure FROM operation_jobs WHERE output_name = ? AND state = 'succeeded'").get("located") as { id: string; disclosure: string };
    const runBefore = JSON.stringify({ ...JSON.parse(job.disclosure), endpoint: address("geocoderUrl", { seeds: EARLIER }) });
    db.prepare("UPDATE operation_jobs SET disclosure = ? WHERE id = ?").run(runBefore, job.id);
    const params = (name: string) => JSON.parse((db.prepare("SELECT source_params FROM data_tables WHERE name = ?").get(name) as { source_params: string }).source_params);
    const located = params("located");
    const datasetBefore = JSON.stringify({ ...located, disclosure: { ...located.disclosure, endpoint: address("geocoderUrl", { seeds: EARLIER }) } });
    const importBefore = JSON.stringify({ ...params(imported), endpoint: address("overpassUrl", { seeds: EARLIER }) });
    db.prepare("UPDATE data_tables SET source_params = ? WHERE name = ?").run(datasetBefore, "located");
    db.prepare("UPDATE data_tables SET source_params = ? WHERE name = ?").run(importBefore, imported);

    const view = await ask("GET", `/api/operations/runs/${job.id}`);
    const reads = [
      ["the earlier run's view", view],
      ["the run list", await ask("GET", "/api/operations/runs")],
      ["the earlier dataset's record", await ask("GET", "/api/tables/located")],
      ["the earlier import's record", await ask("GET", `/api/tables/${imported}`)],
      ["the dataset list", await ask("GET", "/api/tables")],
    ] as const;
    for (const [where, read] of reads) {
      expect(read.status, where).toBe(200);
      searched(where, read.text, { origin, seeds: EARLIER });
    }
    expect(view.body.run.disclosure.endpoint).toBe(origin);
    // Read, not rewritten.
    expect((db.prepare("SELECT disclosure FROM operation_jobs WHERE id = ?").get(job.id) as { disclosure: string }).disclosure).toBe(runBefore);
    expect(JSON.stringify(params("located"))).toBe(datasetBefore);
    expect(JSON.stringify(params(imported))).toBe(importBefore);
  });

  it("the server's log lines over the battery hold neither key", () => {
    // The sinks were the console's for the whole run: nothing put them back.
    for (const sink of SINKS) expect(vi.isMockFunction(console[sink]), sink).toBe(true);
    const leaked = lines.filter(line => leaks(line).length || leaks(line, EARLIER).length);
    expect(leaked, "log lines holding a seeded key").toEqual([]);
    searchedCount += lines.length;
  });

  it("the data folder, the metadata database file first, holds no key the battery set, in any form the search knows", async () => {
    resetLane(); resetLimiter(); resetIsochroneLimiter();
    closeMetadataDb(); resetQueryInstance();
    const data = path.join(dir, "data");
    const files = readdirSync(data, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
      .map(entry => path.relative(data, path.join(entry.parentPath, entry.name)));
    expect(files).toContain("metadata.sqlite");
    const found = files.flatMap(file => leaks(readFileSync(path.join(data, file)).toString("latin1")).map(form => `${file}: ${form}`));
    expect(found).toEqual([]);
    // The search sees into the file: the rows written as they were before
    // still hold their keys there, and are found.
    const metadata = files.filter(file => file.startsWith("metadata.sqlite")).map(file => readFileSync(path.join(data, file)).toString("latin1")).join("");
    expect(leaks(metadata, EARLIER)).toEqual(expect.arrayContaining([...EARLIER]));
    searchedCount += files.length;
    expect(searchedCount).toBeGreaterThan(60);
  });
});
