import { tableRef } from "@/lib/operations/input-ref";
import { namedSql } from "@/lib/query/named-sql";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { prepareStagingInput, removeStagingInput, type StagingInput } from "@/lib/query/staging";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";
import { boundedEvaluation } from "@/lib/query/bounded";
import {
  COSTING_BY_MODE,
  configuredIsochroneEndpoint,
  isochroneEndpointIdentity,
} from "./endpoint";
import {
  askIsochrone,
  isochroneUnconfiguredError,
  type BandStatus,
} from "./provider";

/**
 * The batch: every distinct origin coordinate, answered and staged.
 *
 * **The stage is joined on the origin's exact coordinates**, which are the
 * one key this process and the engine hold identically: the engine reads
 * them out with `ST_X`/`ST_Y`, this module sends them to the provider and
 * writes them back unrounded, and the join is exact float equality on
 * values that made a round trip through nothing. Two source rows at the
 * same coordinates share one stage row — the rule's "cost one request
 * and both get the answer" is this join, not a special case.
 *
 * **All of one origin's bands travel in one request**, so the stage
 * holds one row per origin per band and the cost is one request per
 * origin.
 */

/** What the disclosure says about the requests this run made. */
export interface IsochroneDisclosure {
  /** Host and path only — never the query string, where a key travels. */
  endpoint: string | null;
  travelMode: string;
  /** The profile actually sent — the provider's own word for the mode. */
  costing: string;
  /** The bands as asked for, in the user's order. */
  bands: number[];
  unit: "minutes";
  /** No departure time was supplied (K6) — recorded, not implied. */
  departureTime: "none";
  /** Counted in origins, because one request carries several contours. */
  originsFromCache: number;
  originsFromWire: number;
}

export interface IsochroneBatchResult {
  /** Opaque input retained only by the preparing job. */
  stage: StagingInput;
  /** Distinct origin coordinates staged. */
  origins: number;
  disclosure: IsochroneDisclosure;
}

export interface IsochroneBatchOptions {
  table: DataTable;
  mode: string;
  bands: number[];
  signal?: AbortSignal;
  deadlineAt: number;
  timeoutError: () => ApiError;
}

interface StagedBand {
  lon: number;
  lat: number;
  minutes: number;
  status: BandStatus;
  wkt: string | null;
  snappedLon: number | null;
  snappedLat: number | null;
  source: "cache" | "wire";
}

function remaining(deadlineAt: number, timeoutError: () => ApiError): number {
  const left = deadlineAt - Date.now();
  if (left <= 0) throw timeoutError();
  return left;
}

/** The distinct origin coordinates, ordered — so which origin reaches the
 * wire first is the data's own fact and two identical runs report identical
 * cache and wire counts. */
async function distinctOrigins(
  conn: DuckDBConnection,
  table: DataTable,
): Promise<{ lon: number; lat: number }[]> {
  const geom = ident(table.geometryColumn!);
  const reader = await conn.runAndReadAll(await namedSql(conn,
    `SELECT DISTINCT ST_X(${geom}) AS lon, ST_Y(${geom}) AS lat
     FROM ${tableRef(table)}
     WHERE ${geom} IS NOT NULL AND NOT ST_IsEmpty(${geom})
     ORDER BY 1, 2`,
  ));
  return reader
    .getRowObjects()
    .filter(
      (row): row is { lon: number; lat: number } =>
        typeof row.lon === "number" &&
        typeof row.lat === "number" &&
        Number.isFinite(row.lon) &&
        Number.isFinite(row.lat) &&
        // A SQL-made point can be finite and off the earth: an
        // origin nowhere on it has no usable point — `no_origin`, never a
        // request.
        Math.abs(row.lon) <= 180 &&
        Math.abs(row.lat) <= 90,
    )
    .map((row) => ({ lon: row.lon, lat: row.lat }));
}

function literal(value: string | null): string {
  return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

function numberLiteral(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "NULL" : String(value);
}

async function writeStage(
  conn: DuckDBConnection,
  rows: StagedBand[],
  stage: string,
): Promise<void> {
  const values = rows
    .map(
      (row) =>
        `(${numberLiteral(row.lon)}, ${numberLiteral(row.lat)}, ` +
        `${numberLiteral(row.minutes)}, ${literal(row.status)}, ` +
        `${literal(row.wkt)}, ${numberLiteral(row.snappedLon)}, ` +
        `${numberLiteral(row.snappedLat)}, ${literal(row.source)})`,
    )
    .join(", ");
  const select =
    rows.length === 0
      ? `SELECT NULL::DOUBLE AS lon, NULL::DOUBLE AS lat,
                NULL::INTEGER AS band_minutes, NULL::VARCHAR AS status,
                NULL::VARCHAR AS wkt, NULL::DOUBLE AS snapped_lon,
                NULL::DOUBLE AS snapped_lat, NULL::VARCHAR AS source
         WHERE false`
      : `SELECT lon::DOUBLE AS lon, lat::DOUBLE AS lat,
                minutes::INTEGER AS band_minutes, status::VARCHAR AS status,
                wkt::VARCHAR AS wkt, snapped_lon::DOUBLE AS snapped_lon,
                snapped_lat::DOUBLE AS snapped_lat, source::VARCHAR AS source
         FROM (VALUES ${values})
           AS t(lon, lat, minutes, status, wkt, snapped_lon, snapped_lat, source)`;
  await conn.run(
    `COPY (${select}) TO '${stage.replace(/'/g, "''")}' (FORMAT PARQUET)`,
  );
}

/**
 * The select that publishes an isochrone run (K2, K3).
 *
 * **It names the source table** — the materializer derives lineage from the
 * tables the SQL names, so the generation fence and staleness see the real
 * input. Every source row appears once per band (the cross join), every
 * non-geometry column survives, and **the active geometry column is
 * excluded** — admission has already refused an input carrying more than
 * one. A source row with no usable point misses the join on every band and
 * reads `no_origin`.
 */
export function isochronePublicationSql(
  table: DataTable,
  mode: string,
  bands: number[],
  stage: StagingInput,
): string {
  const source = tableRef(table);
  const geom = ident(table.geometryColumn!);
  const bandRows = bands.map((minutes) => `(${minutes})`).join(", ");
  return `SELECT s.* EXCLUDE (${geom}),
       CASE WHEN g.status = 'answered' THEN ST_GeomFromText(g.wkt) END AS geom,
       ST_X(s.${geom}) AS origin_lon,
       ST_Y(s.${geom}) AS origin_lat,
       g.snapped_lon AS snapped_lon,
       g.snapped_lat AS snapped_lat,
       ${literal(mode)} AS travel_mode,
       b.minutes AS band_minutes,
       COALESCE(g.status, 'no_origin') AS isochrone_status,
       g.source AS isochrone_source
FROM ${source} AS s
CROSS JOIN (VALUES ${bandRows}) AS b(minutes)
LEFT JOIN ${ident(stage.name)} AS g
  ON ST_X(s.${geom}) = g.lon AND ST_Y(s.${geom}) = g.lat
  AND b.minutes = g.band_minutes`;
}

export async function removeIsochroneStage(stage: StagingInput): Promise<void> {
  await removeStagingInput(stage);
}

/**
 * Answer every distinct origin and stage the answers. No request starts
 * once the run is terminal — the deadline and the signal are checked
 * between origins, and carried into each exchange, whose slot wait can
 * outlast the run.
 */
export async function stageIsochroneBatch(
  scope: AccountScope,
  options: IsochroneBatchOptions,
): Promise<IsochroneBatchResult> {
  const { table, mode, bands, signal, deadlineAt, timeoutError } = options;
  const endpoint = configuredIsochroneEndpoint();
  if (!endpoint) throw isochroneUnconfiguredError();

  const origins = await boundedEvaluation(
    async (conn) => distinctOrigins(conn, table),
    { scope,
      ...(signal ? { signal } : {}),
      budgetMs: remaining(deadlineAt, timeoutError),
      timeoutError,
    },
  );

  const rows: StagedBand[] = [];
  let originsFromCache = 0;
  let originsFromWire = 0;
  for (const origin of origins) {
    requireAccountScope(scope);
    if (signal?.aborted) throw new EvaluationCancelled();
    remaining(deadlineAt, timeoutError);
    const answer = await askIsochrone(origin, mode, bands, {
      ...(signal ? { signal } : {}),
      deadlineAt,
    }).catch((error: unknown) => {
      if (Date.now() >= deadlineAt) throw timeoutError();
      throw error;
    });
    if (answer.source === "cache") originsFromCache += 1;
    else originsFromWire += 1;
    for (const band of answer.bands) {
      rows.push({
        lon: origin.lon,
        lat: origin.lat,
        minutes: band.minutes,
        status: band.status,
        wkt: band.wkt,
        snappedLon: answer.snappedLon,
        snappedLat: answer.snappedLat,
        source: answer.source,
      });
    }
  }

  const stage = await prepareStagingInput(scope, "isochrone", async file => {
    await boundedEvaluation(async (conn) => writeStage(conn, rows, file), { scope,
      ...(signal ? { signal } : {}),
      budgetMs: remaining(deadlineAt, timeoutError),
      timeoutError,
    });
  });

  return {
    stage,
    origins: origins.length,
    disclosure: {
      endpoint: isochroneEndpointIdentity(endpoint),
      travelMode: mode,
      costing: COSTING_BY_MODE[mode],
      bands: [...bands],
      unit: "minutes",
      departureTime: "none",
      originsFromCache,
      originsFromWire,
    },
  };
}
