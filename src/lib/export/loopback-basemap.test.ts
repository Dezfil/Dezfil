import { describe, expect, it } from "vitest";
import { startLoopbackBasemap, assertBasemapTraffic } from "../../../scripts/loopback-basemap.mjs";
import { countColored, decodePng } from "../../../scripts/png-probe.mjs";

describe("loopback basemap measurement", () => {
  it("offers light and dark styles that both fetch loopback raster tiles", async () => {
    const fixture = await startLoopbackBasemap();
    try {
      const light = await fetch(new URL("/light/style.json", fixture.styleUrl)).then(response => response.json());
      const dark = await fetch(new URL("/dark/style.json", fixture.styleUrl)).then(response => response.json());
      expect(light.sources).toEqual(dark.sources);
      expect(light.layers[0].type).toBe("raster");
      expect(dark.layers[0].paint["raster-brightness-max"]).toBeLessThan(1);
      expect(dark.layers).not.toEqual(light.layers);
      expect(new URL(light.sources.fixture.tiles[0]).origin).toBe(new URL(fixture.styleUrl).origin);
    } finally { await fixture.close(); }
  });
  it("serves a self-contained CORS style and neutral, opaque PNG without caching", async () => {
    const fixture = await startLoopbackBasemap();
    try {
      const response = await fetch(fixture.styleUrl);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const style = await response.json();
      expect(style.version).toBe(8);
      expect(style.glyphs).toBeUndefined();
      expect(style.sprite).toBeUndefined();
      expect(Object.keys(style.sources)).toEqual(["fixture"]);
      const source = style.sources.fixture;
      expect(source.type).toBe("raster");
      expect(source.tileSize).toBe(512);
      expect(style.layers).toEqual([{ id: "fixture", type: "raster", source: "fixture" }]);
      const tileUrl = source.tiles[0].replace("{z}", "11").replace("{x}", "1100").replace("{y}", "680");
      expect(new URL(tileUrl).origin).toBe(new URL(fixture.styleUrl).origin);
      const tile = await fetch(tileUrl);
      expect(tile.headers.get("access-control-allow-origin")).toBe("*");
      expect(tile.headers.get("cache-control")).toBe("no-store");
      expect(tile.headers.get("content-type")).toBe("image/png");
      const png = decodePng(Buffer.from(await tile.arrayBuffer()));
      expect(png.at(0, 0)).toEqual([240, 240, 240, 255]);
      expect(countColored(png)).toBe(0);
    } finally {
      await fixture.close();
    }
    await expect(fetch(fixture.styleUrl)).rejects.toThrow();
  });

  it("rejects earlier traffic, a style without tiles, and parent-only traffic", async () => {
    const fixture = await startLoopbackBasemap();
    const origin = new URL(fixture.styleUrl).origin;
    try {
      await fetch(fixture.styleUrl).then((r) => r.text());
      await fetch(`${origin}/tiles/11/1100/680.png`).then((r) => r.arrayBuffer());
      const before = fixture.snapshot(10.5);
      expect(fixture.delta(before, 10.5)).toEqual({ styles: 0, viewportTiles: 0 });
      expect(() => assertBasemapTraffic(fixture.delta(before, 10.5))).toThrow(/fixture style/);
      await fetch(fixture.styleUrl).then((r) => r.text());
      expect(() => assertBasemapTraffic(fixture.delta(before, 10.5))).toThrow(/viewport tile/);
      await fetch(`${origin}/tiles/10/550/340.png`).then((r) => r.arrayBuffer());
      expect(fixture.delta(before, 10.5)).toEqual({ styles: 1, viewportTiles: 0 });
      expect(() => assertBasemapTraffic(fixture.delta(before, 10.5))).toThrow(/viewport tile/);
      await fetch(`${origin}/tiles/11/1100/680.png`).then((r) => r.arrayBuffer());
      expect(fixture.delta(before, 10.5)).toEqual({ styles: 1, viewportTiles: 1 });
      expect(() => assertBasemapTraffic(fixture.delta(before, 10.5))).not.toThrow();
    } finally {
      await fixture.close();
    }
  });

  it("cannot borrow another simultaneous export's fixture traffic", async () => {
    const first = await startLoopbackBasemap();
    const second = await startLoopbackBasemap();
    try {
      const firstBefore = first.snapshot(10);
      const secondBefore = second.snapshot(10);
      await fetch(first.styleUrl).then((r) => r.text());
      await fetch(new URL("/tiles/10/550/340.png", first.styleUrl)).then((r) => r.arrayBuffer());
      expect(() => assertBasemapTraffic(first.delta(firstBefore, 10))).not.toThrow();
      expect(second.delta(secondBefore, 10)).toEqual({ styles: 0, viewportTiles: 0 });
      expect(() => assertBasemapTraffic(second.delta(secondBefore, 10))).toThrow(/fixture style/);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
