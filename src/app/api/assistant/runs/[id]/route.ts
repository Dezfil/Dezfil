import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { requireCurrentActor } from "@/lib/auth/credentials";
import { assistantRuns } from "@/lib/assistant/runs";
import { pendingActions } from "@/lib/assistant/pending";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const actor = requireRequestAuth(request), { id } = await context.params;
    requireCurrentActor(actor); assistantRuns.requireAccount(id, actor.account.id);
    return privateResponse(Response.json(assistantRuns.read(id)));
  } catch (error) { return authFailure(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const actor = requireRequestAuth(request), { id } = await context.params;
    requireCurrentActor(actor); assistantRuns.requireAccount(id, actor.account.id);
    const pendingId = assistantRuns.release(id);
    if (pendingId) pendingActions.supersede(pendingId);
    return privateResponse(Response.json(assistantRuns.read(id)));
  } catch (error) { return authFailure(error); }
}
