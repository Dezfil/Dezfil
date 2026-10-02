import { tableRef } from "@/lib/operations/input-ref";
import { namedSql } from "@/lib/query/named-sql";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { prepareStagingInput, removeStagingInput, type StagingInput } from "@/lib/query/staging";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";
import { boundedEvaluation } from "@/lib/query/bounded";
import { configuredEndpoint, endpointIdentity } from "./endpoint";
import { NORMALIZATION_VERSION } from "./normalize";
import { geocodeAddress, unconfiguredError, type RowOutcome } from "./provider";
import type { DatasetScope } from "@/lib/query/access";

/**
 * The batch: every distinct address in a column, answered and staged.
 *
 * **The stage is joined on the address as the source holds it, not on the
 * normalized form.** J1's own wording said normalized, and implementation found
 * that unbuildable in the safe direction: the engine's `lower()` and this
 * process's casefold provably disagree — `İSTANBUL` casefolds to two codepoints
 * in JavaScript and to `istanbul` in DuckDB — so a join on "the normalized
 * address" needs two normalizers that agree forever, and the day they diverge
 * the run publishes *empty_address* for a row it holds a perfectly good answer
 * for. Normalization stays where it decides **what is asked and what is
 * cached**, so two spellings still cost one request; the join key is an exact
 * string equality on the value the source holds, which is the one key this
 * process and the engine can agree on exactly. The spec records the amendment
 * (v4).
 *
 * **Every distinct value gets a stage row, including the empty ones.** A left
 * join whose miss reads as *empty address* is only honest if a miss cannot
 * happen for any other reason — so staging the empties makes the miss exactly
 * one thing: a NULL in the source column.
 */

/** One staged answer. These column names are the stage's own; the publication
 * select is what turns them into the documented output columns. */
interface StagedRow {
  address: string;
  status: RowOutcome;
  lon: number | null;
  lat: number | null;
  display: string | null;
  attribution: string | null;
  source: "cache" | "wire" | null;
}

/** What the disclosure says about the request this run made. */
export interface Disclosure {
  /** Host and path only — never the query string, where a key travels. */
  endpoint: string | null;
  parameters: { format: string; limit: number };
  /** The address-normalization version these answers were asked under. */
  normalization: number;
  fromCache: number;
  fromWire: number;
  attributions: string[];
}

export interface BatchResult {
  /** Opaque input retained only by the preparing job. */
  stage: StagingInput;
  /** Distinct address values staged — the join's own row count. */
  staged: number;
  disclosure: Disclosure;
}

export interface BatchOptions {
  table: DataTable;
  /** The column holding the address, as the registry spells it. */
  column: string;
  signal?: AbortSignal;
  /** When the whole run must be over — publication included. */
  deadlineAt: number;
  /** The lane's own coded timeout, so a batch that runs long fails as a run
   * that ran long rather than as a query that did. */
  timeoutError: () => ApiError;
  /** Where the input is read: the run's evaluation, its account otherwise. */
  reads?: DatasetScope;
}

function remaining(deadlineAt: number, timeoutError: () => ApiError): number {
  const left = deadlineAt - Date.now();
  if (left <= 0) throw timeoutError();
  return left;
}

/**
 * The distinct values of the address column, as the source holds them.
 *
 * **Ordered**, so the run is reproducible: without it the scan decides which
 * spelling of an address reaches the wire and which is answered from the cache
 * it just wrote, and two identical runs can report different cache and wire
 * counts for the same data. The sort costs nothing at these sizes.
 */
async function distinctAddresses(
  conn: DuckDBConnection,
  table: DataTable,
  column: string,
): Promise<(string | null)[]> {
  const reader = await conn.runAndReadAll(await namedSql(conn,
    `SELECT DISTINCT ${ident(column)} AS address FROM ${tableRef(table)}
     ORDER BY 1`,
  ));
  return reader
    .getRowObjects()
    .map((row) => (typeof row.address === "string" ? row.address : null));
}

/** A SQL string literal, or NULL. Every staged value passes through this: they
 * come from user data and from a provider, and neither is ours to trust. */
function literal(value: string | null): string {
  return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

function numberLiteral(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "NULL" : String(value);
}

/**
 * Write the answers where the engine can read them.
 *
 * A literal `VALUES` list rather than a side file: admission's bound keeps this
 * to at most a few hundred rows by construction, so the statement's size is
 * bounded, and every value is escaped. The alternative — staging through JSON —
 * would put this verb's correctness behind an optional extension.
 */
async function writeStage(
  conn: DuckDBConnection,
  rows: StagedRow[],
  stage: string,
): Promise<void> {
  const values = rows
    .map(
      (row) =>
        `(${literal(row.address)}, ${literal(row.status)}, ` +
        `${numberLiteral(row.lon)}, ${numberLiteral(row.lat)}, ` +
        `${literal(row.display)}, ${literal(row.attribution)}, ` +
        `${literal(row.source)})`,
    )
    .join(", ");
  // A source with nothing to ask about still stages a file: the publication
  // reads it either way, and a missing one would fail a run whose only fault
  // was an empty table.
  const select =
    rows.length === 0
      ? `SELECT NULL::VARCHAR AS address, NULL::VARCHAR AS status,
                NULL::DOUBLE AS lon, NULL::DOUBLE AS lat,
                NULL::VARCHAR AS display, NULL::VARCHAR AS attribution,
                NULL::VARCHAR AS source WHERE false`
      : // Named by the alias list rather than by the engine's own positional
        // names for a VALUES list, which are not a contract this depends on.
        `SELECT address::VARCHAR AS address, status::VARCHAR AS status,
                lon::DOUBLE AS lon, lat::DOUBLE AS lat,
                display::VARCHAR AS display, attribution::VARCHAR AS attribution,
                source::VARCHAR AS source
         FROM (VALUES ${values})
           AS t(address, status, lon, lat, display, attribution, source)`;
  await conn.run(
    `COPY (${select}) TO '${stage.replace(/'/g, "''")}' (FORMAT PARQUET)`,
  );
}

/** The select that publishes a geocode run (J1).
 *
 * **It names the source table**, which is the whole of the ruling: the
 * materializer derives an output's inputs from the tables its SQL names, so a
 * publication reading only the stage would record empty lineage, skip the
 * generation fence on the real source, and leave everything downstream unable to
 * notice that source changing. */
export function publicationSql(
  table: DataTable,
  column: string,
  stage: StagingInput,
): string {
  const source = tableRef(table);
  return `SELECT s.*,
       CASE WHEN g.status = 'matched' THEN ST_Point(g.lon, g.lat) END AS geom,
       COALESCE(g.status, 'empty_address') AS geocode_status,
       g.display AS geocode_match,
       g.attribution AS geocode_attribution,
       g.source AS geocode_source
FROM ${source} AS s
LEFT JOIN ${ident(stage.name)} AS g
  ON s.${ident(column)} = g.address`;
}

/** Remove a stage, whatever the run's outcome was. Best-effort by design: the
 * boot sweep collects what a dying process abandons. */
export async function removeStage(stage: StagingInput): Promise<void> {
  await removeStagingInput(stage);
}

/**
 * Answer every distinct address in the column and stage the answers.
 *
 * The provider phase sits between two engine round trips and inside one
 * deadline: the source is read, the addresses are answered one at a time at the
 * instance's pace, and the answers are staged. **No request starts once the run
 * is terminal** — the deadline and the signal are both checked between rows,
 * which is the only place a sequential batch can check them.
 */
export async function stageBatch(scope: AccountScope, options: BatchOptions): Promise<BatchResult> {
  const { table, column, signal, deadlineAt, timeoutError } = options;
  const endpoint = configuredEndpoint();
  if (!endpoint) throw unconfiguredError();

  const addresses = await boundedEvaluation(
    async (conn) => distinctAddresses(conn, table, column),
    { scope: options.reads ?? scope,
      ...(signal ? { signal } : {}),
      budgetMs: remaining(deadlineAt, timeoutError),
      timeoutError,
    },
  );

  const rows: StagedRow[] = [];
  let fromCache = 0;
  let fromWire = 0;
  const attributions = new Set<string>();
  for (const address of addresses) {
    if (address === null) continue; // a NULL cannot be a join key
    requireAccountScope(scope);
    if (signal?.aborted) throw new EvaluationCancelled();
    // Checked *before* the request rather than after it: a row that starts
    // inside the budget and finishes outside it is one thing; a request that
    // starts after the run is already over is forbidden.
    remaining(deadlineAt, timeoutError);
    // **And carried into the lookup**, because this check is not enough on its
    // own: between here and the wire there is a wait for the instance's slot,
    // which can outlast the run — and the exchange would then take its own full
    // deadline on top of a budget already spent. Found at the cross-model
    // review. The lookup abandons instead, and this turns that into the run's
    // own coded timeout rather than a stray abandonment.
    const answer = await geocodeAddress(address, {
      ...(signal ? { signal } : {}),
      deadlineAt,
    }).catch((error: unknown) => {
      if (Date.now() >= deadlineAt) throw timeoutError();
      throw error;
    });
    if (answer.source === "cache") fromCache += 1;
    if (answer.source === "wire") fromWire += 1;
    if (answer.attribution) attributions.add(answer.attribution);
    rows.push({
      address,
      status: answer.outcome,
      lon: answer.lon,
      lat: answer.lat,
      display: answer.display,
      attribution: answer.attribution,
      source: answer.source,
    });
  }

  const stage = await prepareStagingInput(scope, "geocode", async file => {
    await boundedEvaluation(async (conn) => writeStage(conn, rows, file), { scope,
      ...(signal ? { signal } : {}),
      budgetMs: remaining(deadlineAt, timeoutError),
      timeoutError,
    });
  });

  return {
    stage,
    staged: rows.length,
    disclosure: {
      endpoint: endpointIdentity(endpoint),
      parameters: { format: "jsonv2", limit: 1 },
      normalization: NORMALIZATION_VERSION,
      fromCache,
      fromWire,
      attributions: [...attributions].sort(),
    },
  };
}
