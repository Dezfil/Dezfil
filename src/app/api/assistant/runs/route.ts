import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { assistantRuns } from "@/lib/assistant/runs";

export async function POST(request: Request) {
  try {
    const { account } = requireRequestAuth(request);
    return privateResponse(Response.json(assistantRuns.reserve(account.id), { status: 201 }));
  } catch (error) { return authFailure(error); }
}
