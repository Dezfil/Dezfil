import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireJob } from "@/lib/metadata/owned-jobs";
import { jobView } from "@/lib/operations/job-view";

type Params = { params: Promise<{ id: string }> };

/**
 * Read one run — what a caller polls after the run endpoint accepted their
 * operation.
 *
 * A terminal successful run carries its output's id and name here, which is the
 * completed representation used to answer from the run endpoint itself. A
 * failed one carries a coded error. Neither carries a percentage: the run
 * reports when it started, and elapsed time follows from that.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const job = requireJob(scope, id);
    return NextResponse.json({ run: jobView(job) });
  } catch (error) {
    return errorResponse(error);
  }
}
