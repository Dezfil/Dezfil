import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { limits } from "@/lib/limits";
import { ISOCHRONE_PROTOCOL_VERSION, isochroneEndpointKey } from "./endpoint";

/**
 * The durable answer cache: the geocode cache's posture — on disk, atomic
 * writes, TTL plus a size budget with oldest-first eviction, maintained
 * around its own writes — keyed for this protocol.
 *
 * **Only a fully answered response is cached.** A response with an
 * unreachable band is not, because the band that failed may succeed
 * tomorrow; a failure is never cached at all. One lifetime, not two: a
 * road network changes slowly, and there is no cheap-to-retry outcome here
 * the way a no-match is for an address.
 *
 * **Nothing is rounded on the way into the key.** Rounding a coordinate
 * moves where travel starts, which is not a normalization but a different
 * question. The key never contains the endpoint URL, only its hash — the
 * configured URL may carry a credential, and a cache file name gets
 * listed, backed up and pasted into an issue.
 */

/** One origin's fully answered exchange, as it is kept: every requested
 * band with its area, and the candidate the answer was checked against. */
export interface CachedIsochrone {
  /** Per band, in the request's order: the area as WKT in WGS84. Every
   * band present and answered — that is what made this cacheable. */
  bands: { minutes: number; wkt: string }[];
  snappedLon: number;
  snappedLat: number;
  /** When the provider answered — not when this run read it. */
  answeredAt: string;
}

function cacheDir(): string {
  return path.join(dataDir(), "cache", "isochrone");
}

export function isochroneCacheKey(
  endpointUrl: string,
  costing: string,
  origin: { lon: number; lat: number },
  bands: number[],
): string {
  return createHash("sha256")
    .update(isochroneEndpointKey(endpointUrl))
    .update("\n")
    .update(String(ISOCHRONE_PROTOCOL_VERSION))
    .update("\n")
    .update(costing)
    .update("\n")
    // The exact coordinates, unrounded (K10).
    .update(`${origin.lon},${origin.lat}`)
    .update("\n")
    // Canonical: sorted, so band order never splits one question in two.
    .update([...bands].sort((a, b) => a - b).join(","))
    .digest("hex");
}

function lifetimeMs(): number {
  return limits.isochroneCacheHours * 60 * 60 * 1000;
}

/** The answer this instance already has, or null — expired entries are
 * removed rather than merely ignored. */
export async function readIsochrone(
  key: string,
  now: number = Date.now(),
): Promise<CachedIsochrone | null> {
  const file = path.join(cacheDir(), `${key}.json`);
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as CachedIsochrone;
    const answered = Date.parse(raw.answeredAt);
    if (!Number.isFinite(answered) || now - answered > lifetimeMs()) {
      await unlink(file).catch(() => {});
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export async function writeIsochrone(
  key: string,
  answer: CachedIsochrone,
): Promise<void> {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  // Atomic within the directory, unique per write — two overlapping writes
  // of one origin must not steal each other's staging file.
  const staging = path.join(dir, `.${key}.${randomUUID()}.tmp`);
  await writeFile(staging, JSON.stringify(answer), "utf8");
  await rename(staging, file);
  await maintainIsochroneCache();
}

/** Expired entries go, then oldest-first eviction holds the budget. Runs
 * around the cache's own writes, never from a boot sweep — durable by
 * design, shrinking only by lifetime and budget. */
export async function maintainIsochroneCache(
  now: number = Date.now(),
): Promise<void> {
  try {
    const dir = cacheDir();
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    const kept: { file: string; size: number; mtime: number }[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        const raw = JSON.parse(await readFile(file, "utf8")) as CachedIsochrone;
        const answered = Date.parse(raw.answeredAt);
        if (!Number.isFinite(answered) || now - answered > lifetimeMs()) {
          await unlink(file).catch(() => {});
          continue;
        }
        kept.push({ file, size: info.size, mtime: info.mtimeMs });
      } catch {
        await unlink(file).catch(() => {});
      }
    }
    const budget = limits.isochroneCacheMb * 1024 * 1024;
    let total = kept.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= budget) return;
    kept.sort((a, b) => a.mtime - b.mtime);
    for (const entry of kept) {
      if (total <= budget) break;
      await unlink(entry.file).catch(() => {});
      total -= entry.size;
    }
  } catch {
    /* A cache that cannot be maintained still answers; it just grows */
  }
}
