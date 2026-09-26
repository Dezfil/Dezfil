import { errorResponse } from "@/lib/api/errors";
import { assistantRuns } from "@/lib/assistant/runs";
import { pendingActions } from "@/lib/assistant/pending";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try { return Response.json(assistantRuns.read((await context.params).id), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const pendingId = assistantRuns.release(id);
    if (pendingId) pendingActions.supersede(pendingId);
    return Response.json(assistantRuns.read(id), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
