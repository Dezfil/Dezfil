import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createRecipe, addStep } from "@/lib/metadata/recipes";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { buildTools } from "@/lib/tools/tools";
import type { AssistantContext } from "./context";
import type { ModelProvider } from "./provider";
import { stubProvider } from "./providers/stub";
import { admittedTools, policyFor } from "./policy";
import { pendingActions } from "./pending";
import { assistantRuns } from "./runs";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";

/**
 * The policy read: for each page the documented read answers with the
 * policy, the admitted operations and the default offer, equal to what
 * the message route actually offers a run under that page (read from the
 * stub's captured exchange) and what the policy admits (read from the
 * policy module); it generates no tool and the exclusion inventory moved
 * by exactly one.
 */

const factory = vi.hoisted(() => ({ provider: null as ModelProvider | null }));
vi.mock("@/lib/assistant/factory", () => ({ createProvider: () => factory.provider }));

const origin = "http://localhost:3207";
let dir: string;
beforeEach(async () => {
  assistantRuns.resetForTests(); pendingActions.resetForTests();
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-policyread-test-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-never-sent"); vi.stubEnv("PORT", "3207");
  closeMetadataDb(); resetQueryInstance();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => dispatchAssistantTestRoute(input instanceof Request ? input : new Request(String(input), init)));
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

const api = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  dispatchAssistantTestRoute(new Request(origin + url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
const sorted = (names: string[]) => [...names].sort();

describe("the policy read equals what the route offers and admits", () => {
  it("per page, read independently", async () => {
    const csv = path.join(dir, "facts.csv"); await writeFile(csv, "city,lon,lat,value\nBerlin,13.4,52.5,4\n");
    await ingestFile(testAccountScope(), csv, "facts.csv");
    const map = createMap(testAccountScope(), "Read map");
    const recipe = createRecipe(testAccountScope(), "Workflow");
    const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT 1 AS value", name: "output" } });
    const contexts: Record<string, AssistantContext> = {
      builder: { page: "builder", mapId: map.id, selectedLayerId: null },
      sql: { page: "sql", draft: "", selection: null, lastExecution: null },
      workflow: { page: "workflow", recipeId: recipe.id, selectedStepId: step.id, lastRunId: null },
    };
 // Under the measured default (the subset, the live arm of) and under the configured full mode
 // alike, the read equals the route.
    for (const mode of ["subset", "full"] as const) {
      vi.stubEnv("DEZFIL_ASSISTANT_OFFER", mode === "subset" ? "" : "full");
      for (const page of ["builder", "sql", "workflow"] as const) {
        const read = await (await api(`/api/assistant/policy?page=${page}`)).json() as { page: string; policy: string; offer: string; admitted: string[]; offered: string[]; discovery: boolean };
        const provider = stubProvider([{ text: "Captured", toolCalls: [] }]); factory.provider = provider;
        const runId = (await (await api("/api/assistant/runs", {}, "POST")).json()).id as string;
        expect((await api("/api/assistant/messages", { runId, message: "Work", context: contexts[page] })).status).toBe(200);
        const offeredByRoute = sorted(provider.recording.exchanges[0].options.tools.map((t) => t.name));
        expect(read.page).toBe(page);
        expect(read.policy).toBe(policyFor(contexts[page]));
        expect(read.offer).toBe(mode);
        expect(sorted(read.offered), `${mode} on ${page}`).toEqual(offeredByRoute);
        expect(sorted(read.admitted)).toEqual(sorted(admittedTools(policyFor(contexts[page])).map((t) => t.name)));
        expect(read.discovery).toBe(mode === "subset");
        if (mode === "subset") expect(read.offered).toContain("find_operations"); else expect(read.offered).not.toContain("find_operations");
        for (const name of read.offered) if (name !== "find_operations") expect(read.admitted).toContain(name);
      }
    }
    const bad = await api("/api/assistant/policy?page=settings");
    expect(bad.status).toBe(400);
  });
});

describe("the policy read is no tool", () => {
  it("is documented, excluded from tool generation, and the inventory moved by one", () => {
    const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { "x-tool"?: string | false }>> };
    expect(doc.paths["/api/assistant/policy"].get["x-tool"]).toBe(false);
    expect(buildTools().some((t) => t.path === "/api/assistant/policy")).toBe(false);
    // The map check and image read, plus authenticated settings read/update,
    // plus a project's people, the three transfers and the directory search.
    expect(buildTools()).toHaveLength(136);
    const excluded = Object.entries(doc.paths).flatMap(([p, methods]) => Object.entries(methods).filter(([, op]) => op["x-tool"] === false).map(([m]) => `${m.toUpperCase()} ${p}`));
    // 23 once imagery became a configured basemap: its style document is
    // a renderer asset, not an operation an agent calls.
    // Entry/session exchange adds six exclusions; settings now generates tools.
    expect(excluded).toHaveLength(27);
    expect(excluded).toContain("GET /api/assistant/policy");
  });
});
