import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { requireCurrentActor } from "@/lib/auth/credentials";
import { assistantRuns } from "@/lib/assistant/runs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = requireRequestAuth(request), { id } = await context.params;
    requireCurrentActor(actor); assistantRuns.requireAccount(id, actor.account.id);
    assistantRuns.cancel(id);
    return privateResponse(Response.json(assistantRuns.read(id)));
  } catch (error) { return authFailure(error); }
}
