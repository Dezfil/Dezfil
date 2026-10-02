import type { StagingInput } from "@/lib/query/staging";
import type { DatasetScope } from "@/lib/query/access";
import { getOwnedTableByName, requireOwnedTableReference } from "@/lib/metadata/owned-tables";
import { publishDataset, nameTaken } from "./dataset-publication";
export { LostAuthority } from "./dataset-publication";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { ApiError } from "@/lib/api/errors";
import { boundedEvaluation, isOutOfMemory } from "@/lib/query/bounded";
import { safeEngineMessage, engineRefusal } from "@/lib/query/engine-message";
import { findOperation } from "./catalog";
import { namedSql } from "@/lib/query/named-sql";
import {
  collapseGeometryTypes,
  ident,
  measureArtifact,
} from "@/lib/ingest/ingest";
import { deriveTableName } from "@/lib/ingest/naming";
import type { BoundTable } from "@/lib/query/binding-snapshot";
import { retireArtifact } from "@/lib/ingest/retire";
import {
  type DataTable,
} from "@/lib/metadata/tables";
import { firstExternalUnbound, resolveSql, unavailableDataset } from "@/lib/query/bindings";
import { bindingNamespace } from "@/lib/query/namespace";

/**
 * Materialization: a query result becomes a durable registered dataset. The
 * one new engine primitive of — every operation the phase ships ends here.
 *
 * Two disciplines carry the correctness of this module.
 *
 * **One bounded lifetime, one commit point.** Everything — evaluating the
 * user's SQL, writing the artifact, measuring it, registering it — happens
 * inside a single bounded evaluation. That is not tidiness: the boundary is
 * wall-clock, so it can turn the call into a failure *after* the callback
 * returns, and it is also what registers this work as an in-flight reader so a
 * concurrent refresh cannot retire an artifact out from under it. Registration
 * is the commit point: interruption is checked immediately before it, nothing
 * fallible runs after it, and cleanup is conditional on whether it happened. A
 * cleanup that ran unconditionally would delete the artifact of a row that had
 * already committed, leaving a registered table pointing at nothing.
 *
 * **A taken name is refused, never worked around.** The registry's ordinary
 * registration derives a name and appends a numeric suffix on collision, which
 * is right for an import and wrong here: the gate ruled that a caller who asks
 * for a taken name is told. So this inserts exactly, and turns the residual
 * race — another table claiming the name between the check and the insert —
 * into the same refusal rather than a suffixed success.
 */

export interface MaterializeRequest {
  /** Internal provider inputs; never parsed from public request fields. */
  inputs?: readonly StagingInput[];
  /** The read-only SELECT whose result becomes the dataset. */
  sql: string;
  /** The name the caller asked for; sanitized, never de-duplicated. */
  name: string;
  /** The operation that ran, for the record. */
  operation: string;
  /** Its parameters, for the record. */
  parameters?: Record<string, unknown>;
  /**
   * Where this run measured, when it measured anything.
   *
   * A buffer whose provenance does not name its measurement CRS is not
   * reproducible: the same operation with the same parameters can produce a
   * different geometry under a later strategy, and nothing in the record would
   * explain the difference. It rides in the record the run already writes, so
   * there is no second write to keep consistent.
   */
  measurement?: Record<string, unknown>;
  /**
   * What the output's record carries **in place of** the statement that ran.
   *
   * A provider operation discloses the request it made rather than the query it
   * did not write — and its statement names a private staging input, so
   * publishing it would put an internal path in the registry. The record
   * carries this and **no SQL at all**: an absence is a better contract than a
   * redaction that must never miss.
   */
  disclosure?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Execution budget. The run lane supplies its own, larger than the
   * user-query bound; without one this takes the query timeout. */
  budgetMs?: number;
  /** The lane's coded timeout, paired with `budgetMs`. */
  timeoutError?: () => ApiError;
  /**
   * Called inside the publication transaction, immediately before the dataset
   * row is written.
   *
   * This is where a run proves it still has the right to publish. Returning
   * false abandons the whole transaction — no dataset row, no artifact kept —
   * which is what stops a run whose job was cancelled while it worked from
   * registering an output anyway. Doing this as a prior read instead would
   * leave the window it exists to close.
   *
   * It also receives **the inputs this run bound, with the artifact each one
   * held**. A recipe step writes its lineage from these, in this same
   * transaction, so no reader can ever see an output whose lineage has not
   * landed. The artifact is the one the engine's catalog actually bound, not
   * the one a later registry or shared catalog read names. Execution and
   * evidence are pinned together on the evaluation’s own connection.
   *
   * Before it is called, every input that was someone else's when the run
   * bound it must still be within the runner's reach: one withdrawn since
   * (unfiled, deleted, or out of reach once the runner left the project)
   * refuses the output, though the run already read it.
   */
  authorize?: (
    table: DataTable,
    db: Database,
    inputs: BoundInput[],
  ) => boolean;
  /**
   * Replace an existing dataset's contents instead of registering a new one.
   *
   * A step's re-run keeps its output's **id and name** so every layer built on
   * that table keeps pointing at fresh data with no re-wiring. The swap is keyed
   * on both together, so a re-run racing a deletion — or a name reclaimed by a
   * different table — matches nothing and writes nothing rather than
   * overwriting a stranger.
   *
   * Only a caller that has already proven the step owns this exact table may
   * pass it; ownership is never inferred here.
   */
  replaceTable?: { id: string; name: string };

  /**
   * Runs inside the publication transaction, after a NEW dataset's row is
   * inserted and before commit: where a workflow output's project
   * membership is written, so it commits with the row or not at all.
   * Never invoked on the replacement path — a re-run preserves the
   * existing dataset's memberships.
   */
  onPublished?: (table: DataTable, db: Database) => void;
  /**
   * The input generations this run's SQL was built for.
   *
   * A metric run resolves its measurement CRS from the input's extent **at
   * admission**, because the refusal has to be an admission refusal. The job
   * can then wait in the lane while a refresh or an upstream re-run replaces
   * that input — and the generated SQL would apply the old generation's
   * projection to the new data, publish a measurably wrong number, and record a
   * CRS that describes neither. Nothing downstream would notice.
   *
   * So the binding is checked before any work starts: if what the run binds is
   * not what it was compiled for, it fails with a coded error instead of
   * answering. A visible failure beats an invisible wrong number.
   */
  requireBindings?: Record<string, string>;
  /** Where the statement reads: a workflow step's evaluation context. The
   * output is always the calling account's own dataset. */
  evaluation?: DatasetScope;
}

/** An input as this run bound it: which table, and which generation of it. */
export interface BoundInput {
  id: string;
  name: string;
  /** The artifact file the run resolved for this input. */
  artifact: string;
  /** Whose dataset it was when the run bound it; unknown is treated as
   * someone else's. */
  ownerId?: string | null;
  /** The reference as the statement wrote it, for a refusal that names it. */
  written?: string;
}

export interface DryRun {
  rowCount: number;
  /** The registry's own vocabulary, so one result is never described twice. */
  geometryType: string | null;
  geometryColumn: string | null;
  /**
   * The three cases said apart, because a null class alone cannot: a result
   * with no geometry column at all is a different answer from a spatial result
   * with no rows to classify, and a caller must not have to infer which by
   * cross-checking two nullable fields.
   */
  geometry: "none" | "undetermined" | "classified";
}

/**
 * Give an engine failure the same coded shape the query path gives it.
 *
 * A run's SQL can fail exactly as a query's can — an unknown column, a bad
 * cast, a read the fence refuses — and left raw those surface as an internal
 * 500, which tells an agent to retry something that will never succeed. The
 * bound's own concerns (interruption, the memory budget) stay the boundary's
 * to map.
 *
 * **Whose SQL it was decides the voice**. The SQL step's statement is the
 * user's own, so it keeps the engine's diagnostic in the workspace's form —
 * there the message is the cure. Every other operation's SQL was generated
 * by the product, and *"Conversion Error: Could not convert string 'Mitte'
 * to DOUBLE"* is jargon about a statement the user never saw: those get a
 * sentence naming the operation, with the engine's actionable reason kept
 * and its error-class prefix dropped.
 */
const ENGINE_CLASS_PREFIX = /^[A-Z][A-Za-z ]{0,40} Error:\s*/;

function asSqlError(error: unknown, operation?: string): never {
  const refusal = engineRefusal(error);
  if (refusal) throw refusal;
  if (error instanceof ApiError) throw error;
  if (isOutOfMemory(error)) throw error;
  const diagnostic =
    error instanceof Error ? safeEngineMessage(error.message) : null;
  if (!operation || operation === "sql_step") {
    throw new ApiError(
      "sql_error",
      diagnostic ?? "The operation's query could not be run.",
      400,
    );
  }
  const reason = diagnostic?.replace(ENGINE_CLASS_PREFIX, "").trim();
  let label: string;
  try {
    label = findOperation(operation).label;
  } catch {
    label = "The operation";
  }
  throw new ApiError(
    "sql_error",
    reason
      ? `${label} could not run on this data: ${reason}${/[.!?]$/.test(reason) ? "" : "."}`
      : `${label} could not run on this data.`,
    400,
  );
}

/**
 * Strip a trailing statement terminator before the SELECT is nested.
 *
 * The workspace seeds its editor with a terminated statement and keeps the
 * terminator after running, so the most ordinary result a user has in front of
 * them carries one. Nesting that as `COPY (SELECT …;)` is a parse error, which
 * would have made the flagship case — save the query you just ran — the one
 * case that fails. Safe here because the text has already passed the read-only
 * classifier, which accepts exactly one statement.
 */
function nestable(sql: string): string {
  return sql.replace(/;\s*$/, "");
}

async function geometryColumnOfResult(
  conn: Parameters<Parameters<typeof boundedEvaluation>[0]>[0],
  sql: string,
): Promise<string | null> {
  const described = await conn.runAndReadAll(`DESCRIBE ${nestable(sql)}`);
  const columns = described.getRowObjects() as unknown as {
    column_name: string;
    column_type: string;
  }[];
  return (
    columns.find((column) =>
      String(column.column_type).startsWith("GEOMETRY"),
    )?.column_name ?? null
  );
}

async function artifactPaths(): Promise<{ rel: string; abs: string }> {
  const rel = path.join("tables", `${randomUUID()}.parquet`);
  const abs = path.join(dataDir(), rel);
  // The import path creates this directory before every write and so must
  // this one: on a workspace whose first table is a derived one, nothing has
  // created it yet and the write fails for a reason that has nothing to do
  // with the query.
  await mkdir(path.dirname(abs), { recursive: true });
  return { rel, abs };
}

/** Sanitize to a SQL identifier without the registry's collision suffix. */
function exactName(desired: string): string {
  return deriveTableName(desired, new Set());
}

/**
 * What a run would produce, with nothing written.
 *
 * The classification is the registry's own — the same collapse an imported
 * table's class goes through — so a dry run and the dataset it predicts can
 * never describe one result two ways. The layer path's probe was the doctrine's
 * named source and is deliberately not used: it speaks a different vocabulary
 * and refuses classes a run registers happily, so adopting it would guarantee
 * the disagreement this contract forbids.
 */
export async function dryRun(
  scope: DatasetScope,
  sql: string,
  signal?: AbortSignal,
  operation?: string,
): Promise<DryRun> {
  return boundedEvaluation(async (conn) => {
    const compiledSql = await namedSql(conn, sql);
    const from = `(${nestable(compiledSql)})`;
    try {
      return await describeResult(conn, from);
    } catch (error) {
      // The same voice split as the committed run: a dry run returns
      // the coded error directly — it mints no job.
      asSqlError(error, operation);
    }
  }, { scope, signal });
}

async function describeResult(
  conn: Parameters<Parameters<typeof boundedEvaluation>[0]>[0],
  from: string,
): Promise<DryRun> {
    const described = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${from}`);
    const columns = described.getRowObjects() as unknown as {
      column_name: string;
      column_type: string;
    }[];
    const geometryColumn =
      columns.find((c) => String(c.column_type).startsWith("GEOMETRY"))
        ?.column_name ?? null;

    const counted = await conn.runAndReadAll(
      `SELECT count(*) AS n FROM ${from}`,
    );
    const rowCount = Number(counted.getRowObjects()[0].n);

    let geometryType: string | null = null;
    if (geometryColumn && rowCount > 0) {
      const typed = await conn.runAndReadAll(
        // Rows without geometry are not a geometry class — the same exclusion
        // the registry's own measurement makes, and for the same reason: a dry
        // run and the dataset it predicts must never describe one result two
        // ways.
        `SELECT DISTINCT ST_GeometryType(${ident(geometryColumn)}) AS t FROM ${from}
         WHERE ${ident(geometryColumn)} IS NOT NULL`,
      );
      geometryType = collapseGeometryTypes(
        typed.getRowObjects().map((r) => String(r.t)),
      );
    }
    const geometry = !geometryColumn
      ? ("none" as const)
      : geometryType
        ? ("classified" as const)
        : ("undetermined" as const);
    return { rowCount, geometryType, geometryColumn, geometry };
}

export async function materialize(
  scope: AccountScope,
  request: MaterializeRequest,
): Promise<DataTable> {
  requireAccountScope(scope);
  const {
    sql,
    operation,
    parameters,
    measurement,
    signal,
    budgetMs,
    timeoutError,
    replaceTable,
  } = request;
  if (replaceTable) requireOwnedTableReference(scope, replaceTable);
  const name = exactName(request.name);
  const evaluation: DatasetScope = request.evaluation ?? scope;

  return boundedEvaluation(async (conn, bounds) => {
    const compiledSql = await namedSql(conn, sql);

    // Refuse a taken name before doing the work, so the common collision
    // costs the caller nothing. The race is refused again at the insert.
    // A replacement is the one exception: it is *supposed* to find its own
    // table there, and the caller has already proven it owns it.
    if (!replaceTable && getOwnedTableByName(scope, name)) throw nameTaken(name);

    // Every dataset the statement reads, by identity: what the run records
    // and what its lineage says it read. Resolved from the statement as
    // written, in the namespace this evaluation mounted, so a qualified
    // reference stays the dataset it names; the evidence of what each bound
    // comes from this evaluation's own pinned registration.
    const snapshot = bounds.bindings!;
    const reads = await resolveSql(conn, sql, bindingNamespace(conn, evaluation));
    const external = firstExternalUnbound(reads);
    if (external) throw unavailableDataset(external);
    const resolved = reads.datasets
      .map((dataset) => snapshot.byId.get(dataset.id))
      .filter((t): t is BoundTable => t !== undefined);
    const ownerOf = new Map(reads.datasets.map((dataset) => [dataset.id, dataset.ownerId]));
    const writtenOf = new Map<string, string>();
    for (const read of reads.reads) {
      if (read.resolution.status === "bound" && !writtenOf.has(read.resolution.dataset.id)) {
        writtenOf.set(read.resolution.dataset.id, read.written);
      }
    }
    const bound: BoundInput[] = resolved.map((t) => ({
      id: t.id, name: t.name, artifact: t.file,
      ownerId: ownerOf.get(t.id) ?? null, written: writtenOf.get(t.id) ?? t.name,
    }));
    // An input whose geometry this query reads passes its uncertainty on; one
    // contributing only attributes does not.
    const crsAssumed = resolved.some((t) => t.crsAssumed && reads.geometry.has(t.id));

    // Before any work: is this still the data the SQL was built for? The
    // expectation is keyed by the reference the run was compiled with.
    if (request.requireBindings) {
      for (const read of reads.reads) {
        if (read.resolution.status !== "bound") continue;
        const expected = request.requireBindings[read.written.toLowerCase()];
        if (expected === undefined) continue;
        const actual = snapshot.byId.get(read.resolution.dataset.id)?.file;
        if (actual !== expected) throw inputChanged(read.written, !!measurement);
      }
    }

    const { rel, abs } = await artifactPaths();
    let committed = false;
    try {
      let measured;
      try {
        const geometryColumn = await geometryColumnOfResult(conn, compiledSql);
        await conn.run(
          `COPY (${nestable(compiledSql)}) TO '${abs.replace(/'/g, "''")}' (FORMAT PARQUET)`,
        );
        measured = await measureArtifact(conn, abs, geometryColumn);
        // Finish fallible engine work before the atomic metadata publication.
        // Failure elsewhere rolls the snapshot back when the boundary closes.
        await conn.run("COMMIT");
      } catch (error) {
        asSqlError(error, operation);
      }

      // The commit point. Past here nothing may fail, and cleanup must not run.
      if (bounds.interrupted()) throw new Error("interrupted before commit");
      const now = new Date().toISOString();
      const table: DataTable = {
        // A replacement keeps the identity it is replacing — that is what
        // makes every layer built on this table keep working (E4).
        id: replaceTable ? replaceTable.id : randomUUID(),
        name,
        // A derived table never was a file: the registry carries the
        // absence rather than filler that would misdescribe its origin.
        sourceFilename: null,
        format: "geoparquet",
        file: rel,
        geometryColumn: measured.geometryColumn,
        geometryType: measured.geometryType,
        crsAssumed,
        // An operation's output is not a CSV read: the warning never
        // propagates from the inputs.
        headerSuspect: false,
        rowCount: measured.rowCount,
        createdAt: now,
        source: "operation",
        sourceParams: {
          operation,
          parameters: parameters ?? {},
          // **A disclosure replaces the statement; it never joins it** (J9).
          // This run's SQL names a private staging input, so a record carrying
          // both would publish the path it promised never to. The absence is
          // the contract: a reader finding no `sql` is reading a run whose
          // answers came off a wire, and the disclosure says what was asked.
          ...(request.disclosure
            ? { disclosure: request.disclosure }
            : { sql }),
          // Ids as well as names: a name can be reclaimed by a different
          // table, and a name-only record would then silently describe a run
          // against data it never read.
          inputs: resolved.map((t) => ({ id: t.id, name: t.name })),
          ...(measurement ? { measurement } : {}),
          ranAt: now,
        },
        // A derived table reports when it was produced where an import
        // reports its last run, so it is not the one row with no age.
        importedAt: now,
      };
      const replaced = publishDataset(scope, table, bound, request);
      committed = true;
      // The generation this replaced is now unreferenced. Retiring it is
      // post-commit and best-effort, exactly as a refresh's is: the swap is the
      // outcome the caller reads, and a stumble here is a leftover the boot
      // sweep collects — but *not* retiring it at all leaks a full dataset on
      // every re-run, which routine work would turn into a full disk.
      if (replaced && replaced !== table.file) {
        try {
          // An absolute path, as the retirement road takes everywhere else —
          // the registry stores a relative one.
          retireArtifact(path.join(dataDir(), replaced));
        } catch (error) {
          console.warn(
            `post-run retirement failed for "${name}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return table;
    } finally {
      // Only an uncommitted run owns the artifact. After the commit the row
      // points at it, and removing it here would strand a registered table.
      if (!committed) await rm(abs, { force: true });
    }
  }, { scope: evaluation, inputs: request.inputs, pinBindings: true, signal, ...(budgetMs !== undefined ? { budgetMs } : {}), ...(timeoutError ? { timeoutError } : {}) });
}

/**
 * The fence's refusal, in words about what actually went wrong.
 *
 * The fence itself is and unchanged: the binding is taken at admission and
 * re-checked here, because a run that prepared against one generation and
 * published against another would join answers to rows they were never about.
 * What changes is that it no longer says *projection* for a verb that never
 * measured anything — that sentence is true for a buffer and nonsense for a
 * geocode, whose answers came off a wire and have no CRS story at all. The
 * measurement wording stays with the verbs that measure.
 */
function inputChanged(name: string, measured: boolean): ApiError {
  return measured
    ? new ApiError(
        "measurement_crs_unavailable",
        `"${name}" changed while this run was waiting, so the projection it ` +
          `was prepared for no longer describes the data. Nothing was ` +
          `written. Run it again against the current data.`,
        409,
      )
    : new ApiError(
        "input_changed",
        `"${name}" was replaced while this run was working, so what it had ` +
          `prepared belongs to data that is no longer there. Nothing was ` +
          `written. Run it again against the current data.`,
        409,
      );
}
