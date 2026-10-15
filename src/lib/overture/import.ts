import { withTrustedMutation } from "@/lib/trusted-mutation";
import { withTrustedOperation } from "@/lib/trusted-operation";
import { settingRemedy } from "@/lib/settings/remedy";
import { admitAccountWork } from "@/lib/auth/account-deletion-admission";
import { registerAccountFile, removeAccountFile } from "@/lib/ingest/file-ownership";
import { requireFilingDestination } from "@/lib/auth/reach";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dataDir } from "@/lib/config";
import { limits } from "@/lib/limits";
import { ApiError } from "@/lib/api/errors";
import { withConnection } from "@/lib/duckdb";
import { registerTable, type DataTable } from "@/lib/metadata/tables";
import { metadataDb } from "@/lib/metadata/db";
import { fileOwnedTable } from "@/lib/metadata/owned-tables";
import { importProjectId } from "@/lib/project-scope";
import { measureArtifact, type ArtifactMeta } from "@/lib/ingest/ingest";
import {
  OVERTURE_THEMES,
  isOvertureTheme,
  type OvertureTheme,
} from "./catalogue";
import { latestOvertureRelease, isValidRelease } from "./releases";
import { ensureOvertureSupport, mapOvertureError } from "./remote";
import {
  aggregateLevels,
  countryDivisionIndex,
  divisionGeometry,
  subtypeLabel,
  subtypeOrder,
  type DivisionLevel,
} from "./divisions";

import { isBbox, bboxAreaKm2, type Bbox } from "@/lib/bbox";
import {
  isPolygonalGeometry,
  geometryWkt,
  geometryBbox,
  MAX_GEOMETRY_VERTICES,
  type PolygonalGeometry,
} from "@/lib/geo-shape";
import {
  overtureReadExpr,
  buildOvertureQuery,
  buildOvertureCount,
  buildOvertureLevelCounts,
  buildOverturePreview,
  defaultSemantics,
  isAreaSemantics,
  isRing,
  ringWkt,
  ringBbox,
  type AreaSemantics,
  type Ring,
  type ResolvedScope,
  type OvertureSelection,
} from "./query";

export { isBbox, bboxAreaKm2, type Bbox } from "@/lib/bbox";
export { overtureReadExpr, buildOvertureSelect } from "./query";

/**
 * Overture import: resolve a scope (named area, drawn shape, or legacy
 * bbox), shape one SELECT, and land it as GeoParquet. The count preview
 * shares the resolution and WHERE clauses, so the number shown is the
 * number imported.
 */

/** A stored/requested scope — serializable, provenance-friendly. */
export type OvertureScopeParam =
  | { type: "country"; code: string; label?: string }
  | { type: "state"; code: string; label?: string }
  | { type: "division"; id: string; label?: string }
  | { type: "bbox"; bbox: Bbox }
  | { type: "polygon"; ring: Ring }
  | { type: "feature"; geometry: PolygonalGeometry; label?: string };

export interface OvertureImportParams {
  theme: OvertureTheme;
  release: string;
  scope: OvertureScopeParam;
  semantics: AreaSemantics;
  /** Divisions only: the Overture subtype to import. */
  level?: string;
  /** Places-only category filter (curated taxonomy primary). */
  category?: string;
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Freehand rings are simplified client-side; this bounds the SQL we build. */
const MAX_RING_POINTS = 500;

const ISO_COUNTRY = /^[A-Z]{2}$/i;
const ISO_STATE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/i;

/** Refuse oversized selections before any remote read (the budget
 * applies to the scope's extent however it was given). */
export function assertAreaWithinBudget(theme: OvertureTheme, bbox: Bbox): void {
  const budget = limits.overtureMaxKm2 * OVERTURE_THEMES[theme].budgetFactor;
  const area = bboxAreaKm2(bbox);
  if (area > budget) {
    throw new ApiError(
      "area_too_large",
      `The selected area spans ${Math.round(area).toLocaleString()} km²; the ${
        OVERTURE_THEMES[theme].label
      } theme allows up to ${Math.round(budget).toLocaleString()} km². Pick a smaller area or scope. ${settingRemedy("overtureMaxKm2")}`,
      413,
    );
  }
}

export function isOvertureScopeParam(
  value: unknown,
): value is OvertureScopeParam {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "country":
      return typeof v.code === "string" && ISO_COUNTRY.test(v.code);
    case "state":
      return typeof v.code === "string" && ISO_STATE.test(v.code);
    case "division":
      return typeof v.id === "string" && v.id.length > 0;
    case "bbox":
      return isBbox(v.bbox);
    case "polygon":
      return isRing(v.ring) && (v.ring as Ring).length <= MAX_RING_POINTS;
    case "feature":
      // A layer feature's real geometry — Polygon or MultiPolygon.
      return isPolygonalGeometry(v.geometry);
    default:
      return false;
  }
}

export interface OvertureImportRequest {
  theme: unknown;
  /** New-style scope. */
  scope?: unknown;
  semantics?: unknown;
  level?: unknown;
  /** Legacy form: a bare rectangle, historically overlap-filtered. */
  bbox?: unknown;
  release?: unknown;
  category?: unknown;
  name?: unknown;
  /** The project the created table joins; optional. */
  projectId?: unknown;
}

/** Validate a request into parameters, resolving the default release. */
export async function resolveOvertureParams(
  request: OvertureImportRequest,
): Promise<OvertureImportParams & { requestedName?: string }> {
  if (!isOvertureTheme(request.theme)) {
    throw new ApiError(
      "invalid_request",
      `Unknown Overture theme. Supported: ${Object.keys(OVERTURE_THEMES).join(", ")}.`,
      400,
    );
  }
  const theme = request.theme;

  let scope: OvertureScopeParam;
  let semantics: AreaSemantics;
  if (request.scope !== undefined) {
    if (!isOvertureScopeParam(request.scope)) {
      throw new ApiError(
        "invalid_request",
        `Expected scope as one of: {type:"country", code}, {type:"state", code}, {type:"division", id}, {type:"bbox", bbox}, {type:"polygon", ring} (ring ≤ ${MAX_RING_POINTS} points), {type:"feature", geometry} (GeoJSON Polygon/MultiPolygon, ≤ ${MAX_GEOMETRY_VERTICES.toLocaleString()} vertices).`,
        400,
      );
    }
    scope = request.scope;
    if (request.semantics !== undefined && !isAreaSemantics(request.semantics)) {
      throw new ApiError(
        "invalid_request",
        'The semantics must be "within" or "intersect".',
        400,
      );
    }
    semantics = isAreaSemantics(request.semantics)
      ? request.semantics
      : defaultSemantics(theme);
  } else {
    // Legacy shape: bbox at the top level, overlap semantics.
    if (!isBbox(request.bbox)) {
      throw new ApiError(
        "invalid_request",
        "Provide a scope, or bbox as [west, south, east, north] in WGS84 degrees.",
        400,
      );
    }
    scope = { type: "bbox", bbox: request.bbox };
    semantics = isAreaSemantics(request.semantics)
      ? request.semantics
      : "intersect";
  }

  if (request.release !== undefined && !isValidRelease(request.release)) {
    throw new ApiError(
      "invalid_request",
      "The release must look like 2026-06-17.0.",
      400,
    );
  }
  if (request.category !== undefined && typeof request.category !== "string") {
    throw new ApiError("invalid_request", "The category must be a string.", 400);
  }
  if (request.level !== undefined) {
    if (theme !== "divisions") {
      throw new ApiError(
        "invalid_request",
        "A level applies to the divisions theme only.",
        400,
      );
    }
    if (
      typeof request.level !== "string" ||
      !/^[a-z][a-z0-9_]{0,32}$/.test(request.level)
    ) {
      throw new ApiError(
        "invalid_request",
        "The level must be an Overture division subtype (e.g. region, county).",
        400,
      );
    }
  }
  if (request.name !== undefined && typeof request.name !== "string") {
    throw new ApiError("invalid_request", "The name must be a string.", 400);
  }

  return {
    theme,
    scope,
    semantics,
    release: request.release ?? (await latestOvertureRelease()),
    ...(typeof request.level === "string" ? { level: request.level } : {}),
    ...(request.category ? { category: request.category } : {}),
    ...(request.name ? { requestedName: request.name } : {}),
  };
}

/** Parse stored provenance back into parameters — both the shape and
 * the legacy bbox recipe (which refreshes as an intersect rectangle). */
export function parseStoredOvertureParams(
  sourceParams: Record<string, unknown> | null | undefined,
  tableName: string,
): OvertureImportParams {
  const p = sourceParams ?? {};
  const incomplete = () =>
    new ApiError(
      "not_refreshable",
      `Table "${tableName}" has an incomplete Overture recipe and cannot be re-run.`,
      409,
    );
  if (!isOvertureTheme(p.theme) || !isValidRelease(p.release)) throw incomplete();
  let scope: OvertureScopeParam;
  let semantics: AreaSemantics;
  if (p.scope !== undefined) {
    if (!isOvertureScopeParam(p.scope)) throw incomplete();
    scope = p.scope;
    semantics = isAreaSemantics(p.semantics)
      ? p.semantics
      : defaultSemantics(p.theme);
  } else if (isBbox(p.bbox)) {
    scope = { type: "bbox", bbox: p.bbox };
    semantics = "intersect";
  } else {
    throw incomplete();
  }
  return {
    theme: p.theme,
    release: p.release,
    scope,
    semantics,
    ...(typeof p.level === "string" ? { level: p.level } : {}),
    ...(typeof p.category === "string" ? { category: p.category } : {}),
  };
}

/** Resolve a scope to query form: attribute filters for division-native
 * scopes, polygons (fetched once, budget-checked first) for the rest. */
export async function resolveSelection(
  params: OvertureImportParams,
): Promise<OvertureSelection> {
  const { theme, release, scope, semantics } = params;
  let resolved: ResolvedScope;

  if (scope.type === "bbox") {
    assertAreaWithinBudget(theme, scope.bbox);
    resolved = { kind: "bbox", bbox: scope.bbox };
  } else if (scope.type === "polygon") {
    const bbox = ringBbox(scope.ring);
    assertAreaWithinBudget(theme, bbox);
    resolved = { kind: "shape", wkt: ringWkt(scope.ring), bbox };
  } else if (scope.type === "feature") {
    const bbox = geometryBbox(scope.geometry);
    assertAreaWithinBudget(theme, bbox);
    resolved = { kind: "shape", wkt: geometryWkt(scope.geometry), bbox };
  } else if (scope.type === "division") {
    const { wkt, bbox } = await divisionGeometry(release, scope.id);
    assertAreaWithinBudget(theme, bbox);
    resolved = { kind: "shape", wkt, bbox };
  } else if (theme === "divisions") {
    resolved =
      scope.type === "country"
        ? { kind: "country", code: scope.code.toUpperCase() }
        : { kind: "region", code: scope.code.toUpperCase() };
  } else {
    // A named country/state scope for a data theme becomes its boundary
    // polygon. The index row's bbox backs the budget check before the
    // (much heavier) geometry is fetched.
    const code = scope.code.toUpperCase();
    const index = await countryDivisionIndex(
      release,
      scope.type === "country" ? code : code.slice(0, 2),
    );
    const row =
      scope.type === "country"
        ? index.find((r) => r.subtype === "country")
        : index.find((r) => r.subtype === "region" && r.region === code);
    if (!row) {
      throw new ApiError(
        "invalid_request",
        `No division found for scope code ${code} in release ${release}.`,
        404,
      );
    }
    assertAreaWithinBudget(theme, row.bbox);
    const { wkt, bbox } = await divisionGeometry(release, row.divisionId);
    resolved = { kind: "shape", wkt, bbox };
  }

  return {
    theme,
    release,
    scope: resolved,
    semantics,
    ...(params.level ? { level: params.level } : {}),
    ...(params.category ? { category: params.category } : {}),
  };
}

async function presentColumns(
  conn: import("@duckdb/node-api").DuckDBConnection,
  theme: OvertureTheme,
  release: string,
): Promise<string[]> {
  const described = await conn.runAndReadAll(
    `DESCRIBE SELECT * FROM ${overtureReadExpr(theme, release)} LIMIT 0`,
  );
  return (
    described.getRowObjects() as unknown as { column_name: string }[]
  ).map((c) => c.column_name);
}

/** Produce and measure the artifact for a recipe — shared by first import
 * and refresh (which swaps it in atomically). */
export async function buildOvertureArtifact(
  params: OvertureImportParams,
  artifact: string,
): Promise<ArtifactMeta> {
  const selection = await resolveSelection(params);
  await mkdir(path.dirname(artifact), { recursive: true });
  return withConnection(async (conn) => {
    await ensureOvertureSupport(conn);
    try {
      const present = await presentColumns(conn, params.theme, params.release);
      const select = buildOvertureQuery(selection, present);
      await conn.run(`COPY (${select}) TO ${lit(artifact)} (FORMAT PARQUET)`);
      return await measureArtifact(
        conn,
        artifact,
        present.includes("geometry") ? "geometry" : null,
      );
    } catch (error) {
      mapOvertureError(error);
    }
  });
}

/** Count what an import would land — same resolution, same WHERE (spec
 * the preview matches the import). Returns the display query too, so
 * dev mode shows the real thing even for fetched scope polygons. */
export async function countOverture(
  params: OvertureImportParams,
  signal?: AbortSignal,
): Promise<{ count: number; query: string }> {
  return withTrustedOperation({ kind: "interactive-read", name: "Overture read", signal }, async () => {
    const selection = await resolveSelection(params);
    return withConnection(async (conn) => {
      await ensureOvertureSupport(conn);
      try {
        const present = await presentColumns(conn, params.theme, params.release);
        const counted = await conn.runAndReadAll(buildOvertureCount(selection));
        return {
          count: Number(counted.getRowObjects()[0].n),
          query: buildOvertureQuery(selection, present),
        };
      } catch (error) {
        mapOvertureError(error);
      }
    });
  });
}

/** The driver hands LIST columns back either as arrays or as wrapper
 * objects, depending on version — normalize before serializing. */
function listItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { items?: unknown }).items)
  ) {
    return (value as { items: unknown[] }).items;
  }
  return [];
}

/** Per-level scoped counts for the divisions theme: what each
 * level would import under the active scope, with samples. Country and
 * state scopes are answered from the cached index — no remote read; the
 * geometric scopes run one grouped query. The echoed query (the currently
 * parameterized import) comes along for dev mode where the scope polygon
 * only exists server-side. */
export async function countOvertureLevels(
  params: OvertureImportParams,
  signal?: AbortSignal,
): Promise<{ levels: DivisionLevel[]; query?: string }> {
  return withTrustedOperation({ kind: "interactive-read", name: "Overture read", signal }, async () => {
    if (params.theme !== "divisions") {
      throw new ApiError(
        "invalid_request",
        "Per-level counts apply to the divisions theme only.",
        400,
      );
    }
    const { scope } = params;
    if (scope.type === "country" || scope.type === "state") {
      const code = scope.code.toUpperCase();
      const index = await countryDivisionIndex(
        params.release,
        scope.type === "country" ? code : code.slice(0, 2),
      );
      const rows =
        scope.type === "country"
          ? index
          : index.filter((r) => r.region === code);
      return { levels: aggregateLevels(rows) };
    }
    const selection = await resolveSelection(params);
    return withConnection(async (conn) => {
      await ensureOvertureSupport(conn);
      try {
        const grouped = await conn.runAndReadAll(
          buildOvertureLevelCounts(selection),
        );
        const levels = (
          grouped.getRowObjects() as {
            subtype: unknown;
            n: unknown;
            samples: unknown;
          }[]
        )
          .map((r) => ({
            subtype: String(r.subtype),
            label: subtypeLabel(String(r.subtype)),
            count: Number(r.n),
            samples: listItems(r.samples).map((s) => String(s)),
          }))
          .sort((a, b) => subtypeOrder(a.subtype) - subtypeOrder(b.subtype));
        const present = await presentColumns(conn, params.theme, params.release);
        return { levels, query: buildOvertureQuery(selection, present) };
      } catch (error) {
        mapOvertureError(error);
      }
    });
  });
}

export interface FeaturePreview {
  geojson: { type: "FeatureCollection"; features: unknown[] };
  featureCount: number;
  truncated: boolean;
  cap: number;
}

/** Run Query: the features an import with these params
 * would land, as GeoJSON for the dialog map — same resolution, same
 * filters, capped by the render cap with truncation stated. */
export async function previewOvertureFeatures(
  params: OvertureImportParams,
  signal?: AbortSignal,
): Promise<FeaturePreview> {
  return withTrustedOperation({ kind: "interactive-read", name: "Overture read", signal }, async () => {
    const selection = await resolveSelection(params);
    const cap = limits.renderCapFeatures;
    return withConnection(async (conn) => {
      await ensureOvertureSupport(conn);
      try {
        const rows = await conn.runAndReadAll(
          buildOverturePreview(selection, cap),
        );
        const all = rows.getRowObjects() as { geometry: unknown }[];
        const truncated = all.length > cap;
        const features = all
          .slice(0, cap)
          .filter((r) => r.geometry !== null && r.geometry !== undefined)
          .map((r, i) => ({
            type: "Feature",
            id: i,
            geometry: JSON.parse(String(r.geometry)) as unknown,
            properties: {},
          }));
        return {
          geojson: { type: "FeatureCollection", features },
          featureCount: features.length,
          truncated,
          cap,
        };
      } catch (error) {
        mapOvertureError(error);
      }
    });
  });
}

/** Import an Overture slice as a table. The build seam
 * is injectable for tests, the PostGIS road's precedent. */
export async function importOverture(
  scope: AccountScope,
  request: OvertureImportRequest,
  build: typeof buildOvertureArtifact = buildOvertureArtifact,
  signal?: AbortSignal,
): Promise<DataTable> {
  return withTrustedMutation({ kind: "import", name: "Overture import", signal }, async operation => {
    const deletionWork = admitAccountWork([requireAccountScope(scope)]);
    try {
    requireAccountScope(scope);
    const projectId = importProjectId(request.projectId);
    if (projectId) requireFilingDestination(scope, projectId);
    const { requestedName, ...params } = await resolveOvertureParams(request);
    const id = randomUUID();
    const relFile = path.join("tables", `${id}.parquet`);
    const artifact = path.join(dataDir(), relFile);
      registerAccountFile(scope.accountId, artifact);

    try {
      const meta = await build(params, artifact);
      const record: Omit<DataTable, "name"> = {
        id,
        sourceFilename: `overture_${params.theme}`,
        format: "geoparquet",
        file: relFile,
        geometryColumn: meta.geometryColumn,
        geometryType: meta.geometryType,
        crsAssumed: false,
        headerSuspect: false,
        rowCount: meta.rowCount,
        createdAt: new Date().toISOString(),
        source: "overture",
        sourceParams: {
          theme: params.theme,
          scope: params.scope,
          semantics: params.semantics,
          release: params.release,
          ...(params.level ? { level: params.level } : {}),
          ...(params.category ? { category: params.category } : {}),
        },
        importedAt: new Date().toISOString(),
      };
      // Derive-and-register in one synchronous step; the project
      // membership commits with it.
      const db = metadataDb();

      const registered = db.transaction(() => {
        operation.assertCanCommit();
        const table = registerTable(scope, record, requestedName ?? `overture_${params.theme}`, db);
        if (projectId) fileOwnedTable(scope, table.id, projectId, db);
        return table;
      })();
      operation.markCommitted();
      return registered;
    } catch (error) {
      operation.refuseIfFinal(error);
      await removeAccountFile(artifact, { force: true });
      throw error;
    }

    } finally { deletionWork.release(); }
  });
}
