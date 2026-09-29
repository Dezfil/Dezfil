import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { listJobs } from "@/lib/metadata/owned-jobs";
import { jobView } from "@/lib/operations/job-view";

/**
 * Run history — newest first, optionally narrowed to one subject.
 *
 * The subject filter is what answers *"when did this last succeed"* after a
 * failed re-run: a failed run never overwrites the successful one before it, so
 * a subject's history keeps both and the question has an answer. Runs sharing a
 * caller-supplied subject are one subject; a run without one is its own.
 */
export async function GET(request: Request) {
  try {
    const scope = requireRequestScope(request);
    const url = new URL(request.url);
    const subjectId = url.searchParams.get("subject") ?? undefined;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;

    const runs = listJobs(scope, {
      ...(subjectId ? { subjectId } : {}),
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });
    return NextResponse.json({ runs: runs.map(jobView) });
  } catch (error) {
    return errorResponse(error);
  }
}
