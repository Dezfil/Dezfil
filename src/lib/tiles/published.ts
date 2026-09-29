import { existsSync } from "node:fs";
import { limits } from "@/lib/limits";
import { getPublishedSnapshot } from "@/lib/metadata/maps";
import { getTileRecord } from "@/lib/metadata/tiles";
import { renderFilters } from "@/lib/layer-service";
import { publishedFieldsSignature } from "@/lib/publish/published-fields";
import { tileFingerprint } from "./build";
import { tileArchivePath } from "./paths";

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
  const snapshot = getPublishedSnapshot(token);
  if (!snapshot) return null;
  const layer = snapshot.layers.find((candidate) => candidate.id === layerId);
  if (!layer || !layer.visible || layer.viz.type !== "points") return null;

  // The parity pair: this recomputes the projection signature the build
  // path folded in, from the same durable inputs. A drift between the two
  // sides refuses every published tile — the failure is loud, never a
  // wider archive served quietly.
  const fingerprint = tileFingerprint(
    layer.sql,
    renderFilters(layer, snapshot.map.timeline),
    publishedFieldsSignature(layer, {
      timeline: snapshot.map.timeline,
      widgets: snapshot.map.widgets,
      widgetsPublished: snapshot.map.widgetsPublished,
    }),
    layerId,
  );
  const record = getTileRecord(layerId);
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
