// What the picture script's browser may ask for off the instance: the
// built-in basemap from a scene that shows a map, and nothing else, and the
// marks the script reads to know a map's basemap is drawn. The refusals are
// proved here over the rule and the scene's watch; the picture runs that
// fail on them in a browser are recorded with the change that added them.
import { describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: plain-JS scripts, no declaration files on purpose.
import { BASEMAP_CONTENT_ORIGINS, BASEMAP_ORIGINS, basemapSource, mayRequest, problemsMessage, requestsOffInstance, sceneNetwork } from "../../scripts/docs-pictures-network.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { MAP_MARKS } from "../../scripts/docs-pictures-capture.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: as above.
import { SCENES } from "../../scripts/docs-pictures-scenes.mjs";
import { BASEMAPS } from "@/lib/basemap";
import { PAINTED_BASEMAP_KEY } from "@/components/map/capture";
import { MAP_IDLE_KEY } from "@/components/map/idle-stamp";

const origin = "http://127.0.0.1:3411";
const asks = (url: string, map: boolean) => mayRequest(url, { origin, map }) as boolean;
/** A dataset key as the attribute it writes. */
const attribute = (key: string) => `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

describe("the built-in basemap's hosts", () => {
  it("are the host of every built-in style the app lists, and the hosts those styles name, nothing more", () => {
    const styles = BASEMAPS.map((style) => new URL(style.url).origin);
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) expect(BASEMAP_ORIGINS).toContain(style);
    expect(new Set(BASEMAP_ORIGINS)).toEqual(new Set([...styles, ...BASEMAP_CONTENT_ORIGINS]));
    for (const host of BASEMAP_ORIGINS) expect(new URL(host).origin).toBe(host);
  });
});

describe("a map scene's requests", () => {
  it("reach the instance and the built-in basemap's styles, tiles, glyphs and sprites", () => {
    for (const style of BASEMAPS) expect(asks(style.url, true)).toBe(true);
    expect(asks("https://tiles.openfreemap.org/planet", true)).toBe(true);
    expect(asks("https://tiles.openfreemap.org/planet/20261018_080001_pt/2/2/1.pbf", true)).toBe(true);
    expect(asks("https://tiles.openfreemap.org/natural_earth/ne2sr/2/2/1.png", true)).toBe(true);
    expect(asks("https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf", true)).toBe(true);
    expect(asks("https://tiles.openfreemap.org/sprites/ofm_f384/ofm@2x.json", true)).toBe(true);
    expect(asks(`${origin}/api/maps`, true)).toBe(true);
  });

  it("of any other scene reach the instance", () => {
    expect(asks(`${origin}/templates`, false)).toBe(true);
    expect(asks(`${origin}/_next/static/chunks/app.js`, false)).toBe(true);
  });
});

const basemap = [
  ...BASEMAPS.map((style) => style.url),
  "https://tiles.openfreemap.org/planet",
  "https://tiles.openfreemap.org/planet/20261018_080001_pt/2/2/1.pbf",
  "https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf",
];

describe("the rule's refusals", () => {
  it("refuse an unrelated host in a map scene and in any other scene", () => {
    for (const map of [true, false]) {
      expect(asks("https://unrelated.example/seed.json", map)).toBe(false);
      expect(asks("https://fonts.googleapis.com/css2?family=Inter", map)).toBe(false);
    }
  });

  it("refuse the built-in basemap's host from a scene that shows no map", () => {
    for (const url of basemap) expect(asks(url, false)).toBe(false);
    // Only a declared map scene counts, not a truthy stand-in for one.
    expect(mayRequest(basemap[0], { origin, map: 1 as unknown as boolean })).toBe(false);
    expect(mayRequest(basemap[0], { origin })).toBe(false);
  });

  it("refuse, even in a map scene, an address that only looks like the basemap's or the instance's", () => {
    for (const url of [
      "http://tiles.openfreemap.org/styles/positron",
      "https://tiles.openfreemap.org:8443/styles/positron",
      "https://tiles.openfreemap.org.example/styles/positron",
      "https://maps.openfreemap.org/styles/positron",
      "https://tiles.openfreemap.org@unrelated.example/styles/positron",
      "https://unrelated.example/?next=https://tiles.openfreemap.org/styles/positron",
      "http://127.0.0.1:3000/api/maps",
      "http://localhost:3411/api/maps",
      "https://127.0.0.1:3411/api/maps",
      "data:application/json,{}",
      "not an address",
    ]) expect(asks(url, true), url).toBe(false);
  });
});

/** A routed request as the browser context hands it over. */
const routed = (url: string) => ({ request: () => ({ url: () => url }), continue: vi.fn(), abort: vi.fn() });
/** A failed request, with the browser's reason. */
const failedRequest = (url: string, errorText: string) => ({ url: () => url, failure: () => ({ errorText }) });
/** An answer, with its status. */
const answer = (url: string, status: number) => ({ url: () => url, status: () => status });

const mapScene = { id: "first-map", map: true };
const plainScene = { id: "setup-card" };

describe("a scene's watch over its requests", () => {
  it("lets a map scene reach the instance and the basemap, and refuses and names an unrelated host", () => {
    const network = sceneNetwork(origin);
    network.begin(mapScene);
    const requests = [`${origin}/api/maps`, ...basemap, "https://unrelated.example/seed.json"].map(routed);
    for (const request of requests) network.route(request);
    for (const request of requests.slice(0, -1)) {
      expect(request.continue).toHaveBeenCalledOnce();
      expect(request.abort).not.toHaveBeenCalled();
    }
    expect(requests.at(-1)!.abort).toHaveBeenCalledOnce();
    expect(requests.at(-1)!.continue).not.toHaveBeenCalled();
    const problems = network.end();
    expect(problems).toEqual([{ kind: "refused", url: "https://unrelated.example/seed.json" }]);
    expect(problemsMessage(mapScene, problems, { theme: "dark" })).toBe(
      "first-map (dark take): the page asked for addresses off the instance and off the built-in basemap, which the run refuses:\n  https://unrelated.example/seed.json",
    );
  });

  it("refuses and names an unrelated host from a scene that shows no map", () => {
    const network = sceneNetwork(origin);
    network.begin(plainScene);
    const request = routed("https://unrelated.example/seed.json");
    network.route(request);
    expect(request.abort).toHaveBeenCalledOnce();
    const problems = network.end();
    expect(problemsMessage(plainScene, problems)).toBe(
      "setup-card: the page asked for addresses off the instance, which the run refuses:\n  https://unrelated.example/seed.json",
    );
  });

  it("refuses and names the basemap's host from a scene that shows no map, and says how a map scene is declared", () => {
    const network = sceneNetwork(origin);
    network.begin(plainScene);
    const requests = basemap.map(routed);
    for (const request of requests) network.route(request);
    for (const request of requests) expect(request.abort).toHaveBeenCalledOnce();
    // The context reports the aborts it was told to make as failed requests;
    // they are refusals, written down once.
    for (const url of basemap) network.failed(failedRequest(url, "net::ERR_FAILED"));
    const problems = network.end();
    expect(problems).toEqual(basemap.map((url) => ({ kind: "refused", url })));
    const message = problemsMessage(plainScene, problems);
    for (const url of basemap) expect(message).toContain(`\n  ${url}`);
    expect(message).toContain("setup-card: the built-in basemap is reached only from a scene that shows a map, declared with map: true.");
  });

  it("fails a map scene whose basemap is unreachable or answers with an error, naming each address and why", () => {
    const network = sceneNetwork(origin);
    network.begin(mapScene);
    network.failed(failedRequest(basemap[1], "net::ERR_CONNECTION_REFUSED"));
    network.failed(failedRequest(basemap[4], "net::ERR_NAME_NOT_RESOLVED"));
    network.answered(answer(basemap[5], 503));
    network.answered(answer(basemap[3], 404));
    const problems = network.end();
    expect(problems).toHaveLength(4);
    expect(problemsMessage(mapScene, problems, { theme: "light" })).toBe([
      "first-map (light take): the built-in basemap did not load:",
      `  ${basemap[1]} (net::ERR_CONNECTION_REFUSED)`,
      `  ${basemap[4]} (net::ERR_NAME_NOT_RESOLVED)`,
      `  ${basemap[5]} (answered 503)`,
      `  ${basemap[3]} (answered 404)`,
    ].join("\n"));
  });

  it("does not fail a map scene on a basemap answer that arrived, a tile the map gave up on, or the instance's own requests", () => {
    const network = sceneNetwork(origin);
    network.begin(mapScene);
    network.answered(answer(basemap[3], 200));
    network.answered(answer(basemap[3], 304));
    network.failed(failedRequest(basemap[4], "net::ERR_ABORTED"));
    network.failed(failedRequest(`${origin}/api/maps/m`, "net::ERR_CONNECTION_RESET"));
    network.answered(answer(`${origin}/api/maps/m`, 409));
    expect(network.end()).toEqual([]);
  });

  it("keeps each scene's problems to itself, and refuses the basemap between scenes", () => {
    const network = sceneNetwork(origin);
    network.begin(plainScene);
    network.route(routed("https://unrelated.example/one"));
    expect(network.end()).toHaveLength(1);
    network.begin(mapScene);
    network.route(routed(basemap[0]));
    expect(network.end()).toEqual([]);
    const between = routed(basemap[0]);
    network.route(between);
    expect(between.abort).toHaveBeenCalledOnce();
  });

  it("names each address once, and counts what is past a dozen", () => {
    const urls = Array.from({ length: 15 }, (_, i) => `https://unrelated.example/${i}`);
    const problems = [...urls, urls[0]].map((url) => ({ kind: "refused", url }));
    const message = problemsMessage(plainScene, problems);
    expect(message.match(/unrelated\.example\/0\n/g)).toHaveLength(1);
    expect(message).toContain("https://unrelated.example/11\n  and 3 more");
    expect(message).not.toContain("https://unrelated.example/12");
  });
});

describe("the basemap a run drew", () => {
  it("is named by its styles' addresses and its tile sets, the path before the tile's zoom, column and row", () => {
    for (const style of BASEMAPS) expect(basemapSource(style.url)).toBe(style.url);
    expect(basemapSource("https://tiles.openfreemap.org/planet/20261018_080001_pt/2/2/1.pbf")).toBe("https://tiles.openfreemap.org/planet/20261018_080001_pt/");
    expect(basemapSource("https://tiles.openfreemap.org/natural_earth/ne2sr/3/4/2.png")).toBe("https://tiles.openfreemap.org/natural_earth/ne2sr/");
    expect(basemapSource("https://tiles.openfreemap.org/natural_earth/ne2sr/3/4/2@2x.png")).toBe("https://tiles.openfreemap.org/natural_earth/ne2sr/");
    // The tile description, glyphs and sprites follow from the style.
    expect(basemapSource("https://tiles.openfreemap.org/planet")).toBeNull();
    expect(basemapSource("https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf")).toBeNull();
    expect(basemapSource("https://tiles.openfreemap.org/sprites/ofm_f384/ofm@2x.png")).toBeNull();
  });

  it("is gathered from what the basemap answered in the context's map scenes, across scenes, and only that", () => {
    const network = sceneNetwork(origin);
    const tiles = (set: string) => `https://tiles.openfreemap.org/planet/${set}/1/0/1.pbf`;
    network.begin(mapScene);
    network.answered(answer(basemap[1], 200));
    network.answered(answer(tiles("20261018_080001_pt"), 200));
    network.answered(answer(tiles("20261025_080001_pt"), 503));
    network.answered(answer(`${origin}/api/maps/m/1/0/1.pbf`, 200));
    network.end();
    network.begin(mapScene);
    network.answered(answer(basemap[0], 200));
    network.answered(answer(tiles("20261018_080001_pt").replace("/1/0/1.", "/2/1/1."), 200));
    network.end();
    network.begin(plainScene);
    network.answered(answer(basemap[2], 200));
    network.end();
    expect(network.sources()).toEqual([basemap[0], basemap[1], "https://tiles.openfreemap.org/planet/20261018_080001_pt/"].sort());
  });
});

describe("the server's own requests", () => {
  it("stay inside the run when they go to the instance itself, and any other host is named", () => {
    const rows = [
      { engine: "fetch", method: "GET", host: "127.0.0.1:3411", path: "/api/health", pid: 1 },
      { engine: "http", method: "GET", host: "tiles.openfreemap.org", path: "/styles/positron", pid: 1 },
      { engine: "fetch", method: "GET", host: "127.0.0.1:3000", path: "/api/health", pid: 1 },
    ];
    expect(requestsOffInstance(rows, origin)).toEqual([rows[1], rows[2]]);
    expect(requestsOffInstance(rows.slice(0, 1), origin)).toEqual([]);
  });
});

describe("the marks the script waits on", () => {
  it("are the ones the app's map writes on its host", () => {
    expect(MAP_MARKS.painted).toBe(attribute(PAINTED_BASEMAP_KEY));
    expect(MAP_MARKS.idle).toBe(attribute(MAP_IDLE_KEY));
  });

  it("are written by the map every surface draws: the basemap lifecycle attaches the idle stamp", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/components/map/use-basemap-style.ts", "utf8")).toMatch(/attachIdleStamp\(instance, instance\.getContainer\(\)\)/);
  });
});

describe("the scene list", () => {
  it("declares a map scene with map: true, and no scene with any other value", () => {
    for (const scene of SCENES as { id: string; map?: unknown }[]) {
      if ("map" in scene) expect(scene.map, scene.id).toBe(true);
    }
  });
});
