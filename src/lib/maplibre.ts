import { setWorkerUrl } from "maplibre-gl";

// Next bundles the renderer into application chunks, so its relative
// import.meta.url worker default no longer points at the shipped ESM files.
// Serve the matching worker and shared chunk locally, including offline exports.
setWorkerUrl("/workers/maplibre-gl-6.11.2/maplibre-gl-worker.mjs");

// Preserve whole source-max-zoom vector tiles for rendering and feature queries.
export const MAP_RENDERER_OPTIONS = { zoomLevelsToOverscale: undefined };

export * from "maplibre-gl";
