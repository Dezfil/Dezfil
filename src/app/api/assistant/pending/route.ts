import { accountScope } from "@/lib/auth/scope";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { assistantRuns } from "@/lib/assistant/runs";

export async function GET(request: Request) {
  try {
    const scope = accountScope(requireRequestAuth(request));
    return privateResponse(Response.json({ pending: assistantRuns.pending(scope) }));
  } catch (error) { return authFailure(error); }
}
