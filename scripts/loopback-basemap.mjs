// Test-only basemap shared by Playwright and the plain Node API journey.
// Keep every dependency in the renderer's network namespace.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

// Opaque neutral gray: no data hue, dark ink or attribution-gray signal.
const TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP48OHDfwAJdAPQXHvArAAAAABJRU5ErkJggg==",
  "base64",
);

export async function startLoopbackBasemap(port = 0) {
  let styles = 0;
  /** @type {Map<number, number>} */
  const tiles = new Map();
  let origin = "";
  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && ["/style.json", "/light/style.json", "/dark/style.json"].includes(url.pathname)) {
      styles += 1;
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify({
        version: 8,
        sources: {
          fixture: {
            type: "raster",
            tiles: [`${origin}/tiles/{z}/{x}/{y}.png`],
            tileSize: 512,
            maxzoom: 22,
          },
        },
        layers: [{ id: "fixture", type: "raster", source: "fixture",
          ...(url.pathname === "/dark/style.json" ? { paint: { "raster-brightness-max": 0.15 } } : {}) }],
      }));
      return;
    }
    const tile = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
    if (req.method === "GET" && tile) {
      const zoom = Number(tile[1]);
      tiles.set(zoom, (tiles.get(zoom) ?? 0) + 1);
      res.writeHead(200, { ...headers, "content-type": "image/png" });
      res.end(TILE);
      return;
    }
    res.writeHead(404, headers);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;

  // MapLibre's raster source rounds zoom. At tileSize 512 there is no
  // tile-size zoom offset. Count the requested viewport level, excluding
  // lower-resolution parent prefetches (all these export cameras are flat).
  const snapshot = (zoom) => ({
    styles,
    viewportTiles: tiles.get(Math.min(22, Math.round(zoom))) ?? 0,
  });
  return {
    styleUrl: `${origin}/style.json`,
    snapshot,
    delta(before, zoom) {
      const after = snapshot(zoom);
      return {
        styles: after.styles - before.styles,
        viewportTiles: after.viewportTiles - before.viewportTiles,
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve(undefined));
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535 && port !== 3000, "Supply a separate loopback fixture port");
  const fixture = await startLoopbackBasemap(port);
  console.log(fixture.styleUrl);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void fixture.close(); });
}

/** A successful PNG with zero traffic is only an offline fallback. */
export function assertBasemapTraffic(delta) {
  assert.equal(delta.styles, 1, "each export must fetch one fixture style");
  assert(delta.viewportTiles >= 1, "each export must fetch a fixture viewport tile");
}
