import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildMcpFetchHandler } from "./handler";
import { buildTools } from "@/lib/tools/tools";

/**
 * Protocol-level interop: a stock MCP client speaks to our endpoint through
 * the real wire format (a general-purpose MCP client lists tools covering
 * the full journey). Network is looped in-process: the client's fetch goes
 * to the handler; the handler's self-calls to the API are served by a stub
 * that records them.
 */

const MCP_URL = "http://localhost:3000/api/mcp";

function loopFetch(
  apiStub: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const handler = buildMcpFetchHandler();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof Request ? input.url : String(input instanceof URL ? input.href : input);
    if (new URL(url).pathname === "/api/mcp") {
      const request =
        input instanceof Request ? input : new Request(url, init);
      return handler.fetch(request);
    }
    return apiStub(url, init);
  }) as typeof fetch;
}

async function connectedClient() {
  const client = new Client({ name: "interop-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport);
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP endpoint", () => {
  it("a stock client connects and lists every tool with a schema", async () => {
    vi.stubGlobal(
      "fetch",
      loopFetch(() => new Response("unexpected API call", { status: 500 })),
    );
    const client = await connectedClient();
    const { tools } = await client.listTools();

    const expected = buildTools()
      .map((t) => t.name)
      .sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
    await client.close();
  });

  it("a tool call executes against the product's own API", async () => {
    const seen: { url: string; method?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      loopFetch((url, init) => {
        seen.push({ url, method: init?.method });
        return new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const client = await connectedClient();
    const result = await client.callTool({
      name: "check_health",
      arguments: {},
    });

    expect(seen).toEqual([
      { url: "http://127.0.0.1:3000/api/health", method: "GET" },
    ]);
    expect(result.isError ?? false).toBe(false);
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0].text)).toEqual({ status: "ready" });
    await client.close();
  });

  it("API errors surface as isError tool results with the coded body", async () => {
    vi.stubGlobal(
      "fetch",
      loopFetch(
        () =>
          new Response(
            JSON.stringify({
              error: { code: "not_found", message: "No such map." },
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = await connectedClient();
    const result = await client.callTool({
      name: "get_map",
      arguments: { id: "missing" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0].text).error.code).toBe("not_found");
    await client.close();
  });
});
