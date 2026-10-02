import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { authenticatedRoute } from "@/lib/assistant/testing/account";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { editStep } from "@/lib/metadata/owned-recipes";
import { readDocumentRevision } from "@/lib/metadata/revisions";
import { fileRecipe } from "@/lib/metadata/projects";
import { listCascades } from "@/lib/metadata/cascades";
import { cascadeSettled } from "@/lib/operations/cascade";
import { laneSettled } from "@/lib/operations/lane";
import { shareProject } from "@/lib/test-support/sharing";
import { assistantRuns } from "./runs";
import { pendingActions } from "./pending";
import { stubProvider, type ScriptEntry } from "./providers/stub";
import type { ModelProvider } from "./provider";
import type { AssistantEvent } from "./loop";
import { POST as reserveHandler } from "@/app/api/assistant/runs/route";
import { POST as messageHandler } from "@/app/api/assistant/messages/route";
import { GET as pendingHandler } from "@/app/api/assistant/pending/route";
import { GET as recipeGet } from "@/app/api/recipes/[id]/route";
import { POST as runRecipe } from "@/app/api/recipes/[id]/runs/route";
import { GET as catalogue } from "@/app/api/catalogue/tables/route";

/**
 * A pending confirmation is a question, not a permission: the action it
 * parks is checked again, for permission and reach, when it resumes.
 *
 * Ada owns project P and workflow W filed there; the fixture account is an
 * editor of P and asks the assistant to run W, which parks for confirmation.
 * Demoted to viewer, or removed from P, while the action waits, the approval
 * runs nothing: the resumed call is refused with the shape the caller now
 * stands in, and no run is recorded.
 */
const reserve = authenticatedRoute(reserveHandler);
const message = authenticatedRoute(messageHandler);
const pending = authenticatedRoute(pendingHandler);

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));
const origin = "http://localhost:3201";
let dir: string;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, body?: unknown) => testAccountRequest(new Request(origin + url, { method: body === undefined ? "GET" : "POST",
  ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
async function dispatch(request: Request): Promise<Response> {
  request = testAccountRequest(request);
  const p = new URL(request.url).pathname.split("/");
  if (p[2] === "catalogue") return catalogue(request);
  if (p[2] === "recipes" && p.length === 4) return recipeGet(request, params(p[3]));
  if (p[2] === "recipes" && p[4] === "runs") return runRecipe(request, params(p[3]));
  throw new Error(`Unexpected test route: ${request.method} ${request.url}`);
}
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.env.DEZFIL_DATA_DIR ?? process.cwd(), "confirm-reach-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent");
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); pendingActions.resetForTests();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => dispatch(input instanceof Request ? input : new Request(String(input), init)));
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });

const tool = (name: string, args: Record<string, unknown>) => ({ id: randomUUID(), name, args });
const reply = (...toolCalls: ReturnType<typeof tool>[]) => ({ text: "", toolCalls });
async function events(response: Response): Promise<AssistantEvent[]> { expect(response.status).toBe(200); return (await response.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

it.each([
  ["demoted to viewer", "UPDATE project_people SET role = 'viewer' WHERE account_id = 'test-account'", "forbidden"],
  ["removed from the project", "DELETE FROM project_people WHERE account_id = 'test-account'", "not_found"],
  ["left as an editor", null, null],
  ["step SQL changed by another editor", "definition", "stale_revision"],
])("checks the caller again when the confirmation resumes: %s", async (_label, change, code) => {
  testAccountScope(undefined, "test-account");
  const ada = testAccountScope(undefined, "ada");
  const bo = testAccountScope(undefined, "bo");
  shareProject("ada", "P", [["test-account", "editor"], ["bo", "editor"]]);
  const W = createRecipe(ada, "Shared workflow").id;
  fileRecipe(W, "P");
  const first = addStep(W, { operation: "sql_step", parameters: { sql: "SELECT 1 AS v", name: "one" } });
  addStep(W, { operation: "sql_step", parameters: { sql: "SELECT 2 AS v", name: "two" } });

  factory.provider = stubProvider([reply(tool("run_recipe", { id: W })), reply()] as ScriptEntry[]);
  const id = (await (await reserve()).json()).id as string;
  await events(await message(req("/api/assistant/messages", { runId: id, message: "Run it" })));
  const parked = ((await (await pending()).json()).pending as { id: string; runId: string; tool: string }[]).find((p) => p.runId === id);
  expect(parked).toMatchObject({ tool: "run_recipe" });

  if (change === "definition") editStep(bo, first.id, { sql: "SELECT 9 AS v", name: "one" }, undefined, undefined,
    { expectedRevision: readDocumentRevision({ kind: "workflow", id: W })!.editRevision });
  else if (change) metadataDb().prepare(change).run();
  const resumed = await events(await message(req("/api/assistant/messages", { resolution: { pending: parked!.id, approved: true } })));
  for (const run of listCascades(W)) { await cascadeSettled(run.id); await laneSettled(); }
  if (code) {
    expect(resumed).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "run_recipe", ok: false, body: { error: expect.objectContaining({ code }) } }));
    expect(listCascades(W)).toHaveLength(0);
  } else {
    // The control: still an editor, the approval starts the run.
    expect(resumed).toContainEqual(expect.objectContaining({ type: "tool_result", tool: "run_recipe", ok: true }));
    const runs = listCascades(W);
    expect(runs).toHaveLength(1);
    await cascadeSettled(runs[0].id); await laneSettled();
  }
});
