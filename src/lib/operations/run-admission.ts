import { ApiError } from "@/lib/api/errors";
import { boundedEvaluation } from "@/lib/query/bounded";
import { assertReadOnlySelect } from "@/lib/query/guard";
import { getTableByName } from "@/lib/metadata/tables";
import { deriveTableName } from "@/lib/ingest/naming";
import { compileOperation, type CompiledRun } from "./compile";

export interface RunRequest {
  operation: string;
  parameters: Record<string, unknown>;
  /**
   * What groups this run with others in history. A caller may supply one —
   * steps will supply their step id — and runs sharing it are one subject.
   * Omitted, the run is its own subject, which is honest for a one-off and
   * keeps history complete either way.
   */
  subject?: string;
}

/**
 * Everything refused before a job exists.
 *
 * Each of these is knowable without running the operation, so answering
 * immediately is both cheaper and more useful than a job that was doomed when
 * it was minted. Compiling the verb is part of that: a spatial join naming an
 * input that does not exist, or an aggregate a column cannot take, is refused
 * here rather than becoming a job that was doomed when it was minted.
 *
 * **`owns` is the one narrow amendment to that boundary**. A run may be
 * admitted for a name that is already taken **only** when the caller has
 * already proven, from stored state, that it owns exactly that table. It is
 * never derived from anything in the request — `subject` is a grouping identity
 * any client may send, and reading it as authorization would let any caller
 * overwrite any table.
 */
export async function admit(
  request: RunRequest,
  owns?: { id: string; name: string },
): Promise<{
  sql: string;
  name: string;
  operationId: string;
  measurement?: Record<string, unknown>;
  warnings?: string[];
  bindings?: Record<string, string>;
  prepare?: CompiledRun["prepare"];
}> {
  const params = request.parameters ?? {};
  const { sql, name, measurement, bindings, prepare, assumedCrs: ownRoute } = await compileOperation(
    request.operation,
    params,
  );

  // An empty subject is refused rather than quietly treated as absent: it
  // would be stored as a shared identity that groups unrelated runs, while
  // reading as self-owned and being unfilterable — three disagreements from
  // one falsy value.
  if (
    request.subject !== undefined &&
    (typeof request.subject !== "string" || request.subject.trim() === "")
  ) {
    throw new ApiError(
      "invalid_request",
      `"subject" must be a non-empty string when given.`,
      400,
    );
  }
  // Against the name the registry will actually use, not the one typed. The
  // materializer sanitizes into a SQL identifier, so "Bus Stops" becomes
  // "bus_stops" — checking the raw text here would miss a real collision, and
  // the run would be accepted only to fail at its commit, which is precisely
  // the wrong side of the admission boundary.
  const registered = deriveTableName(name, new Set());
  const existing = getTableByName(registered);
  if (existing && !(owns && owns.id === existing.id && owns.name === existing.name)) {
    throw new ApiError(
      "name_taken",
      `A table named "${name}" already exists. An operation never replaces or ` +
        `renames around an existing table. Choose another name.`,
      409,
    );
  }
  // Not a read-only SELECT: the guard's refusal, before anything is minted.
  //
  // **A prepared run has no statement yet**: its SQL names a staging path that
  // does not exist until the preparation has written it, so there is nothing
  // here to classify. The statement the preparation returns goes through the
  // same guard inside the materializer, which is where every run's SQL is
  // checked in any case — so this skips a check that cannot run, not one that
  // matters.
  if (!prepare) {
    await boundedEvaluation(async (conn) => assertReadOnlySelect(conn, sql));
  }

  // The assumed-CRS observation, said **before the run**: a metric answer over data whose WGS84 was guessed is still
  // computed, and the caller is told rather than refused. Either road: the
  // measurement record where one exists, the compiled run's own field
  // where the verb makes no measurement.
  const assumed = measurement?.assumedCrs ?? ownRoute ?? [];
  return {
    sql,
    name,
    operationId: request.operation,
    ...(measurement ? { measurement: measurement as unknown as Record<string, unknown> } : {}),
    ...(bindings ? { bindings } : {}),
    ...(prepare ? { prepare } : {}),
    ...(assumed.length
      ? {
          warnings: [
            `${assumed.map((n) => `"${n}"`).join(", ")} ${
              assumed.length === 1 ? "was" : "were"
            } imported without a declared coordinate system, so WGS84 was ` +
              // K7b: a verb with no measurement record must not call its
              // answer one — the warning is about trusting coordinates.
              `assumed. ${measurement ? "This measurement" : "The result"} is ` +
              `only as trustworthy as that assumption, and the output ` +
              `records it.`,
          ],
        }
      : {}),
  };
}

/** Admit a run that a caller has already proven owns the name it reuses. */
export async function admitOwned(
  request: RunRequest,
  owns: { id: string; name: string } | undefined,
) {
  return admit(request, owns);
}

