import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { cancelRun } from "@/lib/operations/run";
import { jobView } from "@/lib/operations/job-view";

type Params = { params: Promise<{ id: string }> };

/**
 * Stop a run.
 *
 * A queued run never starts; a running one is genuinely interrupted, and its
 * lane slot stays held until the engine has actually let go — marking a row
 * cancelled while the query keeps consuming the instance would be a lie the
 * rest of the product pays for.
 *
 * **A run that has already finished is not an error** (G5). Cancel means *make
 * sure this is not running*, and for a terminal run that is already true, so
 * this answers the run unchanged. The alternative — a coded conflict — turns
 * the commonest race, a cancel clicked as the run lands, into a failure where
 * nothing went wrong.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    // Awaited: the run answers terminal once the engine has actually let go,
    // within a bounded grace, rather than the instant the record is marked.
    return NextResponse.json({ run: jobView(await cancelRun(scope, id)) });
  } catch (error) {
    return errorResponse(error);
  }
}
