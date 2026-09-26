import { ApiError, errorResponse } from "@/lib/api/errors";
import { assistantPolicyRead } from "@/lib/assistant/policy-read";

/** The page action policy, read: what a page admits and
 * what its runs are offered by default, so a headless client can ask
 * before it sends. A documented operation, excluded from tool generation. */
export async function GET(request: Request) {
  try {
    const page = new URL(request.url).searchParams.get("page");
    if (page !== "builder" && page !== "sql" && page !== "workflow") {
      throw new ApiError("invalid_request", 'The "page" query parameter must be builder, sql or workflow.', 400);
    }
    return Response.json(assistantPolicyRead(page), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
