import { settingRemedy } from "@/lib/settings/remedy";
import { bindingKey } from "./input-ref";
import type { AccountScope } from "@/lib/auth/scope";
import type { DatasetScope } from "@/lib/query/access";
import { ApiError } from "@/lib/api/errors";
import { publicationSql, removeStage, stageBatch } from "@/lib/geocode/batch";
import { configuredEndpoint } from "@/lib/geocode/endpoint";
import { unconfiguredError } from "@/lib/geocode/provider";
import { limits } from "@/lib/limits";
import { maxBatchRows } from "./provider-capacities";
export { maxBatchRows, ATTEMPTS_PER_ROW } from "./provider-capacities";
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
      `table first, or lower the pace and the request deadline against your own provider. ` +
      settingRemedy("operationTimeoutS"),
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
  reads: DatasetScope = scope,
): Promise<CompiledRun> {
  const label = operation.label;
  // First, because it is the one refusal that is about the instance rather than
  // the request: nothing else is worth checking if there is nobody to ask.
  // The address is taken here, at admission, and kept to the run's end: a
  // change made while the run waits or works never splits its answers
  // between two providers.
  const endpoint = configuredEndpoint();
  if (!endpoint) throw unconfiguredError();

  const name = str(params, "name");
  if (requireName && !name) required(label, "name");
  const named = str(params, "input");
  if (!named) required(label, "input");
  const table = inputTable(reads, named, "input");

  refuseGeometry(table, label);
  const column = await addressColumn(reads, table, params, label);
  await refuseCollisions(reads, table, label);
  // The gap and the answer time limit are taken with the size check that
  // derives from them, and kept to the run's end like its address: a change
  // made while the run waits or works applies to runs admitted after it.
  const gapMs = limits.geocodePaceMs;
  const requestTimeoutMs = limits.geocodeRequestTimeoutMs;
  refuseSize(table, label);

  return {
    // A prepared run has no statement until its preparation has run: the SQL
    // names a private staging input that does not exist yet.
    sql: "",
    name,
    // The generation the answers will be joined to, captured here — before a
    // single request is spent — and re-checked inside the publication (J10).
    bindings: { [bindingKey(table)]: table.file },
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
        reads,
        table,
        column,
        endpoint,
        gapMs,
        requestTimeoutMs,
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
