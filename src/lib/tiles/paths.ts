import path from "node:path";
import { mkdirSync } from "node:fs";
import { dataDir } from "@/lib/config";

/**
 * Where tile artifacts live. Archives are durable state under the data
 * volume (survive restarts, deleted with the layer). The scratch
 * subdirectory is the one place the hardened query instance may write —
 * exports land there, the finished archive is renamed up one level, so the
 * swap is atomic (same filesystem) and user SQL can never touch a served
 * archive.
 */

export function tilesDir(): string {
  return path.join(dataDir(), "tiles");
}

export function tileScratchDir(): string {
  return path.join(tilesDir(), "scratch");
}

/** Layer ids are UUIDs — safe as file names by construction. */
export function tileArchivePath(layerId: string): string {
  return path.join(tilesDir(), `${layerId}.pmtiles`);
}

export function ensureTileDirs(): void {
  mkdirSync(tileScratchDir(), { recursive: true });
}
