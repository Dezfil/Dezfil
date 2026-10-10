import { canReach } from "@/lib/auth/reach";
import { notFound } from "next/navigation";
import { MapBuilder } from "@/components/builder/MapBuilder";
import { MapReader } from "@/components/reader/MapReader";
import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import { deriveLayerDownloadPreparationTimeoutMs } from "@/components/builder/layer-download-control";
import {
  basemapChoices,
  basemapOverrideAttribution,
  basemapOverrideUrl,
  basemapUrl,
  drawingBasemaps,
} from "@/lib/basemap-offer";
import { limits } from "@/lib/limits";
import { requirePageScope } from "@/lib/auth/scope-page";
import { instanceDefaults } from "@/lib/settings/defaults";
import { ScreenDefaultsProvider } from "@/components/screen-defaults";
import { viewsOnly } from "../../standing";

export default async function MapBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ layer?: string }>;
}) {
  const scope = await requirePageScope();
  const { id } = await params;
  if (!canReach(scope, "map", id)) notFound();
  // Whoever may not change the map reads it (a Viewer, or anyone while its
  // owner is deactivated); everyone else who reaches it builds. The reader
  // opens nothing that takes one of the instance's defaults.
  if (viewsOnly(scope, "map", id)) {
    return (
      <MapReader
        mapId={id}
        basemapUrl={basemapUrl()}
        basemapOverrideUrl={basemapOverrideUrl()}
        basemapOverrideAttribution={basemapOverrideAttribution()}
        basemaps={drawingBasemaps()}
      />
    );
  }
  // The builder draws a map on any style the instance draws, and its
  // picker lists only the ones it offers: each style comes marked.
  // A promotion flow arrives with?layer=<id> so the landed layer opens
  // selected. Read server-side — a client-side URL sniff races the
  // router's history commit.
  const { layer } = await searchParams;
  // The builder's screens are handed the instance's defaults as this page
  // is served.
  return (
    <LayerDownloadControlProvider
      preparationTimeoutMs={deriveLayerDownloadPreparationTimeoutMs(
        limits.queryTimeoutMs,
      )}
    >
      <ScreenDefaultsProvider defaults={instanceDefaults()}>
        <MapBuilder
          mapId={id}
          initialLayerId={layer ?? null}
          basemapUrl={basemapUrl()}
          basemapOverrideUrl={basemapOverrideUrl()}
          basemapOverrideAttribution={basemapOverrideAttribution()}
          basemaps={basemapChoices()}
        />
      </ScreenDefaultsProvider>
    </LayerDownloadControlProvider>
  );
}
