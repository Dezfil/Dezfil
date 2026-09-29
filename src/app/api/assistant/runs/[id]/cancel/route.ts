import { accountScope } from "@/lib/auth/scope";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { requireCurrentActor } from "@/lib/auth/credentials";
import { assistantRuns } from "@/lib/assistant/runs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = requireRequestAuth(request), { id } = await context.params;
    requireCurrentActor(actor); const scope = accountScope(actor);
    assistantRuns.cancel(scope, id);
    return privateResponse(Response.json(assistantRuns.read(scope, id)));
  } catch (error) { return authFailure(error); }
}
