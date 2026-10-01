import { MapBuilder } from "@/components/builder/MapBuilder";
import { MapReader } from "@/components/reader/MapReader";
import { LayerDownloadControlProvider } from "@/components/builder/LayerDownloadControlProvider";
import { deriveLayerDownloadPreparationTimeoutMs } from "@/components/builder/layer-download-control";
import {
  availableBasemaps,
  basemapOverrideAttribution,
  basemapOverrideUrl,
  basemapUrl,
} from "@/lib/basemap";
import { limits } from "@/lib/limits";
import { requirePageScope } from "@/lib/auth/scope-page";
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
  // A Viewer reads the map; everyone else who reaches it builds.
  if (viewsOnly(scope, "map", id)) {
    return (
      <MapReader
        mapId={id}
        basemapUrl={basemapUrl()}
        basemapOverrideUrl={basemapOverrideUrl()}
        basemapOverrideAttribution={basemapOverrideAttribution()}
        basemaps={availableBasemaps()}
      />
    );
  }
  // A promotion flow arrives with?layer=<id> so the landed layer opens
  // selected. Read server-side — a client-side URL sniff races the
  // router's history commit.
  const { layer } = await searchParams;
  return (
    <LayerDownloadControlProvider
      preparationTimeoutMs={deriveLayerDownloadPreparationTimeoutMs(
        limits.queryTimeoutMs,
      )}
    >
      <MapBuilder
        mapId={id}
        initialLayerId={layer ?? null}
        basemapUrl={basemapUrl()}
        basemapOverrideUrl={basemapOverrideUrl()}
        basemapOverrideAttribution={basemapOverrideAttribution()}
        basemaps={availableBasemaps()}
      />
    </LayerDownloadControlProvider>
  );
}
