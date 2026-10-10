import type { Database } from "better-sqlite3";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine's own lookup, answered by a fixture resolver: the template's
// host is public at save. Nothing here reaches it; the imagery is only
// composed, never fetched.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
vi.mock("@/components/builder/MapBuilder", () => ({ MapBuilder: () => null }));
vi.mock("@/components/reader/MapReader", () => ({ MapReader: () => null }));
const who = vi.hoisted(() => ({ account: "member", db: null as unknown }));
vi.mock("next/headers", () => ({
  headers: async () =>
    testAccountRequest(new Request("http://instance.test/maps/M"), who.db as Database, who.account).headers,
}));

import * as metadata from "@/lib/metadata/db";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { MapBuilder } from "@/components/builder/MapBuilder";
import MapPage from "@/app/(workspace)/maps/[id]/page";
import { GET as imageryRoute } from "@/app/api/basemaps/satellite/route";
import { GET as publishedRoute } from "@/app/api/published/[token]/route";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { resetPublishCache } from "@/lib/publish/publication-resolution";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { callAs, tokenFor } from "@/lib/test-support/rule-roads";
import { BASEMAPS, SATELLITE_STYLE_URL, type BasemapStyle } from "./basemap";
import { effectiveBasemap } from "./basemap-effective";
import { createMap, readMap, updateMap } from "./map-service";

/**
 * The satellite imagery as an admin sets it up, as the instance's key
 * changes under it and as an admin removes it, seen from every place it
 * shows: the configuration read (the Satellite card's state), the runtime
 * read's offer, the builder's canvas, a publication assembled afresh and
 * the imagery style itself.
 *
 * The imagery style carries the whole template, key included, so it
 * answers signed-in requests only: an anonymous one, a published page's
 * reader among them, is refused with no part of it. A stored template the
 * key no longer opens is refused by its coded refusal, never by another
 * style, and Satellite leaves every list until it is saved again. Removing
 * it takes Satellite out of every list while every map on it keeps the
 * choice and draws the deployment default, until a template is set again.
 */

const ORIGIN = "http://instance.test";
const SEEDS = ["SEEDED-KEY-0006-USER", "SEEDED-KEY-0006-PATH", "SEEDED-KEY-0006-QUERY"];
const TEMPLATE = `https://seed-user:${SEEDS[0]}@imagery.example/${SEEDS[1]}/{z}/{x}/{y}.jpg?key=${SEEDS[2]}`;
const CREDIT = "© Imagery Provider";
const DEFAULT_STYLE = BASEMAPS[0].url;

type Element = ReactElement<{ basemaps: BasemapStyle[]; basemapUrl: string; basemapOverrideUrl: string | null; children?: Element }>;

let db: Database;
let tokens: Record<"admin" | "member", string>;
let mapId: string;

beforeEach(() => {
  for (const name of ["DEZFIL_SATELLITE_URL", "DEZFIL_SATELLITE_ATTRIBUTION", "DEZFIL_BASEMAP_URL", "DEZFIL_BASEMAP_ATTRIBUTION"]) vi.stubEnv(name, undefined);
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  useKey("4d".repeat(32));
  dns.lookup.mockReset();
  dns.lookup.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
  db = metadata.open(":memory:");
  who.db = db;
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  testAccountScope(db, "member");
  tokens = { admin: tokenFor(db, "admin"), member: tokenFor(db, "member") };
  resetPublishCache();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetSecretKeyCache(); resetPublishCache();
  if (db.open) db.close();
});

function useKey(hex: string) { vi.stubEnv("DEZFIL_SECRET_KEY", hex); resetSecretKeyCache(); }

type Caller = "admin" | "member" | "member-token" | "anonymous";
async function answered(response: Response) {
  const text = await response.text();
  return { status: response.status, cache: response.headers.get("cache-control"), text, body: text ? JSON.parse(text) : null };
}
/** One call on the shipped routes: by a session cookie or a token. */
async function call(method: string, pathname: string, as: Exclude<Caller, "anonymous">, body?: unknown) {
  let request = new Request(`${ORIGIN}${pathname}`, body === undefined ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (as === "admin" || as === "member") request = testAccountRequest(request, db, as);
  else { request.headers.set("authorization", `Bearer ${tokens.member}`); request = socketRequest(request); }
  return answered(await dispatchAssistantTestRoute(request));
}
/** A request with no credential at all, straight to the route that answers it. */
const unsigned = (pathname: string) => socketRequest(new Request(`${ORIGIN}${pathname}`));
const change = async (patch: Record<string, unknown>) => {
  const answer = await call("PATCH", "/api/instance/settings", "admin", patch);
  expect(answer.status, answer.text).toBe(200);
  expectNoSeed(answer.text);
};
function expectNoSeed(text: string) {
  for (const seed of SEEDS) expect(text, `holds ${seed}`).not.toContain(seed);
}

/** The Satellite card's state: what the configuration read says of the template and the credit. */
async function card() {
  const read = await call("GET", "/api/instance/settings", "admin");
  expect(read.status).toBe(200);
  expectNoSeed(read.text);
  return { template: read.body.settings.satelliteUrl.value, credit: read.body.settings.satelliteAttribution.value };
}
/** The runtime read's offer, as a member's page reads it. */
async function offer(): Promise<string[]> {
  const read = await call("GET", "/api/config", "member");
  expect(read.status).toBe(200);
  expectNoSeed(read.text);
  return (read.body.basemaps as { key: string }[]).map(b => b.key);
}
/** What the builder's canvas draws for the map: the page's own lists, through the canvas's derivation. */
async function builder() {
  who.account = "member";
  let element = (await MapPage({ params: Promise.resolve({ id: mapId }), searchParams: Promise.resolve({}) })) as Element | undefined;
  while (element && element.type !== MapBuilder) element = element.props.children;
  expect(element, "the builder").toBeDefined();
  const { basemaps, basemapUrl, basemapOverrideUrl } = element!.props;
  const drawn = effectiveBasemap({ key: readMap(testAccountScope(db, "member"), mapId).basemap, custom: null, theme: "dark",
    overrideUrl: basemapOverrideUrl, defaultUrl: basemapUrl, basemaps });
  return { url: drawn.url, kind: drawn.kind };
}
/** A publication of the map assembled afresh, read as its anonymous reader reads it. */
async function publication(token: string) {
  resetPublishCache();
  const view = await answered(await publishedRoute(unsigned(`/api/published/${token}`), { params: Promise.resolve({ token }) }));
  expect(view.status, view.text).toBe(200);
  expectNoSeed(view.text);
  return { url: view.body.basemapUrl, kind: view.body.basemapKind, credit: view.body.basemapAttribution };
}
/** The imagery style, as each caller asks for it. */
const imagery = async (as: Caller) => as === "anonymous"
  ? answered(await imageryRoute(unsigned(SATELLITE_STYLE_URL))) : call("GET", SATELLITE_STYLE_URL, as);

/** Imagery set up, a member's map on it and published. */
async function setUp(): Promise<string> {
  await change({ satelliteUrl: TEMPLATE, satelliteAttribution: CREDIT });
  const scope = testAccountScope(db, "member");
  mapId = createMap(scope, "Harbour from above").id;
  updateMap(scope, mapId, { basemap: "satellite" }, { expectedRevision: readDocumentRevision({ kind: "map", id: mapId }, db)?.editRevision });
  const published = await callAs(db, "cookie", "member", tokens.member, "publish_map", { id: mapId, theme: "dark" },
    readDocumentRevision({ kind: "map", id: mapId }, db)?.editRevision);
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  return (published.body as { token: string }).token;
}

/** The anonymous refusal: the sign-in it asks for, and no part of the template. */
async function refusedAnonymously() {
  const anonymous = await imagery("anonymous");
  expect(anonymous.status).toBe(401);
  expect(anonymous.cache).toBe("private, no-store");
  expect(anonymous.body).toEqual({ error: { code: "authentication_required", message: expect.any(String) } });
  expectNoSeed(anonymous.text);
  expect(anonymous.text).not.toContain("imagery.example");
}

describe("the satellite imagery while it is set up", () => {
  it("gives signed-in readers the whole template in the imagery style, refuses an anonymous one any part of it, and draws a map on Satellite in the builder and afresh", async () => {
    const token = await setUp();
    expect(await card()).toEqual({ template: { set: true, origin: "https://imagery.example" }, credit: CREDIT });
    expect(await offer()).toContain("satellite");
    for (const as of ["member", "member-token", "admin"] as const) {
      const style = await imagery(as);
      expect(style.status, as).toBe(200);
      expect(style.cache).toBe("private, no-store");
      expect(style.body.sources.satellite).toMatchObject({ type: "raster", tiles: [TEMPLATE], attribution: CREDIT });
    }
    await refusedAnonymously();
    expect(await builder()).toEqual({ url: SATELLITE_STYLE_URL, kind: "imagery" });
    // A published page's reader is anonymous: its style is this route, which
    // refuses them, so the page draws its data on the plain fallback.
    expect(await publication(token)).toEqual({ url: SATELLITE_STYLE_URL, kind: "imagery", credit: [{ label: CREDIT }] });
  });
});

describe("the satellite imagery once the instance's key changed", () => {
  it("reads set and unreadable, leaves the offer and the drawing list, draws a map on it on the default style, and refuses the imagery style by its code, never with another", async () => {
    const token = await setUp();
    useKey("6f".repeat(32));
    expect((await card()).template).toEqual({ set: true, unreadable: true });
    expect(await offer()).not.toContain("satellite");
    expect(readMap(testAccountScope(db, "member"), mapId).basemap).toBe("satellite");
    expect(await builder()).toEqual({ url: DEFAULT_STYLE, kind: "vector" });
    expect(await publication(token)).toMatchObject({ url: DEFAULT_STYLE, kind: "vector" });
    for (const as of ["member", "member-token", "admin"] as const) {
      const refused = await imagery(as);
      expect(refused.status, as).toBe(400);
      expect(refused.cache).toBe("private, no-store");
      expect(refused.body).toEqual({ error: { code: "service_address_unreadable", message: expect.stringContaining('"Satellite template"') } });
      expectNoSeed(refused.text);
    }
    await refusedAnonymously();
  });
});

describe("the satellite imagery removed, then set again", () => {
  it("keeps every map's choice and draws it on the default style in the builder and afresh, serves no imagery style, keeps the credit; once set again, imagery for signed-in readers", async () => {
    const token = await setUp();
    await change({ satelliteUrl: null });
    expect(await card()).toEqual({ template: { set: false }, credit: CREDIT });
    expect(await offer()).not.toContain("satellite");
    expect(readMap(testAccountScope(db, "member"), mapId).basemap).toBe("satellite");
    expect(await builder()).toEqual({ url: DEFAULT_STYLE, kind: "vector" });
    expect(await publication(token)).toMatchObject({ url: DEFAULT_STYLE, kind: "vector" });
    const none = await imagery("member");
    expect(none.status).toBe(404);
    expect(none.cache).toBe("private, no-store");
    expectNoSeed(none.text);
    await refusedAnonymously();

    await change({ satelliteUrl: TEMPLATE });
    expect(await offer()).toContain("satellite");
    const again = await imagery("member");
    expect(again.status).toBe(200);
    expect(again.body.sources.satellite).toMatchObject({ tiles: [TEMPLATE], attribution: CREDIT });
    expect(await builder()).toEqual({ url: SATELLITE_STYLE_URL, kind: "imagery" });
    expect(await publication(token)).toEqual({ url: SATELLITE_STYLE_URL, kind: "imagery", credit: [{ label: CREDIT }] });
    await refusedAnonymously();
  });
});
