import { open, stat } from "node:fs/promises";
import { PMTiles, type Source, type RangeResponse } from "pmtiles";
import { tileArchivePath } from "./paths";

/**
 * Read side of a layer's PMTiles archive: the app serves tiles itself,
 * straight from the data volume. Archives are cached per layer and
 * re-opened when the file changes underneath (the atomic swap after a
 * rebuild), so directory offsets never go stale.
 */

class ArchiveSource implements Source {
  constructor(private readonly path: string) {}

  getKey(): string {
    return this.path;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const handle = await open(this.path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return {
        data: buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + bytesRead,
        ),
      };
    } finally {
      await handle.close();
    }
  }
}

interface CachedArchive {
  pmtiles: PMTiles;
  mtimeMs: number;
  size: number;
}

const archivesKey = Symbol.for("dezfil.tile-archives");
const archivesHost = globalThis as typeof globalThis & { [archivesKey]?: Map<string, CachedArchive> };
const archives = archivesHost[archivesKey] ??= new Map<string, CachedArchive>();
const readsKey = Symbol.for("dezfil.tile-readers");
const readsHost = globalThis as typeof globalThis & { [readsKey]?: Map<string, Set<Promise<unknown>>> };
const reads = readsHost[readsKey] ??= new Map<string, Set<Promise<unknown>>>();

/** Tests reset shared state. */
export function resetTileArchives(): void {
  archives.clear();
}

async function openArchive(layerId: string): Promise<PMTiles | null> {
  const file = tileArchivePath(layerId);
  let s;
  try {
    s = await stat(file);
  } catch {
    archives.delete(layerId);
    return null;
  }
  const cached = archives.get(layerId);
  if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size) {
    return cached.pmtiles;
  }
  // A fresh PMTiles instance carries a fresh directory cache — nothing
  // survives from the pre-swap archive.
  const pmtiles = new PMTiles(new ArchiveSource(file));
  archives.set(layerId, { pmtiles, mtimeMs: s.mtimeMs, size: s.size });
  return pmtiles;
}

export interface TileArchiveInfo {
  /** [west, south, east, north] of the tiled data. */
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
}

/** Bounds and zoom range of a layer's archive, or null when it has none. */
async function archiveInfo(
  layerId: string,
): Promise<TileArchiveInfo | null> {
  const archive = await openArchive(layerId);
  if (!archive) return null;
  const header = await archive.getHeader();
  return {
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
  };
}

/** One decompressed MVT tile, or null when the archive or tile is absent —
 * an empty spot on the map, not an error. */
async function tile(
  layerId: string,
  z: number,
  x: number,
  y: number,
): Promise<Uint8Array | null> {
  const archive = await openArchive(layerId);
  if (!archive) return null;
  let tile;
  try {
    tile = await archive.getZxy(z, x, y);
  } catch {
    // Out-of-range coordinates and similar — an empty tile, not a 500.
    return null;
  }
  return tile ? new Uint8Array(tile.data) : null;
}

function track<T>(layerId: string, read: Promise<T>): Promise<T> {
  let pending = reads.get(layerId);
  if (!pending) { pending = new Set(); reads.set(layerId, pending); }
  pending.add(read);
  const done = () => { pending.delete(read); if (!pending.size) reads.delete(layerId); };
  void read.then(done, done); return read;
}
export function tileArchiveInfo(layerId: string): Promise<TileArchiveInfo | null> { return track(layerId, archiveInfo(layerId)); }
export function readTile(layerId: string, z: number, x: number, y: number): Promise<Uint8Array | null> { return track(layerId, tile(layerId, z, x, y)); }
export async function closeTileArchives(layerIds: readonly string[]): Promise<void> {
  for (const id of layerIds) {
    while (reads.get(id)?.size) await Promise.allSettled([...reads.get(id)!]);
    archives.delete(id);
  }
}
export function tileArchivesForTests() { return { archives: [...archives.keys()], readers: [...reads.keys()] }; }
