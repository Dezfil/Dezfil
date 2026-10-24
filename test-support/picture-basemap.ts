import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { encodePng } from "../src/lib/export/png-codec";

export const PICTURE_GROUND = [245, 240, 230] as const;
export const PICTURE_LAND = [100, 40, 150] as const;
/** One request the ground answered, or is answering: when it arrived,
 * when its answer was sent, and when its connection closed unanswered. */
export interface GroundRequest { path: string; started: number; answered?: number; closed?: number }

/** Real style and tile responses. Run beside the isolated renderer with
 * DEZFIL_EGRESS_ALLOWLIST=127.0.0.1; no browser interception is involved.
 * `/box.json?w=&s=&e=&n=` draws the ground with one land box at those
 * coordinates, so a picture's camera can be read back from its pixels.
 * `/hold.json?ms=&w=&s=&e=&n=` draws the ground with land tiles inside that
 * box only, each answered `ms` milliseconds after it is asked for, or never
 * when `ms` is "never"; every request is recorded with its times. */
export async function pictureBasemap() {
  let origin = "", styles = 0, tiles = 0, held = 0, closed = 0;
  const requests: GroundRequest[] = [];
  const tile = encodePng({ width: 1, height: 1, rgba: new Uint8Array([...PICTURE_LAND, 255]) });
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("cache-control", "no-store");
    const record: GroundRequest = { path: request.url ?? "/", started: Date.now() };
    requests.push(record);
    response.on("finish", () => { record.answered = Date.now(); });
    response.on("close", () => { if (record.answered === undefined) record.closed = Date.now(); });
    if (request.url?.startsWith("/hold/")) {
      const wait = request.url.split("/")[2];
      if (wait === "never") return;
      const timer = setTimeout(() => { response.setHeader("content-type", "image/png"); response.end(tile); }, Number(wait));
      response.on("close", () => clearTimeout(timer));
      return;
    }
    if (request.url?.startsWith("/hold.json")) {
      styles++;
      const address = new URL(request.url, "http://fixture");
      const [w, s, e, n] = ["w", "s", "e", "n"].map(key => Number(address.searchParams.get(key)));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ version: 8,
        sources: { held: { type: "raster", tileSize: 512, bounds: [w, s, e, n], tiles: [`${origin}/hold/${address.searchParams.get("ms")}/{z}/{x}/{y}.png`] } },
        layers: [
          { id: "ground", type: "background", paint: { "background-color": `rgb(${PICTURE_GROUND.join(",")})` } },
          { id: "held", type: "raster", source: "held", paint: { "raster-fade-duration": 0 } },
        ],
      }));
      return;
    }
    if (request.url?.startsWith("/stall/")) {
      held++;
      response.on("close", () => { closed++; });
      return; // Accept the request but send neither headers nor bytes.
    }
    const address = new URL(request.url ?? "/", "http://fixture");
    if (address.pathname === "/box.json") {
      styles++;
      const [w, s, e, n] = ["w", "s", "e", "n"].map(key => Number(address.searchParams.get(key)));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ version: 8,
        sources: { box: { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } } } },
        layers: [
          { id: "ground", type: "background", paint: { "background-color": `rgb(${PICTURE_GROUND.join(",")})` } },
          { id: "box", type: "fill", source: "box", paint: { "fill-color": `rgb(${PICTURE_LAND.join(",")})`, "fill-antialias": false } },
        ],
      }));
    } else if (request.url?.endsWith(".json")) {
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
  return { origin, traffic: () => ({ styles, tiles, held, closed }), requests: () => requests.map(r => ({ ...r })), close: async () => {
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
