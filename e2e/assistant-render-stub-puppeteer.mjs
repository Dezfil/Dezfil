// The fake puppeteer-core of the render stub: the driver's own seam, faked.
// A page that settles at once, declares what it drew and screenshots a
// fixed 1024 by 640 PNG. A map whose name carries "[render-fails]" is the
// named failure sentinel: its render declares a failed composition.
// Test-owned.
import { deflateSync } from "node:zlib";
import { browserAccount, provisionJourney } from "../scripts/journey-auth.mjs";

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
/** A pale ground with a kelp block and an amber block, so a thumbnail reads as a picture. */
function fixturePng(width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const i = 1 + x * 3;
      const kelp = x > width * 0.3 && x < width * 0.55 && y > height * 0.3 && y < height * 0.6;
      const amber = x > width * 0.6 && x < width * 0.8 && y > height * 0.45 && y < height * 0.75;
      row[i] = kelp ? 26 : amber ? 233 : 236; row[i + 1] = kelp ? 93 : amber ? 179 : 240; row[i + 2] = kelp ? 74 : amber ? 91 : 232;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = fixturePng(1024, 640);
let renders = 0;
const credentials = new Map();

function fixtureCredential(origin) {
  if (!credentials.has(origin)) credentials.set(origin, provisionJourney(origin, browserAccount));
  return credentials.get(origin);
}

function fakePage() {
  let mapId = ""; let sentinel = false;
  return {
    async setRequestInterception() {},
    on() {},
    async setViewport() {},
    async evaluateOnNewDocument() {},
    async goto(url) {
      mapId = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
      // The page would read the map itself; the fake reads its name for the sentinel.
      const origin = new URL(url).origin;
      const fixture = await fixtureCredential(origin);
      const response = await fixture.fetch(`${origin}/api/maps/${encodeURIComponent(mapId)}`);
      if (!response.ok) throw new Error(`Render stub map read failed: ${response.status}`);
      const map = await response.json();
      if (typeof map.name !== "string") throw new Error("Render stub map read has no name");
      sentinel = map.name.includes("[render-fails]");
    },
    async waitForFunction() { return true; },
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes("data-export-failed")) return sentinel ? "The stub declares this composition failed: the map's name is the failure sentinel." : null;
      if (source.includes("data-export-state")) return JSON.stringify({ map: mapId, layers: [], legend: { visible: true, corner: "bottom-left", order: [] }, widgets: [], attribution: "Stub basemap", failures: [] });
      return null;
    },
    async screenshot() { renders += 1; console.info(`[render stub] screenshot ${renders} for map ${mapId}`); return new Uint8Array(PNG); },
  };
}
const puppeteer = {
  async launch() {
    return { async newPage() { return fakePage(); }, async close() {}, process() { return { kill() {} }; } };
  },
};
export default puppeteer;
export const launch = puppeteer.launch;
