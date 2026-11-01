import type { StorageRecovery } from "@/lib/system/storage-reserve";
import { rm } from "node:fs/promises";
import path from "node:path";
import { PROVIDER_CACHES, type ProviderCache } from "./provider-caches";
export { PROVIDER_CACHES, type ProviderCache };
interface Writer { cache: ProviderCache; done: ReturnType<typeof Promise.withResolvers<void>> }
interface CacheState { generation: number; purgedAt: Record<ProviderCache, number>; purge: Promise<void> | null; writers: Set<Writer> }
const key = Symbol.for("dezfil.provider-cache-generation");
const host = globalThis as typeof globalThis & { [key]?: CacheState };
const state: CacheState = host[key] ??= { generation: 0, purgedAt: { geocode: 0, isochrone: 0, overpass: 0 }, purge: null, writers: new Set() };
/** Capture before looking up or requesting an answer, never at write time. */
export function providerCacheGeneration(): number { return state.generation; }
/** A lease spans all filesystem writes and maintenance, including failures. New
 * generations wait behind a purge; a request that began before a purge of its
 * cache can never write again, while a purge of another cache leaves it be. */
export async function beginProviderCacheWrite(generation: number, cache: ProviderCache): Promise<(() => void) | null> {
  while (state.purge) { try { await state.purge; } catch { return null; } }
  if (generation < state.purgedAt[cache]) return null;
  const writer: Writer = { cache, done: Promise.withResolvers<void>() }; state.writers.add(writer);
  return () => { state.writers.delete(writer); writer.done.resolve(); };
}
/** Empties the named caches, all three by default, once every write already
 * under way in them has landed. */
export function purgeProviderAnswerFiles(directory: string, caches: readonly ProviderCache[] = PROVIDER_CACHES,
  recover: StorageRecovery = async work => work()): Promise<void> {
  const preceding = state.purge;
  state.generation++;
  for (const cache of caches) state.purgedAt[cache] = state.generation;
  const work = Promise.resolve(preceding).catch(() => {}).then(async () => {
    await Promise.all([...state.writers].filter(writer => caches.includes(writer.cache)).map(writer => writer.done.promise));
    const results = await Promise.allSettled(caches.map(name => recover(() => rm(path.join(directory, "cache", name), { recursive: true, force: true }))));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }).finally(() => { if (state.purge === work) state.purge = null; });
  state.purge = work; return work;
}
export function providerCacheWritersForTests(): number { return state.writers.size; }
