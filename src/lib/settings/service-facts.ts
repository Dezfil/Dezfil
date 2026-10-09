import type { Database } from "better-sqlite3";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { dataDir } from "@/lib/config";
import { limits } from "@/lib/limits";
import { metadataDb } from "@/lib/metadata/db";
import { keptReleaseList } from "@/lib/overture/releases";
import { purgeProviderAnswerFiles } from "@/lib/provider-cache-generation";
import { PROVIDER_CACHES, type ProviderCache } from "@/lib/provider-caches";
import { forgetStorageRead } from "@/lib/system/storage";

/**
 * What the services keep on this instance, for the configuration read, and
 * the Clear that empties a cache.
 *
 * Each provider cache reports the bytes its answers take on disk, how many
 * answers it holds and its budget in its variable's unit (MB). The Overture
 * release list is the one this process keeps: how many releases, the newest
 * and when it was listed, or not listed yet. Reading these looks at the data
 * folder and this process only; it asks no service.
 */

export interface CacheFacts { bytes: number; answers: number; budgetMb: number }
export type ReleaseListFacts = { listed: false } | { listed: true; releases: number; newest: string; listedAt: string };
export type ServiceFacts = Record<ProviderCache, CacheFacts> & { overture: ReleaseListFacts };

const BUDGET_MB: Record<ProviderCache, () => number> = {
  geocode: () => limits.geocodeCacheMb,
  isochrone: () => limits.isochroneCacheMb,
  overpass: () => limits.overpassCacheMb,
};

export function isProviderCache(value: unknown): value is ProviderCache {
  return typeof value === "string" && (PROVIDER_CACHES as readonly string[]).includes(value);
}

async function cacheFacts(cache: ProviderCache): Promise<CacheFacts> {
  const directory = path.join(dataDir(), "cache", cache);
  // An answer is a .json file; a write still landing under its temporary
  // name is not one yet.
  const names = await readdir(directory).then(entries => entries.filter(name => name.endsWith(".json")), () => []);
  let bytes = 0;
  let answers = 0;
  for (const name of names) {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (!info?.isFile()) continue; // raced away by its cache's own upkeep
    bytes += info.size;
    answers += 1;
  }
  return { bytes, answers, budgetMb: BUDGET_MB[cache]() };
}

function releaseListFacts(): ReleaseListFacts {
  const kept = keptReleaseList();
  if (!kept || kept.releases.length === 0) return { listed: false };
  return { listed: true, releases: kept.releases.length, newest: kept.releases[0], listedAt: new Date(kept.listedAt).toISOString() };
}

export async function readServiceFacts(): Promise<ServiceFacts> {
  const [geocode, isochrone, overpass] = await Promise.all(PROVIDER_CACHES.map(cacheFacts));
  return { geocode, isochrone, overpass, overture: releaseListFacts() };
}

/**
 * Empty one provider cache, or all three, through the purge every account
 * erasure uses: a request that began before the Clear writes no answer
 * after it, and a write already landing is waited for and then removed.
 * The admin is rechecked first; nothing else changes, except that the
 * storage read's last answer is forgotten, so the next shows the caches
 * as they are now.
 */
export async function clearServiceCaches(
  context: AuthContext,
  cache: ProviderCache | null,
  db: Database = metadataDb(),
  now = Date.now(),
): Promise<{ cleared: ProviderCache[] }> {
  requireAdmin(context, db, now);
  const cleared = cache ? [cache] : [...PROVIDER_CACHES];
  await purgeProviderAnswerFiles(dataDir(), cleared);
  forgetStorageRead();
  return { cleared };
}
