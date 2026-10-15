/*
 * A raster tile template filled for one tile as MapLibre GL JS fills it in
 * the browser: `CanonicalTileID.url`, which its raster source calls for
 * every tile it asks. `{prefix}`, `{z}`, `{x}`, `{y}`, `{ratio}`,
 * `{quadkey}` and `{bbox-epsg-3857}` are filled at every occurrence, in
 * that order. `{y}` counts rows from the south where the source declares
 * the TMS scheme; `{ratio}` is `@2x` past one device pixel to the CSS
 * pixel, else nothing; the bounding box is the tile's in EPSG:3857 metres,
 * as a WMS asks for it. The satellite relay fills the imagery's template
 * here, so a template using any of them asks the imagery for the address a
 * browser asked when it filled the template itself.
 *
 * Adapted from MapLibre GL JS 6.11.2, src/tile/tile_id.ts:
 * `CanonicalTileID.url`, `getQuadkey`, `getTileBBox` and
 * `getEpsg3857Coords`, whose notice follows.
 *
 * Copyright (c) 2023, MapLibre contributors
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 *       notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above copyright
 *       notice, this list of conditions and the following disclaimer in
 *       the documentation and/or other materials provided with the
 *       distribution.
 *     * Neither the name of MapLibre GL JS nor the names of its
 *       contributors may be used to endorse or promote products derived
 *       from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * The bounding box there is inlined from @mapbox/whoots-js, whose notice
 * follows.
 *
 * Copyright (c) 2017, Mapbox
 *
 * Permission to use, copy, modify, and/or distribute this software for
 * any purpose with or without fee is hereby granted, provided that the
 * above copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
 * WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR
 * BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES
 * OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
 * WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS
 * SOFTWARE.
 */

/** How a raster source counts its rows: from the north (the default), or
 * from the south (TMS). */
export type TileScheme = "xyz" | "tms";

/** A tile by its zoom, column and row, rows counted from the north. */
export interface CanonicalTile { z: number; x: number; y: number }

/** The template filled for one tile, as MapLibre fills it. */
export function fillTileTemplate(template: string, tile: CanonicalTile, pixelRatio: number, scheme: TileScheme = "xyz"): string {
  const { z, x, y } = tile;
  return template
    .replace(/{prefix}/g, (x % 16).toString(16) + (y % 16).toString(16))
    .replace(/{z}/g, String(z))
    .replace(/{x}/g, String(x))
    .replace(/{y}/g, String(scheme === "tms" ? (Math.pow(2, z) - y - 1) : y))
    .replace(/{ratio}/g, pixelRatio > 1 ? "@2x" : "")
    .replace(/{quadkey}/g, quadkey(z, x, y))
    .replace(/{bbox-epsg-3857}/g, tileBBox(x, y, z));
}

/** The WGS84 spherical radius EPSG:3857 is built on. */
const EPSG3857_RADIUS = 6378137;
const EPSG3857_HALF_CIRCUMFERENCE = Math.PI * EPSG3857_RADIUS;

/** The tile's bounding box in EPSG:3857 metres, `minX,minY,maxX,maxY`. */
function tileBBox(x: number, y: number, z: number): string {
  // Counted from the south, as the projection's y runs.
  y = Math.pow(2, z) - y - 1;
  const min = epsg3857Coords(x * 256, y * 256, z);
  const max = epsg3857Coords((x + 1) * 256, (y + 1) * 256, z);
  return `${min[0]},${min[1]},${max[0]},${max[1]}`;
}

/** Tile pixel coordinates in EPSG:3857 metres. */
function epsg3857Coords(x: number, y: number, z: number): [number, number] {
  const resolution = (2 * EPSG3857_HALF_CIRCUMFERENCE / 256) / Math.pow(2, z);
  const mercX = x * resolution - EPSG3857_HALF_CIRCUMFERENCE;
  const mercY = y * resolution - EPSG3857_HALF_CIRCUMFERENCE;
  return [mercX, mercY];
}

/** The tile's quadkey: one digit a zoom, from the coarsest. */
function quadkey(z: number, x: number, y: number): string {
  let key = "";
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    key += ((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return key;
}
