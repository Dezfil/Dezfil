import { MAKI_GLYPHS } from "@/lib/maki";

/** Data-free files needed by entry, viewer and embed. No extension exemptions. */
export const PUBLIC_ASSETS: ReadonlySet<string> = new Set([
  "/icon.svg", "/shell-sheet-light.svg", "/shell-sheet-dark.svg",
  "/workers/maplibre-gl-6.11.2/maplibre-gl-worker.mjs",
  "/workers/maplibre-gl-6.11.2/maplibre-gl-shared.mjs",
  "/workers/loaders.gl-mvt-worker-4.4.5.js",
  ...["light", "dark", "streets", "satellite"].map(name => `/basemaps/thumbs/${name}.webp`),
  ...MAKI_GLYPHS.map(name => `/maki/${name}.svg`),
]);
export function isAnonymousAsset(pathname: string, method: string, development: boolean): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return PUBLIC_ASSETS.has(pathname) || /^\/_next\/static\/[^\\]+$/.test(pathname) ||
    (development && pathname === "/_next/hmr");
}
