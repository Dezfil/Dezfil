import type { AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource } from "@/lib/auth/owned-resource";
import { getOwnedTableByName, updateOwnedTableData, ownedDependentLayerIds } from "@/lib/metadata/owned-tables";
import { requireTable } from "@/lib/table-service";
import { getGeometryState } from "@/lib/geometry/state";
import { geometryEvidence } from "@/lib/geometry-evidence";
import path from "node:path";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dataDir } from "@/lib/config";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import {
  type DataTable,
} from "@/lib/metadata/tables";
import {
  buildOvertureArtifact,
  parseStoredOvertureParams,
} from "@/lib/overture/import";
import { isValidRelease, latestOvertureRelease } from "@/lib/overture/releases";
import { buildClassArtifact, osmGroupMembers } from "@/lib/osm/import";
import { buildPostgisArtifact, requireTarget } from "@/lib/postgis/import";
import type {
  ConnectionHealth,
  ConnectionTarget,
} from "@/lib/postgis/access";
import {
  isConnectionLevelFailure,
  recordConnectionFailure,
  recordConnectionHealth,
  statusBlocksRefresh,
} from "@/lib/postgis/status";
import { fetchOverpass } from "@/lib/osm/overpass";
import {
  assembleAndSplit,
  filterSplitWithin,
  type GeometryClass,
} from "@/lib/osm/geometry";
import { isBbox } from "@/lib/bbox";
import { isRing } from "@/lib/overture/query";
import { isPolygonalGeometry, geometryParts } from "@/lib/geo-shape";
import { buildArtifact, type ArtifactMeta } from "./ingest";
import { isGdalFormat } from "./gdal-formats";
import { refreshUrlSpatial } from "./refresh-spatial";
import { resolveRemoteSource } from "./remote";
import { invalidateTileBuild } from "@/lib/tiles/build";
import { beginRefresh, endRefresh, refreshUnit } from "./fence";
import { retireArtifact } from "./retire";

/**
 * Re-run a table's stored import (refresh is atomic: dispatched by source
 * kind). A candidate artifact is produced and measured first; only then
 * does one registry update swap it in, the old artifact is removed, and
 * dependent layers' tile records are dropped so their next render rebuilds
 * against fresh data (tile fingerprints cover only SQL + filters). Any
 * failure before the swap leaves the table untouched.
 */

/** Tile fingerprints re-decide freshness on their own once the artifact
 * changes (they carry the referenced artifact identities); this explicit
 * invalidation makes the rebuild prompt rather than next-render-lazy. The
 * fence inside covers an attempt already running when the refresh
 * commits — it can no longer register old-data tiles as ready. */
export function invalidateTilesForTable(scope: AccountScope, name: string): number {
  let changes = 0;
  for (const id of ownedDependentLayerIds(scope, name)) {
    if (invalidateTileBuild(id)) changes += 1;
  }
  return changes;
}

export interface RefreshOptions {
  /** Overture only: move the stored recipe to this release ("latest" allowed)
   * before re-running — an explicit choice, never implicit. */
  release?: string;
}

/** Post-commit cleanup is best-effort: the committed swap is the
 * outcome the caller reads. A stumble here — retirement scheduling, tile
 * invalidation — is logged, never a failure answer for a refresh that
 * succeeded; the boot sweep and the next render absorb the leftovers.
 * Exported for the container-format refresh road. */
export function postCommitCleanup(scope: AccountScope, name: string, oldArtifact: string): void {
  try {
    retireArtifact(oldArtifact);
    invalidateTilesForTable(scope, name);
  } catch (error) {
    console.warn(
      `post-refresh cleanup failed for "${name}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function rebuildFromUrl(
  table: DataTable,
  artifact: string,
): Promise<ArtifactMeta> {
  const url = String(table.sourceParams!.url);
  const source = await resolveRemoteSource(url);
  try {
    const state = getGeometryState(table);
    return await buildArtifact(source.sourcePath, source.filename, artifact, state?.mode === "set" ? { table, state } : undefined);
  } finally {
    await source.cleanup();
  }
}

/**
 * OSM refresh is group-wide (one provenance unit): the stored query
 * re-runs once, bypassing the cache; candidate artifacts build for every
 * group member; the registry swap is one transaction. Classes that
 * vanished rebuild to empty rather than vanish.
 */
async function refreshOsmGroup(
  scope: AccountScope,
  requested: DataTable,
  name: string,
): Promise<DataTable> {
  const p = requested.sourceParams ?? {};
  if (typeof p.ql !== "string" || typeof p.group !== "string") {
    throw new ApiError(
      "not_refreshable",
      `Table "${name}" has an incomplete OSM recipe and cannot be re-run.`,
      409,
    );
  }
  const members = osmGroupMembers(scope, p.group);
  const promoted = Array.isArray(p.promoted)
    ? p.promoted.map(String)
    : ["name"];
  const { response } = await fetchOverpass(p.ql, { bypassCache: true });
  let split = assembleAndSplit(response, promoted);
  // Stored within-semantics re-apply on refresh — the recipe means the
  // same thing every time it runs.
  if (p.semantics === "within") {
    if (isPolygonalGeometry(p.geometry))
      split = filterSplitWithin(split, { parts: geometryParts(p.geometry) });
    else if (isRing(p.ring)) split = filterSplitWithin(split, { ring: p.ring });
    else if (isBbox(p.bbox)) split = filterSplitWithin(split, { bbox: p.bbox });
  }

  const candidates: {
    member: DataTable;
    relFile: string;
    artifact: string;
    meta: ArtifactMeta;
  }[] = [];
  let now = "";
  try {
    for (const member of members) {
      const cls = member.sourceParams?.class as GeometryClass;
      const relFile = path.join("tables", `${randomUUID()}.parquet`);
      const artifact = path.join(dataDir(), relFile);
      // A build that dies after partially writing its file must clean that
      // file itself — it joins `candidates` only on success, so the outer
      // catch never sees it.
      let meta: ArtifactMeta;
      try {
        meta = await buildClassArtifact(split, cls, promoted, artifact);
      } catch (error) {
        await rm(artifact, { force: true });
        throw error;
      }
      candidates.push({ member, relFile, artifact, meta });
    }
    const db = metadataDb();
    now = new Date().toISOString();
    // A member deleted mid-refresh must stay deleted: one silent zero-match
    // rolls the whole group swap back (spec: races leave no residue).
    db.transaction(() => {
      for (const c of candidates) {
        const swapped = updateOwnedTableData(
          scope,
          { name: c.member.name, id: c.member.id, file: c.member.file },
          {
            file: c.relFile,
            geometryColumn: c.meta.geometryColumn,
            geometryType: c.meta.geometryType,
            crsAssumed: c.meta.crsAssumed,
            headerSuspect: false,
            rowCount: c.meta.rowCount,
            importedAt: now,
          },
          db,
        );
        if (!swapped) {
          throw new ApiError(
            "not_found",
            `Table "${c.member.name}" was deleted while the group refresh ran; the group was left as it was.`,
            404,
          );
        }
      }
    })();
  } catch (error) {
    for (const c of candidates) await rm(c.artifact, { force: true });
    throw error;
  }

  for (const c of candidates) {
    postCommitCleanup(scope, c.member.name, path.join(dataDir(), c.member.file));
  }
  // The answer is what the transaction committed — never a re-read that a
  // concurrent delete could turn into a silent null.
  const done = candidates.find((c) => c.member.name === name)!;
  return {
    ...done.member,
    file: done.relFile,
    geometryColumn: done.meta.geometryColumn,
    geometryType: done.meta.geometryType,
    crsAssumed: done.meta.crsAssumed,
    rowCount: done.meta.rowCount,
    importedAt: now,
  };
}

export async function refreshTable(
  scope: AccountScope,
  name: string,
  options: RefreshOptions = {},
): Promise<DataTable> {
  const table = requireTable(scope, name);
  // Single-flight per provenance unit: the claim happens before the first
  // await, so a second caller can never start a second build.
  const unit = refreshUnit(scope, table);
  beginRefresh(unit, name);
  try {
    return await performRefresh(scope, table, name, options);
  } finally {
    endRefresh(unit);
  }
}

async function performRefresh(
  scope: AccountScope,
  table: DataTable,
  name: string,
  options: RefreshOptions,
): Promise<DataTable> {
  if (options.release !== undefined && table.source !== "overture") {
    throw new ApiError(
      "invalid_request",
      "A release applies to Overture imports only.",
      400,
    );
  }
  if (table.source === "osm") return refreshOsmGroup(scope, table, name);

  const relFile = path.join("tables", `${randomUUID()}.parquet`);
  const artifact = path.join(dataDir(), relFile);
  let meta: ArtifactMeta;
  let newParams: Record<string, unknown> | null = null;
  let now = "";

  try {
    switch (table.source) {
      case "url": {
        if (typeof table.sourceParams?.url !== "string") {
          throw new ApiError(
            "not_refreshable",
            `Table "${name}" has no stored URL to re-run.`,
            409,
          );
        }
        // Container formats re-run per stored layer, group-wide.
        if (isGdalFormat(table.format)) {
          return refreshUrlSpatial(scope, table, name);
        }
        meta = await rebuildFromUrl(table, artifact);
        break;
      }
      case "postgis": {
        const p = table.sourceParams ?? {};
        if (
          typeof p.connectionId !== "string" ||
          typeof p.schema !== "string" ||
          typeof p.table !== "string"
        ) {
          throw new ApiError(
            "not_refreshable",
            `Table "${name}" has an incomplete PostGIS recipe and cannot be re-run.`,
            409,
          );
        }
        const required = requireTarget(scope, p.connectionId);
        if (statusBlocksRefresh(required.connection)) {
          throw new ApiError(
            "connection_failed",
            required.connection.lastCheckError ?? "The connection is failing.",
            502,
          );
        }
        const target: ConnectionTarget = required.target;
        const connectionId = required.connection.id;
        let observedHealth: ConnectionHealth | null = null;
        let completedHealth: ConnectionHealth;
        try {
          const built = await buildPostgisArtifact(
            target,
            {
              connectionId: p.connectionId,
              schema: p.schema,
              table: p.table,
              ...(typeof p.filter === "string" ? { filter: p.filter } : {}),
              ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
            },
            artifact,
            (health) => {
              observedHealth = health;
            },
          );
          meta = built;
          completedHealth = built.connectionHealth;
        } catch (error) {
          requireOwnedResource(scope, "connection", connectionId);
          if (error instanceof ApiError && error.code === "not_found") {
            const message = `The stored recipe for "${p.schema}.${p.table}" no longer resolves on this connection. The previous snapshot data is unchanged.`;
            throw new ApiError("not_refreshable", message, 409);
          }
          if (isConnectionLevelFailure(error)) {
            recordConnectionFailure(scope, connectionId, error);
          } else if (observedHealth) {
            recordConnectionHealth(scope, connectionId, observedHealth);
          }
          throw error;
        }
        recordConnectionHealth(scope, connectionId, completedHealth);
        break;
      }
      case "overture": {
        const params = parseStoredOvertureParams(table.sourceParams, name);
        if (options.release !== undefined) {
          const release =
            options.release === "latest"
              ? await latestOvertureRelease()
              : options.release;
          if (!isValidRelease(release)) {
            throw new ApiError(
              "invalid_request",
              'The release must look like 2026-06-17.0 (or "latest").',
              400,
            );
          }
          params.release = release;
          newParams = { ...table.sourceParams, release };
        }
        meta = await buildOvertureArtifact(params, artifact);
        break;
      }
      // a derived table is not an import and must not be told it was
      // uploaded. Refusing in the words of how it was actually produced is
      // the point — the wrong sentence here is a defect the user reads.
      case "operation":
        throw new ApiError(
          "not_refreshable",
          `Table "${name}" was produced by an operation, not imported. Run the operation again to produce it afresh.`,
          409,
        );
      default:
        throw new ApiError(
          "not_refreshable",
          `Table "${name}" was uploaded and has no remote source to re-run. Refresh applies to imported tables only.`,
          409,
        );
    }

    // The data and any recipe change (a release move) commit as one
    // statement, so provenance can never claim data the refresh failed to
    // produce — and data can never lose the recipe that produced it.
    now = new Date().toISOString();
    const swapped = updateOwnedTableData(
      scope,
      { name, id: table.id, file: table.file },
      {
        file: relFile,
        geometryColumn: meta.geometryColumn,
        geometryType: meta.geometryType,
        crsAssumed: meta.crsAssumed,
        // The refresh's own read recomputes the verdict — it may add or
        // clear the warning.
        headerSuspect: meta.headerSuspect,
        ...geometryEvidence(meta),
        geometryState: meta.geometryState,
        rowCount: meta.rowCount,
        importedAt: now,
        ...(newParams ? { sourceParams: newParams } : {}),
      },
    );
    if (!swapped) {
      if (getOwnedTableByName(scope, name)?.id === table.id) throw new ApiError("input_changed", "The dataset changed while the refresh ran; nothing was replaced.", 409);
      throw new ApiError(
        "not_found",
        `Table "${name}" was deleted while the refresh ran; nothing was replaced.`,
        404,
      );
    }
  } catch (error) {
    await rm(artifact, { force: true });
    throw error;
  }

  // The swap is registered; the old artifact retires (removed once the
  // readers that predate the swap settle) and stale tile records go.
  postCommitCleanup(scope, name, path.join(dataDir(), table.file));
  // The answer is what the swap committed — never a re-read that a
  // concurrent delete could turn into a silent null.
  return {
    ...table,
    file: relFile,
    geometryColumn: meta.geometryColumn,
    geometryType: meta.geometryType,
    crsAssumed: meta.crsAssumed,
    headerSuspect: meta.headerSuspect,
    ...geometryEvidence(meta),
    rowCount: meta.rowCount,
    importedAt: now,
    sourceParams: newParams ?? table.sourceParams,
  };
}
