import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { limits } from "@/lib/limits";
import { lookFacts, type LookFacts, type LookResult } from "./map-look";

/**
 * The retained renders of the map check: in process, under a count
 * bound and a byte bound that count full images and thumbnails
 * together, oldest evicted first, gone with the process. A read after
 * eviction or restart is the documented unavailability and never a
 * render; the module knows nothing of the renderer. The thumbnail
 * arrives with the check's result, prepared inside its budget; nothing
 * is decoded here.
 */

export { THUMBNAIL_WIDTH } from "./look-thumbnail";
export type LookVariant = "full" | "thumbnail";

interface Retained { accountId: string; id: string; facts: LookFacts; full: Uint8Array; thumbnail: Uint8Array; at: number }

export interface RetentionBounds { count: number; bytes: number }

export class LookRetention {
  private entries = new Map<string, Retained>();
  private total = 0;
  constructor(private readonly bounds: RetentionBounds | (() => RetentionBounds), private readonly now: () => number = Date.now) {}
  private limit(): RetentionBounds { return typeof this.bounds === "function" ? this.bounds() : this.bounds; }
  /** Keep a check's image and its thumbnail; evict the oldest until both bounds hold. */
  retain(scope: AccountScope, result: LookResult): { id: string; fullBytes: number; thumbnailBytes: number } {
    const accountId = requireAccountScope(scope);
    const thumbnail = result.thumbnail.png;
    const entry: Retained = { accountId, id: result.id, facts: lookFacts(result), full: result.image.png, thumbnail, at: this.now() };
    this.entries.set(entry.id, entry);
    this.total += entry.full.byteLength + entry.thumbnail.byteLength;
    const { count, bytes } = this.limit();
    for (const [id, oldest] of this.entries) {
      if (this.entries.size <= count && this.total <= bytes) break;
      // The newest alone over the byte cap is not kept either: the store
      // never sits above its bound, and the read answers unavailability.
      this.entries.delete(id);
      this.total -= oldest.full.byteLength + oldest.thumbnail.byteLength;
    }
    return { id: entry.id, fullBytes: entry.full.byteLength, thumbnailBytes: thumbnail.byteLength };
  }
  /** The retained bytes, or null once evicted or after a restart. */
  read(scope: AccountScope, id: string, variant: LookVariant): Uint8Array | null {
    const accountId = requireAccountScope(scope);
    const entry = this.entries.get(id);
    if (!entry || entry.accountId !== accountId) return null;
    return variant === "thumbnail" ? entry.thumbnail : entry.full;
  }
  facts(scope: AccountScope, id: string): LookFacts | null {
    const accountId = requireAccountScope(scope), entry = this.entries.get(id);
    return entry?.accountId === accountId ? structuredClone(entry.facts) : null;
  }
  sizeForTests(): { count: number; bytes: number } { return { count: this.entries.size, bytes: this.total }; }
  /** Oldest first. */
  idsForTests(): string[] { return [...this.entries.keys()]; }
  /** Test seams: an eviction and the process's restart, never exposed by the API. */
  evictForTests(id: string) { const entry = this.entries.get(id); if (entry) { this.entries.delete(id); this.total -= entry.full.byteLength + entry.thumbnail.byteLength; } }
  resetForTests() { this.entries.clear(); this.total = 0; }
}

export const lookRetention = new LookRetention(() => ({ count: limits.assistantLookRetention, bytes: limits.assistantLookRetentionMb * 1024 * 1024 }));
