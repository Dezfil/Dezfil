import { datasetReachOf, reachableDatasetIds, requireReachable } from "@/lib/auth/reach";
import type { AccountScope } from "@/lib/auth/scope";
import { requirePublicationScope, type PublicationScope } from "@/lib/publish/publication-scope";
import { ownerlessDatasets } from "@/lib/query/bindings";
import type { ArtifactInputs } from "@/lib/query/evaluation-inputs";
import { namespaceFor } from "@/lib/query/namespace";

/**
 * Who may be served, or may copy, a retained artifact: a tile archive, a
 * card image, a published view held for its freshness bound.
 *
 * The rule is the live evaluation's: a caller is served an artifact only
 * when they can now reach every dataset it recorded drawing, checked when
 * it is served or copied, never when it was made. An unattributed artifact
 * (one made before artifacts recorded their inputs, or a capture the server
 * could not attribute) is its map's current owner's alone. A publication
 * reaches what its map's own SQL names in its owner's current reach, and is
 * never the owner.
 */

export function inputsReached(inputs: ArtifactInputs, reach: ReadonlySet<string>): boolean {
  return inputs.datasets.every((input) => reach.has(input.id));
}

/** A signed-in caller who reaches the map. */
export function servableTo(scope: AccountScope, mapId: string, inputs: ArtifactInputs | null): boolean {
  try {
    if (inputs === null) return requireReachable(scope, "map", mapId).relation === "owner";
    return inputsReached(inputs, reachableDatasetIds(scope));
  } catch {
    return false;
  }
}

/**
 * A published link: what its map names, within the owner's reach now. An
 * artifact that drew only what its map's SQL bound names nothing else, so
 * the owner's current reach decides it. One that read the catalogue drew a
 * whole reach, which the link may be served only when that reach is the
 * link's own: what the map names, as its last evaluation resolved it.
 */
export function servableToPublication(scope: PublicationScope, inputs: ArtifactInputs | null): boolean {
  if (inputs === null) return false;
  try {
    if (inputs.catalogue) return inputsReached(inputs, new Set(namespaceFor(scope).datasets.map((dataset) => dataset.id)));
    const owner = requirePublicationScope(scope);
    const reach = owner === null ? new Set(ownerlessDatasets().map((dataset) => dataset.id)) : datasetReachOf(owner);
    return inputsReached(inputs, reach);
  } catch {
    return false;
  }
}
