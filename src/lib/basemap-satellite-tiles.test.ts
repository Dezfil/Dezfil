/// <reference types="vite/client" />
import type { Database } from "better-sqlite3";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The engine's own lookup, answered by a fixture resolver, so a tile host
// can answer publicly at save and privately at use.
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import * as metadata from "@/lib/metadata/db";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { encodePng } from "@/lib/export/png-codec";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { tokenFor } from "@/lib/test-support/rule-roads";

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
  fixture = createServer((req, res) => { asked.push({ url: req.url ?? "", headers: req.headers }); answer(req, res); });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  port = (fixture.address() as AddressInfo).port;
  vi.stubEnv("DEZFIL_SATELLITE_URL", template());
  vi.stubEnv("DEZFIL_SATELLITE_ATTRIBUTION", CREDIT);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetSecretKeyCache();
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
        .toEqual({ type: "raster", tiles: ["/api/basemaps/satellite/tiles/{z}/{x}/{y}"], tileSize: 256, maxzoom: 19, attribution: CREDIT });
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
    const [tiles] = (style.body as { sources: { satellite: { tiles: string[] } } }).sources.satellite.tiles;
    const tile = await call(tiles.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0"), "member");
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
