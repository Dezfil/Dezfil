import { testAccountScope } from "@/lib/test-support/accounts";
import { authenticatedRoute, TEST_ACCOUNT_ID } from "@/lib/assistant/testing/account";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAssistantTestRoute } from "./testing/route-dispatch";
import { resetQueryInstance } from "@/lib/duckdb";
import { closeMetadataDb } from "@/lib/metadata/db";
import { GET as statusHandler } from "@/app/api/assistant/route";
import { POST as postHandler } from "@/app/api/assistant/messages/route";
import { assistantRuns } from "./runs";
import { stubProvider } from "./providers/stub";
import type { ProviderChoice } from "./factory";
import type { ModelKnowledge } from "./model-knowledge";
import * as catalogue from "./model-catalogue";

const status = authenticatedRoute(statusHandler);
const post = authenticatedRoute(postHandler);

const built = vi.hoisted(() => [] as ProviderChoice[]);
vi.mock("./factory", () => ({ createProvider: (choice: ProviderChoice) => {
  built.push(choice);
  return stubProvider([{ text: "Done.", toolCalls: [] }]);
} }));
let dir: string;
let file: string;
const network = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init);
  if (new URL(request.url).origin !== "http://127.0.0.1:3410") throw new Error("Unexpected external network");
  return dispatchAssistantTestRoute(request);
});
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "catalogue-admission-"));
  file = path.join(dir, "assistant-models.json");
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  vi.stubEnv("PORT", "3410");
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEZFIL_AI_PROVIDER", "DEZFIL_AI_MODEL", "DEZFIL_AI_MODELS_OPENAI", "DEZFIL_AI_MODELS_ANTHROPIC"]) {
    vi.stubEnv(key, ""); delete process.env[key];
  }
  vi.stubGlobal("fetch", network); network.mockClear(); built.length = 0;
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests();
});
afterEach(() => {
  closeMetadataDb(); resetQueryInstance(); assistantRuns.resetForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
});
const put = (value: unknown) => { writeFileSync(`${file}.next`, JSON.stringify(value)); renameSync(`${file}.next`, file); };
const entry = (id: string, efforts = ["low", "high"]) => ({ id, name: `Name ${id}`, efforts });
const read = async () => (await status()).json() as Promise<{ models: ModelKnowledge[]; catalogue: catalogue.CatalogueState }>;
const send = (choice: ProviderChoice, runId = assistantRuns.reserve(testAccountScope(undefined, TEST_ACCOUNT_ID)).id) => post(new Request("http://localhost:3410/api/assistant/messages", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, message: "Hello", history: [], choice }),
}));
async function accepted(choice: ProviderChoice) {
  const response = await send(choice);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Done.");
  expect(built.at(-1)).toEqual({ model: choice.model, effort: choice.effort ?? "default" });
}
async function refused(choice: ProviderChoice, code: string, replacement: ProviderChoice) {
  const run = assistantRuns.reserve(testAccountScope(undefined, TEST_ACCOUNT_ID));
  const before = built.length;
  const work = network.mock.calls.length;
  const response = await send(choice, run.id);
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe(code);
  expect(built.length).toBe(before);
  expect(network.mock.calls.length).toBe(work);
  expect(assistantRuns.read(testAccountScope(), run.id)).toMatchObject({ state: "reserved", actions: [], text: "" });
  expect(assistantRuns.read(testAccountScope(), run.id).provenance).toBeUndefined();
  const reused = await send(replacement, run.id);
  expect(reused.status).toBe(200);
  await reused.text();
  expect(built.length).toBe(before + 1);
}

for (const [provider, key, base] of [["openai", "OPENAI_API_KEY", "gpt-5.6-terra"], ["anthropic", "ANTHROPIC_API_KEY", "claude-opus-5"]] as const) {
  describe(`${provider}: current status and admissions`, () => {
    beforeEach(() => { vi.stubEnv(key, "fixture-never-sent"); });
    it("reports absent, empty-applied and rejected with a usable whole shipped fallback", async () => {
      const original = await read();
      expect(original.catalogue).toEqual({ source: "shipped", instance: "absent" });
      put({});
      expect(await read()).toMatchObject({ catalogue: { source: "merged", instance: "applied" }, models: original.models });
      put({ [provider]: [entry("prefix"), entry("bad", ["default"])] });
      const rejected = await read();
      expect(rejected.models).toEqual(original.models);
      expect(rejected.catalogue).toEqual({ source: "shipped", instance: "rejected", reason: `${provider}[1].efforts[0]: invalid effort word.` });
      await accepted({ model: base });
    });
    it("add, override, replace, remove and repair affect the next read and new admission", async () => {
      put({ [provider]: [entry("added")] });
      expect((await read()).models.at(-1)).toMatchObject({ id: "added", name: "Name added" });
      await accepted({ model: "added", effort: "high" });
      put({ [provider]: [entry(base, ["low"]), entry("added", ["low"])] });
      expect((await read()).models.find((m) => m.id === base)?.efforts.map((e) => e.value)).toEqual(["default", "low"]);
      await accepted({ model: base, effort: "low" });
      await refused({ model: "added", effort: "high" }, "assistant_effort_not_offered", { model: "added", effort: "low" });
      put({ [provider]: [entry("replacement", [])] });
      expect((await read()).models.at(-1)?.id).toBe("replacement");
      await refused({ model: "added" }, "assistant_model_not_offered", { model: "replacement" });
      await refused({ model: "replacement", effort: "low" }, "assistant_effort_not_supported", { model: base });
      rmSync(file);
      expect((await read()).catalogue).toEqual({ source: "shipped", instance: "absent" });
      await refused({ model: "replacement" }, "assistant_model_not_offered", { model: base });
      writeFileSync(file, "{");
      expect((await read()).catalogue.instance).toBe("rejected");
      await accepted({ model: base });
      put({ [provider]: [entry("repaired", ["high"])] });
      expect((await read()).models.at(-1)?.id).toBe("repaired");
      await accepted({ model: "repaired", effort: "high" });
    });
    it("source checkout replacement changes the next status and admission", async () => {
      const original = JSON.parse(readFileSync("src/lib/assistant/model-catalogue.json", "utf8"));
      const sourceDir = path.join(dir, "src/lib/assistant"); mkdirSync(sourceDir, { recursive: true });
      const source = path.join(sourceDir, "model-catalogue.json");
      writeFileSync(source, JSON.stringify(original));
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      expect((await read()).models.some((m) => m.id === "source-added")).toBe(false);
      original[provider].push(entry("source-added", ["low"]));
      writeFileSync(source, JSON.stringify(original));
      expect((await read()).models.at(-1)?.id).toBe("source-added");
      await accepted({ model: "source-added", effort: "low" });
      original[provider].at(-1).efforts = ["high"];
      writeFileSync(source, JSON.stringify(original));
      expect((await read()).models.at(-1)?.efforts.map((e) => e.value)).toEqual(["default", "high"]);
      await refused({ model: "source-added", effort: "low" }, "assistant_effort_not_offered", { model: "source-added", effort: "high" });
    });
    it("one admission uses one coherent snapshot even when replacement follows its read", async () => {
      put({ [provider]: [entry("snapshot", ["high"])] });
      const real = catalogue.readModelCatalogue;
      const reads = vi.spyOn(catalogue, "readModelCatalogue").mockImplementation(() => {
        const snapshot = real(); put({ [provider]: [entry("snapshot", [])] }); return snapshot;
      });
      await accepted({ model: "snapshot", effort: "high" });
      expect(reads).toHaveBeenCalledTimes(1);
      await refused({ model: "snapshot", effort: "high" }, "assistant_effort_not_supported", { model: base });
    });
  });
}
