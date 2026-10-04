import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { laneSettled } from "@/lib/operations/lane";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { assistantWire, seedSharing, verifySharing } from "../../../scripts/sharing-journey.mjs";

/**
 * The sharing journey through the real route, MCP and assistant handlers,
 * with no listening instance: requests to the journey's origin are answered
 * by the route modules; the scripted model wire is a real loopback server the
 * assistant's provider client reaches as it would in production. Reopening the
 * store and resetting the engine stand in for a server replacement here; the
 * process and container replacement run the same script against an instance.
 */
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

const base = "http://127.0.0.1:3388";
let directory: string;
let wire: Awaited<ReturnType<typeof assistantWire>> | undefined;
afterEach(async () => {
  await wire?.close(); wire = undefined;
  await laneSettled(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function prepare() {
  directory = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "sharing-journey-"));
  wire = await assistantWire(0);
  vi.stubEnv("DEZFIL_DATA_DIR", directory); vi.stubEnv("PORT", "3388");
  vi.stubEnv("DEZFIL_AI_PROVIDER", "openai"); vi.stubEnv("OPENAI_API_KEY", "scripted-wire");
  vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${wire.port}/v1`);
  closeMetadataDb(); resetQueryInstance();
  // A seeded leak for the negative control: the non-member's read of the
  // shared map answers as if they reached it.
  let leak = false;
  const native = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = new Request(input, init);
    if (new URL(raw.url).origin !== base) return native(raw);
    const request = socketRequest(raw);
    const pathname = new URL(request.url).pathname;
    for (const route of routes) {
      const match = pathname.match(route.pattern);
      if (!match) continue;
      const handler = (await route.load())[request.method];
      if (!handler) throw new Error(`No handler for ${request.method} ${pathname}`);
      const response = await handler(request, { params: Promise.resolve(Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]))) });
      if (leak && request.method === "GET" && /^\/api\/maps\/[^/]+$/.test(pathname) && response.status === 404 && !pathname.endsWith("never-created-resource")) {
        return Response.json({ id: pathname.split("/").at(-1), name: "Leaked" });
      }
      return response;
    }
    throw new Error(`Unexpected journey request: ${request.method} ${pathname}`);
  });
  return () => { leak = true; };
}

it("shares a project with a Viewer and an Editor through real route, MCP and assistant handlers, with a seeded-leak negative control", async () => {
  const seedLeak = await prepare();
  const state = await seedSharing(base);
  await expect(seedSharing(base)).rejects.toThrow("seed requires an empty scratch instance");
  const first = await verifySharing(base, state, { wire });
  expect(first).toMatchObject({ accounts: 5, transports: { console: 16, mcp: 8, assistant: 8 }, concurrentQueries: 48 });
  expect(first.departures).toMatchObject({ session: 4, token: 4, mcp: 4, assistant: 4, frozen: 8, readded: 16 });
  expect(first.comparisons).toBeGreaterThanOrEqual(30);
  // Every refusal compared carries its body, and the permission refusal is one sentence everywhere.
  const bodies = [...state.seedRefusals, ...first.refusals];
  expect(bodies.every((refusal: { body: unknown }) => refusal.body !== null && typeof refusal.body === "object")).toBe(true);
  expect(new Set(bodies.filter((r: { status: number }) => r.status === 403).map((r: { body: unknown }) => JSON.stringify(r.body))).size).toBe(1);
  const stamps = () => Object.fromEntries(["maps", "data_tables", "recipes", "projects", "project_people"].map(table =>
    [table, metadataDb().prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()]));
  const before = stamps();
  closeMetadataDb(); resetQueryInstance();
  expect(stamps()).toEqual(before);
  expect(await verifySharing(base, state, { wire })).toMatchObject({ comparisons: first.comparisons, transports: first.transports });
  seedLeak();
  await expect(verifySharing(base, state, { wire })).rejects.toThrow(/the owner's unfiled map/);
}, 240_000);
