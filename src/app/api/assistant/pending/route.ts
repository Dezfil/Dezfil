import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { assistantRuns } from "@/lib/assistant/runs";

export async function GET(request: Request) {
  try {
    const { account } = requireRequestAuth(request);
    return privateResponse(Response.json({ pending: assistantRuns.pending(account.id) }));
  } catch (error) { return authFailure(error); }
}
