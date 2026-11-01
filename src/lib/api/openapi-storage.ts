export const STORAGE_STATE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["full", "free", "total", "threshold"],
  properties: {
    full: { type: "boolean", description: "True when free space is at or below the fixed threshold, compared before rounding." },
    free: { type: "integer", minimum: 0, description: "Available bytes on the data folder's volume, rounded to the nearest MB (1,048,576 bytes)." },
    total: { type: "integer", minimum: 0, description: "Total bytes on that volume, rounded to the nearest MB (1,048,576 bytes)." },
    threshold: { type: "integer", const: 536870912, description: "The fixed 512 MB admission threshold, in bytes." },
  },
};
export type StorageContract = "write" | "recovery" | "download" | "tiles";
export const STORAGE_NOTES: Record<StorageContract, string> = {
  write: "At or below 512 MB free on the data volume, refuses before writing with 409 storage_full. A declared transfer must fit above that threshold; an undeclared transfer is stopped at the threshold and its partial file removed. An admitted write refused by the volume answers 507 storage_exhausted; previous artifacts survive. The threshold does not reserve capacity for overlapping work or conversion output. ",
  recovery: "Available while storage is full, using a fixed reserve after stopping disk-heavy writers when necessary. If the reserve is exhausted, answers 507 storage_exhausted. A sign-in that cannot commit its session and bookkeeping issues no session. ",
  download: "The existing GeoParquet file remains downloadable while storage is full. CSV and GeoJSON conversion refuse at or below 512 MB free with 409 storage_full; an admitted conversion refused by the volume answers 507 storage_exhausted and removes its partial file. ",
  tiles: "While storage is full, inline data and usable tile archives remain readable. A layer needing a new archive answers its errored-layer envelope with storage_full in the initial response. A running build stopped by the volume answers storage_exhausted, with scratch removed and its previous archive preserved. Once space returns, the next render starts another build. Other layers are unaffected. ",
};
