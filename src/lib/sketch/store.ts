import { documentFacts } from "@/lib/metadata/document-facts";
import { recordDocumentChanges, requireDocumentRevision } from "@/lib/metadata/revisions";
import { requireOwnedResource, resourceAbsent } from "@/lib/auth/owned-resource";
import { getLayer, getMap } from "@/lib/metadata/map-queries";
import { listOwnedTables, updateOwnedTableData, deleteOwnedTable, ownedDependentLayerIds } from "@/lib/metadata/owned-tables";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { requireFilingAddition, requirePermitted } from "@/lib/auth/reach";
import { getAccount } from "@/lib/metadata/accounts";
import { fileTable, mapProjectId } from "@/lib/metadata/projects";
import { mapHome } from "@/lib/metadata/maps";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { dataDir } from "@/lib/config";
import { withConnection } from "@/lib/duckdb";
import { ApiError } from "@/lib/api/errors";
import { lit, measureArtifact } from "@/lib/ingest/ingest";
import { retireArtifact } from "@/lib/ingest/retire";
import { metadataDb } from "@/lib/metadata/db";
import { touchProjectsOf } from "@/lib/metadata/projects";
import {
  registerTable,
  type DataTable,
} from "@/lib/metadata/tables";
import {
  deleteLayer,
  insertLayer,
  nextOrdinal,
  updateMapFields,
  type Layer,
} from "@/lib/metadata/maps";
import {
  purgeStepsReferencing,
  purgeTargetSteps,
} from "@/lib/metadata/history";
import { removeTileArtifacts } from "@/lib/tiles/build";
import { dropTableView } from "@/lib/query/views";
import { layerCycleColor } from "@/lib/style/palettes";
import { POINTS_VIZ } from "@/lib/viz";
import type { LayerStyle } from "@/lib/style/style";
import { sketchBaseName } from "./naming";
import { ownerOf, readFeatures, requireSketch, type StoredSketchFeature } from "./read";
export { listFeatures, mapSketches, type StoredSketchFeature, type SketchSummary } from "./read";
import {
  asSketchFeature,
  sketchFeatureError,
  sketchGeometryWkt,
} from "./geometry";

/**
 * The sketch store: drawn features live as ordinary GeoParquet tables —
 * this module owns their lifecycle. Every mutation rewrites the whole
 * artifact and swaps it under the table's stable id and name, in the
 * materialization mold: write, measure, keyed swap, retire. Same-sketch
 * mutations are serialized here, in process, because the keyed swap alone
 * cannot see a race — a sketch's name and id never change across
 * generations, so two concurrent writers would both "succeed" and one
 * would silently vanish. Creation, mutation and the cascade never touch
 * map history (spec behaviors 6 and 13).
 */

/* ---------------- serialization ---------------- */

const lanes = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const tail = lanes.get(key) ?? Promise.resolve();
  const run = tail.then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  lanes.set(key, settled);
  void settled.then(() => {
    // A completed predecessor must not remove a newer queued mutation.
    if (lanes.get(key) === settled) lanes.delete(key);
  });
  return run;
}

/* ---------------- registry helpers ---------------- */

function setSourceParams(
  ref: { name: string; id: string },
  params: Record<string, unknown>,
  db = metadataDb(),
): void {
  db.prepare(`UPDATE data_tables SET source_params = ? WHERE name = ? AND id = ?`).run(
    JSON.stringify(params),
    ref.name,
    ref.id,
  );
}

/* ---------------- the artifact ---------------- */

function absOf(rel: string): string {
  return path.join(dataDir(), rel);
}

async function writeArtifact(
  features: StoredSketchFeature[],
): Promise<{ rel: string; abs: string }> {
  const rel = path.join("tables", `${randomUUID()}.parquet`);
  const abs = absOf(rel);
  await mkdir(path.dirname(abs), { recursive: true });
  const select = features.length
    ? `SELECT * FROM (VALUES ${features
        .map(
          (f) =>
            `(${lit(f.id)}, ${lit(f.kind)}, ST_GeomFromText(${lit(
              sketchGeometryWkt(f.geometry),
            )}))`,
        )
        .join(", ")}) AS t(feature_id, kind, geom)`
    : `SELECT CAST(NULL AS VARCHAR) AS feature_id, CAST(NULL AS VARCHAR) AS kind,
              CAST(NULL AS GEOMETRY) AS geom WHERE false`;
  await withConnection(async (conn) => {
    await conn.runAndReadAll(
      `COPY (${select}) TO ${lit(abs)} (FORMAT PARQUET)`,
    );
  });
  return { rel, abs };
}

/* ---------------- creation ---------------- */

/** The explicit all-families style (plan: the mixed default hides lines —
 * a sketch layer must draw points, lines and polygons from birth). */
function sketchLayerStyle(ordinal: number): LayerStyle {
  const cycle = layerCycleColor(ordinal);
  return {
    fill: { type: "constant", color: cycle },
    fillOpacity: 0.45,
    stroke: cycle,
    strokeOpacity: 0.95,
    strokeWidth: 2,
    pointRadius: 4,
    opacity: 1,
  };
}

function displayNameFor(tableName: string): string {
  const m = tableName.match(/_sketch(?:_(\d+))?$/);
  return m?.[1] ? `Sketch ${m[1]}` : "Sketch";
}

export interface CreatedSketch {
  table: DataTable;
  layerId: string;
  layerName: string;
  editRevision: string;
  featureId: string;
}

const quoted = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** How a sketch layer names its dataset in its map's home: plainly where the
 * drawer is the home, else qualified with the drawer's SQL name, so the layer
 * never binds a same-named dataset of the home's. Both parts of the qualified
 * name are quoted: a SQL name may also be a keyword (`order`, `group`). */
function sketchReference(scope: AccountScope, mapId: string, name: string, db = metadataDb()): string {
  if (mapHome(mapId, db) === scope.accountId) return name;
  return `${quoted(getAccount(scope.accountId, db)!.sqlName)}.${quoted(name)}`;
}

/** Whether the drawer may file their sketch into the map's project: the
 * filing rule, whose refusal leaves the sketch unfiled. */
function mayFile(scope: AccountScope, tableId: string, projectId: string, db = metadataDb()): boolean {
  try {
    requireFilingAddition(scope, "dataset", tableId, projectId, db);
    return true;
  } catch {
    return false;
  }
}

/**
 * First commit: one failure-safe outcome minting the dataset and its
 * owning layer together, provenance recorded, no history step. The
 * artifact is written first; every registry write shares one transaction;
 * a failed transaction removes the artifact.
 *
 * Anyone who may change the map's content draws on it. The dataset is the
 * drawer's own, filed into the map's project as the drawer may file, and
 * the layer names it unambiguously in the map's home.
 */
export async function createSketch(
  scope: AccountScope,
  mapId: string,
  feature: unknown,
  opts: { expectedRevision?: unknown } = {},
): Promise<CreatedSketch> {
  requireAccountScope(scope);
  requirePermitted(scope, "map", mapId, "sketch");
  requireDocumentRevision(scope, { kind: "map", id: mapId, expectedRevision: opts.expectedRevision });
  const refusal = sketchFeatureError(feature);
  if (refusal) throw new ApiError("invalid_sketch_feature", refusal, 400);
  const map = getMap(mapId)!;

  const stored: StoredSketchFeature = {
    id: randomUUID(),
    ...asSketchFeature(feature),
  };
  const { rel, abs } = await writeArtifact([stored]);
  try {
    const meta = await withConnection((conn) =>
      measureArtifact(conn, abs, "geom"),
    );
    const db = metadataDb();
    const created = db.transaction(() => {
      requirePermitted(scope, "map", mapId, "sketch", db);
      requireDocumentRevision(scope, { kind: "map", id: mapId, expectedRevision: opts.expectedRevision }, db);
      const table = registerTable(
        scope,
        {
          id: randomUUID(),
          sourceFilename: null,
          format: "geoparquet",
          file: rel,
          geometryColumn: meta.geometryColumn,
          geometryType: meta.geometryType,
          crsAssumed: false,
          headerSuspect: false,
          rowCount: meta.rowCount,
          createdAt: new Date().toISOString(),
          source: "sketch",
          sourceParams: { mapId, mapName: map.name },
          importedAt: null,
        },
        sketchBaseName(map.name),
        db,
      );
      // The sketch follows its map's project as it is AT THIS COMMIT —
      // read inside the transaction, not from the map object captured
      // before the artifact build — where its drawer may file it.
      const projectId = mapProjectId(mapId, db);
      if (projectId && mayFile(scope, table.id, projectId, db)) fileTable(table.id, projectId, db);
      const ordinal = nextOrdinal(mapId, db);
      const now = new Date().toISOString();
      const layer: Layer = {
        id: randomUUID(),
        mapId,
        name: displayNameFor(table.name),
        sql: `SELECT * FROM ${sketchReference(scope, mapId, table.name, db)}`,
        style: sketchLayerStyle(ordinal),
        visible: true,
        tooltip: null,
        popup: null,
        publishedFields: null,
        inLegend: true,
        viz: POINTS_VIZ,
        filters: [],
        legendTitle: null,
        legendLabels: null,
        legendAttrs: null,
        ordinal,
        createdAt: now,
        updatedAt: now,
      };
      insertLayer(layer, db);
      recordDocumentChanges(scope, [{ kind: "map", id: mapId }], db);
      const params = { mapId, mapName: map.name, layerId: layer.id };
      setSourceParams({ name: table.name, id: table.id }, params, db);
      return {
        table: { ...table, sourceParams: params },
        layerId: layer.id,
        layerName: layer.name,
        editRevision: documentFacts({ kind: "map", id: mapId }, db).editRevision,
      };
    })();
    return { ...created, featureId: stored.id };
  } catch (error) {
    await rm(abs, { force: true });
    throw error;
  }
}

/* ---------------- mutations ---------------- */

interface MutationResult {
  table: DataTable;
  rowCount: number;
}

async function mutate(
  scope: AccountScope,
  name: string,
  transform: (features: StoredSketchFeature[]) => StoredSketchFeature[],
): Promise<MutationResult> {
  const keyed = requireSketch(scope, name);
  return serialize(keyed.id, async () => {
    const fresh = requireSketch(scope, name);
    // The name alone is not identity: a cascaded sketch's
    // reclaimed name resolves the REPLACEMENT, and the keyed swap would
    // then happily write an old session's feature into the new dataset.
    if (fresh.id !== keyed.id)
      throw new ApiError(
        "sketch_gone",
        `"${name}" was deleted and its name reclaimed while this change was in flight; nothing was written.`,
        409,
      );
    const features = await readFeatures(absOf(fresh.file));
    const next = transform(features);
    const { rel, abs } = await writeArtifact(next);
    try {
      const meta = await withConnection((conn) =>
        measureArtifact(conn, abs, "geom"),
      );
      const swapped = updateOwnedTableData(
        scope,
        { name: fresh.name, id: fresh.id },
        {
          file: rel,
          geometryColumn: meta.geometryColumn,
          geometryType: meta.geometryType,
          crsAssumed: false,
          headerSuspect: false,
          rowCount: meta.rowCount,
          importedAt: new Date().toISOString(),
        },
      );
      if (!swapped)
        throw new ApiError(
          "sketch_gone",
          `"${name}" was deleted or replaced while this change was in flight; nothing was written.`,
          409,
        );
      retireArtifact(absOf(fresh.file));
      return {
        table: {
          ...fresh,
          file: rel,
          geometryColumn: meta.geometryColumn,
          geometryType: meta.geometryType,
          rowCount: meta.rowCount,
        },
        rowCount: meta.rowCount,
      };
    } catch (error) {
      await rm(abs, { force: true });
      throw error;
    }
  });
}

export async function appendFeature(
  scope: AccountScope,
  name: string,
  feature: unknown,
): Promise<MutationResult & { featureId: string }> {
  requireAccountScope(scope);
  const refusal = sketchFeatureError(feature);
  if (refusal) throw new ApiError("invalid_sketch_feature", refusal, 400);
  const stored: StoredSketchFeature = {
    id: randomUUID(),
    ...asSketchFeature(feature),
  };
  const result = await mutate(scope, name, (features) => [...features, stored]);
  return { ...result, featureId: stored.id };
}

export async function deleteFeature(
  scope: AccountScope,
  name: string,
  featureId: string,
): Promise<MutationResult> {
  return mutate(scope, name, (features) => {
    if (!features.some((f) => f.id === featureId))
      throw new ApiError(
        "feature_not_found",
        `No drawn feature "${featureId}" in "${name}".`,
        404,
      );
    return features.filter((f) => f.id !== featureId);
  });
}

/**
 * The one permitted edit: move exactly one vertex of a
 * polygon-kind shape. Kind and vertex count are preserved by
 * construction; the moved ring passes the same structural gate as a
 * fresh commit.
 */
export async function moveVertex(
  scope: AccountScope,
  name: string,
  featureId: string,
  vertexIndex: number,
  position: unknown,
): Promise<MutationResult> {
  return mutate(scope, name, (features) => {
    const feature = features.find((f) => f.id === featureId);
    if (!feature)
      throw new ApiError(
        "feature_not_found",
        `No drawn feature "${featureId}" in "${name}".`,
        404,
      );
    if (feature.kind !== "polygon" && feature.kind !== "freehand")
      throw new ApiError(
        "vertex_move_refused",
        "Vertex move applies to drawn polygons and freehand shapes only.",
        409,
      );
    const ring = (feature.geometry as { coordinates: [number, number][][] })
      .coordinates[0];
    if (
      !Number.isInteger(vertexIndex) ||
      vertexIndex < 0 ||
      vertexIndex >= ring.length - 1
    )
      throw new ApiError(
        "vertex_move_refused",
        `Vertex index must be between 0 and ${ring.length - 2}.`,
        400,
      );
    const moved = ring.slice();
    moved[vertexIndex] = position as [number, number];
    if (vertexIndex === 0) moved[moved.length - 1] = position as [number, number];
    const next: StoredSketchFeature = {
      ...feature,
      geometry: { type: "Polygon", coordinates: [moved] },
    };
    const refusal = sketchFeatureError({
      kind: next.kind,
      geometry: next.geometry,
    });
    if (refusal) throw new ApiError("invalid_sketch_feature", refusal, 400);
    return features.map((f) => (f.id === featureId ? next : f));
  });
}

/* ---------------- reads ---------------- */

/** The sketch a layer owns by recorded provenance, when it owns one —
 * the layer-delete route's cascade test (enforced at the API, not
 * inferred client-side). */
export function sketchOwnedByLayer(scope: AccountScope, layerId: string): DataTable | null {
  // Only the acting account's own sketch cascades: a layer drawing someone
  // else's sketch is removed alone, and their dataset stays.
  requirePermitted(scope, "layer", layerId, "edit");
  return (
    listOwnedTables(scope).find(
      (t) => t.source === "sketch" && ownerOf(t).layerId === layerId,
    ) ?? null
  );
}

/* ---------------- the cascade ---------------- */

function ownsMap(scope: AccountScope, mapId: string, db = metadataDb()): boolean {
  const row = db.prepare("SELECT owner_id FROM maps WHERE id = ?").get(mapId) as { owner_id: string | null } | undefined;
  return row?.owner_id === requireAccountScope(scope, db);
}

export interface CascadeResult {
  editRevision?: string;
  layerId: string | null;
  mapId: string | null;
}

/**
 * Deleting the owner: the provenance-named owning
 * layer, its bound widgets, the dataset, the artifact and the tile
 * artifacts leave together. No new history step is written, and every
 * step that targeted the owner leaves the timeline — replay can neither
 * restore nor error on destroyed state. Unrelated steps survive.
 *
 * Only the sketch's own drawer deletes it. Removing one's own sketch layer
 * (`from: "layer"`) keeps that cascade on any map whose content one may
 * change. Deleting the sketch dataset itself never modifies another person's
 * map: on one's own map the cascade stands, on anyone else's the layer stays
 * and fails by name for whoever opens it.
 */
export async function cascadeDeleteSketch(scope: AccountScope, name: string, from: "layer" | "dataset" = "dataset", opts: { expectedRevision?: unknown } = {}): Promise<CascadeResult> {
  const keyed = requireSketch(scope, name);
  return serialize(keyed.id, async () => {
    const fresh = requireSketch(scope, name);
    if (fresh.id !== keyed.id)
      throw new ApiError(
        "sketch_gone",
        `"${name}" was deleted and its name reclaimed while this cascade was in flight; nothing was removed.`,
        409,
      );
    const recorded = ownerOf(fresh);
    // Every dependent layer's tile artifacts leave with the table: a duplicate with a PMTiles
    // archive would otherwise
    // keep serving deleted rows instead of the standing missing-table
    // state. Snapshot before the registry row disappears.
    const dependents = ownedDependentLayerIds(scope, fresh.name);
    const db = metadataDb();
    const { mapId, layerId, editRevision } = db.transaction(() => {
      requireOwnedResource(scope, "dataset", fresh.id, db);
      let { mapId, layerId } = recorded;
      if (mapId && layerId) {
        const map = getMap(mapId, db);
        if (map && from === "dataset" && !ownsMap(scope, mapId, db)) {
          // Someone else's map keeps its layer, whatever became of it.
          mapId = layerId = null;
        } else {
          const layer = getLayer(layerId, db);
          if (!map || !layer || layer.mapId !== mapId) throw resourceAbsent();
          if (from === "layer") {
            requirePermitted(scope, "layer", layerId, "edit", db);
            requireDocumentRevision(scope, { kind: "map", id: mapId, expectedRevision: opts.expectedRevision }, db);
          }
        }
      }
      if (mapId && layerId) {
        const map = getMap(mapId, db);
        if (map) {
          const remaining = map.widgets.filter((w) => w.layerId !== layerId);
          if (remaining.length !== map.widgets.length)
            updateMapFields(mapId, { widgets: remaining }, db);
          // A manual legend arrangement loses the owner's slot with it
          // — unrecorded, like the whole cascade, which purges rather
          // than replays its history.
          if (map.legendOrder?.includes(layerId)) {
            const pruned = map.legendOrder.filter((lid) => lid !== layerId);
            updateMapFields(
              mapId,
              { legendOrder: pruned.length ? pruned : null },
              db,
            );
          }
          purgeTargetSteps(mapId, layerId, db);
          purgeStepsReferencing(mapId, layerId, db);
        }
        deleteLayer(layerId, db);
        recordDocumentChanges(scope, [{ kind: "map", id: mapId }], db);
      }
      // The set the sketch leaves must notice (found at review): the
      // cascade removes the membership row but cannot advance the
      // project's clock.
      touchProjectsOf({ tableId: fresh.id }, db);
      deleteOwnedTable(scope, fresh, db);
      return { mapId, layerId, ...(mapId ? { editRevision: documentFacts({ kind: "map", id: mapId }, db).editRevision } : {}) };
    })();
    for (const dependent of new Set([...(layerId ? [layerId] : []), ...dependents]))
      await removeTileArtifacts(dependent);
    await dropTableView(scope, fresh.name).catch((error: unknown) => {
      console.warn(
        `sketch cascade: view drop failed for ${fresh.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    retireArtifact(absOf(fresh.file));
    return { layerId, mapId, ...(editRevision ? { editRevision } : {}) };
  });
}
