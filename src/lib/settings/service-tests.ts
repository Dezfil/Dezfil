import type { Database } from "better-sqlite3";
import type { IncomingHttpHeaders } from "node:http";
import { ApiError } from "@/lib/api/errors";
import { requireAdmin } from "@/lib/auth/admin";
import { satelliteTileUrl } from "@/lib/basemap-satellite";
import type { AuthContext } from "@/lib/auth/credentials";
import { configuredEndpoint } from "@/lib/geocode/endpoint";
import { readAnswerBody, requestGeocoder } from "@/lib/geocode/provider";
import { openS3AddressRoot } from "@/lib/ingest/remote";
import { configuredIsochroneEndpoint } from "@/lib/isochrone/endpoint";
import { isNoRouteAnswer, readIsochroneBody, requestIsochrone } from "@/lib/isochrone/provider";
import { metadataDb } from "@/lib/metadata/db";
import { readCapped } from "@/lib/net/read-capped";
import { openRemote } from "@/lib/net/remote-fetch";
import { openOverpass, overpassEndpoint, readOverpassAnswer } from "@/lib/osm/overpass";
import { keepReleaseList, sendReleaseListing } from "@/lib/overture/releases";
import { testCatalogue } from "@/lib/templates/catalogue";
import type { ServiceTestAnswer, TestedService } from "./service-test-answer";

/**
 * A service's Test: one fixed request to the service at its address in
 * effect, never a typed one, sent through the service's own request step
 * below its cache, so the way its requests go (the egress check, redirects
 * included, and the gap for the address finder and travel time) and with
 * no cache read or written. It reaches outside this server and stores
 * nothing, except that Overture's Test keeps the release list it finds, as
 * Check now does. A second Test of a service while one runs gets the same
 * answer from the same request. The satellite imagery's Test asks its tile
 * template for one fixed low-zoom tile through the same outbound engine and
 * egress check, under its own ten seconds, as a browser drawing the imagery
 * asks for any tile, and reads the tile whole within them: it passes only on
 * an image complete for its format, timed when the last byte arrived. The
 * template catalogue's Test reads its index as a refresh does, within the
 * link import's time bound, and keeps nothing; while the catalogue is off it
 * is refused and sends nothing.
 *
 * The answer is a closed shape (`service-test-answer.ts`): what the service
 * said is read only to tell a pass from a failure, and none of it, nor the
 * address or a key, is ever part of the answer. It is read by the service's
 * own reader (a geocoding run's, a travel-time run's, an import's), so an
 * answer those would not take is answered, but not as the service does.
 */

/** The address finder's fixed question. */
export const TEST_PLACE = "Paris";
/** Travel time's fixed point, asked on foot for the shortest band. */
export const TEST_POINT = { lon: 2.3522, lat: 48.8566 };
const TEST_BANDS = [1];
/** The smallest Overpass query: it selects nothing and prints it. */
export const TEST_QUERY = "[out:json][timeout:10];out;";
/** Past this a Test's answer is not read further; none needs more. */
const ANSWER_BYTES = 64 * 1024;
/** The satellite imagery's fixed tile: zoom 3, over Europe, which every
 * imagery service draws. */
export const TEST_TILE = { z: 3, x: 4, y: 2 };
/** How long the satellite imagery's Test waits for its tile, whole. */
const TILE_TEST_MS = 10_000;
/** The most of a tile's answer that is read. A 512-pixel tile's raw RGBA
 * bitmap is 1 MiB; four times that holds any tile of the five formats,
 * stored uncompressed or not, and an answer past it is no tile a browser
 * draws. One Test runs at a time, so this is also its memory's bound. */
const TILE_MAX_BYTES = 4 * 1024 * 1024;

const passed = (service: Exclude<TestedService, "overture" | "templates">, milliseconds: number): ServiceTestAnswer =>
  ({ service, result: "passed", milliseconds });
const answeredWith = (service: TestedService, status: number): ServiceTestAnswer =>
  ({ service, result: "failed", reason: "status", status });
const unexpected = (service: TestedService): ServiceTestAnswer =>
  ({ service, result: "failed", reason: "unexpected_answer" });
const notSetUp = (service: TestedService): ServiceTestAnswer =>
  ({ service, result: "failed", reason: "not_set_up" });

/** A status answered: the body is closed unread. */
function closing(response: { body: { destroy(): void } }, answer: ServiceTestAnswer): ServiceTestAnswer {
  response.body.destroy();
  return answer;
}

/** S3's own shape: its request identity on the answer, or its XML. A
 * healthy store refuses an unsigned request at its root, in that shape. */
const s3Headers = (headers: IncomingHttpHeaders) => typeof headers["x-amz-request-id"] === "string";
const s3Body = (text: string | null) =>
  text !== null && /^\s*(<\?xml[^>]*\?>\s*)?<(Error>[\s\S]*<Code>|ListAllMyBucketsResult[\s>])/.test(text);

/** The fixed tile's address under a template: its three placeholders filled. */
const tileAddress = (template: string) =>
  template.split("{z}").join(String(TEST_TILE.z)).split("{x}").join(String(TEST_TILE.x)).split("{y}").join(String(TEST_TILE.y));

/** A tile's answer to its end, or null past the size bound: a length
 * declared past it is closed unread, a stream is cut where it passes it. A
 * stream that stalls is ended by the exchange's own deadline. */
async function readTile(response: { headers: IncomingHttpHeaders; body: NodeJS.ReadableStream & { destroy(): void } }): Promise<Buffer | null> {
  if (Number(response.headers["content-length"]) > TILE_MAX_BYTES) {
    response.body.destroy();
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > TILE_MAX_BYTES) {
      response.body.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/** Whether the bytes are a whole image a browser draws as a tile, whatever
 * the answer's type says: each format to its end marker, or to the length
 * it declares, as the format allows. Bytes after that end are not read. */
const isWholeImage = (bytes: Buffer): boolean =>
  wholePng(bytes) || wholeJpeg(bytes) || wholeGif(bytes) || wholeWebp(bytes) || wholeAvif(bytes);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG: its header chunk first, image data, and its end chunk, each chunk
 * whole at the length it declares. */
function wholePng(b: Buffer): boolean {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let at = 8, data = false;
  while (at + 12 <= b.length) {
    const length = b.readUInt32BE(at), type = b.toString("latin1", at + 4, at + 8);
    if (length > 0x7fffffff || at + 12 + length > b.length) return false;
    if (at === 8 && type !== "IHDR") return false;
    if (type === "IDAT") data = true;
    if (type === "IEND") return data;
    at += 12 + length;
  }
  return false;
}

/** A JPEG: its segments at their declared lengths, a scan's coded data to
 * the next marker, and the end-of-image marker after at least one scan. */
function wholeJpeg(b: Buffer): boolean {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let at = 2, scanned = false;
  const restart = (marker: number) => marker >= 0xd0 && marker <= 0xd7;
  while (at + 1 < b.length) {
    if (b[at] !== 0xff) return false;
    const marker = b[at + 1];
    if (marker === 0xff) { at += 1; continue; } // a fill byte before a marker
    if (marker === 0xd9) return scanned;
    if (restart(marker) || marker === 0x01) { at += 2; continue; }
    if (at + 4 > b.length) return false;
    const length = b.readUInt16BE(at + 2);
    if (length < 2) return false;
    at += 2 + length;
    if (marker === 0xda) {
      scanned = true;
      // Coded data runs to the next marker: a 0xFF that is neither a
      // stuffed zero nor a restart.
      while (at + 1 < b.length && !(b[at] === 0xff && b[at + 1] !== 0x00 && !restart(b[at + 1]))) at += 1;
    }
  }
  return false;
}

/** A GIF: its blocks, each whole, up to the trailer after at least one image. */
function wholeGif(b: Buffer): boolean {
  if (b.length < 13 || !/^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return false;
  const table = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  let at = 13 + table(b[10]), image = false;
  // Data sub-blocks, each led by its size, up to the empty one.
  const subBlocks = () => {
    while (at < b.length) {
      const size = b[at];
      at += 1 + size;
      if (size === 0) return true;
    }
    return false;
  };
  while (at < b.length) {
    const block = b[at];
    if (block === 0x3b) return image;
    if (block === 0x21) {
      at += 2;
      if (!subBlocks()) return false;
    } else if (block === 0x2c) {
      if (at + 10 > b.length) return false;
      // The descriptor, its own color table, the code size, then the data.
      at += 10 + table(b[at + 9]) + 1;
      if (!subBlocks()) return false;
      image = true;
    } else return false;
  }
  return false;
}

/** A WebP: the length its RIFF header declares, its first chunk an image
 * whole inside it. */
function wholeWebp(b: Buffer): boolean {
  if (b.length < 20 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return false;
  const end = 8 + b.readUInt32LE(4);
  return /^VP8[ LX]$/.test(b.toString("latin1", 12, 16)) && end <= b.length && 20 + b.readUInt32LE(16) <= end;
}

/** An AVIF: its boxes whole at the lengths they declare, up to its
 * metadata and its image data (a box declared to run to the end runs to
 * the answer's end). */
function wholeAvif(b: Buffer): boolean {
  if (b.length < 12 || b.toString("latin1", 4, 8) !== "ftyp" || !/^avi[fs]$/.test(b.toString("latin1", 8, 12))) return false;
  const seen = new Set<string>();
  let at = 0;
  while (at + 8 <= b.length) {
    let size = b.readUInt32BE(at), header = 8;
    if (size === 1) {
      if (at + 16 > b.length) return false;
      size = Number(b.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = b.length - at;
    if (size < header || at + size > b.length) return false;
    seen.add(b.toString("latin1", at + 4, at + 8));
    if (seen.has("meta") && seen.has("mdat")) return true;
    at += size;
  }
  return false;
}

const TESTS: Record<TestedService, (deadline: () => ApiError) => Promise<ServiceTestAnswer>> = {
  async geocode(deadline) {
    const endpoint = configuredEndpoint();
    if (!endpoint) return notSetUp("geocode");
    // A person waiting, as at a search: ahead of a batch, after the gap.
    const exchange = await requestGeocoder(endpoint, TEST_PLACE, { priority: "interactive", timeoutError: deadline });
    if (exchange.statusCode !== 200) return answeredWith("geocode", exchange.statusCode);
    return exchange.text !== null && readAnswerBody(exchange.text) !== null ? passed("geocode", exchange.milliseconds) : unexpected("geocode");
  },

  async isochrone(deadline) {
    const endpoint = configuredIsochroneEndpoint();
    if (!endpoint) return notSetUp("isochrone");
    const exchange = await requestIsochrone(endpoint, TEST_POINT, "walking", TEST_BANDS, { timeoutError: deadline });
    // No route from the point, in the protocol's own words, is the service answering.
    if (exchange.statusCode === 400 && isNoRouteAnswer(exchange.text)) return passed("isochrone", exchange.milliseconds);
    if (exchange.statusCode !== 200) return answeredWith("isochrone", exchange.statusCode);
    // A band with no route is the service answering; an answer the run
    // could not read is not.
    const read = exchange.text === null ? null : readIsochroneBody(exchange.text, TEST_POINT, TEST_BANDS);
    return read !== null && read.bands.every(band => band.status !== "unreadable_answer")
      ? passed("isochrone", exchange.milliseconds) : unexpected("isochrone");
  },

  async overpass(deadline) {
    const started = Date.now();
    const response = await openOverpass(overpassEndpoint(), TEST_QUERY, deadline);
    if (response.statusCode < 200 || response.statusCode >= 300) return closing(response, answeredWith("overpass", response.statusCode));
    const text = await readCapped(response.body, ANSWER_BYTES);
    const milliseconds = Date.now() - started;
    return text !== null && readOverpassAnswer(text).kind === "answer" ? passed("overpass", milliseconds) : unexpected("overpass");
  },

  async overture(deadline) {
    const { statusCode, releases } = await sendReleaseListing(deadline);
    if (statusCode !== 200) return answeredWith("overture", statusCode);
    if (releases.length === 0) return unexpected("overture");
    // Kept as the list the pane offers, as Check now keeps it.
    keepReleaseList(releases);
    return { service: "overture", result: "passed", releases: releases.length, newest: releases[0] };
  },

  async s3(deadline) {
    // A store may redirect its root elsewhere; the redirect is its answer.
    let shaped = false;
    const started = Date.now();
    const response = await openS3AddressRoot({ timeoutError: deadline, onRedirect: hop => { shaped ||= s3Headers(hop.headers); } });
    if (response.statusCode >= 500) return closing(response, answeredWith("s3", response.statusCode));
    const text = await readCapped(response.body, ANSWER_BYTES);
    const milliseconds = Date.now() - started;
    return shaped || s3Headers(response.headers) || s3Body(text) ? passed("s3", milliseconds) : unexpected("s3");
  },

  async satellite(deadline) {
    // The template in effect, its variable or the stored one; a stored one
    // the key no longer opens refuses, as the imagery style does.
    const template = satelliteTileUrl();
    if (!template) return notSetUp("satellite");
    const started = Date.now();
    const response = await openRemote(tileAddress(template), { timeoutMs: TILE_TEST_MS, timeoutError: deadline });
    if (response.statusCode < 200 || response.statusCode >= 300) return closing(response, answeredWith("satellite", response.statusCode));
    // The whole tile, under the same deadline: its time is its arrival.
    const tile = await readTile(response);
    const milliseconds = Date.now() - started;
    return tile !== null && isWholeImage(tile) ? passed("satellite", milliseconds) : unexpected("satellite");
  },

  templates: deadline => testCatalogue(deadline),
};

async function run(service: TestedService): Promise<ServiceTestAnswer> {
  // This Test's own deadline, told apart from every other failure by
  // identity, never by its words.
  const deadline = new ApiError("remote_timeout", "The service did not answer within its time limit.", 504);
  try {
    return await TESTS[service](() => deadline);
  } catch (error) {
    if (error === deadline) return { service, result: "failed", reason: "timed_out" };
    if (error instanceof ApiError && error.code === "egress_blocked") return { service, result: "failed", reason: "refused", message: error.message };
    // A stored address the instance's key no longer opens: the service
    // refuses, and so does its Test, never reaching a default instead.
    if (error instanceof ApiError && error.code === "service_address_unreadable") throw error;
    // The template catalogue turned off: refused, as its refresh is.
    if (error instanceof ApiError && error.code === "templates_catalogue_off") throw error;
    // Whatever else stopped the exchange (a refused connection, a name that
    // does not resolve, an answer cut short) is said without its words,
    // which may repeat the address.
    return { service, result: "failed", reason: "unreachable" };
  }
}

const key = Symbol.for("dezfil.service-tests");
const host = globalThis as typeof globalThis & { [key]?: Map<TestedService, Promise<ServiceTestAnswer>> };
const running = host[key] ??= new Map();

/** Test one service, the admin rechecked first. A Test of a service already
 * under way is joined, not repeated. */
export async function testService(
  context: AuthContext,
  service: TestedService,
  db: Database = metadataDb(),
  now = Date.now(),
): Promise<ServiceTestAnswer> {
  requireAdmin(context, db, now);
  const current = running.get(service);
  if (current) return current;
  const test: Promise<ServiceTestAnswer> = run(service).finally(() => {
    if (running.get(service) === test) running.delete(service);
  });
  running.set(service, test);
  return test;
}
