import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { findOperation } from "@/lib/operations/catalog";
import { compileOperation } from "@/lib/operations/compile";
import { dryRun } from "@/lib/operations/materialize";
import { startRun } from "@/lib/operations/run";
import { jobView } from "@/lib/operations/job-view";

/**
 * Run an operation, or ask what it would produce.
 *
 * **Asynchronous**: a run answers `202 Accepted` with a job, before the work is done, and the
 * caller polls the run resource. Answered `201` with the finished table; that
 * completed representation now lives on the job a caller polls, so the
 * information did not disappear — the moment it arrives did.
 *
 * The caller's own cancellation is deliberately **not** passed into the work.
 * That is the whole point of the lane: an accepted run outlives the request
 * that started it, and closing a tab must not destroy work a user asked for.
 * Cancellation, loss of account activity or the lane's budget can stop publication.
 *
 * A dry run is unchanged: synchronous, minting no job, and still bounded by the
 * caller's departure, because nobody is waiting on it but them.
 */
export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    // The admission table documents a malformed body as refused here. Left to
    // chance it is not: invalid JSON throws out of parsing and a literal `null`
    // body is dereferenced, and both would surface as an internal 500 — a
    // documented contract the code did not keep.
    let body: {
      operation?: unknown;
      parameters?: unknown;
      subject?: unknown;
      dryRun?: unknown;
    };
    try {
      const parsed: unknown = await request.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      body = parsed as typeof body;
    } catch {
      throw new ApiError(
        "invalid_request",
        "The request body must be a JSON object describing the operation to run.",
        400,
      );
    }
    const params =
      typeof body.parameters === "object" && body.parameters !== null
        ? (body.parameters as Record<string, unknown>)
        : {};

    if (body.dryRun === true) {
      const operation = findOperation(
        typeof body.operation === "string" ? body.operation : "",
      );
      // Compiled, not read: a verb that generates its own SQL is previewable
      // on the same terms as one whose SQL the caller wrote. The compiler
      // keeps the refusal an absent parameter has always had — without it the
      // missing value reaches the SQL classifier as an empty string and
      // answers sql_rejected where the contract documents invalid_request.
      const {
        sql,
        measurement,
        preview: declared,
        assumedCrs: ownRoute,
      } = await compileOperation(operation.id, params, { requireName: false });
      // **A verb that can answer without running answers without running**. For
      // a provider operation that is not an optimization: its statement does
      // not exist until it has spent requests, and a dry run that spent them
      // would not be dry.
      const preview =
        declared ?? (await dryRun(sql, request.signal, operation.id));
      // Either road (K7b): the measurement record where one exists, the
      // compiled run's own field where the verb makes no measurement.
      const assumed = measurement?.assumedCrs ?? ownRoute ?? [];
      return NextResponse.json({
        operation: operation.id,
        dryRun: preview,
        // Said **before** the run, which is the point of the gate: a metric
        // answer over data whose WGS84 was guessed is computed and the caller
        // is told, rather than refused.
        ...(assumed.length
          ? {
              warnings: [
                `${assumed.map((n) => `"${n}"`).join(", ")} ${
                  assumed.length === 1 ? "was" : "were"
                } imported without a declared coordinate system, so WGS84 ` +
                  // K7b: no measurement record, no measurement language.
                  `was assumed. ${measurement ? "This measurement" : "The result"} ` +
                  `is only as trustworthy as that assumption, and the ` +
                  `output records it.`,
              ],
            }
          : {}),
        ...(measurement ? { measurement } : {}),
      });
    }

    const job = await startRun(scope, {
      operation: typeof body.operation === "string" ? body.operation : "",
      parameters: params,
      ...(body.subject !== undefined ? { subject: body.subject as string } : {}),
    });

    return NextResponse.json(
      { run: jobView(job) },
      {
        status: 202,
        // Where the caller watches it. The run's own resource, not the
        // output's — the output does not exist yet.
        headers: { Location: `/api/operations/runs/${job.id}` },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
