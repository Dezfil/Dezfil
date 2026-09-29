import { testAccountScope } from "@/lib/test-support/accounts";
import { delegateCredential } from "@/lib/auth/delegation";
import { requireRequestAuth } from "@/lib/auth/http";
import { authenticatedRequest } from "@/lib/assistant/testing/account";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { limits } from "@/lib/limits";
import { lookAtMap } from "./map-look";
import { decodePng } from "./png-codec";
import { renderRequestBoundMs } from "./render-stall";

/**
 * The real proof: the map check against a basemap whose tile host never
 * answers. The renderer abandons the stalled external request at the bound
 * resolved from the check's own budget, the page settles, and the check
 * answers an image whose composition names the host, instead of the coded
 * timeout the check returned when the export road's 20 s bound left a 30 s
 * budget no room. Stall fixture, on the check's road.
 *
 * Provisioning: DEZFIL_STALLED_TILES_RENDER names a production standalone's
 * port; DEZFIL_DATA_DIR is the directory both share; DEZFIL_CHROMIUM_PATH
 * points at a headless shell; DEZFIL_EGRESS_ALLOWLIST admits 127.0.0.1.
 * Skipped without the port.
 */
const port = process.env.DEZFIL_STALLED_TILES_RENDER;

/** One opaque pixel, the answer to every tile but the held one. */
const ONE_PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A raster style whose first viewport tile is held open for ever. A
 * prefetched parent that never arrives does not hold the map's idle; only
 * a tile the viewport needs does, which is what the stall is about
 * (learned in ` `). Without the CORS header the style fails to load and
 * the page settles on its offline fallback, which is a different case. */
async function startStallingBasemap() {
  const held: ServerResponse[] = [];
  let served = 0;
  let tiles = "";
  const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/style.json") {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({
        version: 8,
        sources: { t: { type: "raster", tiles: [tiles], tileSize: 256 } },
        layers: [{ id: "t", type: "raster", source: "t" }],
      }));
      return;
    }
    if (url.pathname.startsWith("/tiles/")) {
      served += 1;
      if (held.length === 0 && Number(url.pathname.split("/")[2]) >= 10) { held.push(res); return; }
      res.writeHead(200, { "content-type": "image/png", ...cors });
      res.end(ONE_PX);
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  tiles = `http://127.0.0.1:${address.port}/tiles/{z}/{x}/{y}.png`;
  return {
    styleUrl: `http://127.0.0.1:${address.port}/style.json`,
    heldCount: () => held.length,
    servedCount: () => served,
    async close() { for (const response of held) response.destroy(); await new Promise((r) => server.close(r)); },
  };
}

describe.skipIf(!port)("the check outlives a stalled tile host", () => {
  let mapId: string;
  let basemap: Awaited<ReturnType<typeof startStallingBasemap>>;

  beforeAll(async () => {
    const dir = process.env.DEZFIL_DATA_DIR;
    if (!dir) throw new Error("DEZFIL_DATA_DIR must name the directory the standalone shares");
    vi.stubEnv("PORT", port!);
    closeMetadataDb(); resetQueryInstance();
    basemap = await startStallingBasemap();
    await mkdir(path.join(dir, "fixtures"), { recursive: true });
    const file = path.join(dir, "fixtures", `stall-${Date.now().toString(36)}.geojson`);
    await writeFile(file, JSON.stringify({ type: "FeatureCollection", features: [
      { type: "Feature", properties: { kind: "a" }, geometry: { type: "Point", coordinates: [13.4, 52.5] } },
    ] }));
    const table = await ingestFile(testAccountScope(), file, path.basename(file));
    mapId = createMap(testAccountScope(), "Stalled tiles").id;
    updateMap(mapId, {
      viewport: { lng: 13.4, lat: 52.5, zoom: 12, pitch: 0, bearing: 0 },
      customBasemap: { url: basemap.styleUrl, name: "Stalling tiles", attribution: [{ label: "Stall fixture" }] },
    });
    await createLayer(mapId, { name: "Point", sql: `SELECT * FROM ${table.name}`, style: { fill: { type: "constant", color: { r: 26, g: 93, b: 74, a: 1 } }, fillOpacity: 1, stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeOpacity: 1, strokeWidth: 0, pointRadius: 10, opacity: 1 } });
  }, 120_000);

  afterAll(async () => { await basemap?.close(); vi.unstubAllEnvs(); });

  it("answers an image naming the abandoned host, inside the check's own budget", async () => {
    const budget = limits.assistantLookTimeoutMs;
    const bound = renderRequestBoundMs(budget);
    const started = Date.now();
    const result = await lookAtMap({ mapId, credential: delegateCredential(requireRequestAuth(authenticatedRequest())), baseUrl: `http://127.0.0.1:${port}` });
    const elapsed = Date.now() - started;
    console.info(JSON.stringify({
      budgetMs: budget, elapsedMs: result.elapsedMs, wallMs: elapsed,
      image: `${result.image.width}x${result.image.height}`, bytes: result.image.bytes,
      abandoned: result.composition.abandoned, failures: result.composition.failures,
      heldTiles: basemap.heldCount(), servedTiles: basemap.servedCount(),
    }));
    expect(basemap.heldCount()).toBe(1);
    expect(basemap.servedCount()).toBeGreaterThan(1);
    expect(result.composition.abandoned).toContain("127.0.0.1");
    // The abandonment fires at the bound this call resolved, and what
    // follows it (the grace, the offline flip, the settle, the
    // screenshot) is the margin the check has left. Ten seconds is
    // generous for that tail: it measured about three here. At the
    // export road's bound the same fixture leaves under eight seconds of
    // a thirty second budget, which is the margin is about.
    expect(elapsed).toBeLessThan(bound + 10_000);
    expect(elapsed).toBeLessThan(budget);
    const decoded = decodePng(result.image.png);
    expect([decoded.width, decoded.height]).toEqual([1024, 640]);
  }, 120_000);
});
