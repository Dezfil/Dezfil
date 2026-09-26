/**
 * Fixed-window rate limiter for anonymous viewer traffic (spec: rate limiting
 * keeps a popular link from overwhelming the instance). In-memory, per key —
 * adequate for the single-instance skeleton. Tile traffic gets its own,
 * larger bucket: one pan is dozens of tile requests, so counting them against
 * the view bucket would choke a single legitimate viewer.
 */

const WINDOW_MS = 10_000;
const DEFAULT_MAX = 60; // requests per window per key
const DEFAULT_TILE_MAX = 600; // tile requests per window per key

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

function maxPerWindow(): number {
  const raw = Number(process.env.DEZFIL_PUBLIC_RATE_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX;
}

/** The tile bucket's size (DEZFIL_PUBLIC_TILE_RATE_LIMIT). */
export function tileMaxPerWindow(): number {
  const raw = Number(process.env.DEZFIL_PUBLIC_TILE_RATE_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TILE_MAX;
}

export function rateLimit(key: string, now: number, max?: number): boolean {
  const limit = max ?? maxPerWindow();
  const existing = windows.get(key);
  if (!existing || now >= existing.resetAt) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}

/** Tests reset shared state. */
export function resetRateLimits(): void {
  windows.clear();
}
