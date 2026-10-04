import path from "node:path";
import { DuckDBConnection } from "@duckdb/node-api";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { laneSettled } from "@/lib/operations/lane";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { exerciseProjectDepartures } from "../../../scripts/sharing-departures.mjs";
import { seedSharing } from "../../../scripts/sharing-journey.mjs";

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const modules = import.meta.glob("/src/app/api/**/route.ts") as Record<string, () => Promise<Record<string, Handler>>>;
const routes = Object.entries(modules).map(([file, load]) => {
  const keys: string[] = [];
  const pattern = file.replace("/src/app", "").replace("/route.ts", "").split("/").map(part => {
    if (part.startsWith("[")) { keys.push(part.slice(1, -1)); return "([^/]+)"; }
    return part;
  }).join("/");
  return { pattern: new RegExp(`^${pattern}$`), keys, load };
}).sort((a, b) => a.keys.length - b.keys.length);
let directory: string;
afterEach(async () => {
  await laneSettled(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("seeds shared edits through reached reads and the real handlers without a listening transport", async () => {
  if (!process.env.DEZFIL_DATA_DIR) throw new Error("DEZFIL_DATA_DIR must name a scratch directory");
  directory = await mkdtemp(`${process.env.DEZFIL_DATA_DIR}/sharing-seed-`);
  vi.stubEnv("DEZFIL_DATA_DIR", directory); vi.stubEnv("PORT", "3388");
  closeMetadataDb(); resetQueryInstance();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = socketRequest(new Request(input, init));
    expect(new URL(request.url).origin).toBe("http://127.0.0.1:3388");
    const pathname = new URL(request.url).pathname;
    for (const route of routes) {
      const match = pathname.match(route.pattern);
      if (!match) continue;
      const handler = (await route.load())[request.method];
      if (!handler) throw new Error(`No handler for ${request.method} ${pathname}`);
      return handler(request, { params: Promise.resolve(Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]))) });
    }
    throw new Error(`Unexpected request: ${request.method} ${pathname}`);
  });
  const state = await seedSharing("http://127.0.0.1:3388");
  expect(state.ids.layers).toHaveProperty("editor");
  expect(state.seedRefusals.length).toBeGreaterThan(20);
  const originalRun = DuckDBConnection.prototype.run;
  const originalRead = DuckDBConnection.prototype.runAndReadAll;
  try {
    await import("../../../scripts/sharing-leave-observer.mjs");
    expect(await exerciseProjectDepartures("http://127.0.0.1:3388", state, { holdDirectory: path.join(directory, ".leave-probe") })).toMatchObject({
      session: 4, token: 4, mcp: 4, assistant: 0, frozen: 6, readded: 12,
      held: { sessionPrivateOutput: "confirmed", tokenRefusedOutput: "confirmed" },
    });
  } finally {
    DuckDBConnection.prototype.run = originalRun;
    DuckDBConnection.prototype.runAndReadAll = originalRead;
  }
}, 120_000);
