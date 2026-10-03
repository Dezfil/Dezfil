import { boundedMcpRequest } from "@/lib/api/bounded-handoff";
import { callMcpTool } from "./call";
import {
  createMcpHandler,
  McpServer,
  fromJsonSchema,
  ProtocolError,
} from "@modelcontextprotocol/server";
import { buildTools } from "@/lib/tools/tools";
import { selfBaseUrl } from "@/lib/self-url";

/**
 * The MCP face of the API (the documented surface served as MCP tools;
 * external agents bring their own model). Stateless: every request gets a
 * fresh server instance from the factory. Tool calls execute through the
 * product's own HTTP API, so MCP traffic is held to the same parity,
 * read-only SQL policy, and limits as every other client.
 */

export function buildMcpFetchHandler(fetchImpl?: typeof fetch) {
  const handler = createMcpHandler(({ requestInfo }) => {
    const server = new McpServer({ name: "dezfil", version: "0.1.0" });
    const baseUrl = selfBaseUrl(requestInfo);

    const tools = buildTools();
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: fromJsonSchema(
            tool.inputSchema as Parameters<typeof fromJsonSchema>[0],
          ),
          outputSchema: fromJsonSchema(tool.outputSchema! as Parameters<typeof fromJsonSchema>[0]),
          _meta: {
            "dezfil/confirmation": { policy: tool.confirm ? "required" : tool.confirmWhen ?? "none", ...tool.confirmation },
            "dezfil/effects": tool.effects,
            ...(tool.mcp!.repeatability ? { "dezfil/repeatability": tool.mcp!.repeatability } : {}),
          },
          annotations: {
            readOnlyHint: tool.effects.readOnly,
            destructiveHint: tool.mcp!.destructiveHint,
            openWorldHint: tool.mcp!.openWorldHint,
            ...(tool.mcp!.idempotentHint !== undefined ? { idempotentHint: tool.mcp!.idempotentHint } : {}),
          },
        },
        async (args) => {
          return callMcpTool(tool, (args ?? {}) as Record<string, unknown>, baseUrl, requestInfo?.signal, fetchImpl);
        },
      );
    }
    // The low-level call hook owns coded validation failures; registration
    // still supplies the exact schemas and metadata to the stock listing.
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    server.server.setRequestHandler("tools/call", async (request, context) => {
      const tool = byName.get(request.params.name);
      if (!tool) throw new ProtocolError(-32602, "Unknown tool.");
      const signal = requestInfo?.signal ? AbortSignal.any([requestInfo.signal, context.mcpReq.signal]) : context.mcpReq.signal;
      const result = await callMcpTool(tool, request.params.arguments ?? {}, baseUrl, signal, fetchImpl);
      return server.server.projectCallToolResult(result, tool.outputSchema as Parameters<typeof server.server.projectCallToolResult>[1]);
    });
    return server;
  });
  return { ...handler, async fetch(request: Request) {
    return handler.fetch(await boundedMcpRequest(request));
  } };
}
