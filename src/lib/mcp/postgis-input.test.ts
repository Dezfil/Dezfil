import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
const io = vi.hoisted(() => ({ resolve: vi.fn(), lookup: vi.fn(), run: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/duckdb", () => ({
  withConnection: async (work: (conn: DuckDBConnection) => Promise<unknown>) =>
    work({ run: io.run, runAndReadAll: io.read } as unknown as DuckDBConnection),
}));
vi.mock("@/lib/net/egress", async (original) => {
  const actual = await original<typeof import("@/lib/net/egress")>();
  return { ...actual, resolveAllowed: (host: string) => { io.resolve(host); return actual.resolveAllowed(host, io.lookup); } };
});
import { POST } from "@/app/api/connections/postgis/route";
import { PATCH } from "@/app/api/connections/postgis/[id]/route";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { insertConnection, recordConnectionCheck } from "@/lib/metadata/connections";
import { resetSecretKeyCache } from "@/lib/secrets";
import { testClient } from "./test-client";
const rows = () => metadataDb().prepare("SELECT * FROM pg_connections ORDER BY id").all();
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(process.cwd(), ".tmp-mcp-postgis-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("DEZFIL_EGRESS_ALLOWLIST", "");
  closeMetadataDb(); resetSecretKeyCache();
  io.resolve.mockReset(); io.lookup.mockReset().mockResolvedValue([{ address: "2001:4860:4860::8888", family: 6 }]);
  io.run.mockReset().mockResolvedValue(undefined);
  io.read.mockReset().mockResolvedValue({ getRowObjects: () => [{ v: "fixture-version" }] });
});
afterEach(() => { vi.unstubAllGlobals(); closeMetadataDb(); resetSecretKeyCache(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
for (const operation of ["create", "update"] as const) {
  for (const form of ["uri", "libpq"] as const) {
    it(`${operation} ${form} retains coded refusal and secret-free copy through real MCP and routes`, async () => {
      if (operation === "update") {
        insertConnection(testAccountScope(), { id: "saved", name: "Prior", host: "old.example.org", port: 5432, database: "prior", username: "prior", password: "stored-mcp-secret", ssl: false });
        recordConnectionCheck(testAccountScope(), "saved", { outcome: "failing", error: "Prior failure.", checkedAt: "2026-01-01T00:00:00.000Z" });
      }
      const before = rows();
      const dispatched: string[] = [];
      const client = await testClient(async (request) => {
        const pathname = new URL(request.url).pathname;
        dispatched.push(`${request.method} ${pathname}`);
        const authenticated = testAccountRequest(request);
        if (request.method === "POST" && pathname === "/api/connections/postgis") return POST(authenticated);
        if (request.method === "PATCH" && pathname === "/api/connections/postgis/saved") return PATCH(authenticated, { params: Promise.resolve({ id: "saved" }) });
        throw new Error("Unexpected route dispatch");
      });
      const string = (parameter: string, value: string) => form === "uri"
        ? `postgres://reader:mcp-distinctive-password@mcp-private-host.example.org/gis?${parameter}=${encodeURIComponent(value)}`
        : `host=mcp-private-host.example.org dbname=gis user=reader password=mcp-distinctive-password ${parameter}='${value}'`;
      const args = { name: "Candidate", ...(operation === "update" ? { id: "saved" } : {}) };
      try {
        for (const [parameter, value] of [["channel_binding", "require"], ["sslrootcert", "/distinctive/mcp-certificate.pem"], ["oauth_scope", "distinctive-mcp-scope"]]) {
          const result = await client.callTool({ name: `${operation}_postgis_connection`, arguments: { ...args, url: string(parameter, value), host: "override.example.org", password: "mcp-override-secret", ssl: false } });
          const expected = { error: { code: "invalid_request", message: `This connection string uses the unsupported protection parameter ${parameter}; Dezfil supports connection fields and SSL required or not required.` } };
          expect.soft(result.isError).toBe(true);
          const content = result.content as { type: string; text: string }[];
          expect.soft(content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
          expect.soft(result.structuredContent).toEqual({ result: expected, history: null });
          for (const secret of ["mcp-distinctive-password", "mcp-override-secret", "mcp-private-host.example.org", "/distinctive/mcp-certificate.pem", "distinctive-mcp-scope"]) {
            expect.soft(JSON.stringify(content)).not.toContain(secret);
            expect.soft(JSON.stringify(result.structuredContent)).not.toContain(secret);
          }
          expect.soft(rows()).toEqual(before);
          expect.soft(io.resolve).not.toHaveBeenCalled(); expect.soft(io.lookup).not.toHaveBeenCalled();
          expect.soft(io.run).not.toHaveBeenCalled(); expect.soft(io.read).not.toHaveBeenCalled();
        }
        expect(dispatched).toEqual(Array(3).fill(operation === "create" ? "POST /api/connections/postgis" : "PATCH /api/connections/postgis/saved"));
        const accepted = await client.callTool({ name: `${operation}_postgis_connection`, arguments: { ...args, url: string("channel_binding", "prefer") } });
        expect(accepted.isError).toBe(false);
        expect(io.resolve).toHaveBeenCalledWith("mcp-private-host.example.org");
        expect(io.lookup).toHaveBeenCalled(); expect(io.read).toHaveBeenCalled();
        expect(io.run.mock.calls.some(([sql]) => String(sql).includes("hostaddr=''2001:4860:4860::8888''"))).toBe(true);
      } finally { await client.close(); }
    });
  }
}
