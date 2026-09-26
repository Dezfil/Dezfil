"use client";

import type { MiniViewport } from "../../MiniMap";
import type { FailureKey } from "../use-mutation-lane";
import type { useLayerSourceCoordinator } from "../use-layer-source-coordinator";
import { AddLayerCatalogPortal } from "./AddLayerCatalogPortal";

/**
 * The builder's catalog mount (the decomposition rule): the
 * coordinator's handoffs, the edit lane's mirrored failure, and the
 * map's project — the import context and the filter's default scope —
 * assembled here so MapBuilder only states what it holds.
 */
export function CatalogHost({
  sources,
  failures,
  viewport,
  projectId,
}: {
  sources: ReturnType<typeof useLayerSourceCoordinator>;
  failures: Partial<Record<FailureKey, string>>;
  viewport: MiniViewport | null;
  projectId: string | null;
}) {
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
      initialViewport={viewport}
      projectId={projectId}
    />
  );
}
