import type { IncomingHttpHeaders } from "node:http";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { privateResponse } from "@/lib/auth/http";
import { USER_AGENT } from "@/lib/geocode/endpoint";
import { getMap } from "@/lib/metadata/map-queries";
import { resolveAllowed } from "@/lib/net/egress";
import { openRemote, type OpenRemoteOptions, type RemoteResponse } from "@/lib/net/remote-fetch";
import { carriesUserInformation } from "@/lib/settings/disclosure";
import { SATELLITE_MAX_ZOOM, SATELLITE_TILE_SCHEME } from "./basemap";
import { satelliteBasemap, satelliteTileUrl } from "./basemap-satellite";
import { fillTileTemplate, type TileScheme } from "./tile-template";

/**
 * The satellite imagery's tiles, fetched by the server and passed back, so
 * the tile template, and the key in it, never reaches a browser. The style
 * a browser loads names the instance's own tile address; each tile asked
 * there is fetched here from the template in effect.
 *
 * Not a way out to anywhere else: the only part of a request that reaches
 * the template is the tile's z, x and y, whole numbers inside the zoom's
 * range, and `@2x` after y or nothing, checked before anything is sent;
 * the template is filled from these alone, as MapLibre fills it
 * (`tile-template.ts`), and no query, header or credential of the caller
 * goes with them. The fetch takes the outbound engine every
 * user-directed fetch takes, so the egress policy admits each hop at
 * connect, under its own time bound and a size bound, and only a whole
 * raster image comes back, with the type its bytes are. Nothing is kept:
 * no tile is written anywhere. Every failure upstream is one coded
 * refusal whose words say what went wrong and never where: the engine's
 * own failures name the address, so none of their words is passed on, and
 * nothing here writes to the log.
 *
 * The satellite imagery's Test asks for its fixed tile through the same
 * request step and reads it under the same bound.
 */

/** A tile as the relay's own address names it: its z, x and y, the row
 * counted as the style's source counts it, and the pixel ratio MapLibre
 * wrote after it (2 for `@2x`, else 1). */
export interface TileCoordinate { z: number; x: number; y: number; ratio?: 1 | 2 }

/** A part of a tile's address: a whole number in plain decimal, no sign,
 * no leading zero. */
const WHOLE = /^(?:0|[1-9][0-9]{0,6})$/;

/** The row part: a whole number, and `@2x` after it or nothing. */
const ROW = /^(0|[1-9][0-9]{0,6})(@2x)?$/;

/** A tile's z, x and y as the address gives them, or null unless each is a
 * whole number inside the zoom's range, the row followed by `@2x` or by
 * nothing. */
export function readTileCoordinate(z: string, x: string, y: string): TileCoordinate | null {
  const row = ROW.exec(y);
  if (!WHOLE.test(z) || !WHOLE.test(x) || !row) return null;
  const tile: TileCoordinate = { z: Number(z), x: Number(x), y: Number(row[1]), ratio: row[2] ? 2 : 1 };
  if (tile.z > SATELLITE_MAX_ZOOM) return null;
  const span = 2 ** tile.z;
  return tile.x < span && tile.y < span ? tile : null;
}

/** The refusal of a tile address outside the imagery. */
export function invalidTile(): ApiError {
  return new ApiError("invalid_request",
    `A tile's z, x and y are whole numbers: z from 0 to ${SATELLITE_MAX_ZOOM}, and x and y below 2 to the power of z, the row followed by @2x or by nothing.`, 400);
}

/** A tile's address under the imagery's template: filled as MapLibre
 * would have filled it, handed the template where it was handed the
 * relay's address. MapLibre counted the relay's row by the source's
 * scheme, so the tile is read back by that scheme and the template filled
 * by it, with the pixel ratio MapLibre asked at. */
export function tileAddress(template: string, tile: TileCoordinate, scheme: TileScheme = SATELLITE_TILE_SCHEME): string {
  const y = scheme === "tms" ? Math.pow(2, tile.z) - tile.y - 1 : tile.y;
  return fillTileTemplate(template, { z: tile.z, x: tile.x, y }, tile.ratio ?? 1, scheme);
}

/** Ask the imagery for one tile at its template, through the outbound
 * engine and its egress check, identified as this application and with
 * nothing else of anyone's request. */
export function openSatelliteTile(
  template: string,
  tile: TileCoordinate,
  options: Pick<OpenRemoteOptions, "timeoutMs" | "timeoutError" | "signal">,
): Promise<RemoteResponse> {
  return openRemote(tileAddress(template, tile), { ...options, headers: { "user-agent": USER_AGENT, accept: "image/*" } });
}

/** The most of a tile's answer that is read. A 512-pixel tile's raw RGBA
 * bitmap is 1 MiB; four times that holds any tile of the five formats,
 * stored uncompressed or not, and an answer past it is no tile a browser
 * draws. */
export const TILE_MAX_BYTES = 4 * 1024 * 1024;

/** How long one tile waits for the imagery, whole. */
export const TILE_WAIT_MS = 10_000;

/** A tile's answer to its end, or null past the size bound: a length
 * declared past it is closed unread, a stream is cut where it passes it. A
 * stream that stalls is ended by the exchange's own deadline. */
export async function readTile(response: { headers: IncomingHttpHeaders; body: NodeJS.ReadableStream & { destroy(): void } }): Promise<Buffer | null> {
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

/** The type of a whole image a browser draws as a tile, whatever the
 * answer's type says, or null: each format to its end marker, or to the
 * length it declares, as the format allows. Bytes after that end are not
 * read. Only raster formats: nothing that can carry a script. */
export function tileImageType(bytes: Buffer): string | null {
  if (wholePng(bytes)) return "image/png";
  if (wholeJpeg(bytes)) return "image/jpeg";
  if (wholeGif(bytes)) return "image/gif";
  if (wholeWebp(bytes)) return "image/webp";
  if (wholeAvif(bytes)) return "image/avif";
  return null;
}

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

/** One tile as it passes back: its bytes and the type they are. */
export interface RelayedTile { bytes: Buffer; type: string }

/** The coded refusal of every failure upstream, in words that never say
 * where the tile was asked. */
const unavailable = (message: string, status = 502) => new ApiError("imagery_unavailable", message, status);

/**
 * One tile of the imagery in effect, fetched now, or null while no
 * template is set. A stored template the instance's key no longer opens
 * throws its coded refusal, as the style does. A template carrying a user
 * name or password is not drawn, so nothing is asked of it. The caller's
 * signal, when it leaves, abandons the fetch.
 */
export async function relaySatelliteTile(
  tile: TileCoordinate,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RelayedTile | null> {
  const template = satelliteTileUrl();
  if (!template) return null;
  if (carriesUserInformation(template)) {
    throw unavailable("The satellite imagery's tile address carries a user name or password, so its tiles are not drawn.");
  }
  // This fetch's own deadline, told apart from every other failure by
  // identity, never by its words.
  const deadline = unavailable("The satellite imagery did not answer within its time limit.", 504);
  const refusals = new Set<ApiError>([deadline]);
  const refuse = (message: string) => { const error = unavailable(message); refusals.add(error); return error; };
  try {
    const response = await openSatelliteTile(template, tile, {
      timeoutMs: options.timeoutMs ?? TILE_WAIT_MS, timeoutError: () => deadline, signal: options.signal,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.body.destroy();
      throw refuse(`The satellite imagery answered ${response.statusCode} for the tile.`);
    }
    const bytes = await readTile(response);
    if (bytes === null) throw refuse("The satellite imagery answered with more than a tile.");
    const type = tileImageType(bytes);
    if (type === null) throw refuse("The satellite imagery did not answer with a tile image.");
    return { bytes, type };
  } catch (error) {
    if (error instanceof ApiError && refusals.has(error)) throw error;
    // The caller left: coded as an abandonment, with no address in it.
    if (error instanceof ApiError && error.code === "remote_fetch_abandoned") throw error;
    if (error instanceof ApiError && error.code === "egress_blocked") {
      throw unavailable("The satellite imagery's tile address is one this instance's egress policy refuses.");
    }
    // Whatever else stopped the exchange (a refused connection, a name
    // that does not resolve, an answer cut short) is said without its
    // words, which may repeat the address.
    throw unavailable("The satellite imagery could not be reached.");
  }
}

/**
 * The host an image of this map would draw its imagery from, or null when
 * it draws none. The renderer asks the instance's own tile address, which
 * it admits as the app's, so a host the egress policy refuses would only
 * come back as tiles that failed and the image would be made without its
 * basemap; an export asks `imageryHostRefused` of this host first and
 * refuses instead, as it refuses a map whose style reaches a refused
 * address.
 */
export function imageryHostOf(mapId: string): string | null {
  const map = getMap(mapId);
  if (!map || map.customBasemap || map.basemap !== "satellite" || !satelliteBasemap()) return null;
  const template = satelliteTileUrl();
  if (!template || carriesUserInformation(template)) return null;
  try {
    return new URL(tileAddress(template, { z: 0, x: 0, y: 0 })).hostname;
  } catch {
    return null;
  }
}

/** Whether the egress policy refuses the imagery's host now, admitted as
 * the relay's fetch admits it at connect. A name that does not resolve is
 * not a refusal here, as it is not for a custom style. */
export async function imageryHostRefused(host: string): Promise<boolean> {
  try {
    await resolveAllowed(host);
    return false;
  } catch (error) {
    return error instanceof ApiError && error.code === "egress_blocked";
  }
}

/** The answer while no imagery is configured, as the style answers it. */
export function noImageryResponse(): Response {
  return privateResponse(NextResponse.json(
    { error: "No satellite imagery is configured on this instance." },
    { status: 404 },
  ));
}

/** A relayed tile's answer: its bytes and their type, private and not
 * stored, so a browser asks again rather than keep it. */
export function tileResponse(tile: RelayedTile): Response {
  return privateResponse(new NextResponse(new Uint8Array(tile.bytes), {
    status: 200,
    headers: { "content-type": tile.type, "x-content-type-options": "nosniff" },
  }));
}
