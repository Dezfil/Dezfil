/**
 * Documented limits (spec: every limit fails fast with an actionable
 * message). Defaults agreed at the plan gate; each is overridable by a
 * deployment setting.
 */

function fromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The same, for settings where **zero is a value rather than an absence**.
 *
 * The geocoder's pace is one: an administrator running their own unrestricted
 * provider sets it to zero to mean *no gap*, and `fromEnv` would silently hand
 * back the one-second fallback instead — the documented way to turn the pace
 * off, quietly not working. Found at the cross-model review.
 */
function nonNegativeFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const limits = {
  /** Upload size cap in bytes (default 5 GB). */
  get uploadMaxBytes(): number {
    return fromEnv("DEZFIL_UPLOAD_MAX_MB", 5120) * 1024 * 1024;
  },
  /** Remote-import download cap in bytes (default 2 GB). Deliberately below
   * the upload cap: remote fetches run unattended and object-store reads
   * can only be size-checked coarsely. */
  get remoteMaxBytes(): number {
    return fromEnv("DEZFIL_REMOTE_MAX_MB", 2048) * 1024 * 1024;
  },
  /** Remote-fetch time bound in milliseconds (default 300 s) — covers the
   * whole exchange of a URL or object-store import, body included. */
  get remoteTimeoutMs(): number {
    return fromEnv("DEZFIL_REMOTE_TIMEOUT_S", 300) * 1000;
  },
  /** Overture area budget in km² for the places theme; other themes scale
   * it by density. */
  get overtureMaxKm2(): number {
    return fromEnv("DEZFIL_OVERTURE_MAX_KM2", 25_000);
  },
  /** OSM import area budget in km². */
  get osmMaxKm2(): number {
    return fromEnv("DEZFIL_OSM_MAX_KM2", 10_000);
  },
  /** Timeout injected into every Overpass query in seconds. */
  get overpassTimeoutS(): number {
    return fromEnv("DEZFIL_OVERPASS_TIMEOUT_S", 60);
  },
  /** Overpass maxsize injected into every query, in MB. */
  get overpassMaxsizeMb(): number {
    return fromEnv("DEZFIL_OVERPASS_MAXSIZE_MB", 512);
  },
  /** Overpass response cache TTL in hours. */
  get overpassCacheHours(): number {
    return fromEnv("DEZFIL_OVERPASS_CACHE_H", 24);
  },
  /** Overpass cache size budget in MB (default 2 GB) — enforced
   * oldest-first by the cache's own maintenance. */
  get overpassCacheMb(): number {
    return fromEnv("DEZFIL_OVERPASS_CACHE_MB", 2048);
  },
  /** Query timeout in milliseconds (default 60 s). */
  get queryTimeoutMs(): number {
    return fromEnv("DEZFIL_QUERY_TIMEOUT_S", 60) * 1000;
  },
  /** Engine memory budget for user SQL in MB (default 2 GB) — set on the
   * hardened instance at creation, shared by all queries on it. */
  get queryMemoryMb(): number {
    return fromEnv("DEZFIL_QUERY_MEMORY_MB", 2048);
  },
  /** Result preview row cap (default 1,000). */
  get previewRows(): number {
    return fromEnv("DEZFIL_PREVIEW_ROWS", 1000);
  },
  /** Per-layer render cap in features (default 250,000). */
  get renderCapFeatures(): number {
    return fromEnv("DEZFIL_RENDER_CAP_FEATURES", 250_000);
  },
  /** Source-point cap for responsive slider previews. Unlike the
   * render cap, this bounds transfer and interactive re-aggregation work. */
  get sliderPreviewRows(): number {
    return fromEnv("DEZFIL_SLIDER_PREVIEW_ROWS", 50_000);
  },
  /** Published-view freshness bound in seconds (default 30). */
  get publishFreshnessS(): number {
    return fromEnv("DEZFIL_PUBLISH_FRESHNESS_S", 30);
  },
  /** Tile build timeout in milliseconds (default 10 min) — covers the export
   * and the tiling stages each; builds run in the background. */
  get tileBuildTimeoutMs(): number {
    return fromEnv("DEZFIL_TILE_BUILD_TIMEOUT_S", 600) * 1000;
  },
  /** Server image-render budget in milliseconds (default 90 s) — spans
   * queue wait through response; a render past it dies with the coded
   * error, never lingers. */
  get exportRenderTimeoutMs(): number {
    return fromEnv("DEZFIL_EXPORT_RENDER_TIMEOUT_S", 90) * 1000;
  },
  /** The bound on any one request the render page makes (default 20 s):
   * a request past it is abandoned so the page can settle, and the
   * export still answers — one stalled external tile no longer costs
   * the whole render budget. */
  get exportRequestTimeoutMs(): number {
    return fromEnv("DEZFIL_EXPORT_REQUEST_TIMEOUT_S", 20) * 1000;
  },
  /** Concurrent server image renders (default 2) — software-GL browsers
   * are CPU-expensive; work beyond the cap waits inside the budget. */
  get exportRenderConcurrency(): number {
    return Math.max(1, Math.floor(fromEnv("DEZFIL_EXPORT_RENDER_CONCURRENCY", 2)));
  },
  /** Tool attachment cap in bytes (default 32 MB): a download answered to
   * an agent tool arrives as a base64 envelope; past this size the tool
   * answers a coded error instead of flooding the transport. */
  get toolAttachmentMaxBytes(): number {
    return fromEnv("DEZFIL_TOOL_ATTACHMENT_MAX_MB", 32) * 1024 * 1024;
  },
  /** Max model+tool steps one assistant request may take (default 20). The
   * agent loop stops here so a runaway loop is impossible. */
  get assistantStepBudget(): number {
    return fromEnv("DEZFIL_ASSISTANT_STEP_BUDGET", 20);
  },
  /** The assistant's map check budget in milliseconds (default 30 s, spec
   * D5): request to response, queue wait, render and image preparation
   * included; a proposed default, measured by the piece's item 8, not
   * the export's 90 s. */
  get assistantLookTimeoutMs(): number {
    return fromEnv("DEZFIL_ASSISTANT_LOOK_TIMEOUT_S", 30) * 1000;
  },
  /** Renders of the map check kept in process (default 256,
   * item 6), full images and thumbnails counted together, oldest evicted
   * first; gone with the process. */
  get assistantLookRetention(): number {
    return Math.max(1, Math.floor(fromEnv("DEZFIL_ASSISTANT_LOOK_RETENTION", 256)));
  },
  /** The retained renders' byte budget in MiB (default 96). */
  get assistantLookRetentionMb(): number {
    return fromEnv("DEZFIL_ASSISTANT_LOOK_RETENTION_MB", 96);
  },
  /** Whether the assistant checks the map by itself after a turn that
   * changed it: the instance owner's setting, on by default; "0",
   * "false" or "off" turns it off. An explicit check is available
   * whatever this says. */
  get assistantAutoCheck(): boolean {
    const raw = process.env.DEZFIL_ASSISTANT_AUTO_CHECK?.trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "off");
  },
  /**
   * The minimum gap between two requests to the configured geocoder, in
   * milliseconds.
   *
   * One second by default, which is what the public Nominatim recipe requires.
   * An administrator running their own geocoder sets it lower and gets a
   * proportionally larger batch bound without touching a second setting —
   * though not without limit, because a slow provider's own response time
   * dominates a fast pace.
   */
  get geocodePaceMs(): number {
    return nonNegativeFromEnv("DEZFIL_GEOCODE_PACE_MS", 1000);
  },
  /** How long a matched address keeps. Thirty days: an address that resolved
   * rarely moves. */
  get geocodeMatchCacheHours(): number {
    return fromEnv("DEZFIL_GEOCODE_MATCH_CACHE_HOURS", 720);
  },
  /** How long a no-match keeps. One day: an address that did not resolve is
   * exactly what improves when the provider's data does. */
  get geocodeNoMatchCacheHours(): number {
    return fromEnv("DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS", 24);
  },
  /** The geocode cache's size budget, in megabytes. */
  get geocodeCacheMb(): number {
    return fromEnv("DEZFIL_GEOCODE_CACHE_MB", 64);
  },
  /** The isochrone endpoint's own pace. One request a
   * second by default — the courteous default for a shared provider; a
   * self-hosted Valhalla sets it lower and the origin bound grows with it. */
  get isochronePaceMs(): number {
    return nonNegativeFromEnv("DEZFIL_ISOCHRONE_PACE_MS", 1000);
  },
  /** The whole-exchange deadline for one isochrone request. Twenty seconds:
   * routing is slower than geocoding, and the geocoder's ten would fail
   * honest answers (K10). */
  get isochroneRequestTimeoutMs(): number {
    return fromEnv("DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S", 20) * 1000;
  },
  /** How long a fully answered isochrone keeps. A week: a road network
   * changes slowly, and an isochrone is expensive to ask for (K10). */
  get isochroneCacheHours(): number {
    return fromEnv("DEZFIL_ISOCHRONE_CACHE_HOURS", 168);
  },
  /** The isochrone cache's size budget, in megabytes (K10). */
  get isochroneCacheMb(): number {
    return fromEnv("DEZFIL_ISOCHRONE_CACHE_MB", 64);
  },
  /**
   * The whole-exchange deadline for one geocoding request, in milliseconds.
   *
   * **It is half of what a batch costs per row.** A row costs the pacing
   * interval or the provider's answer, whichever is longer, and this is what
   * bounds the second — so lowering it raises the batch bound exactly as
   * lowering the pace does, and the bound is derived from both rather than
   * from the pace alone.
   */
  get geocodeRequestTimeoutMs(): number {
    return fromEnv("DEZFIL_GEOCODE_REQUEST_TIMEOUT_S", 10) * 1000;
  },
  /** Operation execution budget in milliseconds (default 10 min) — the run
   * lane's own bound, deliberately larger than the user-query timeout. It
   * covers execution only: a job charged for the time it waited in the
   * queue would fail work that never got to run.
   *
   * The default is set from the E9 measurement rather than by feel
   * (`scripts/perf/overlay-budget.mjs`): the slowest verified overlay at a
   * million rows was ~23 s against realistically complex geometry, and the
   * spec requires at least a ten-fold margin over the recorded figure. Ten
   * minutes also matches the tile build's bound, so the product has one
   * number for long background work rather than two. */
  get operationTimeoutMs(): number {
    return fromEnv("DEZFIL_OPERATION_TIMEOUT_S", 600) * 1000;
  },
  /** Operations executing at once (default 1) — they are heavy work on the
   * hardened instance, whose memory budget is shared by everything running
   * on it, so an uncapped lane turns two large joins into a memory failure
   * for both. Matches the tile build's process-wide serialization. */
  get operationConcurrency(): number {
    return Math.max(1, Math.floor(fromEnv("DEZFIL_OPERATION_CONCURRENCY", 1)));
  },
  /** Runs that may wait for the lane (default 20). Past it a run is refused
   * with a coded error rather than admitted to a queue that will not
   * drain. */
  get operationQueueMax(): number {
    return Math.max(1, Math.floor(fromEnv("DEZFIL_OPERATION_QUEUE_MAX", 20)));
  },
  /** Runs kept per subject (default 20). The subject's most recent success
   * is preserved inside this depth rather than beside it, so the number
   * means one thing. */
  get operationHistoryPerSubject(): number {
    return Math.max(
      1,
      Math.floor(fromEnv("DEZFIL_OPERATION_HISTORY_PER_SUBJECT", 20)),
    );
  },
};
