import { existsSync } from "node:fs";
import { limits } from "@/lib/limits";
import { resolvePublication } from "@/lib/publish/publication-scope";
import { getTileRecord } from "@/lib/metadata/tiles";
import { renderFilters } from "@/lib/layer-service";
import { tileArchiveSignature } from "@/lib/field-dependencies";
import { tileFingerprint } from "./build";
import { tileArchivePath } from "./paths";
import { tileArchiveInputs } from "./evidence";
import { servableToPublication } from "@/lib/artifact-access";
import { currentInputs } from "@/lib/table-deps";

/** Durable identity of the tile artifact a published request may use. */
export interface PublishedTileArtifact {
  layerId: string;
  fingerprint: string;
  version: string;
  etag: string;
}

/**
 * Authorize one published tile against current durable state. The builder can
 * keep serving its last-ready archive while replacement work runs; this path
 * deliberately cannot. Styling and client-live filter bounds do not enter the
 * fingerprint and therefore retain the current artifact. Visibility retains
 * the artifact too, but a hidden layer stops being served here — it is absent
 * from the published surface.
 */
export function currentPublishedTile(
  token: string,
  layerId: string,
  requestedVersion: string | null,
): PublishedTileArtifact | null {
  const snapshot = resolvePublication(token);
  if (!snapshot) return null;
  const layer = snapshot.layers.find((candidate) => candidate.id === layerId);
  if (!layer || !layer.visible || layer.viz.type !== "points") return null;

  // The parity pair: this recomputes the projection signature the build
  // path folded in, from the same durable inputs, and the data identity
  // from the identities the archive's build recorded, as they stand now. A
  // drift between the two sides refuses every published tile — the failure
  // is loud, never a wider archive served quietly. An archive with no
  // evidence of what it drew is not served here.
  const record = getTileRecord(layerId);
  const recorded = tileArchiveInputs(layerId, record);
  if (!recorded) return null;
  const fingerprint = tileFingerprint(
    layer.sql,
    renderFilters(layer, snapshot.map.timeline),
    tileArchiveSignature(layer, {
      timeline: snapshot.map.timeline,
      widgets: snapshot.map.widgets,
      widgetsPublished: snapshot.map.widgetsPublished,
    }),
    currentInputs(recorded),
  );
  if (
    !record ||
    record.state !== "ready" ||
    record.fingerprint !== fingerprint ||
    record.featureCount === null ||
    record.featureCount <= limits.renderCapFeatures ||
    !record.builtAt ||
    !existsSync(tileArchivePath(layerId))
  ) {
    return null;
  }
  // The link is served what the archive drew only while the map names it
  // within the owner's current reach.
  if (!servableToPublication(snapshot.scope, recorded)) return null;

  const version = String(Date.parse(record.builtAt));
  if (requestedVersion !== null && requestedVersion !== version) return null;
  return {
    layerId,
    fingerprint,
    version,
    etag: `"${fingerprint}-${version}"`,
  };
}

export function samePublishedTile(
  left: PublishedTileArtifact,
  right: PublishedTileArtifact | null,
): boolean {
  return (
    right !== null &&
    left.layerId === right.layerId &&
    left.fingerprint === right.fingerprint &&
    left.version === right.version
  );
}
