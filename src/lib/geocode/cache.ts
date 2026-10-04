import { beginProviderCacheWrite } from "@/lib/provider-cache-generation";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { limits } from "@/lib/limits";
import { endpointKey } from "./endpoint";
import { NORMALIZATION_VERSION } from "./normalize";

/**
 * The durable answer cache.
 *
 * **The Overpass cache's posture, not its code.** Same shape — on disk, keyed
 * by endpoint plus request, TTL and a size budget with oldest-first eviction,
 * maintained around its own writes rather than by a boot sweep — and three
 * differences that matter:
 *
 *  - **Two lifetimes.** A match keeps far longer than a no-match: an address
 *    that resolved rarely moves, while an address that did not is exactly what
 *    improves when the provider's data does.
 *  - **Atomic writes.** Overpass writes its file in place, so a process that
 *    dies mid-write leaves a truncated entry that parses as garbage forever
 *    after. Here the write lands under a temporary name and is renamed, which
 *    is atomic within a directory.
 *  - **The key carries the normalization version**, because a cached answer is
 *    a claim about *this* spelling of the address.
 *
 * The key never contains the endpoint URL, only a hash of it — the configured
 * URL may carry a credential, and a cache file name is a thing that gets
 * listed, backed up and pasted into an issue.
 */

/** What the provider said about one address, as it is kept. */
export interface CachedAnswer {
  /** `matched` or `no_match`. Nothing else is cached: an empty address is
   * never asked about, and an answer we could not read is a provider fault
   * that is likely transient. */
  outcome: "matched" | "no_match";
  lon?: number;
  lat?: number;
  /** What the provider says it matched. */
  display?: string;
  attribution?: string | null;
  /** When the provider answered — not when this run read it. A cached row's
   * age is a different fact from the run's own time. */
  answeredAt: string;
}

function cacheDir(): string {
  return path.join(dataDir(), "cache", "geocode");
}

export function cacheKey(endpointUrl: string, normalized: string): string {
  return createHash("sha256")
    .update(endpointKey(endpointUrl))
    .update("\n")
    .update(String(NORMALIZATION_VERSION))
    .update("\n")
    .update(normalized)
    .digest("hex");
}

function lifetimeMs(outcome: CachedAnswer["outcome"]): number {
  return outcome === "matched"
    ? limits.geocodeMatchCacheHours * 60 * 60 * 1000
    : limits.geocodeNoMatchCacheHours * 60 * 60 * 1000;
}

/** The answer this instance already has, or null — expired entries are
 * removed rather than merely ignored, so a cache never keeps what it will
 * never serve. */
export async function readAnswer(
  endpointUrl: string,
  normalized: string,
  now: number = Date.now(),
): Promise<CachedAnswer | null> {
  const file = path.join(cacheDir(), `${cacheKey(endpointUrl, normalized)}.json`);
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as CachedAnswer;
    const answered = Date.parse(raw.answeredAt);
    if (!Number.isFinite(answered)) {
      await unlink(file).catch(() => {});
      return null;
    }
    if (now - answered > lifetimeMs(raw.outcome)) {
      await unlink(file).catch(() => {});
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export async function writeAnswer(
  endpointUrl: string,
  normalized: string,
  answer: CachedAnswer,
  generation: number,
): Promise<void> {
  const finish = await beginProviderCacheWrite(generation); if (!finish) return;
  try {
    const dir = cacheDir();
    await mkdir(dir, { recursive: true });
    const key = cacheKey(endpointUrl, normalized);
    const file = path.join(dir, `${key}.json`);
    // Atomic within the directory: a reader sees the whole entry or no entry,
    // never half of one. **Unique per write**, not per process: two writes of one
    // address that overlap would otherwise target the same temporary file, and
    // the first rename would take it out from under the second — failing a run
    // that did nothing wrong.
    const staging = path.join(dir, `.${key}.${randomUUID()}.tmp`);
    await writeFile(staging, JSON.stringify(answer), "utf8");
    await rename(staging, file);
    await maintain();
  } finally { finish(); }
}

/**
 * Expired entries go, then oldest-first eviction holds the cache under its
 * budget. Runs around the cache's own writes — never from a boot sweep, for
 * the reason the Overpass cache states: this cache is durable by design and
 * shrinks by lifetime, budget and account erasure.
 */
export async function maintain(now: number = Date.now()): Promise<void> {
  try {
    const dir = cacheDir();
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    const kept: { file: string; size: number; mtime: number }[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        const raw = JSON.parse(await readFile(file, "utf8")) as CachedAnswer;
        const answered = Date.parse(raw.answeredAt);
        if (!Number.isFinite(answered) || now - answered > lifetimeMs(raw.outcome)) {
          await unlink(file).catch(() => {});
          continue;
        }
        kept.push({ file, size: info.size, mtime: info.mtimeMs });
      } catch {
        await unlink(file).catch(() => {});
      }
    }
    const budget = limits.geocodeCacheMb * 1024 * 1024;
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
