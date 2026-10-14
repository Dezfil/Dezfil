import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
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
import { createMap, updateMap, mapWithLayers } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { limits } from "@/lib/limits";
import { lookAtMap, lookDefinition } from "./map-look";
import { renderMapImage } from "./render-image";
import { decodePng } from "./png-codec";
import { renderRequestBoundMs } from "./render-stall";

/**
 * A basemap's first viewport tile never answers. Raster tiles exercise
 * page fetches; vector tiles exercise worker fetches. Both the map check
 * and the image export must abandon the host and answer an image within
 * their own request bound plus settlement margin, before their budgets.
 *
 * Provisioning: DEZFIL_STALLED_TILES_RENDER names a production standalone's
 * port; DEZFIL_DATA_DIR is the directory both share; DEZFIL_CHROMIUM_PATH
 * points at a headless shell; DEZFIL_EGRESS_ALLOWLIST admits 127.0.0.1.
 * DEZFIL_RENDER_DELEGATION_KEY is the same 64 hexadecimal digits in both
 * processes. From the repository root, launch the provisioned standalone:
 * PORT="$DEZFIL_STALLED_TILES_RENDER" HOSTNAME=127.0.0.1 node
 * --import="data:text/javascript,process[Symbol.for('dezfil.session-delegation-key')]=Buffer.from(process.env.DEZFIL_RENDER_DELEGATION_KEY,'hex')"
 * --import=./scripts/ingress-preload.mjs .next/standalone/server.js
 * (Join those three lines into one command.) Skipped without the port;
 * setup refuses a missing key or a standalone that rejects the credential.
 */
const port = process.env.DEZFIL_STALLED_TILES_RENDER;
const SIGNING_KEY = Symbol.for("dezfil.session-delegation-key");

/** One opaque pixel, the answer to every tile but the held one. */
const ONE_PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A style whose first viewport tile is held open for ever. A
 * prefetched parent that never arrives does not hold the map's idle; only
 * a tile the viewport needs does, which is what the stall is about.
 * Without the CORS header the style fails to load and
 * the page settles on its offline fallback, which is a different case. */
async function startStallingBasemap(kind: "raster" | "vector") {
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
        sources: { t: kind === "vector"
          ? { type: "vector", tiles: [tiles], minzoom: 0, maxzoom: 14 }
          : { type: "raster", tiles: [tiles], tileSize: 256 } },
        layers: kind === "vector" ? [
          { id: "bg", type: "background", paint: { "background-color": "#eeeeee" } },
          { id: "t", type: "fill", source: "t", "source-layer": "x", paint: { "fill-color": "#999999" } },
        ] : [{ id: "t", type: "raster", source: "t" }],
      }));
      return;
    }
    if (url.pathname.startsWith("/tiles/")) {
      served += 1;
      if (held.length === 0 && Number(url.pathname.split("/")[2]) >= 10) { held.push(res); return; }
      res.writeHead(200, { "content-type": kind === "vector" ? "application/x-protobuf" : "image/png", ...cors });
      res.end(kind === "vector" ? Buffer.alloc(0) : ONE_PX);
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  tiles = `http://127.0.0.1:${address.port}/tiles/{z}/{x}/{y}.${kind === "vector" ? "pbf" : "png"}`;
  return {
    styleUrl: `http://127.0.0.1:${address.port}/style.json`,
    heldCount: () => held.length,
    servedCount: () => served,
    async close() { for (const response of held) response.destroy(); await new Promise((r) => server.close(r)); },
  };
}

describe.skipIf(!port).each([
  { kind: "raster", road: "check" },
  { kind: "vector", road: "check" },
  { kind: "raster", road: "export" },
  { kind: "vector", road: "export" },
] as const)("$road outlives a stalled $kind tile host", ({ kind, road }) => {
  let mapId: string;
  let basemap: Awaited<ReturnType<typeof startStallingBasemap>>;
  let restoreKey: (() => void) | undefined;

  beforeAll(async () => {
    const dir = process.env.DEZFIL_DATA_DIR;
    if (!dir) throw new Error("DEZFIL_DATA_DIR must name the directory the standalone shares");
    const key = process.env.DEZFIL_RENDER_DELEGATION_KEY ?? "";
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("DEZFIL_RENDER_DELEGATION_KEY must carry the standalone's render signing key, 64 hexadecimal digits");
    const slots = process as unknown as Record<symbol, unknown>;
    const heldKey = slots[SIGNING_KEY];
    restoreKey = () => { if (heldKey === undefined) delete slots[SIGNING_KEY]; else slots[SIGNING_KEY] = heldKey; };
    slots[SIGNING_KEY] = Buffer.from(key, "hex");
    vi.stubEnv("PORT", port!);
    closeMetadataDb(); resetQueryInstance();
    basemap = await startStallingBasemap(kind);
    await mkdir(path.join(dir, "fixtures"), { recursive: true });
    const file = path.join(dir, "fixtures", `stall-${Date.now().toString(36)}.geojson`);
    await writeFile(file, JSON.stringify({ type: "FeatureCollection", features: [
      { type: "Feature", properties: { kind: "a" }, geometry: { type: "Point", coordinates: [13.4, 52.5] } },
    ] }));
    const table = await ingestFile(testAccountScope(), file, path.basename(file));
    mapId = createMap(testAccountScope(), "Stalled tiles").id;
    updateMap(testAccountScope(), mapId, {
      viewport: { lng: 13.4, lat: 52.5, zoom: 12, pitch: 0, bearing: 0 },
      customBasemap: { url: basemap.styleUrl, name: "Stalling tiles", attribution: [{ label: "Stall fixture" }] },
    }, { expectedRevision: readEditRevision({ kind: "map", id: mapId })?.editRevision });
    await createLayer(testAccountScope(), mapId, { name: "Point", sql: `SELECT * FROM ${table.name}`, style: { fill: { type: "constant", color: { r: 26, g: 93, b: 74, a: 1 } }, fillOpacity: 1, stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeOpacity: 1, strokeWidth: 0, pointRadius: 10, opacity: 1 } }, { expectedRevision: readEditRevision({ kind: "map", id: mapId })?.editRevision });
    const accepted = await fetch(`http://127.0.0.1:${port}/api/maps/${mapId}`, {
      headers: { authorization: `Bearer ${delegateCredential(requireRequestAuth(authenticatedRequest()))}` },
      redirect: "manual",
    });
    if (accepted.status !== 200) throw new Error(`The standalone on port ${port} refused this process's render credential (${accepted.status}): start it with the same DEZFIL_RENDER_DELEGATION_KEY`);
  }, 120_000);

  afterAll(async () => {
    restoreKey?.();
    try { await basemap?.close(); } finally { vi.unstubAllEnvs(); }
  });

  it("answers an image naming the abandoned host inside its own budget", async () => {
    const budget = road === "check" ? limits.assistantLookTimeoutMs : limits.exportRenderTimeoutMs;
    const bound = renderRequestBoundMs(road === "check" ? budget : undefined);
    const credential = delegateCredential(requireRequestAuth(authenticatedRequest()));
    const baseUrl = `http://127.0.0.1:${port}`;
    const started = Date.now();
    const result = road === "check"
      ? await lookAtMap(testAccountScope(), { mapId, credential, baseUrl }).then((look) => ({
        png: look.image.png, abandoned: look.composition.abandoned,
      }))
      : await renderMapImage(testAccountScope(), {
        mapId, credential, baseUrl,
        definition: lookDefinition(mapWithLayers(testAccountScope(), mapId), "light"),
      });
    const elapsed = Date.now() - started;
    const decoded = decodePng(result.png);
    console.info(JSON.stringify({
      kind, road, budgetMs: budget, boundMs: bound, wallMs: elapsed,
      image: `${decoded.width}x${decoded.height}`, bytes: result.png.byteLength,
      abandoned: result.abandoned,
      heldTiles: basemap.heldCount(), servedTiles: basemap.servedCount(),
    }));
    expect(basemap.heldCount()).toBe(1);
    expect(basemap.servedCount()).toBeGreaterThan(1);
    expect(result.abandoned).toContain("127.0.0.1");
    // Allow ten seconds after the bound for the grace, socket abandonment,
    // page settlement and screenshot, while still requiring the road's budget.
    expect(elapsed).toBeLessThan(bound + 10_000);
    expect(elapsed).toBeLessThan(budget);
    expect([decoded.width, decoded.height]).toEqual([1024, 640]);
  }, 120_000);
});
