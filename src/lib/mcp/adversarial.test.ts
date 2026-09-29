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
 * The read-only adversarial suite, driven through MCP tools (MCP enforces
 * the same read-only SQL policy as the API; the adversarial suite passes
 * when driven through MCP). The wire path is real — stock client → /api/mcp
 * handler → tool executor → the actual query route — looped in-process.
 */

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
  await rm(dir, { recursive: true, force: true });
});

async function connectedClient() {
  const client = new Client({ name: "adversary", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp")),
  );
  return client;
}

async function runSql(client: Client, sql: string) {
  const result = await client.callTool({ name: "run_sql", arguments: { sql } });
  const text = (result.content as { type: string; text: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  return { error: result.isError === true, body: JSON.parse(text) };
}

describe("read-only enforcement through MCP", () => {
  it("rejects every mutating category as an isError tool result, data unchanged", async () => {
    const client = await connectedClient();
    const attempts = [
      "INSERT INTO assets VALUES ('x', 9, 9)",
      "UPDATE assets SET name = 'p0wned'",
      "DELETE FROM assets",
      "CREATE TABLE exfil AS SELECT * FROM assets",
      "DROP VIEW assets",
      "ALTER TABLE assets ADD COLUMN c INT",
      "SET memory_limit = '100TB'",
      "PRAGMA memory_limit = '100TB'",
      "INSTALL httpfs",
      "LOAD httpfs",
      "ATTACH '/tmp/evil.db' AS evil",
      "COPY assets TO '/tmp/exfil.csv'",
      "EXPORT DATABASE '/tmp/exfil'",
      "/* comment */ DELETE FROM assets",
      "SELECT 1; DROP VIEW assets",
      "begin transaction",
    ];
    for (const sql of attempts) {
      const r = await runSql(client, sql);
      expect(r.error, sql).toBe(true);
      expect(r.body?.error?.code, sql).toBe("sql_rejected");
    }

    const check = await runSql(client, "SELECT count(*) AS n FROM assets");
    expect(check.error).toBe(false);
    expect(Number(check.body.preview[0].n)).toBe(2);
    await client.close();
  });

  it("fences filesystem escapes identically through MCP", async () => {
    const client = await connectedClient();
    for (const sql of [
      "SELECT * FROM read_csv('/etc/hosts')",
      "SELECT * FROM glob('/etc/*')",
    ]) {
      const r = await runSql(client, sql);
      expect(r.error, sql).toBe(true);
      expect(r.body?.error?.code, sql).toBe("sql_error");
    }
    await client.close();
  });
});
