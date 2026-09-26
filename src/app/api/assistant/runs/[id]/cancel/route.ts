import { errorResponse } from "@/lib/api/errors";
import { assistantRuns } from "@/lib/assistant/runs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; assistantRuns.cancel(id); return Response.json(assistantRuns.read(id), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
