import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { ApiError } from "@/lib/api/errors";
import { assistantPolicyRead } from "@/lib/assistant/policy-read";

/** The page action policy, read: what a page admits and
 * what its runs are offered by default, so a headless client can ask
 * before it sends. A documented operation, excluded from tool generation. */
export async function GET(request: Request) {
  try {
    requireRequestAuth(request);
    const page = new URL(request.url).searchParams.get("page");
    if (page !== "builder" && page !== "sql" && page !== "workflow") {
      throw new ApiError("invalid_request", 'The "page" query parameter must be builder, sql or workflow.', 400);
    }
    return privateResponse(Response.json(assistantPolicyRead(page)));
  } catch (error) { return authFailure(error); }
}
