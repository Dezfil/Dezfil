import { accountScope } from "@/lib/auth/scope";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { requireCurrentActor } from "@/lib/auth/credentials";
import { assistantRuns } from "@/lib/assistant/runs";
import { pendingActions } from "@/lib/assistant/pending";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const actor = requireRequestAuth(request), { id } = await context.params;
    requireCurrentActor(actor); const scope = accountScope(actor);
    return privateResponse(Response.json(assistantRuns.read(scope, id)));
  } catch (error) { return authFailure(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const actor = requireRequestAuth(request), { id } = await context.params;
    requireCurrentActor(actor); const scope = accountScope(actor);
    const pendingId = assistantRuns.release(scope, id);
    if (pendingId) pendingActions.supersede(scope, pendingId);
    return privateResponse(Response.json(assistantRuns.read(scope, id)));
  } catch (error) { return authFailure(error); }
}
