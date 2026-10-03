import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { testAccountRequest } from "@/lib/test-support/accounts";
import { authFailure } from "@/lib/auth/http";
import { buildMcpFetchHandler } from "./handler";
import { mcpBodyControl, maximumBase64File } from "../../../scripts/mcp-body-control.mjs";
import { POST as upload } from "@/app/api/tables/route";
import { POST as query } from "@/app/api/query/route";
it("imports one byte below the measured stock-client envelope ceiling with every row", async () => {
  const dir = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "mcp-body-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); closeMetadataDb(); resetQueryInstance();
  try {
    const api: typeof fetch = async (input, init) => {
      const req = testAccountRequest(new Request(input, init));
      if (new URL(req.url).pathname === "/api/tables") return upload(req);
      if (new URL(req.url).pathname === "/api/query") return query(req);
      throw new Error("Unexpected internal operation " + req.url);
    };
    const handler = buildMcpFetchHandler(api);
    const result = await mcpBodyControl("http://instance.test", {}, async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await handler.fetch(new Request(input, init)); } catch (error) { return authFailure(error); }
    });
    expect(result).toMatchObject({ emptyEnvelopeBytes: 138, maximumFileBytes: 12_582_807, fileBytes: 12_582_806, wireBytes: 16_777_214, rows: 12_288 });
    expect(maximumBase64File(138)).toBe(12_582_807);
  } finally { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
});
