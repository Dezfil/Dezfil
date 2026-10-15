/// <reference types="vite/client" />
import type { Database } from "better-sqlite3";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine's own lookup, answered by a fixture resolver, so a tile host
// can answer publicly at save and privately at use.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
vi.mock("@/components/viewer/PublishedView", () => ({ PublishedView: () => null }));

import type { ReactElement } from "react";
import { NextRequest } from "next/server";
import PublishedPage from "@/app/v/[token]/page";
import { gateRequest } from "@/lib/auth/gate";
import * as metadata from "@/lib/metadata/db";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { publishMap, resetPublishCache, unpublishMap, type PublishSettings } from "@/lib/publish/publish-service";
import { resetRateLimits } from "@/lib/publish/rate-limit";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { encodePng } from "@/lib/export/png-codec";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { tokenFor } from "@/lib/test-support/rule-roads";
import { initialDefinition } from "@/lib/export/image-definition";
import { renderMapImage, type RenderDriver } from "@/lib/export/render-image";
import { satelliteTilesUrl, type BasemapStyle } from "./basemap";
import { readTileCoordinate, tileAddress } from "./basemap-satellite-tiles";
import { createMap, updateMap } from "./map-service";

/**
 * The satellite imagery through the instance. The style a browser loads
 * names the instance's own tile address; the server fetches each tile from
 * the configured template and passes it back, so the template and its key
 * reach no browser. Only the tile's z, x and y reach the template, checked
 * as whole numbers inside the zoom's range before anything is asked;
 * nothing else of the request goes with them. Only an image passes back;
 * every failure upstream is one coded refusal that names neither the
 * template nor its key, in its words, its headers or the server's log.
 *
 * The imagery is a loopback fixture listening on 127.0.0.1, which the
 * egress allowlist admits; its key sits in the template's path and query.
 */

const ORIGIN = "http://instance.test";
const SEEDS = ["SEEDED-KEY-0042-PATH", "SEEDED-KEY-0042-QUERY"];
const CREDIT = "© Imagery Fixture";
const STYLE = "/api/basemaps/satellite";
const TILE = Buffer.from(encodePng({ width: 1, height: 1, rgba: new Uint8Array([196, 72, 48, 255]) }));

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const healthy: Handler = (_req, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(TILE); };

let db: Database;
let tokens: Record<"member", string>;
let fixture: Server;
let port: number;
let answer: Handler;
let asked: { url: string; headers: IncomingMessage["headers"] }[];

const template = (host = "127.0.0.1") => `http://${host}:${port}/${SEEDS[0]}/{z}/{x}/{y}.png?key=${SEEDS[1]}`;

beforeEach(async () => {
  for (const name of ["DEZFIL_SATELLITE_URL", "DEZFIL_SATELLITE_ATTRIBUTION"]) vi.stubEnv(name, undefined);
  vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "127.0.0.1");
  vi.stubEnv("DEZFIL_SECRET_KEY", "4d".repeat(32)); resetSecretKeyCache();
  dns.lookup.mockReset();
  dns.lookup.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  testAccountScope(db, "member");
  tokens = { member: tokenFor(db, "member") };
  asked = [];
  answer = healthy;
  resetPublishCache(); resetRateLimits();
  fixture = createServer((req, res) => { asked.push({ url: req.url ?? "", headers: req.headers }); answer(req, res); });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  port = (fixture.address() as AddressInfo).port;
  vi.stubEnv("DEZFIL_SATELLITE_URL", template());
  vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", CREDIT);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetSecretKeyCache(); resetPublishCache();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  if (db.open) db.close();
});

// The shipped routes, matched as the router matches them, so an address
// nothing answers at reads as that, never as a missing import.
const ROUTES = Object.entries(import.meta.glob("/src/app/api/**/route.ts")).map(([file, load]) => {
  const keys: string[] = [];
  const pattern = file.replace("/src/app", "").replace("/route.ts", "").split("/").map((part) => {
    if (part.startsWith("[") && part.endsWith("]")) { keys.push(part.slice(1, -1)); return "([^/]+)"; }
    return part;
  }).join("/");
  return { pattern: new RegExp(`^${pattern}$`), keys, load: load as () => Promise<Record<string, (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>>> };
}).sort((a, b) => a.keys.length - b.keys.length);

type Caller = "admin" | "member" | "member-token" | "anonymous";
interface Answer { status: number; text: string; body: unknown; headers: Headers; bytes: Buffer }
/** One request on the shipped routes, by a session cookie, a token or no credential at all. */
async function call(pathname: string, as: Caller, init: RequestInit = {}): Promise<Answer> {
  let request = new Request(`${ORIGIN}${pathname}`, init);
  if (as === "admin" || as === "member") request = testAccountRequest(request, db, as);
  else if (as === "member-token") { request.headers.set("authorization", `Bearer ${tokens.member}`); request = socketRequest(request); }
  else request = socketRequest(request);
  const { pathname: path } = new URL(request.url);
  const route = ROUTES.find((candidate) => candidate.pattern.test(path));
  if (!route) return { status: 404, text: "nothing answers here", body: null, headers: new Headers(), bytes: Buffer.alloc(0) };
  const matched = path.match(route.pattern)!;
  const handler = (await route.load())[request.method];
  const response = await handler(request, { params: Promise.resolve(Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(matched[i + 1])]))) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, text, body, headers: response.headers, bytes };
}

/** Nothing of the template: no key, no part of its address. */
function expectNoTemplate(where: string, answer: Pick<Answer, "text" | "headers">) {
  const said = [answer.text, ...[...answer.headers].map(([name, value]) => `${name}: ${value}`)].join("\n");
  for (const seed of SEEDS) expect(said, `${where} holds ${seed}`).not.toContain(seed);
  expect(said, `${where} names the tile host`).not.toContain(`:${port}`);
}

const refusal = { error: { code: "imagery_unavailable", message: expect.any(String) } };

/** A PNG whole to its end, past the size bound only by an ancillary chunk
 * of its own: nothing but the bound refuses it. */
function oversized(): Buffer {
  const length = 4 * 1024 * 1024 + 1;
  const chunk = Buffer.alloc(12 + length);
  chunk.writeUInt32BE(length, 0);
  chunk.write("teXt", 4, "latin1");
  return Buffer.concat([TILE.subarray(0, 33), chunk, TILE.subarray(33)]);
}

describe("the satellite style a signed-in browser loads", () => {
  it("names the instance's own tile address with the credit, and none of the template or its key", async () => {
    for (const as of ["member", "member-token"] as const) {
      const style = await call(STYLE, as);
      expect(style.status, as).toBe(200);
      expect((style.body as { sources: { satellite: unknown } }).sources.satellite)
        .toEqual({ type: "raster", tiles: ["/api/basemaps/satellite/tiles/{z}/{x}/{y}{ratio}"], scheme: "xyz", tileSize: 256, maxzoom: 19, attribution: CREDIT });
      expectNoTemplate(`the style for ${as}`, style);
    }
    expect(asked).toEqual([]);
  });
});

describe("a satellite tile for a signed-in browser", () => {
  it("is fetched by the server from the template, only z, x and y going with it, and passed back as the image with its type", async () => {
    for (const as of ["member", "member-token"] as const) {
      asked = [];
      const tile = await call("/api/basemaps/satellite/tiles/3/4/2?key=other&z=9", as, {
        headers: { referer: "https://reader.example/page", "x-forwarded-for": "198.51.100.7", "x-caller": "kept here" },
      });
      expect(tile.status, as).toBe(200);
      expect(tile.headers.get("content-type")).toBe("image/png");
      expect(tile.headers.get("cache-control")).toBe("private, no-store");
      expect(tile.bytes.equals(TILE), "the fixture's tile, byte for byte").toBe(true);
      expectNoTemplate(`the tile for ${as}`, tile);
      expect(asked.map((a) => a.url)).toEqual([`/${SEEDS[0]}/3/4/2.png?key=${SEEDS[1]}`]);
      // Nothing of the caller's request goes upstream: no credential, no
      // page, none of its own headers, none of their values. (This
      // process's ingress hook stamps its own forwarding headers on every
      // server here, the fixture's included, so those are read by value.)
      const sent = asked[0].headers;
      for (const name of ["cookie", "authorization", "referer", "origin", "x-caller"]) expect(sent[name], name).toBeUndefined();
      const values = JSON.stringify(sent);
      for (const value of ["198.51.100.7", "reader.example", "kept here", "other"]) expect(values, value).not.toContain(value);
      expect(sent["user-agent"]).toMatch(/^Dezfil /);
    }
  });

  it("the style's tile address is the one that answers", async () => {
    const style = await call(STYLE, "member");
    const { tiles, scheme } = (style.body as { sources: { satellite: { tiles: string[]; scheme: string } } }).sources.satellite;
    const tile = await call((await maplibreTile(0, 0, 0)).url(tiles, 1, scheme), "member");
    expect(tile.status).toBe(200);
    expect(asked.map((a) => a.url)).toEqual([`/${SEEDS[0]}/0/0/0.png?key=${SEEDS[1]}`]);
  });

  it("refuses an anonymous request, asking the imagery nothing", async () => {
    const tile = await call("/api/basemaps/satellite/tiles/3/4/2", "anonymous");
    expect(tile.status).toBe(401);
    expect(tile.body).toEqual({ error: { code: "authentication_required", message: expect.any(String) } });
    expectNoTemplate("the anonymous refusal", tile);
    expect(asked).toEqual([]);
  });

  it.each([
    ["a zoom past the imagery's deepest", "20", "0", "0"],
    ["a column outside its zoom", "3", "8", "0"],
    ["a row outside its zoom", "3", "0", "8"],
    ["a negative zoom", "-1", "0", "0"],
    ["a fraction", "1.5", "0", "0"],
    ["an exponent", "1e1", "0", "0"],
    ["a hexadecimal number", "0x1", "0", "0"],
    ["a leading zero", "01", "0", "0"],
    ["a word", "z", "0", "0"],
    ["a padded number", "%201", "0", "0"],
    ["an empty part", "3", "4", "%20"],
    ["a placeholder", "{z}", "0", "0"],
    ["a pixel ratio other than @2x", "3", "4", "2@3x"],
    ["a pixel ratio in capitals", "3", "4", "2@2X"],
    ["a pixel ratio alone", "3", "4", "@2x"],
    ["a pixel ratio twice", "3", "4", "2@2x@2x"],
    ["a pixel ratio after the column", "3", "4@2x", "2"],
    ["a pixel ratio after the zoom", "3@2x", "4", "2"],
    ["a pixel ratio placeholder left unfilled", "3", "4", "2{ratio}"],
  ])("refuses %s without asking the imagery", async (_what, z, x, y) => {
    const tile = await call(`/api/basemaps/satellite/tiles/${z}/${x}/${y}`, "member");
    expect(tile.status).toBe(400);
    expect(tile.body).toEqual({ error: { code: "invalid_request", message: expect.any(String) } });
    expect(asked).toEqual([]);
  });

  it("answers as the style does while no imagery is configured", async () => {
    vi.stubEnv("DEZFIL_SATELLITE_URL", undefined);
    for (const pathname of [STYLE, "/api/basemaps/satellite/tiles/3/4/2"]) {
      const none = await call(pathname, "member");
      expect(none.status, pathname).toBe(404);
      expect(none.body, pathname).toEqual({ error: "No satellite imagery is configured on this instance." });
      expect(none.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(asked).toEqual([]);
  });

  it("draws nothing from a template carrying a user name or password, asking the imagery nothing", async () => {
    vi.stubEnv("DEZFIL_SATELLITE_URL", `http://${SEEDS[0]}:${SEEDS[1]}@127.0.0.1:${port}/{z}/{x}/{y}.png`);
    const tile = await call("/api/basemaps/satellite/tiles/3/4/2", "member");
    expect(tile.status).toBe(502);
    expect(tile.body).toEqual(refusal);
    expectNoTemplate("the refusal", tile);
    expect(asked).toEqual([]);
  });
});

/** MapLibre's own tile, whose `url` is what its raster source fills a
 * tile template with for every tile it asks: read from the installed
 * package's source, so the relay is held to the function itself rather
 * than to a restatement of it. */
type MapLibreTile = { url(urls: string[], pixelRatio: number, scheme?: string): string };
async function maplibreTile(z: number, x: number, y: number): Promise<MapLibreTile> {
  const dir = dirname(createRequire(import.meta.url).resolve("maplibre-gl/package.json"));
  const { CanonicalTileID } = await import(/* @vite-ignore */ join(dir, "src/tile/tile_id.ts")) as
    { CanonicalTileID: new (z: number, x: number, y: number) => MapLibreTile };
  return new CanonicalTileID(z, x, y);
}
/** Tiles at the corners and inside of their zooms, the deepest included. */
const SAMPLE_TILES = [[0, 0, 0], [1, 1, 0], [3, 4, 2], [7, 100, 37], [12, 2200, 1343], [19, 524287, 0], [19, 280001, 170003]] as const;

describe("a tile template's placeholders", () => {
  it.each([
    ["z, x and y", "{z}/{x}/{y}.png"],
    ["the pixel ratio", "{z}/{x}/{y}{ratio}.png"],
    ["the quadkey", "q/{quadkey}.jpeg"],
    ["the prefix", "{prefix}/{z}/{x}/{y}.png"],
    ["the bounding box, in the query", "wms?bbox={bbox-epsg-3857}&width=256"],
    ["every one together, twice", "{prefix}/{z}-{x}-{y}{ratio}/{quadkey}/{z}?bbox={bbox-epsg-3857}&q={quadkey}&r={ratio}"],
  ])("asks the imagery for the address MapLibre fills with %s, at either pixel ratio", async (_what, path) => {
    const imagery = `http://127.0.0.1:${port}/${SEEDS[0]}/${path}${path.includes("?") ? "&" : "?"}key=${SEEDS[1]}`;
    vi.stubEnv("DEZFIL_SATELLITE_URL", imagery);
    const style = await call(STYLE, "member");
    const source = (style.body as { sources: { satellite: { tiles: string[]; scheme?: string } } }).sources.satellite;
    for (const [z, x, y] of SAMPLE_TILES) for (const ratio of [1, 2]) {
      asked = [];
      const tile = await maplibreTile(z, x, y);
      // The address MapLibre asks of the instance, from the style it is handed...
      const relayed = await call(tile.url(source.tiles, ratio, source.scheme), "member");
      expect(relayed.status, `${z}/${x}/${y} at ${ratio}`).toBe(200);
      // ...is answered from the address it asked of the imagery when it was
      // handed the template itself.
      const direct = new URL(tile.url([imagery], ratio, source.scheme));
      expect(asked.map((a) => a.url), `${z}/${x}/${y} at ${ratio}`).toEqual([direct.pathname + direct.search]);
    }
  });

  it("fills the template by the scheme the style's source declares, counting the rows of a TMS source as MapLibre does", async () => {
    const template = "https://imagery.example/{z}/{x}/{y}{ratio}/{quadkey}/{prefix}.png?bbox={bbox-epsg-3857}";
    const relay = satelliteTilesUrl(STYLE);
    for (const scheme of ["xyz", "tms"] as const) for (const [z, x, y] of SAMPLE_TILES) for (const ratio of [1, 2]) {
      const tile = await maplibreTile(z, x, y);
      // The parts of the relay's own address, as MapLibre fills it for this source.
      const [zs, xs, ys] = tile.url([relay], ratio, scheme).slice(`${STYLE}/tiles/`.length).split("/");
      const requested = readTileCoordinate(zs, xs, ys);
      expect(requested, `${scheme} ${z}/${x}/${y} at ${ratio}`).not.toBeNull();
      expect(tileAddress(template, requested!, scheme), `${scheme} ${z}/${x}/${y} at ${ratio}`)
        .toBe(tile.url([template], ratio, scheme));
    }
  });
});

describe("an upstream failure", () => {
  const echo = (status: number, type: string): Handler => (req, res) => {
    // Every part of the request the imagery saw, echoed back in its words
    // and its headers.
    res.writeHead(status, { "content-type": type, "x-echo": req.url ?? "", "set-cookie": `seen=${encodeURIComponent(req.url ?? "")}` });
    res.end(`<html>${req.url} ${JSON.stringify(req.headers)}</html>`);
  };

  it.each([
    ["an error status", echo(500, "text/html"), 502],
    ["a refusal of the key", echo(403, "image/png"), 502],
    ["a page in place of a tile", echo(200, "text/html"), 502],
    ["a page claiming to be an image", echo(200, "image/png"), 502],
    ["a picture a browser would run", (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    }, 502],
    ["a whole image past the size bound", (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(oversized());
    }, 502],
    ["an answer cut short", (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(TILE.length * 2) });
      res.write(TILE.subarray(0, 20));
      res.destroy();
    }, 502],
    ["a redirect into blocked space", (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(302, { location: `http://10.0.0.7/${SEEDS[0]}/3/4/2.png?key=${SEEDS[1]}` });
      res.end();
    }, 502],
  ])("answers the coded refusal for %s, its words, headers and the log free of the template and its key", async (_what, handler, status) => {
    answer = handler as Handler;
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const tile = await call("/api/basemaps/satellite/tiles/3/4/2", "member");
    expect(tile.status).toBe(status);
    expect(tile.body).toEqual(refusal);
    expect(tile.headers.get("content-type")).toMatch(/^application\/json/);
    expect(tile.headers.get("cache-control")).toBe("private, no-store");
    expect(tile.headers.get("set-cookie")).toBeNull();
    expectNoTemplate("the refusal", tile);
    for (const spy of logs) for (const args of spy.mock.calls) expectNoTemplate("the log", { text: args.map(String).join(" "), headers: new Headers() });
    expect(asked).toHaveLength(1);
  });

  it("answers the coded refusal where nothing listens at the tile host", async () => {
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    const tile = await call("/api/basemaps/satellite/tiles/3/4/2", "member");
    expect(tile.status).toBe(502);
    expect(tile.body).toEqual(refusal);
    expectNoTemplate("the refusal", tile);
    fixture = createServer(() => {});
  });

  it("answers the coded refusal for a tile host public at save and private at use, which it never contacts", async () => {
    vi.stubEnv("DEZFIL_SATELLITE_URL", undefined);
    const save = await call("/api/instance/settings", "admin", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ satelliteUrl: template("imagery.fixture.test") }) });
    expect(save.status, save.text).toBe(200);
    dns.lookup.mockReset();
    dns.lookup.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    const tile = await call("/api/basemaps/satellite/tiles/3/4/2", "member");
    expect(tile.status).toBe(502);
    expect(tile.body).toEqual(refusal);
    expectNoTemplate("the refusal", tile);
    // The name was looked up at use, and nothing reached the address it gave.
    expect(dns.lookup.mock.calls.map((args) => args[0])).toContain("imagery.fixture.test");
    expect(asked).toEqual([]);
  });

  it("answers the coded refusal once the imagery outlasts the wait, the tile abandoned", async () => {
    answer = () => { /* never answers */ };
    const { relaySatelliteTile } = await import("./basemap-satellite-tiles");
    await expect(relaySatelliteTile({ z: 3, x: 4, y: 2 }, { timeoutMs: 150 }))
      .rejects.toMatchObject({ code: "imagery_unavailable", status: 504 });
    expect(asked).toHaveLength(1);
  });
});

/** A member's map on a basemap, published with its reader controls. */
async function publishOn(basemap: "satellite" | "dark", settings: PublishSettings = {}): Promise<{ mapId: string; token: string }> {
  const scope = testAccountScope(db, "member");
  const revision = () => ({ expectedRevision: readDocumentRevision({ kind: "map", id: mapId }, db)?.editRevision });
  const mapId = createMap(scope, "Harbour from above").id;
  updateMap(scope, mapId, { basemap }, revision());
  const { token } = publishMap(scope, mapId, { theme: "dark", ...settings }, revision());
  return { mapId, token };
}
const unpublish = (mapId: string) => unpublishMap(testAccountScope(db, "member"), mapId,
  { expectedRevision: readDocumentRevision({ kind: "map", id: mapId }, db)?.editRevision });
const readerStyle = (token: string) => `/api/published/${token}/basemaps/satellite`;
const readerTile = (token: string, z = 3, x = 4, y = 2) => `${readerStyle(token)}/tiles/${z}/${x}/${y}`;
/** What the reader page hands the published view: its default style and its basemap list. */
async function readerPage(token: string) {
  const page = await PublishedPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) }) as
    ReactElement<{ children: ReactElement<{ basemapUrl: string; basemaps: BasemapStyle[] }> }>;
  return page.props.children.props;
}
const notAvailable = { error: { code: "not_found", message: "This map is not available." } };

describe("a published map's reader", () => {
  it("gets the satellite style and its tiles through the publication's own addresses, with none of the template", async () => {
    const { token } = await publishOn("satellite");
    const view = await call(`/api/published/${token}`, "anonymous");
    expect(view.status, view.text).toBe(200);
    expect((view.body as { basemapUrl: string }).basemapUrl).toBe(readerStyle(token));
    expectNoTemplate("the published view", view);
    // The reader page's list: Satellite at the publication's address, every other style as it was.
    const page = await readerPage(token);
    expect(page.basemaps.map((b) => [b.key, b.url])).toEqual([
      ["dark", "https://tiles.openfreemap.org/styles/dark"],
      ["light", "https://tiles.openfreemap.org/styles/positron"],
      ["streets", "https://tiles.openfreemap.org/styles/liberty"],
      ["satellite", readerStyle(token)],
    ]);
    const style = await call(readerStyle(token), "anonymous");
    expect(style.status, style.text).toBe(200);
    expect(style.headers.get("cache-control")).toBe("private, no-store");
    expect((style.body as { sources: { satellite: unknown } }).sources.satellite).toEqual({ type: "raster",
      tiles: [`/api/published/${token}/basemaps/satellite/tiles/{z}/{x}/{y}{ratio}`], scheme: "xyz", tileSize: 256, maxzoom: 19, attribution: CREDIT });
    expectNoTemplate("the reader's style", style);
    const { tiles, scheme } = (style.body as { sources: { satellite: { tiles: string[]; scheme: string } } }).sources.satellite;
    const tile = await call((await maplibreTile(3, 4, 2)).url(tiles, 2, scheme), "anonymous");
    expect(tile.status, tile.text).toBe(200);
    expect(tile.headers.get("content-type")).toBe("image/png");
    expect(tile.headers.get("cache-control")).toBe("private, no-store");
    expect(tile.bytes.equals(TILE)).toBe(true);
    expectNoTemplate("the reader's tile", tile);
    expect(asked.map((a) => a.url)).toEqual([`/${SEEDS[0]}/3/4/2.png?key=${SEEDS[1]}`]);
    // The signed-in addresses still refuse a reader who is not signed in.
    for (const pathname of [STYLE, "/api/basemaps/satellite/tiles/3/4/2"]) expect((await call(pathname, "anonymous")).status, pathname).toBe(401);
  });

  it("is refused the style and the tile of a revoked or unknown publication as its layer tiles are, the imagery asked nothing", async () => {
    const { mapId, token } = await publishOn("satellite");
    expect((await call(readerStyle(token), "anonymous")).status).toBe(200);
    unpublish(mapId);
    resetPublishCache();
    for (const gone of [token, "u".repeat(22)]) {
      // The published layer tiles' own refusal, for the same token.
      const layerTile = await call(`/api/published/${gone}/tiles/L/0/0/0`, "anonymous");
      expect(layerTile.body).toEqual(notAvailable);
      for (const pathname of [readerStyle(gone), readerTile(gone)]) {
        const refused = await call(pathname, "anonymous");
        expect(refused.status, pathname).toBe(404);
        expect(refused.body, pathname).toEqual(layerTile.body);
        expect(refused.headers.get("cache-control")).toBe("private, no-store");
      }
    }
    expect(asked).toEqual([]);
  });

  it("is refused a tile whose publication is revoked while the imagery answers", async () => {
    const { mapId, token } = await publishOn("satellite");
    answer = (req, res) => { unpublish(mapId); healthy(req, res); };
    const tile = await call(readerTile(token), "anonymous");
    expect(tile.status).toBe(404);
    expect(tile.body).toEqual(notAvailable);
    expect(asked).toHaveLength(1);
  });

  it("is served the imagery only where the publication's reader can see it: on the map's own style, or offered in its switcher", async () => {
    const offered = await publishOn("dark");
    const closed = await publishOn("dark", { viewerControls: { basemap: false } });
    const own = await publishOn("satellite", { viewerControls: { basemap: false } });
    const served = async (token: string) => (await call(readerStyle(token), "anonymous")).status === 200 &&
      (await call(readerTile(token), "anonymous")).status === 200;
    expect(await served(offered.token), "offered in the switcher").toBe(true);
    expect(await served(own.token), "the map's own style").toBe(true);
    asked = [];
    for (const pathname of [readerStyle(closed.token), readerTile(closed.token)]) {
      const refused = await call(pathname, "anonymous");
      expect(refused.status, pathname).toBe(404);
      expect(refused.body, pathname).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    }
    // An admin hides Satellite: a map on it keeps drawing it, the switcher no longer offers it.
    const save = await call("/api/instance/settings", "admin", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ "basemaps.satellite": false }) });
    expect(save.status, save.text).toBe(200);
    resetPublishCache();
    expect(await served(own.token), "the map's own style, hidden").toBe(true);
    asked = [];
    expect((await call(readerStyle(offered.token), "anonymous")).status, "hidden from the switcher").toBe(404);
    expect((await call(readerTile(offered.token), "anonymous")).status, "hidden from the switcher").toBe(404);
    expect(asked).toEqual([]);
  });

  it("answers as the instance does now while no imagery is configured", async () => {
    const { token } = await publishOn("satellite");
    vi.stubEnv("DEZFIL_SATELLITE_URL", undefined);
    resetPublishCache();
    for (const pathname of [readerStyle(token), readerTile(token)]) {
      const none = await call(pathname, "anonymous");
      expect(none.status, pathname).toBe(404);
      expect(none.body, pathname).toEqual({ error: "No satellite imagery is configured on this instance." });
    }
    expect(asked).toEqual([]);
  });

  it("is refused a tile address outside the imagery before anything is asked", async () => {
    const { token } = await publishOn("satellite");
    for (const [z, x, y] of [[20, 0, 0], [3, 8, 0]] as const) {
      const tile = await call(readerTile(token, z, x, y), "anonymous");
      expect(tile.status).toBe(400);
      expect(tile.body).toEqual({ error: { code: "invalid_request", message: expect.any(String) } });
    }
    expect(asked).toEqual([]);
  });

  it("reaches the reader's addresses without signing in, by GET and HEAD alone, and is refused without the ingress provenance", async () => {
    const { token } = await publishOn("satellite");
    const gate = (pathname: string, method: string) => gateRequest(new NextRequest(socketRequest(new Request(`${ORIGIN}${pathname}`, { method }))));
    for (const pathname of [readerStyle(token), readerTile(token)]) {
      for (const method of ["GET", "HEAD"]) expect(gate(pathname, method).headers.get("x-middleware-next"), `${method} ${pathname}`).toBe("1");
      expect(gate(pathname, "POST").status, `POST ${pathname}`).toBe(401);
    }
    expect(gate("/api/basemaps/satellite/tiles/3/4/2", "GET").status).toBe(401);
    const route = await import("@/app/api/published/[token]/basemaps/satellite/route");
    const unstamped = await route.GET(new Request(`${ORIGIN}${readerStyle(token)}`), { params: Promise.resolve({ token }) });
    expect(unstamped.status).toBe(503);
    expect(await unstamped.json()).toEqual({ error: { code: "ingress_unavailable", message: expect.any(String) } });
  });
});

describe("an image export of a map on Satellite", () => {
  const EGRESS_REFUSAL = "The map reaches an address this instance's egress policy denies (private and internal ranges). The image was not produced.";
  const definition = () => initialDefinition({ appearance: "light", camera: { lng: 13.4, lat: 52.5, zoom: 11 }, canvasWidth: 1200,
    legendPresent: false, legendCorner: null, visibleWidgetIds: [], basemapLayers: null }, { width: 1920, scale: 1 });
  let launches = 0;
  const driver: RenderDriver = { launch: async () => {
    launches += 1;
    return { render: async () => ({ png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }), close: async () => {}, kill: () => {} };
  } };
  const exportOf = (mapId: string) => renderMapImage(testAccountScope(db, "member"), {
    mapId, definition: definition(), credential: "fixture-render-credential", baseUrl: "http://127.0.0.1:3620", driver });
  /** A member's map on a basemap, unpublished. */
  const mapOn = (basemap: "satellite" | "dark") => {
    const scope = testAccountScope(db, "member");
    const id = createMap(scope, "Harbour from above").id;
    updateMap(scope, id, { basemap }, { expectedRevision: readDocumentRevision({ kind: "map", id }, db)?.editRevision });
    return id;
  };
  /** The tile host stored while it answers publicly, then answering as `atUse` says. */
  async function storeTemplate(atUse: { address: string; family: number }[] | "unresolved") {
    vi.stubEnv("DEZFIL_SATELLITE_URL", undefined);
    dns.lookup.mockReset();
    dns.lookup.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
    const save = await call("/api/instance/settings", "admin", { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ satelliteUrl: template("imagery.fixture.test") }) });
    expect(save.status, save.text).toBe(200);
    dns.lookup.mockReset();
    if (atUse === "unresolved") dns.lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND imagery.fixture.test"), { code: "ENOTFOUND" }));
    else dns.lookup.mockResolvedValue(atUse);
  }
  beforeEach(() => { launches = 0; });

  it("is refused with the egress refusal before any render when the outbound policy refuses the imagery's host, the imagery asked nothing", async () => {
    const id = mapOn("satellite");
    await storeTemplate([{ address: "10.0.0.7", family: 4 }]);
    await expect(exportOf(id)).rejects.toMatchObject({ code: "render_failed", status: 502, message: EGRESS_REFUSAL });
    expect(launches, "no browser launched").toBe(0);
    expect(dns.lookup.mock.calls.map((args) => args[0])).toContain("imagery.fixture.test");
    expect(asked).toEqual([]);
  });

  it("renders while the policy admits the host, where the host does not resolve, and for a map not on Satellite", async () => {
    const satellite = mapOn("satellite");
    const dark = mapOn("dark");
    await storeTemplate([{ address: "203.0.113.10", family: 4 }]);
    await exportOf(satellite);
    expect(launches).toBe(1);
    dns.lookup.mockReset();
    dns.lookup.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    await exportOf(dark);
    expect(launches, "a map not on Satellite asks nothing of the imagery's host").toBe(2);
    await storeTemplate("unresolved");
    await exportOf(satellite);
    expect(launches, "a dead name is no refusal, as before").toBe(3);
  });
});
