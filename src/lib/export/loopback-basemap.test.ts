import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
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

/** A loopback port free a moment ago. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe("the loopback basemap's two uses", () => {
  it("stays a module the browser suite's loader can read: no module-only syntax at its top", () => {
    // The browser suite reads this file through a loader that makes plain
    // scripts of it, where import.meta and a top-level await do not parse.
    const source = readFileSync("scripts/loopback-basemap.mjs", "utf8");
    expect(source).not.toMatch(/import\.meta/);
    expect(source).not.toMatch(/^[^\s/*].*\bawait\b/m);
  });

  it("starts from the command line on the port it is given and answers its style there until it is stopped", async () => {
    const port = await freePort();
    const server = spawn(process.execPath, ["scripts/loopback-basemap-serve.mjs", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve) => server.once("exit", resolve));
    try {
      const printed = await Promise.race([
        new Promise<string>((resolve) => {
          let out = "";
          server.stdout.on("data", (chunk) => {
            out += chunk;
            if (out.includes("\n")) resolve(out.trim());
          });
        }),
        exited.then((code) => { throw new Error(`The command exited (${code}) before it served.`); }),
      ]);
      expect(printed).toBe(`http://127.0.0.1:${port}/style.json`);
      const style = await fetch(printed);
      expect(style.status).toBe(200);
      expect((await style.json()).version).toBe(8);
    } finally {
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
      await exited;
    }
  });

  it("refuses to start without a port of its own", async () => {
    for (const args of [[], ["3000"], ["not-a-port"]]) {
      const refused = spawn(process.execPath, ["scripts/loopback-basemap-serve.mjs", ...args], { stdio: "ignore" });
      const code = await new Promise((resolve) => refused.once("exit", resolve));
      expect(code, args.join(" ") || "no port").not.toBe(0);
    }
  });
});
