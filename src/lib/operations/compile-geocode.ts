import type { AccountScope } from "@/lib/auth/scope";
import type { DatasetScope } from "@/lib/query/access";
import { ApiError } from "@/lib/api/errors";
import { publicationSql, removeStage, stageBatch } from "@/lib/geocode/batch";
import { geocoderConfigured } from "@/lib/geocode/endpoint";
import { unconfiguredError } from "@/lib/geocode/provider";
import { limits } from "@/lib/limits";
import type { DataTable } from "@/lib/metadata/tables";
import type { OperationDef } from "./catalog";
import { isTextColumn } from "./column-types";
import type { CompiledRun } from "./compile";
import { columnsOf, fields, inputTable, required, str } from "./compile-support";

/**
 * Admission for the verb that asks a provider.
 *
 * **Everything refusable is refused before a job exists**, which for this verb
 * means before a single request is spent — an unknown input, a column that is
 * not text, an input above the bound, a generated column that would collide, an
 * input that already carries geometry, and an instance with no endpoint
 * configured at all. Draws that line and this verb has the strongest reason to
 * respect it: the alternative spends a provider's quota to find out.
 *
 * **What it cannot produce is the SQL.** Every other verb compiles to a
 * statement here; this one compiles to a *preparation* — the work that has to
 * happen before a statement exists at all — and the lane runs it inside the
 * run's own budget and signal.
 */

/** The columns this verb writes. Every one of them is checked against the
 * input's own columns at admission: two columns of one name come back as
 * `name` and `name_1`, and which is which is the engine's business, so the
 * answer would arrive under a name nobody chose. */
export const GEOCODE_COLUMNS = [
  "geom",
  "geocode_status",
  "geocode_match",
  "geocode_attribution",
  "geocode_source",
];

/**
 * The largest input this instance will accept, derived from what a row can
 * actually cost.
 *
 * **A row costs the pacing interval or the provider's answer, whichever is
 * longer** — the per-request deadline bounds the second — and the run must also
 * publish inside the same budget, so a reserve is held back for that. The
 * reserve is one query timeout: publication *is* a query, and reserving exactly
 * what a query is allowed to take is a number with a reason rather than a feel.
 *
 * **And a row may cost that twice.** A transport failure is retried once
 * before it fails the run (J8), so a run in which every first exchange burns
 * its deadline and every retry succeeds is a perfectly valid run that spends
 * two slots per row. Budgeting one meant an input admitted *at the advertised
 * maximum* could time out around halfway through — which is the opposite of
 * what a bound is for. Found at the cross-model review.
 *
 * It follows that the bound **does not simply scale with the pace**: against a
 * slow provider the deadline dominates, and lowering the pace alone changes
 * nothing. Both settings move it, which is what makes it a derived bound rather
 * than a disguised constant.
 */
/** One attempt, then the retry J8 allows before a transport failure ends the
 * run. Exported so the bound's test can state the formula independently of the
 * function that computes it. */
export const ATTEMPTS_PER_ROW = 2;

export function maxBatchRows(): number {
  const perExchange = Math.max(
    limits.geocodePaceMs,
    limits.geocodeRequestTimeoutMs,
  );
  // The retry is part of what a row is allowed to cost, so it is part of what
  // a row is budgeted at.
  const perRow = perExchange * ATTEMPTS_PER_ROW;
  const available = limits.operationTimeoutMs - limits.queryTimeoutMs;
  return Math.max(1, Math.floor(available / Math.max(1, perRow)));
}

function refuseGeometry(table: DataTable, label: string): void {
  if (!table.geometryColumn) return;
  // J4: a dataset has one active geometry column, so a geocoded point would
  // either replace the shape the user had or sit beside it as a second geometry
  // the registry cannot name. Both are worse than a refusal naming the column.
  throw new ApiError(
    "invalid_request",
    `"${table.name}" already carries geometry in "${table.geometryColumn}", ` +
      `and ${label} writes a point onto every row. A dataset has one geometry ` +
      `column, so this would replace what is there. Geocode a table without ` +
      `geometry, or drop that column first.`,
    400,
  );
}

async function addressColumn(
  scope: DatasetScope,
  table: DataTable,
  params: Record<string, unknown>,
  label: string,
): Promise<string> {
  const named = await fields(scope, table, params.column, "address column");
  if (named.length !== 1) required(label, "column");
  const column = named[0];
  const described = (await columnsOf(scope, table)).find(
    (c) => c.name.toLowerCase() === column.toLowerCase(),
  );
  // The same predicate the form offers columns by, so a caller that is not the
  // form is refused on exactly the terms the form promised.
  if (!described || !isTextColumn(described.type)) {
    throw new ApiError(
      "invalid_request",
      `"${column}" holds ${described?.type ?? "no readable type"}, and an ` +
        `address is text. Choose a text column, or cast this one first with a ` +
        `SQL step.`,
      400,
    );
  }
  return column;
}

async function refuseCollisions(scope: DatasetScope, table: DataTable, label: string): Promise<void> {
  const existing = new Set(
    (await columnsOf(scope, table)).map((column) => column.name.toLowerCase()),
  );
  const collides = GEOCODE_COLUMNS.filter((name) => existing.has(name));
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
  const bound = maxBatchRows();
  if (rows <= bound) return;
  // **Read from the registry, not from the engine** — the same posture
  // clustering's bound takes: the recorded row count is the number this
  // contract is about, and the answer either way is a refusal.
  //
  // **It counts input rows, not distinct addresses and not the ones a cache
  // might already hold.** A bound that depended on cache contents would accept
  // or refuse the same request differently depending on history, which is not a
  // contract a user can hold.
  throw new ApiError(
    "invalid_request",
    `"${table.name}" has ${rows.toLocaleString("en-US")} rows, and ${label} ` +
      `accepts ${bound.toLocaleString("en-US")} in one run; every row may ` +
      `cost a request, and the run has to finish inside its budget. Filter the ` +
      `table first, or raise DEZFIL_OPERATION_TIMEOUT_S (or lower the pace ` +
      `and the request deadline against your own provider).`,
    400,
  );
}

export function isGeocodeVerb(id: string): boolean {
  return id === "geocode_addresses";
}

export async function compileGeocode(
  scope: AccountScope,
  operation: OperationDef,
  params: Record<string, unknown>,
  requireName: boolean,
): Promise<CompiledRun> {
  const label = operation.label;
  // First, because it is the one refusal that is about the instance rather than
  // the request: nothing else is worth checking if there is nobody to ask.
  if (!geocoderConfigured()) throw unconfiguredError();

  const name = str(params, "name");
  if (requireName && !name) required(label, "name");
  const named = str(params, "input");
  if (!named) required(label, "input");
  const table = inputTable(scope, named, "input");

  refuseGeometry(table, label);
  const column = await addressColumn(scope, table, params, label);
  await refuseCollisions(scope, table, label);
  refuseSize(table, label);

  return {
    // A prepared run has no statement until its preparation has run: the SQL
    // names a private staging input that does not exist yet.
    sql: "",
    name,
    // The generation the answers will be joined to, captured here — before a
    // single request is spent — and re-checked inside the publication (J10).
    bindings: { [table.name.toLowerCase()]: table.file },
    // **Answerable without asking anybody**, which is what makes a dry run of a
    // provider verb possible at all: one row goes out for every row in, so the
    // count is the input's own, and the class is the catalog's declaration
    // (doctrine E7).
    preview: {
      rowCount: table.rowCount ?? 0,
      geometryType: "POINT",
      geometryColumn: "geom",
      geometry: "classified",
    },
    prepare: async (context) => {
      const staged = await stageBatch(scope, {
        table,
        column,
        ...(context.signal ? { signal: context.signal } : {}),
        deadlineAt: context.deadlineAt,
        timeoutError: context.timeoutError,
      });
      return {
        inputs: [staged.stage],
        sql: publicationSql(table, column, staged.stage),
        // Published **in place of** the SQL, which names a private input (J9).
        disclosure: {
          kind: "provider_request",
          ...staged.disclosure,
          addresses: staged.staged,
        },
        cleanup: () => removeStage(staged.stage),
      };
    },
  };
}
