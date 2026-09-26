import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { GET as tablesRoute } from "@/app/api/tables/route";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { buildMcpFetchHandler } from "./handler";

/**
 * parity: an unexpected, non-coded failure reports the identical
 * documented internal shape to a headless MCP caller and a direct HTTP
 * caller — same code, byte-identical sentence, and no internals (paths,
 * engine text) on either wire. The MCP path is real: stock client →
 * /api/mcp handler → tool executor → the actual route, looped
 * in-process.
 */

vi.mock("@/lib/table-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/table-service")>();
  return {
    ...actual,
    listTablesWithSize: () =>
      Promise.reject(
        new Error(
          "SQLITE_CANTOPEN: unable to open database file at /data/dezfil/metadata.sqlite",
        ),
      ),
  };
});

beforeEach(() => {
  const handler = buildMcpFetchHandler();
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const { pathname } = new URL(url);
      const request = input instanceof Request ? input : new Request(url, init);
      if (pathname === "/api/mcp") return handler.fetch(request);
      if (pathname === "/api/tables") return tablesRoute(new Request("http://dezfil.test/api/tables"));
      throw new Error(`Unexpected self-call in test: ${pathname}`);
    }) as typeof fetch,
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("internal-500 parity", () => {
  it("MCP and the route report the identical documented internal shape", async () => {
    const client = new Client({ name: "parity", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL("http://localhost:3000/api/mcp"),
      ),
    );
    const result = await client.callTool({ name: "list_tables", arguments: {} });
    const text = (result.content as { type: string; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(result.isError).toBe(true);
    const viaMcp = JSON.parse(text) as {
      error?: { code?: string; message?: string };
    };
    expect(viaMcp.error?.code).toBe("internal");
    expect(viaMcp.error?.message).toBe(ERROR_CATALOGUE.internal);
    expect(text).not.toContain("/data");
    expect(text).not.toContain("metadata.sqlite");
    await client.close();

    const direct = await tablesRoute(new Request("http://dezfil.test/api/tables"));
    expect(direct.status).toBe(500);
    const body = (await direct.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("internal");
    // Identical shape and identical copy — not merely the same class.
    expect(body.error.message).toBe(viaMcp.error?.message);
    expect(JSON.stringify(body)).not.toContain("/data");
  }, 30_000);
});
