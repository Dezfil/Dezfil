import { errorResponse } from "@/lib/api/errors";
import { assistantRuns } from "@/lib/assistant/runs";

export async function POST() {
  try { return Response.json(assistantRuns.reserve(), { status: 201, headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
