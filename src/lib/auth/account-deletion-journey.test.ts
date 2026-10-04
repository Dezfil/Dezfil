import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { metadataDb, closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { laneSettled } from "@/lib/operations/lane";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { provisionJourney } from "../../../scripts/journey-auth.mjs";
import { journeyApi } from "../../../scripts/journey-http.mjs";
import { deletionFixture } from "../../../scripts/deletion-journey-fixture.mjs";
import { assertErased, scanStore, writeProofFile } from "../../../scripts/deletion-journey-store.mjs";
import { deleteOriginal } from "../../../scripts/deletion-recovery-checks.mjs";
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const modules = import.meta.glob("/src/app/api/**/route.ts") as Record<string, () => Promise<Record<string, Handler>>>;
const routes = Object.entries(modules).map(([file, load]) => {
  const keys: string[] = [];
  const pattern = file.replace("/src/app", "").replace("/route.ts", "").split("/").map(part => {
    if (part.startsWith("[")) { keys.push(part.slice(1, -1)); return "([^/]+)"; } return part;
  }).join("/");
  return { pattern: new RegExp(`^${pattern}$`), keys, load };
}).sort((a, b) => a.keys.length - b.keys.length);
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string;
afterEach(async () => {
  await laneSettled(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("populates the outside journey's real stores and detects erased bytes and foreign cards before closing SQLite", async () => {
  directory = await mkdtemp(path.join(root, "journey-fixture-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory); vi.stubEnv("PORT", "3403"); closeMetadataDb(); resetQueryInstance();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = socketRequest(new Request(input, init));
    const pathname = new URL(request.url).pathname;
    for (const route of routes) {
      const match = pathname.match(route.pattern); if (!match) continue;
      const handler = (await route.load())[request.method]; if (!handler) throw new Error(`No handler: ${request.method} ${pathname}`);
      return handler(request, { params: Promise.resolve(Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]))) });
    }
    throw new Error(`Unexpected fixture route: ${pathname}`);
  });
  const base = "http://127.0.0.1:3403", admin = await provisionJourney(base), api = journeyApi(base, admin);
  const fixture = await deletionFixture(base, admin, directory, metadataDb());
  await deleteOriginal((method: string, route: string, body?: object) => api(method, route, { body }), { id: fixture.target.id, email: fixture.email });
  expect(() => assertErased(directory, fixture.ledger)).not.toThrow();
  expect(metadataDb().prepare("SELECT * FROM maps WHERE id=?").get(fixture.controlMap.id)).toEqual(fixture.controlRow);
  const keep = journeyApi(base, fixture.control);
  const rendered = await keep("GET", `/api/layers/${fixture.layers.foreign}/render`);
  expect(rendered.json).toMatchObject({ ok: false, error: { message: `The dataset "${fixture.target.sqlName}.same" is not available to you.` } });
  const workflow = await keep("GET", `/api/recipes/${fixture.survivorWorkflow.id}`);
  expect(workflow.json.recipe.steps[0].missingInputs).toEqual(expect.arrayContaining([expect.objectContaining({ tableId: `missing:${fixture.target.sqlName}.same`, tableName: `${fixture.target.sqlName}.same` })]));
}, 60000);
it("finds a planted sentinel across a scan chunk boundary and in an otherwise unlisted file", async () => {
  directory = await mkdtemp(path.join(root, "scan-ledger-"));
  writeProofFile(directory, "new-store/bytes", "x".repeat(65532) + "boundary-sentinel");
  expect(scanStore(directory, ["boundary-sentinel"])).toEqual({ "boundary-sentinel": ["new-store/bytes"] });
});
