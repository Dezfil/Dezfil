/**
 * The requests the egress check governs, as the Private network note names
 * them: what the server reaches for a person only once the deployment's
 * allowlist names a private host. Each entry names the modules that make
 * its request through the check, so a test holds the list against the code
 * in both directions: no request the note leaves out, none it names that
 * the check does not govern.
 *
 * Browser-safe, as the settings page reads it. What is not here is not
 * governed: an Overture import's own reads and the credentialed cloud
 * storage road run in the query engine, outside the check.
 */
export interface GovernedRequest {
  /** The request as the note names it. */
  readonly label: string;
  /** The modules that make it through the check. */
  readonly modules: readonly string[];
}

export const GOVERNED_REQUESTS: readonly GovernedRequest[] = [
  { label: "Imports and refreshes from web addresses", modules: ["src/lib/ingest/remote.ts"] },
  { label: "Cloud storage links read without the server's credentials", modules: ["src/lib/ingest/remote.ts"] },
  { label: "Database connections", modules: ["src/lib/postgis/access.ts"] },
  { label: "The address finder and place search", modules: ["src/lib/geocode/provider.ts", "src/lib/search/provider.ts"] },
  { label: "Travel time", modules: ["src/lib/isochrone/provider.ts"] },
  { label: "OpenStreetMap", modules: ["src/lib/osm/overpass.ts"] },
  { label: "The Overture release list", modules: ["src/lib/overture/releases.ts"] },
  { label: "Custom basemap styles", modules: ["src/lib/net/inspect-style.ts"] },
  { label: "Map image exports", modules: ["src/lib/export/render-address.ts"] },
  { label: "The satellite imagery's Test", modules: ["src/lib/settings/service-tests.ts"] },
  { label: "The template catalogue", modules: ["src/lib/templates/catalogue.ts", "src/lib/templates/download.ts"] },
];
