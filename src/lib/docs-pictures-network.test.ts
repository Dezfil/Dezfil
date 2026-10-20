// What the picture script's browser may ask for off the instance: the
// built-in basemap from a scene that shows a map, and nothing else, and the
// marks the script reads to know a map's basemap is drawn.
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: plain-JS scripts, no declaration files on purpose.
import { BASEMAP_CONTENT_ORIGINS, BASEMAP_ORIGINS, mayRequest, requestsOffInstance } from "../../scripts/docs-pictures-network.mjs";
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
