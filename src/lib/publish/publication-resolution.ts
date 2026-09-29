import { resolvePublication } from "./publication-scope";
import { limits } from "@/lib/limits";
import type { PublishedView } from "./publish-service";

type PublicationSnapshot = NonNullable<ReturnType<typeof resolvePublication>>;

// Freshness cache: published views are live within a documented bound. A cache
// hit within the bound returns instantly; a popular link cannot melt the
// instance. Unpublish invalidates by construction.
interface CacheEntry {
  view: PublishedView;
  mapId: string;
  revision: string;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

export function invalidatePublishedToken(token: string): void {
  cache.delete(token);
}

/** Tests reset shared state. */
export function resetPublishCache(): void {
  cache.clear();
}

/**
 * Assemble the read-only view for a published token, or null if the token
 * does not resolve. Read-only by construction: this reads map/layer state and
 * renders; it never mutates. Served within the freshness bound from cache.
 */
export async function resolvePublishedView(
  token: string,
  now: number,
  assemble: (snapshot: PublicationSnapshot) => Promise<PublishedView>,
): Promise<PublishedView | null> {
  let snapshot = resolvePublication(token);
  if (!snapshot) {
    invalidatePublishedToken(token);
    return null;
  }
  const cached = cache.get(token);
  if (
    cached &&
    cached.mapId === snapshot.map.id &&
    cached.revision === snapshot.revision &&
    now < cached.expiresAt
  ) {
    return cached.view;
  }

  // Assembly performs asynchronous queries. If durable state changes across
  // one pass, discard the mixed result and assemble again from the new
  // snapshot. Revocation returns null and can never repopulate the cache.
  while (true) {
    const { map, revision } = snapshot;
    const view = await assemble(snapshot);
    const current = resolvePublication(token);
    if (!current) {
      invalidatePublishedToken(token);
      return null;
    }
    if (current.map.id !== map.id || current.revision !== revision) {
      snapshot = current;
      continue;
    }
    cache.set(token, {
      view,
      mapId: map.id,
      revision,
      expiresAt: now + limits.publishFreshnessS * 1000,
    });
    return view;
  }
}
