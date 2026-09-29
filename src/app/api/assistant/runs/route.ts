import { accountScope } from "@/lib/auth/scope";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { assistantRuns } from "@/lib/assistant/runs";

export async function POST(request: Request) {
  try {
    const scope = accountScope(requireRequestAuth(request));
    return privateResponse(Response.json(assistantRuns.reserve(scope), { status: 201 }));
  } catch (error) { return authFailure(error); }
}
