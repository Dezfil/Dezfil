import type { NumericDefinition, NumericParsing, WriteConstraint } from "./types";

function numeric<const K extends string>(
  key: K, environment: string, label: string, purpose: string,
  defaultValue: number, unit: string, write?: Extract<WriteConstraint, { kind: "integer" }>,
  parsing: NumericParsing = "positive",
): NumericDefinition & { readonly key: K } {
  return { key, environment, label, purpose, defaultValue, unit, write, parsing,
    kind: "number", scope: "instance", readBy: "admin", changedBy: write ? "admin" : "deployment",
    documentedDefault: String(defaultValue), environmentTiming: "restart",
    timing: write ? "live" : "next-start", secret: false, editable: !!write };
}
const integer = (min: number, max: number) => ({ kind: "integer", min, max } as const);

/** Values use deployment units. Facades convert bytes and milliseconds at their boundary.
 * The services' numbers an admin may store keep those units too: a gap in
 * milliseconds, an answer limit in seconds, freshness in hours. */
export const NUMERIC_SETTINGS = [
  numeric("uploadMaxMb", "DEZFIL_UPLOAD_MAX_MB", "Largest upload", "Size cap for one uploaded file.", 5120, "MB", integer(1, 102400)),
  numeric("dataProcessingTimeoutS", "DEZFIL_DATA_PROCESSING_TIMEOUT_S", "Data processing time limit", "Admitted budget for upload reception and trusted data processing, separately.", 3600, "seconds", integer(60, 21600)),
  numeric("remoteMaxMb", "DEZFIL_REMOTE_MAX_MB", "Largest link import", "Size cap for a URL or object-store import.", 2048, "MB", integer(1, 102400)),
  numeric("remoteTimeoutS", "DEZFIL_REMOTE_TIMEOUT_S", "Link import time limit", "Budget for the complete remote exchange, including the body.", 300, "seconds", integer(10, 3600)),
  numeric("overtureMaxKm2", "DEZFIL_OVERTURE_MAX_KM2", "Overture area", "Places area budget; other themes scale by density.", 25000, "km²", integer(1, 1000000)),
  numeric("osmMaxKm2", "DEZFIL_OSM_MAX_KM2", "OpenStreetMap area", "Area budget for one OpenStreetMap import.", 10000, "km²", integer(1, 1000000)),
  numeric("overpassTimeoutS", "DEZFIL_OVERPASS_TIMEOUT_S", "Overpass time limit", "Time budget sent with every Overpass query.", 60, "seconds", integer(10, 900)),
  numeric("overpassMaxsizeMb", "DEZFIL_OVERPASS_MAXSIZE_MB", "Overpass response budget", "Response budget sent to Overpass; twice this aborts locally.", 512, "MB"),
  numeric("overpassCacheHours", "DEZFIL_OVERPASS_CACHE_H", "Overpass cache freshness", "How long an Overpass response stays fresh.", 24, "hours", integer(1, 720)),
  numeric("overpassCacheMb", "DEZFIL_OVERPASS_CACHE_MB", "Overpass cache size", "Cache size budget, evicted oldest first.", 2048, "MB"),
  numeric("queryTimeoutS", "DEZFIL_QUERY_TIMEOUT_S", "Query time limit", "Admitted budget for user SQL and interactive trusted reads.", 60, "seconds", integer(5, 600)),
  numeric("queryMemoryMb", "DEZFIL_QUERY_MEMORY_MB", "Engine memory", "Shared memory budget of the hardened query instance.", 2048, "MB"),
  numeric("trustedMemoryMb", "DEZFIL_TRUSTED_MEMORY_MB", "Trusted engine memory", "Shared memory budget of the trusted engine; scratch allowance is four times this value.", 3072, "MB"),
  numeric("previewRows", "DEZFIL_PREVIEW_ROWS", "Rows shown in results", "Row cap for result previews.", 1000, "rows", integer(10, 100000)),
  numeric("renderCapFeatures", "DEZFIL_RENDER_CAP_FEATURES", "Features drawn per layer", "Feature cap for rendering and the point-layer tile threshold.", 250000, "features"),
  numeric("renderCapBytes", "DEZFIL_RENDER_CAP_BYTES", "Bytes drawn per layer", "Complete uncompressed UTF-8 JSON byte ceiling for each inline layer answer.", 134217728, "bytes", undefined, "positive-integer"),
  numeric("sliderPreviewRows", "DEZFIL_SLIDER_PREVIEW_ROWS", "Slider preview rows", "Source points transferred for interactive slider previews.", 50000, "rows"),
  numeric("publishFreshnessS", "DEZFIL_PUBLISH_FRESHNESS_S", "Published freshness", "Cache window for published views.", 30, "seconds"),
  numeric("tileBuildTimeoutS", "DEZFIL_TILE_BUILD_TIMEOUT_S", "Tile build time limit", "Time budget for each background tile-build stage.", 600, "seconds"),
  numeric("exportRenderTimeoutS", "DEZFIL_EXPORT_RENDER_TIMEOUT_S", "Time limit per image", "Image-render budget including queue wait.", 90, "seconds", integer(10, 300)),
  numeric("exportRequestTimeoutS", "DEZFIL_EXPORT_REQUEST_TIMEOUT_S", "Image request time limit", "Deadline for each request made by the render page.", 20, "seconds"),
  numeric("exportRenderConcurrency", "DEZFIL_EXPORT_RENDER_CONCURRENCY", "Images at once", "Concurrent server image renders.", 2, "renders", integer(1, 8), "positive-integer"),
  numeric("toolAttachmentMaxMb", "DEZFIL_TOOL_ATTACHMENT_MAX_MB", "Tool attachment size", "Maximum download carried in a tool's base64 envelope.", 32, "MB"),
  numeric("assistantStepBudget", "DEZFIL_ASSISTANT_STEP_BUDGET", "Assistant steps", "Maximum model and tool steps per request.", 20, "steps"),
  numeric("assistantLookTimeoutS", "DEZFIL_ASSISTANT_LOOK_TIMEOUT_S", "Map check time limit", "Budget for an assistant map check, including queue wait.", 30, "seconds"),
  numeric("assistantLookRetention", "DEZFIL_ASSISTANT_LOOK_RETENTION", "Retained map checks", "Full images and thumbnails retained in process.", 256, "images", undefined, "positive-integer"),
  numeric("assistantLookRetentionMb", "DEZFIL_ASSISTANT_LOOK_RETENTION_MB", "Map check storage", "Byte budget for retained map checks.", 96, "MB"),
  numeric("geocodePaceMs", "DEZFIL_GEOCODE_PACE_MS", "Address finder pace", "Minimum request gap; zero means no gap.", 1000, "milliseconds", integer(0, 60000), "non-negative"),
  numeric("geocodeMatchCacheHours", "DEZFIL_GEOCODE_MATCH_CACHE_HOURS", "Address match freshness", "How long matched addresses are cached.", 720, "hours", integer(24, 8760)),
  numeric("geocodeNoMatchCacheHours", "DEZFIL_GEOCODE_NO_MATCH_CACHE_HOURS", "Unmatched address freshness", "How long no-match answers are cached.", 24, "hours"),
  numeric("geocodeCacheMb", "DEZFIL_GEOCODE_CACHE_MB", "Address cache size", "Size budget for cached geocoding answers.", 64, "MB"),
  numeric("isochronePaceMs", "DEZFIL_ISOCHRONE_PACE_MS", "Travel-time pace", "Minimum routing request gap; zero means no gap.", 1000, "milliseconds", integer(0, 60000), "non-negative"),
  numeric("isochroneRequestTimeoutS", "DEZFIL_ISOCHRONE_REQUEST_TIMEOUT_S", "Travel-time request limit", "Deadline for one routing exchange.", 20, "seconds", integer(1, 120)),
  numeric("isochroneCacheHours", "DEZFIL_ISOCHRONE_CACHE_HOURS", "Travel-time cache freshness", "How long complete routing answers are cached.", 168, "hours", integer(24, 8760)),
  numeric("isochroneCacheMb", "DEZFIL_ISOCHRONE_CACHE_MB", "Travel-time cache size", "Size budget for cached routing answers.", 64, "MB"),
  numeric("geocodeRequestTimeoutS", "DEZFIL_GEOCODE_REQUEST_TIMEOUT_S", "Address request limit", "Deadline for one geocoding exchange.", 10, "seconds", integer(1, 120)),
  numeric("operationTimeoutS", "DEZFIL_OPERATION_TIMEOUT_S", "Time limit per run", "Execution budget for a geospatial operation, excluding queue wait.", 600, "seconds", integer(30, 7200)),
  numeric("operationConcurrency", "DEZFIL_OPERATION_CONCURRENCY", "Operation runs at once", "Concurrent geospatial operations sharing the hardened engine.", 1, "runs", integer(1, 8), "positive-integer"),
  numeric("operationQueueMax", "DEZFIL_OPERATION_QUEUE_MAX", "Operation runs waiting", "Maximum waiting geospatial operations.", 20, "runs", integer(1, 200), "positive-integer"),
  numeric("operationHistoryPerSubject", "DEZFIL_OPERATION_HISTORY_PER_SUBJECT", "Run history depth", "Runs retained per subject, including its most recent success.", 20, "runs", undefined, "positive-integer"),
  numeric("publicRateLimit", "DEZFIL_PUBLIC_RATE_LIMIT", "Requests per source", "Anonymous published reads per verified source across publication tokens.", 60, "per 10 seconds", integer(1, 10000)),
  numeric("publicTileRateLimit", "DEZFIL_PUBLIC_TILE_RATE_LIMIT", "Tile requests per source", "Anonymous tile reads per verified source across publication tokens.", 600, "per 10 seconds", integer(1, 100000)),
] as const;

export type NumericSettingKey = (typeof NUMERIC_SETTINGS)[number]["key"];
