/** Source windows shared by every route bundle in the single server process. */
const WINDOW_MS = 10_000;
const DEFAULT_MAX = 60; // requests per window per key
const DEFAULT_TILE_MAX = 600; // tile requests per window per key

interface Window {
  count: number;
  resetAt: number;
}

const STATE = Symbol.for("dezfil.publication-windows");
const SWEEP = Symbol.for("dezfil.publication-sweep");
const shared = process as typeof process & { [STATE]?: Map<string, Window>; [SWEEP]?: number };
const windows = shared[STATE] ??= new Map<string, Window>();
const MAX_ENTRIES = 10_000;

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
  // Route bundles share the sweep deadline as well as the source windows.
  if (now >= (shared[SWEEP] ?? -Infinity) + 1000) {
    shared[SWEEP] = now;
    for (const [source, window] of windows) if (now >= window.resetAt) windows.delete(source);
  }
  const limit = max ?? maxPerWindow();
  const existing = windows.get(key);
  if (!existing || now >= existing.resetAt) {
    if (existing) windows.delete(key);
    if (windows.size >= MAX_ENTRIES) windows.delete(windows.keys().next().value!);
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  windows.delete(key); windows.set(key, existing);
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}

/** Tests reset shared state. */
export function resetRateLimits(): void {
  windows.clear();
  delete shared[SWEEP];
}

/** In-process evidence only; never exposed by an HTTP operation. */
export function rateLimitEntryCount(): number { return windows.size; }
