import {
  availableBasemaps,
  basemapOverrideAttribution,
  basemapOverrideUrl,
  basemapUrl,
} from "@/lib/basemap";
import { RenderExportView } from "./RenderExportView";

/**
 * The bare render route: one map's export composition and nothing else
 * — no builder, no viewer chrome. The renderer service drives a
 * headless browser here and screenshots the viewport; the definition
 * arrives through the driver's request-scoped page initialization,
 * never the URL. Private surface, map by id — the same exposure as the
 * rest of the single-administrator API; deliberately not the published token
 * path (no rate bucket, no field projection, no publish requirement).
 */
export default async function RenderExportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Environment-read basemap config resolves server-side; everything
  // else the view imports from the same isomorphic lib the builder uses.
  return (
    <RenderExportView
      mapId={id}
      defaultBasemapUrl={basemapUrl()}
      basemapOverrideUrl={basemapOverrideUrl()}
      basemapOverrideAttribution={basemapOverrideAttribution()}
      basemaps={availableBasemaps()}
    />
  );
}
