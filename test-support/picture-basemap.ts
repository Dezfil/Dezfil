import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { encodePng } from "../src/lib/export/png-codec";

export const PICTURE_GROUND = [245, 240, 230] as const;
export const PICTURE_LAND = [100, 40, 150] as const;
/** Real style and tile responses. Run beside the isolated renderer with
 * DEZFIL_EGRESS_ALLOWLIST=127.0.0.1; no browser interception is involved. */
export async function pictureBasemap() {
  let origin = "", styles = 0, tiles = 0, held = 0, closed = 0;
  const tile = encodePng({ width: 1, height: 1, rgba: new Uint8Array([...PICTURE_LAND, 255]) });
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("cache-control", "no-store");
    if (request.url?.startsWith("/stall/")) {
      held++;
      response.on("close", () => { closed++; });
      return; // Accept the request but send neither headers nor bytes.
    }
    if (request.url?.endsWith(".json")) {
      styles++;
      const land = request.url === "/land.json" || request.url === "/stall.json";
      const tileUrl = request.url === "/stall.json" ? `${origin}/stall/{z}/{x}/{y}.png` : `${origin}/tile.png`;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ version: 8,
        sources: land ? { land: { type: "raster", tileSize: 512, tiles: [tileUrl] } } : {},
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
  return { origin, traffic: () => ({ styles, tiles, held, closed }), close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

/** Allocate and close a listener, then prove the selected address refuses
 * connections. Check again after rendering to catch accidental port reuse. */
export async function closedPictureAddress() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const assertClosed = () => new Promise<void>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Closed-port probe timed out")); });
    socket.once("connect", () => { socket.destroy(); reject(new Error("The closed fixture port was reused")); });
    socket.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
  await assertClosed();
  return { url: `http://127.0.0.1:${port}/unreachable.json`, assertClosed };
}
