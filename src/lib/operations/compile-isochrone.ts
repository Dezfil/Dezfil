import type { DatasetScope } from "@/lib/query/access";
import { ApiError } from "@/lib/api/errors";
import {
  isochronePublicationSql,
  removeIsochroneStage,
  stageIsochroneBatch,
} from "@/lib/isochrone/batch";
import { isochroneConfigured } from "@/lib/isochrone/endpoint";
import { isochroneUnconfiguredError } from "@/lib/isochrone/provider";
import { limits } from "@/lib/limits";
import type { DataTable } from "@/lib/metadata/tables";
import type { OperationDef } from "./catalog";
import type { CompiledRun } from "./compile";
import { assumedCrsOf, columnsOf, inputTable, required, str } from "./compile-support";

/**
 * Admission for the second verb that asks a provider. Everything
 * refusable is refused before a job exists — before a single request is
 * spent.
 */

/** The columns this verb writes. Checked against the input's own at
 * admission — except the active geometry column, whose replacement is the
 * point (K3). */
export const ISOCHRONE_COLUMNS = [
  "geom",
  "origin_lon",
  "origin_lat",
  "snapped_lon",
  "snapped_lat",
  "travel_mode",
  "band_minutes",
  "isochrone_status",
  "isochrone_source",
];

/** The protocol's own default maximum (K10): the product does not promise
 * what a stock provider refuses. */
export const MAX_BANDS = 4;

/** One attempt, then the retry the run allows before a transport failure
 * ends it. Exported so the bound's test can state K9's formula
 * independently of the function that computes it. */
export const ATTEMPTS_PER_ORIGIN = 2;

/**
 * K9: the bound is derived and counts **origins** — a row costs nothing, an
 * origin costs one request, which may cost the pace or the deadline,
 * whichever is longer, twice. Bands do not enter it: they travel together.
 * Publication keeps one query timeout as its reserve.
 */
export function maxIsochroneOrigins(): number {
  const perExchange = Math.max(
    limits.isochronePaceMs,
    limits.isochroneRequestTimeoutMs,
  );
  const perOrigin = perExchange * ATTEMPTS_PER_ORIGIN;
  const available = limits.operationTimeoutMs - limits.queryTimeoutMs;
  // Zero is an answer: a budget that cannot afford one origin's
  // worst case plus the publication reserve admits nothing, rather than
  // admitting one run the advertised reserve cannot hold.
  return Math.max(0, Math.floor(available / Math.max(1, perOrigin)));
}

/** The travel-time bands, refused on every rule the catalog serves: present, at most four, each a positive whole number of
 * minutes, no duplicates. */
function bandsOf(params: Record<string, unknown>, label: string): number[] {
  const raw = params.bands;
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    required(label, "bands");
  }
  if (!Array.isArray(raw)) {
    throw new ApiError(
      "invalid_request",
      `"bands" is a list of travel times in minutes, up to ${MAX_BANDS} ` +
        `whole numbers.`,
      400,
    );
  }
  if (raw.length > MAX_BANDS) {
    throw new ApiError(
      "invalid_request",
      `${label} accepts at most ${MAX_BANDS} bands in one run; the ` +
        `protocol's own maximum. Ask for fewer.`,
      400,
    );
  }
  const bands: number[] = [];
  for (const value of raw) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < 1
    ) {
      throw new ApiError(
        "invalid_request",
        `A band is a positive whole number of minutes; "${String(value)}" ` +
          `is not one.`,
        400,
      );
    }
    if (bands.includes(value)) {
      throw new ApiError(
        "invalid_request",
        `Each band is asked once. ${value} appears twice.`,
        400,
      );
    }
    bands.push(value);
  }
  return bands;
}

function modeOf(
  operation: OperationDef,
  params: Record<string, unknown>,
  label: string,
): string {
  const declared = operation.parameters.find((p) => p.name === "travel_mode");
  const mode = str(params, "travel_mode") || String(declared?.default ?? "");
  if (!declared?.options?.includes(mode)) {
    throw new ApiError(
      "invalid_request",
      `"${mode}" is not a way of travelling ${label} knows. The modes are ` +
        `${(declared?.options ?? []).join(", ")}.`,
      400,
    );
  }
  return mode;
}

/** A table of single points: the registry's class must be
 * POINT exactly — a MULTIPOINT has no single origin — and the input must
 * physically carry exactly one geometry column, because every one of them
 * is excluded and `geom` replaces them all (K3). */
async function refuseWrongGeometry(
  scope: DatasetScope,
  table: DataTable,
  label: string,
): Promise<void> {
  const type = (table.geometryType ?? "").toUpperCase();
  if (!table.geometryColumn || type === "") {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" has no geometry, and ${label} asks where travel ` +
        `starts. Geocode it first, or choose a table of points.`,
      400,
    );
  }
  if (type !== "POINT") {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" holds ${type.toLowerCase()}, and ${label} needs ` +
        `single points: a ${type === "MULTIPOINT" ? "multipoint has no single origin" : "point is where travel starts"}. ` +
        `Take centroids first.`,
      400,
    );
  }
  const geometryColumns = (await columnsOf(scope, table)).filter(
    // GEOMETRY bare or with the engine's parenthesised CRS qualifier — and
    // never the prefix test alone, which is how swallowed GEOMETRY_TYPE.
    (column) => /^GEOMETRY($|\()/.test(column.type.toUpperCase()),
  );
  if (geometryColumns.length > 1) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" physically carries ${geometryColumns.length} geometry ` +
        `columns, and ${label} replaces geometry entirely, excluding only ` +
        `the active one would leave the other in the output and register ` +
        `the result as whatever it happens to be. Drop the extra column ` +
        `first with a SQL step.`,
      400,
    );
  }
}

async function refuseCollisions(scope: DatasetScope, table: DataTable, label: string): Promise<void> {
  const active = table.geometryColumn?.toLowerCase();
  const existing = new Set(
    (await columnsOf(scope, table))
      .map((column) => column.name.toLowerCase())
      .filter((name) => name !== active),
  );
  const collides = ISOCHRONE_COLUMNS.filter((name) => existing.has(name));
  if (collides.length > 0) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" already has a column called "${collides[0]}", and ` +
        `${label} writes one of that name. Rename or drop it first.`,
      400,
    );
  }
}

function refuseSize(table: DataTable, label: string): void {
  const rows = table.rowCount ?? 0;
  const bound = maxIsochroneOrigins();
  if (rows <= bound) return;
  throw new ApiError(
    "invalid_request",
    `"${table.name}" has ${rows.toLocaleString("en-US")} rows, and ${label} ` +
      `accepts ${bound.toLocaleString("en-US")} origins in one run; every ` +
      `origin may cost a request, and the run has to finish inside its ` +
      `budget. Filter the table first, or raise ` +
      `DEZFIL_OPERATION_TIMEOUT_S (or lower the pace and the request ` +
      `deadline against your own provider).`,
    400,
  );
}

export function isIsochroneVerb(id: string): boolean {
  return id === "isochrone";
}

export async function compileIsochrone(
  scope: DatasetScope,
  operation: OperationDef,
  params: Record<string, unknown>,
  requireName: boolean,
): Promise<CompiledRun> {
  const label = operation.label;
  // First, because it is about the instance rather than the request.
  if (!isochroneConfigured()) throw isochroneUnconfiguredError();

  const name = str(params, "name");
  if (requireName && !name) required(label, "name");
  const named = str(params, "input");
  if (!named) required(label, "input");
  const table = inputTable(scope, named, "input");
  const assumed = assumedCrsOf([table]);

  await refuseWrongGeometry(scope, table, label);
  const mode = modeOf(operation, params, label);
  const bands = bandsOf(params, label);
  await refuseCollisions(scope, table, label);
  refuseSize(table, label);

  return {
    sql: "",
    name,
    bindings: { [table.name.toLowerCase()]: table.file },
    // Origins × bands: every origin and every band gets a
    // row, answered or not, which is what makes the count knowable before
    // a request is made. The class is the catalog's declaration (E7).
    preview: {
      rowCount: (table.rowCount ?? 0) * bands.length,
      geometryType: "POLYGON",
      geometryColumn: "geom",
      geometry: "classified",
    },
    // K7b: the warning is about whether the coordinates are trusted, and
    // this is the verb where it matters most — a wrong guess hands the
    // router a start somewhere else entirely.
    assumedCrs: assumed,
    prepare: async (context) => {
      const staged = await stageIsochroneBatch(scope, {
        table,
        mode,
        bands,
        ...(context.signal ? { signal: context.signal } : {}),
        deadlineAt: context.deadlineAt,
        timeoutError: context.timeoutError,
      });
      return {
        sql: isochronePublicationSql(table, mode, bands, staged.stage),
        disclosure: {
          kind: "provider_request",
          ...staged.disclosure,
          origins: staged.origins,
          // K7b: the assumption is recorded where the run's own story is.
          ...(assumed.length ? { assumedCrs: assumed } : {}),
        },
        cleanup: () => removeIsochroneStage(staged.stage),
      };
    },
  };
}
