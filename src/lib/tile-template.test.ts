import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillTileTemplate } from "./tile-template";

/**
 * A raster tile template, filled here for one tile, is the address MapLibre
 * GL JS fills it to: its `CanonicalTileID.url`, read from the installed
 * package's own source, is the reference, never a restatement of it.
 */

type MapLibreTile = { url(urls: string[], pixelRatio: number, scheme?: string): string };
async function maplibre(): Promise<new (z: number, x: number, y: number) => MapLibreTile> {
  const dir = dirname(createRequire(import.meta.url).resolve("maplibre-gl/package.json"));
  return ((await import(/* @vite-ignore */ join(dir, "src/tile/tile_id.ts"))) as
    { CanonicalTileID: new (z: number, x: number, y: number) => MapLibreTile }).CanonicalTileID;
}

const TEMPLATES = [
  "https://imagery.example/{z}/{x}/{y}.png",
  "https://imagery.example/{z}/{x}/{y}{ratio}.png?key=K",
  "https://imagery.example/tiles/{quadkey}.jpeg",
  "https://imagery.example/{prefix}/{z}/{x}/{y}.webp",
  "https://imagery.example/wms?bbox={bbox-epsg-3857}&width=256&height=256",
  "https://imagery.example/{prefix}/{z}/{x}/{y}{ratio}/{quadkey}/{x}?bbox={bbox-epsg-3857}&r={ratio}",
];

/** Every tile at the shallow zooms, and spread tiles at every deeper one. */
function tiles(): [number, number, number][] {
  const all: [number, number, number][] = [];
  for (let z = 0; z <= 3; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) all.push([z, x, y]);
  for (let z = 4; z <= 19; z++) {
    const span = 2 ** z;
    for (const [fx, fy] of [[0, 0], [1, 1], [0.37, 0.61], [0.5, 0.5], [0.93, 0.08]]) {
      all.push([z, Math.min(span - 1, Math.floor(fx * span)), Math.min(span - 1, Math.floor(fy * span))]);
    }
  }
  return all;
}

describe("a tile template filled for one tile", () => {
  it("is the address MapLibre fills it to, for every placeholder, both pixel ratios and both schemes", async () => {
    const CanonicalTileID = await maplibre();
    let compared = 0;
    for (const template of TEMPLATES) for (const [z, x, y] of tiles()) for (const ratio of [1, 1.5, 2, 3]) {
      for (const scheme of ["xyz", "tms"] as const) {
        expect(fillTileTemplate(template, { z, x, y }, ratio, scheme), `${template} ${z}/${x}/${y} at ${ratio}, ${scheme}`)
          .toBe(new CanonicalTileID(z, x, y).url([template], ratio, scheme));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(5000);
  });

  it("carries MapLibre's notice and the bounding box's, and NOTICE credits them", () => {
    const source = readFileSync("src/lib/tile-template.ts", "utf8");
    expect(source).toContain("Copyright (c) 2023, MapLibre contributors");
    expect(source).toContain("Redistributions of source code must retain the above copyright");
    expect(source).toContain("Copyright (c) 2017, Mapbox");
    expect(source).toContain("above copyright notice and this permission notice appear in all copies.");
    const notice = readFileSync("NOTICE", "utf8");
    expect(notice).toMatch(/MapLibre GL JS 6\.11\.2 \(BSD-3-Clause[\s\S]*?src\/lib\/tile-template\.ts[\s\S]*?@mapbox\/whoots-js \(ISC/);
  });
});
