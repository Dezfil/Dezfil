import { currentTrustedOperation } from "@/lib/trusted-operation";
import { registerAccountFile, removeAccountFile } from "@/lib/ingest/file-ownership";
import type { AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource } from "@/lib/auth/owned-resource";
import { geometryEvidence } from "@/lib/geometry-evidence";
import { getGeometryState } from "@/lib/geometry/state";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "@/lib/config";
import { ApiError } from "@/lib/api/errors";
import { withConnection } from "@/lib/duckdb";
import { metadataDb } from "@/lib/metadata/db";
import type { DataTable } from "@/lib/metadata/tables";
import { getOwnedTableByName, updateOwnedTableData } from "@/lib/metadata/owned-tables";
import type { ArtifactMeta } from "./ingest";
import {
  buildLayerArtifact,
  enumerateLayers,
  prepareSource,
  urlGroupMembers,
  type GdalFormat,
} from "./gdal-formats";
import { resolveRemoteSource } from "./remote";
import { postCommitCleanup } from "./refresh";

/**
 * Refresh for URL imports of the container formats. Mirrors the OSM
 * group contract: the group is one provenance unit — the stored URL
 * downloads once, a candidate artifact builds for every member from its
 * stored layer, and the registry swap is one transaction. A member whose
 * layer vanished from the remote file fails the whole refresh; the group
 * is left as it was. Refresh replaces known tables — a layer newly
 * appearing in the file is not imported by a refresh.
 */
export async function refreshUrlSpatial(
  scope: AccountScope,
  requested: DataTable,
  name: string,
): Promise<DataTable> {
  requireOwnedResource(scope, "dataset", requested.id);
  const p = requested.sourceParams ?? {};
  const url = typeof p.url === "string" ? p.url : null;
  const group = typeof p.group === "string" ? p.group : null;
  if (!url) {
    throw new ApiError(
      "not_refreshable",
      `Table "${name}" has no stored URL to re-run.`,
      409,
    );
  }
  const members = group ? urlGroupMembers(scope, group) : [requested];
  for (const member of members) {
    if (typeof member.sourceParams?.layer !== "string") {
      throw new ApiError(
        "not_refreshable",
        `Table "${member.name}" has an incomplete import recipe and cannot be re-run.`,
        409,
      );
    }
  }

  const format = requested.format as GdalFormat;
  const source = await resolveRemoteSource(url, scope.accountId);
  const candidates: {
    member: DataTable;
    relFile: string;
    artifact: string;
    meta: ArtifactMeta;
  }[] = [];
  let now = "";
  try {
    const prepared = await prepareSource(format, source.sourcePath, source.filename, scope.accountId, source.budget);
    await withConnection(async (conn) => {
      const { spatial } = await enumerateLayers(conn, format, prepared);
      for (const member of members) {
        const layerName = String(member.sourceParams!.layer);
        // Validated against fresh enumeration — never read blind (the
        // reader crashes on a layer the file no longer holds).
        const layer = spatial.find((l) => l.name === layerName);
        if (!layer) {
          throw new ApiError(
            "malformed_file",
            `The file at ${url} no longer contains layer "${layerName}"; the ${
              group ? "group" : "table"
            } was left as it was.`,
            422,
          );
        }
        const relFile = path.join("tables", `${randomUUID()}.parquet`);
        const artifact = path.join(dataDir(), relFile);
    registerAccountFile(scope.accountId, artifact);
        let meta: ArtifactMeta;
        try {
          const state = getGeometryState(member);
          meta = await buildLayerArtifact(conn, format, layer, artifact, state?.mode === "set" ? { table: member, state } : undefined);
        } catch (error) {
          await removeAccountFile(artifact, { force: true });
          throw error;
        }
        candidates.push({ member, relFile, artifact, meta });
      }
    });

    const db = metadataDb();
    now = new Date().toISOString();
    // A member deleted mid-refresh must stay deleted: one silent
    // zero-match rolls the whole swap back.
    db.transaction(() => {
      currentTrustedOperation()?.assertCanCommit();
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
            ...geometryEvidence(c.meta),
            geometryState: c.meta.geometryState,
            rowCount: c.meta.rowCount,
            importedAt: now,
          },
          db,
        );
        if (!swapped) {
          if (getOwnedTableByName(scope, c.member.name, db)?.id === c.member.id) throw new ApiError("input_changed", "A dataset changed while the group refresh ran; the group was left as it was.", 409);
          throw new ApiError(
            "not_found",
            `Table "${c.member.name}" was deleted while the refresh ran; ${
              group ? "the group was left as it was" : "nothing was replaced"
            }.`,
            404,
          );
        }
      }
    })();
    currentTrustedOperation()?.markCommitted();
  } catch (error) {
    currentTrustedOperation()?.refuseIfFinal(error);
    for (const c of candidates) await removeAccountFile(c.artifact, { force: true });
    throw error;
  }
  // The extraction folder and the downloaded file are removed on the
  // operation's cleanup path (see prepareSource and resolveRemoteSource),
  // never inline after the swap: a removal that stalled or failed there would
  // hold or replace the committed answer.

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
    ...geometryEvidence(done.meta),
    rowCount: done.meta.rowCount,
    importedAt: now,
  };
}
