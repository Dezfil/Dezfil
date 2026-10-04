import { admitAccountWork } from "@/lib/auth/account-deletion-admission";
import { registerAccountFile, removeAccountFile, fileAccountId } from "@/lib/ingest/file-ownership";
import { listOwnedTables } from "@/lib/metadata/owned-tables";
import { requireFilingDestination } from "@/lib/auth/reach";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dataDir } from "@/lib/config";
import { limits } from "@/lib/limits";
import { ApiError } from "@/lib/api/errors";
import { withConnection } from "@/lib/duckdb";
import { isBbox, bboxAreaKm2, type Bbox } from "@/lib/bbox";
import {
  registerTable,
  type DataTable,
} from "@/lib/metadata/tables";
import { buildArtifact, type ArtifactMeta } from "@/lib/ingest/ingest";
import { metadataDb } from "@/lib/metadata/db";
import { fileOwnedTable } from "@/lib/metadata/owned-tables";
import { importProjectId } from "@/lib/project-scope";
import {
  buildOverpassQl,
  applyEnvelope,
  parseSelector,
  promotedKeys,
  suggestStem,
  type Selector,
  type EnvelopeSettings,
  type OsmArea,
} from "./query";
import {
  isRing,
  ringBbox,
  isAreaSemantics,
  type AreaSemantics,
  type Ring,
} from "@/lib/overture/query";
import {
  isPolygonalGeometry,
  geometryBbox,
  geometryParts,
  MAX_GEOMETRY_VERTICES,
  type PolygonalGeometry,
} from "@/lib/geo-shape";
import { fetchOverpass, overpassEndpoint } from "./overpass";
import {
  assembleAndSplit,
  classDocument,
  filterSplitWithin,
  type GeometryClass,
  type SplitResult,
  type WithinShape,
} from "./geometry";

/**
 * OSM import: query the administrator's Overpass endpoint once, assemble
 * geometries, split by class, and land up to three GeoParquet tables
 * sharing a name stem — one provenance unit (shared group id, one stored
 * query, one refresh).
 */

const CLASSES: GeometryClass[] = ["points", "lines", "polygons"];

function envelope(): EnvelopeSettings {
  return {
    timeoutS: limits.overpassTimeoutS,
    maxsizeBytes: limits.overpassMaxsizeMb * 1024 * 1024,
  };
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function assertOsmAreaWithinBudget(bbox: Bbox): void {
  const area = bboxAreaKm2(bbox);
  if (area > limits.osmMaxKm2) {
    throw new ApiError(
      "area_too_large",
      `The selected area is ${Math.round(area).toLocaleString()} km²; OSM imports allow up to ${Math.round(limits.osmMaxKm2).toLocaleString()} km². Zoom in, or raise DEZFIL_OSM_MAX_KM2.`,
      413,
    );
  }
}

export interface OsmImportRequest {
  /** Selector entries like "amenity=restaurant" or "building". */
  selectors?: unknown;
  /** Raw OverpassQL (the escape hatch); the safety envelope still applies. */
  ql?: unknown;
  bbox?: unknown;
  /** A drawn polygon ring [[lng, lat], …] — alternative to bbox. */
  ring?: unknown;
  /** A layer feature's GeoJSON Polygon/MultiPolygon — parts and holes
   * intact. Takes precedence over ring and bbox. */
  geometry?: unknown;
  /** The project every created class table joins; optional. */
  projectId?: unknown;
  /** Within keeps only features entirely inside the drawn shape; the
   * default is intersect, Overpass's native behavior. */
  semantics?: unknown;
  name?: unknown;
}

/** Freehand rings are simplified client-side; this bounds the query. */
const MAX_RING_POINTS = 500;

interface ResolvedOsm {
  finalQl: string;
  selectors: Selector[];
  bbox: Bbox | null;
  ring: Ring | null;
  geometry: PolygonalGeometry | null;
  semantics: AreaSemantics;
  stem: string;
  promoted: string[];
}

export function resolveOsmRequest(request: OsmImportRequest): ResolvedOsm {
  if (request.name !== undefined && typeof request.name !== "string") {
    throw new ApiError("invalid_request", "The name must be a string.", 400);
  }
  if (request.semantics !== undefined && !isAreaSemantics(request.semantics)) {
    throw new ApiError(
      "invalid_request",
      'The semantics must be "within" or "intersect".',
      400,
    );
  }
  const semantics: AreaSemantics = isAreaSemantics(request.semantics)
    ? request.semantics
    : "intersect";

  let geometry: PolygonalGeometry | null = null;
  if (request.geometry !== undefined && request.geometry !== null) {
    if (!isPolygonalGeometry(request.geometry)) {
      throw new ApiError(
        "invalid_request",
        `Expected geometry as a GeoJSON Polygon or MultiPolygon with at most ${MAX_GEOMETRY_VERTICES.toLocaleString()} vertices.`,
        400,
      );
    }
    geometry = request.geometry;
  }
  let ring: Ring | null = null;
  if (request.ring !== undefined && request.ring !== null) {
    if (!isRing(request.ring) || request.ring.length > MAX_RING_POINTS) {
      throw new ApiError(
        "invalid_request",
        `Expected ring as [[lng, lat], …] with 3 to ${MAX_RING_POINTS} points.`,
        400,
      );
    }
    ring = request.ring;
  }
  const bbox = request.bbox === undefined || request.bbox === null
    ? null
    : (() => {
        if (!isBbox(request.bbox)) {
          throw new ApiError(
            "invalid_request",
            "Expected bbox as [west, south, east, north] in WGS84 degrees.",
            400,
          );
        }
        return request.bbox;
      })();
  const extent = geometry
    ? geometryBbox(geometry)
    : ring
      ? ringBbox(ring)
      : bbox;
  if (extent) assertOsmAreaWithinBudget(extent);

  if (typeof request.ql === "string" && request.ql.trim()) {
    let finalQl: string;
    try {
      finalQl = applyEnvelope(request.ql, envelope(), extent);
    } catch (error) {
      throw new ApiError(
        "invalid_request",
        error instanceof Error ? error.message : "The query is invalid.",
        400,
      );
    }
    return {
      finalQl,
      selectors: [],
      bbox,
      ring,
      geometry,
      semantics,
      stem:
        typeof request.name === "string" && request.name.trim()
          ? request.name.trim()
          : "osm_import",
      promoted: ["name"],
    };
  }

  if (!Array.isArray(request.selectors) || request.selectors.length === 0) {
    throw new ApiError(
      "invalid_request",
      'Provide "selectors" (e.g. ["amenity=restaurant"]) with an area, or a raw "ql" query.',
      400,
    );
  }
  const area: OsmArea | null = geometry
    ? { geometry }
    : ring
      ? { ring }
      : bbox
        ? { bbox }
        : null;
  if (!area) {
    throw new ApiError(
      "invalid_request",
      "Selector imports need an area. Pick one.",
      400,
    );
  }
  const selectors: Selector[] = [];
  for (const raw of request.selectors) {
    const parsed = typeof raw === "string" ? parseSelector(raw) : null;
    if (!parsed) {
      throw new ApiError(
        "invalid_request",
        `"${String(raw)}" is not a valid tag selector (use key or key=value).`,
        400,
      );
    }
    selectors.push(parsed);
  }
  return {
    finalQl: buildOverpassQl(selectors, area, envelope()),
    selectors,
    bbox,
    ring,
    geometry,
    semantics,
    stem:
      typeof request.name === "string" && request.name.trim()
        ? request.name.trim()
        : suggestStem(selectors),
    promoted: promotedKeys(selectors),
  };
}

/** The within-filter shape for a resolved request, when enforceable. */
export function withinShapeOf(resolved: {
  ring: Ring | null;
  bbox: Bbox | null;
  geometry?: PolygonalGeometry | null;
  semantics: AreaSemantics;
}): WithinShape | null {
  if (resolved.semantics !== "within") return null;
  if (resolved.geometry) return { parts: geometryParts(resolved.geometry) };
  if (resolved.ring) return { ring: resolved.ring };
  if (resolved.bbox) return { bbox: resolved.bbox };
  return null;
}

/** Write one class's features to a temp GeoJSON and convert to an artifact.
 * Empty classes (refresh only) get an explicit schema-matched artifact —
 * ST_Read drops property columns on empty collections. */
export async function buildClassArtifact(
  split: SplitResult,
  cls: GeometryClass,
  promoted: string[],
  artifact: string,
): Promise<ArtifactMeta> {
  const features = split[cls];
  if (features.length === 0) {
    await mkdir(path.dirname(artifact), { recursive: true });
    return withConnection(async (conn) => {
      const cols = [
        `CAST(NULL AS BIGINT) AS ${ident("OGC_FID")}`,
        `CAST(NULL AS VARCHAR) AS osm_id`,
        `CAST(NULL AS VARCHAR) AS osm_type`,
        ...promoted.map((k) => `CAST(NULL AS VARCHAR) AS ${ident(k)}`),
        `CAST(NULL AS VARCHAR) AS tags`,
        `CAST(NULL AS GEOMETRY) AS geom`,
      ];
      await conn.run(
        `COPY (SELECT ${cols.join(", ")} WHERE false) TO ${lit(artifact)} (FORMAT PARQUET)`,
      );
      return {
        geometryColumn: "geom",
        geometryType: null,
        rowCount: 0,
        crsAssumed: false,
        headerSuspect: false,
      };
    });
  }

  const tmpDir = path.join(dataDir(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${randomUUID()}.geojson`);
  const owner = fileAccountId(artifact); if (owner) registerAccountFile(owner, tmp);
  try {
    await writeFile(tmp, classDocument(features));
    return await buildArtifact(tmp, `${cls}.geojson`, artifact);
  } finally {
    await removeAccountFile(tmp, { force: true });
  }
}

export interface OsmFeaturePreview {
  geojson: { type: "FeatureCollection"; features: unknown[] };
  featureCount: number;
  truncated: boolean;
  cap: number;
}

/** Run Query: fetch (cached), assemble, apply the within
 * filter — exactly the import pipeline — and return the features for the
 * dialog map instead of landing tables. A following import re-serves the
 * Overpass response from cache. */
export async function previewOsm(
  request: OsmImportRequest,
): Promise<OsmFeaturePreview> {
  const resolved = resolveOsmRequest(request);
  const { response } = await fetchOverpass(resolved.finalQl);
  let split = assembleAndSplit(response, resolved.promoted);
  const within = withinShapeOf(resolved);
  if (within) split = filterSplitWithin(split, within);
  const all = [...split.points, ...split.lines, ...split.polygons];
  const cap = limits.renderCapFeatures;
  return {
    geojson: { type: "FeatureCollection", features: all.slice(0, cap) },
    featureCount: Math.min(all.length, cap),
    truncated: all.length > cap,
    cap,
  };
}

/** Import: fetch (cached), assemble, split, land one table per non-empty
 * class. All-or-nothing: a failure removes anything already registered. */
export async function importOsm(
  scope: AccountScope,
  request: OsmImportRequest,
): Promise<DataTable[]> {
  const deletionWork = admitAccountWork([scope.accountId]);
  try {
  requireAccountScope(scope);
  const projectId = importProjectId(request.projectId);
  if (projectId) requireFilingDestination(scope, projectId);
  const resolved = resolveOsmRequest(request);
  const { response } = await fetchOverpass(resolved.finalQl);
  let split = assembleAndSplit(response, resolved.promoted);
  const within = withinShapeOf(resolved);
  if (within) split = filterSplitWithin(split, within);
  if (split.total === 0) {
    throw new ApiError(
      "invalid_request",
      "The query returned no features; nothing was imported. Widen the area or loosen the tags.",
      422,
    );
  }

  const group = randomUUID();

  const created: DataTable[] = [];
  // The class being built when a failure lands: its artifact exists but
  // its table is not yet in `created`, so the unwind below must know
  // it.
  let inFlight: string | null = null;
  try {
    for (const cls of CLASSES) {
      if (split[cls].length === 0) continue;
      const id = randomUUID();
      const relFile = path.join("tables", `${id}.parquet`);
      const artifact = path.join(dataDir(), relFile);
    registerAccountFile(scope.accountId, artifact);
      inFlight = artifact;
      const meta = await buildClassArtifact(split, cls, resolved.promoted, artifact);
      // Derive-and-register is one synchronous step — no taken-names
      // snapshot survives the artifact build above.
      const record: Omit<DataTable, "name"> = {
        id,
        sourceFilename: `${resolved.stem}.osm`,
        format: "geojson",
        file: relFile,
        geometryColumn: meta.geometryColumn,
        geometryType: meta.geometryType,
        crsAssumed: false,
        headerSuspect: false,
        rowCount: meta.rowCount,
        createdAt: new Date().toISOString(),
        source: "osm",
        sourceParams: {
          ql: resolved.finalQl,
          ...(resolved.bbox ? { bbox: resolved.bbox } : {}),
          ...(resolved.ring ? { ring: resolved.ring } : {}),
          ...(resolved.geometry ? { geometry: resolved.geometry } : {}),
          semantics: resolved.semantics,
          ...(resolved.selectors.length > 0
            ? {
                selectors: resolved.selectors.map((s) =>
                  s.value ? `${s.key}=${s.value}` : s.key,
                ),
              }
            : {}),
          endpoint: overpassEndpoint(),
          group,
          class: cls,
          promoted: resolved.promoted,
        },
        importedAt: new Date().toISOString(),
      };
      // Registration and membership commit together per class: a filing
      // failure rolls this class's registration back.
      const db = metadataDb();
      created.push(
        db.transaction(() => {
          const table = registerTable(scope, record, `${resolved.stem}_${cls}`, db);
          if (projectId) fileOwnedTable(scope, table.id, projectId, db);
          return table;
        })(),
      );
      inFlight = null;
    }
    return created;
  } catch (error) {
    // All-or-nothing: unwind anything this import already registered —
    // and the in-flight class's artifact, which no registry row names.
    for (const t of created) {
      metadataDb().prepare("DELETE FROM data_tables WHERE id = ? AND owner_id = ?").run(t.id, scope.accountId);
      await removeAccountFile(path.join(dataDir(), t.file), { force: true });
    }
    if (inFlight) await removeAccountFile(inFlight, { force: true });
    throw error;
  }

  } finally { deletionWork.release(); }
}

/** Every member of an import group, by any member's group id. */
export function osmGroupMembers(scope: AccountScope, group: string): DataTable[] {
  return listOwnedTables(scope).filter(
    (t) => t.source === "osm" && t.sourceParams?.group === group,
  );
}
