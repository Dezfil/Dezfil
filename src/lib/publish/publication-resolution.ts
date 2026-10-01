import { resolvePublication } from "./publication-scope";
import { limits } from "@/lib/limits";
import { publicationRevision } from "@/lib/query/namespace";
import { forgetPublications } from "@/lib/query/publication-namespace";
import { collectInputs, type ArtifactInputs } from "@/lib/query/evaluation-inputs";
import { servableToPublication } from "@/lib/artifact-access";
import type { PublishedView } from "./publish-service";

type PublicationSnapshot = NonNullable<ReturnType<typeof resolvePublication>>;

// Freshness cache: published views are live within a documented bound. A cache
// hit within the bound returns instantly; a popular link cannot melt the
// instance. Unpublish invalidates by construction. Each entry keeps the
// evidence of what its assembly drew: every evaluation that ran for it.
interface CacheEntry {
  view: PublishedView;
  mapId: string;
  revision: string;
  expiresAt: number;
  inputs: ArtifactInputs;
}
const cache = new Map<string, CacheEntry>();

export function invalidatePublishedToken(token: string): void {
  cache.delete(token);
}

/** What the view held for this token drew, or null when none is held. */
export function cachedPublicationInputs(token: string): ArtifactInputs | null {
  return cache.get(token)?.inputs ?? null;
}

/** Tests reset shared state. */
export function resetPublishCache(): void {
  cache.clear();
  forgetPublications();
}

/** A snapshot's revision with what its mounts are resolved from: a change of
 * the owner's reach, or of the map's SQL, retires an assembled view. */
function revisionOf(snapshot: PublicationSnapshot): string {
  return JSON.stringify([snapshot.revision, publicationRevision(snapshot.scope)]);
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
  // A hit is served like any retained artifact: only while the link may
  // still be served everything the held view drew.
  const cached = cache.get(token);
  if (
    cached &&
    cached.mapId === snapshot.map.id &&
    cached.revision === revisionOf(snapshot) &&
    now < cached.expiresAt &&
    servableToPublication(snapshot.scope, cached.inputs)
  ) {
    return cached.view;
  }

  // Assembly performs asynchronous queries. If durable state changes across
  // one pass, discard the mixed result and assemble again from the new
  // snapshot. Revocation returns null and can never repopulate the cache.
  while (true) {
    const { map } = snapshot;
    const revision = revisionOf(snapshot);
    const assembling: PublicationSnapshot = snapshot;
    const { value: view, inputs } = await collectInputs(() => assemble(assembling));
    const current = resolvePublication(token);
    if (!current) {
      invalidatePublishedToken(token);
      return null;
    }
    if (current.map.id !== map.id || revisionOf(current) !== revision) {
      snapshot = current;
      continue;
    }
    cache.set(token, {
      view,
      mapId: map.id,
      revision,
      expiresAt: now + limits.publishFreshnessS * 1000,
      inputs,
    });
    return view;
  }
}
