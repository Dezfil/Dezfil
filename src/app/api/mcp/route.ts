import { buildMcpFetchHandler } from "@/lib/mcp/handler";

/**
 * MCP endpoint: JSON-RPC exchanges are POSTs in both protocol eras; the
 * handler is stateless (fresh server per request), so there are no session
 * streams to GET or DELETE.
 */
const handler = buildMcpFetchHandler();

export async function POST(request: Request) {
  return handler.fetch(request);
}
