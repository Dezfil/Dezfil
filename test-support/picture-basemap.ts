import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePng } from "../src/lib/export/png-codec";

export const PICTURE_GROUND = [245, 240, 230] as const;
export const PICTURE_LAND = [100, 40, 150] as const;
/** Real style and tile responses. Run beside the isolated renderer with
 * DEZFIL_EGRESS_ALLOWLIST=127.0.0.1; no browser interception is involved. */
export async function pictureBasemap() {
  let origin = "", styles = 0, tiles = 0;
  const tile = encodePng({ width: 1, height: 1, rgba: new Uint8Array([...PICTURE_LAND, 255]) });
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("cache-control", "no-store");
    if (request.url?.endsWith(".json")) {
      styles++;
      const land = request.url === "/land.json";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ version: 8,
        sources: land ? { land: { type: "raster", tileSize: 512, tiles: [`${origin}/tile.png`] } } : {},
        layers: [
          { id: "ground", type: "background", paint: { "background-color": `rgb(${PICTURE_GROUND.join(",")})` } },
          ...(land ? [{ id: "land", type: "raster", source: "land", paint: { "raster-fade-duration": 0 } }] : []),
        ],
      }));
    } else if (request.url === "/tile.png") {
      tiles++;
      response.setHeader("content-type", "image/png"); response.end(tile);
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, traffic: () => ({ styles, tiles }), close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
