import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { createLegacyStore, legacy, legacyFiles, legacyRows, readLegacyPassword, assertLegacyOwners } from "../../../scripts/legacy-store-fixture.mjs";
import { provisionJourney } from "../../../scripts/journey-auth.mjs";
import { journeyApi } from "../../../scripts/journey-http.mjs";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { laneSettled } from "@/lib/operations/lane";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { seedOwnership, verifyOwnership } from "../../../scripts/ownership-journey.mjs";

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

async function prepareRoutes() {
  directory = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "journey-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); vi.stubEnv("PORT", "3387");
  closeMetadataDb(); resetQueryInstance();
  let widenMaps = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = socketRequest(new Request(input, init));
    const pathname = new URL(request.url).pathname;
    for (const route of routes) {
      const match = pathname.match(route.pattern);
      if (!match) continue;
      const handler = (await route.load())[request.method];
      if (!handler) throw new Error(`No handler for ${request.method} ${pathname}`);
      const response = await handler(request, { params: Promise.resolve(Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]))) });
      if (widenMaps && pathname === "/api/maps" && request.method === "GET" && response.ok) {
        return Response.json([...await response.json(), { id: "foreign-map" }]);
      }
      return response;
    }
    throw new Error(`Unexpected journey request: ${request.method} ${pathname}`);
  });
  return () => { widenMaps = true; };
}
const base = "http://127.0.0.1:3387";
it("seeds the legacy store in a standalone Node process without bundler resolution", async () => {
  directory = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR!, "standalone-seed-"));
  expect(execFileSync(process.execPath, ["--input-type=module", "-e",
    "import { createLegacyStore } from './scripts/legacy-store-fixture.mjs'; await createLegacyStore(process.argv[1]); console.log('seeded');", directory,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 }).trim()).toBe("seeded");
});

it("exercises the ownership journey through real route and MCP handlers, including a widened-list negative control", async () => {
  const widenMaps = await prepareRoutes();
  const state = await seedOwnership(base);
  await expect(seedOwnership(base)).rejects.toThrow("seed requires an empty scratch instance");
  expect(await verifyOwnership(base, state)).toEqual({ accounts: 3, comparisons: 87, concurrentQueries: 12 });
  const owners = () => Object.fromEntries(["maps", "data_tables", "recipes", "projects"].map(table =>
    [table, metadataDb().prepare(`SELECT id, owner_id FROM ${table} ORDER BY id`).all()]));
  const before = owners();
  closeMetadataDb(); resetQueryInstance();
  expect(owners()).toEqual(before);
  expect(await verifyOwnership(base, state)).toEqual({ accounts: 3, comparisons: 87, concurrentQueries: 12 });
  widenMaps();
  await expect(verifyOwnership(base, state)).rejects.toThrow("map listing stays owner-only");
}, 60_000);


it("adopts a populated legacy store through setup and retains its owners and sessions across reopen", async () => {
  await prepareRoutes();
  await createLegacyStore(directory);
  const source = new Database(path.join(directory, "metadata.sqlite"));
  const before = legacyRows(source); source.close();
  const files = await legacyFiles(directory);
  const anonymous = journeyApi(base);
  expect((await anonymous("GET", "/api/auth/entry")).json.setupRequired).toBe(true);
  expect(legacyRows(metadataDb())).toEqual(before);
  assertLegacyOwners(metadataDb(), null);
  expect((await anonymous("GET", "/api/maps")).status).toBe(401);
  expect((await anonymous("GET", `/api/published/${legacy.token}`)).json.layers[0].render.geojson.features).toHaveLength(1);
  const first = await provisionJourney(base);
  assertLegacyOwners(metadataDb(), first.account.id);
  expect(legacyRows(metadataDb())).toEqual(before);
  expect(await readLegacyPassword(directory, metadataDb())).toBe(legacy.password);
  const api = journeyApi(base, { token: first.token });
  const invited = await api("POST", "/api/users", { body: { name: "Second admin", email: "second@example.test", isAdmin: true } });
  expect(invited.status).toBe(201);
  const secret = new URLSearchParams(new URL(invited.json.signInUrl).hash.slice(1)).get("secret");
  const password = "field notebooks at dawn";
  const redeemed = await fetch(base + "/api/auth/redeem", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ secret, password }) });
  expect(redeemed.status).toBe(200);
  const second = await provisionJourney(base, { name: "Second admin", email: "second@example.test", password });
  const admin = journeyApi(base, { token: second.token });
  expect((await admin("PATCH", `/api/users/${first.account.id}`, { body: { isAdmin: false } })).status).toBe(200);
  closeMetadataDb(); resetQueryInstance();
  assertLegacyOwners(metadataDb(), first.account.id);
  expect(legacyRows(metadataDb())).toEqual(before);
  for (const credential of [{ token: first.token }, { cookie: first.cookie }]) {
    const owner = journeyApi(base, credential);
    expect((await owner("GET", "/api/account")).json.account.id).toBe(first.account.id);
    for (const endpoint of [`/api/maps/${legacy.map}`, `/api/tables/${legacy.table}`, `/api/projects/${legacy.project}`, `/api/recipes/${legacy.workflow}`, "/api/operations/runs/legacy-job"]) {
      expect((await owner("GET", endpoint)).status, endpoint).toBe(200);
      expect((await admin("GET", endpoint)).status, endpoint).toBe(404);
    }
    expect((await owner("POST", "/api/query", { body: { sql: `SELECT name, value FROM ${legacy.table}` } })).json.preview).toEqual([{ name: "station", value: 7 }]);
    const exported = await owner("GET", `/api/tables/${legacy.table}/export?format=csv`, { raw: true });
    expect(exported.status).toBe(200); expect(await (exported as Response).text()).toContain("station");
  }
  expect((await admin("GET", "/api/connections/postgis")).json).toEqual([]);
  const hidden = await admin("POST", "/api/query", { body: { sql: `SELECT * FROM ${legacy.table}` } });
  expect(hidden.status).toBe(400);
  expect(hidden).toEqual(await admin("POST", "/api/query", { body: { sql: "SELECT * FROM never_imported" } }));
  expect((await anonymous("GET", `/api/published/${legacy.token}`)).json.layers[0].render.geojson.features).toHaveLength(1);
  const afterFiles = await legacyFiles(directory);
  expect(afterFiles["tables/legacy.parquet"]).toBe(files["tables/legacy.parquet"]);
  expect(afterFiles["secret.key"]).toBe(files["secret.key"]);
  expect(await readLegacyPassword(directory, metadataDb())).toBe(legacy.password);
});
