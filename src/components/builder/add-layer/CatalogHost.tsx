"use client";

import type { MapWithLayers } from "@/lib/metadata/maps";
import type { PersonLabel } from "../../sharing/people";
import type { FailureKey } from "../use-mutation-lane";
import type { useLayerSourceCoordinator } from "../use-layer-source-coordinator";
import { AddLayerCatalogPortal } from "./AddLayerCatalogPortal";

/**
 * The builder's catalog mount (the decomposition rule): the
 * coordinator's handoffs, the edit lane's mirrored failure, the map's
 * project — the import context and the filter's default scope — and the
 * map's SQL home and owner, by which the catalogue names datasets as the
 * map's SQL types them, assembled here so MapBuilder only states what it
 * holds.
 */
export function CatalogHost({
  sources,
  failures,
  map,
  projectId,
}: {
  sources: ReturnType<typeof useLayerSourceCoordinator>;
  failures: Partial<Record<FailureKey, string>>;
  map: MapWithLayers;
  projectId: string | null;
}) {
  // A map read carries its home's SQL name and its owner.
  const presence = map as { home?: string; owner?: PersonLabel };
  const { catalogRequest } = sources;
  if (catalogRequest === null) return null;
  return (
    <AddLayerCatalogPortal
      portalRoot={document.body}
      request={catalogRequest}
      onClose={sources.closeCatalog}
      onDismissedOutcome={sources.showNotice}
      createLayer={sources.createLayerInline}
      updateLayer={sources.updateCatalogLayerSql}
      updateFailure={
        catalogRequest.kind === "edit"
          ? (failures[`layer:${catalogRequest.layerId}`] ?? null)
          : null
      }
      onTableImported={sources.onCatalogTableImported}
      onPostgisTableImported={sources.onPostgisTableImported}
      setPendingSkips={sources.setPendingSkips}
      uploadQueue={sources.uploadQueue}
      listingStamp={sources.catalogListingStamp}
      initialViewport={map.viewport}
      projectId={projectId}
      mapId={sources.mapId}
      mapHome={presence.home ?? null}
      mapOwner={presence.owner ?? null}
    />
  );
}
