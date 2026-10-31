import { accountScope } from "@/lib/auth/scope";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { assistantRuns } from "@/lib/assistant/runs";
import { resolvePayer } from "@/lib/assistant/keys/resolve";
import { ApiError } from "@/lib/api/errors";

export async function POST(request: Request) {
  try {
    const scope = accountScope(requireRequestAuth(request));
    const payer = resolvePayer(scope.accountId);
    if (payer.kind === "none") throw new ApiError("assistant_disabled", payer.reason, 404);
    return privateResponse(Response.json(assistantRuns.reserve(scope), { status: 201 }));
  } catch (error) { return authFailure(error); }
}
