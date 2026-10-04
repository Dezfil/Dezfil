import { rm } from "node:fs/promises";
import path from "node:path";
interface CacheState { generation: number; purge: Promise<void> | null; writers: Set<ReturnType<typeof Promise.withResolvers<void>>> }
const key = Symbol.for("dezfil.provider-cache-generation");
const host = globalThis as typeof globalThis & { [key]?: CacheState };
const state: CacheState = host[key] ??= { generation: 0, purge: null, writers: new Set() };
/** Capture before looking up or requesting an answer, never at write time. */
export function providerCacheGeneration(): number { return state.generation; }
/** A lease spans all filesystem writes and maintenance, including failures. New
 * generations wait behind a purge; an earlier request can never write again. */
export async function beginProviderCacheWrite(generation: number): Promise<(() => void) | null> {
  while (state.purge) { try { await state.purge; } catch { return null; } }
  if (generation !== state.generation) return null;
  const writer = Promise.withResolvers<void>(); state.writers.add(writer);
  return () => { state.writers.delete(writer); writer.resolve(); };
}
export function purgeProviderAnswerFiles(directory: string): Promise<void> {
  const preceding = state.purge;
  state.generation++;
  const work = Promise.resolve(preceding).catch(() => {}).then(async () => {
    await Promise.all([...state.writers].map(writer => writer.promise));
    const results = await Promise.allSettled(["geocode", "isochrone", "overpass"].map(name => rm(path.join(directory, "cache", name), { recursive: true, force: true })));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }).finally(() => { if (state.purge === work) state.purge = null; });
  state.purge = work; return work;
}
export function providerCacheWritersForTests(): number { return state.writers.size; }
