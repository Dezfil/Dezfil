import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { instanceFetch, loopbackCredential } from "@/lib/auth/instance-fetch";
import { selfBaseUrl } from "@/lib/self-url";
import { buildMcpFetchHandler } from "@/lib/mcp/handler";

/**
 * MCP endpoint: JSON-RPC exchanges are POSTs in both protocol eras; the
 * handler is stateless (fresh server per request), so there are no session
 * streams to GET or DELETE.
 */


export async function POST(request: Request) {
  try {
    const context = requireRequestAuth(request);
    const transport = instanceFetch(selfBaseUrl(request), loopbackCredential(request, context));
    return privateResponse(await buildMcpFetchHandler(transport).fetch(request));
  } catch (error) { return authFailure(error); }
}
