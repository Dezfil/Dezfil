import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { POST as queryRoute } from "@/app/api/query/route";
import { buildMcpFetchHandler } from "./handler";

/**
 * parity: the timeout is the same documented error for a UI caller
 * and a headless caller of the same lane. The MCP wire path is real — stock
 * client → /api/mcp handler → tool executor → the actual query route —
 * looped in-process, exactly as the adversarial suite drives it.
 */

const SLOW_SQL =
  "SELECT count(*) FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "assets.csv");
  await writeFile(src, "name,lon,lat\na,1,2\nb,3,4\n");
  await ingestFile(testAccountScope(), src, "assets.csv");

  const handler = buildMcpFetchHandler();
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const { pathname } = new URL(url);
      const request = input instanceof Request ? input : new Request(url, init);
      if (pathname === "/api/mcp") return handler.fetch(request);
      if (pathname === "/api/query") return queryRoute(request);
      throw new Error(`Unexpected self-call in test: ${pathname}`);
    }) as typeof fetch,
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_QUERY_TIMEOUT_S;
  await rm(dir, { recursive: true, force: true });
});

describe("query bounds parity", () => {
  it("MCP and the route report the identical coded timeout", async () => {
    process.env.DEZFIL_QUERY_TIMEOUT_S = "1";

    const client = new Client({ name: "parity", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL("http://localhost:3000/api/mcp"),
      ),
    );
    const result = await client.callTool({
      name: "run_sql",
      arguments: { sql: SLOW_SQL },
    });
    const text = (result.content as { type: string; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    const viaMcp = JSON.parse(text) as {
      error?: { code?: string; message?: string };
    };
    expect(result.isError).toBe(true);
    expect(viaMcp.error?.code).toBe("query_timeout");
    await client.close();

    const direct = await queryRoute(
      new Request("http://localhost:3000/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: SLOW_SQL }),
      }),
    );
    expect(direct.status).toBe(408);
    const body = (await direct.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("query_timeout");
    // Identical shape and identical copy — not merely the same class.
    expect(body.error.message).toBe(viaMcp.error?.message);
  }, 60_000);
});
