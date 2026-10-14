import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { pendingActions } from "./pending";
import { assistantRuns } from "./runs";
import { policyFor } from "./policy";
import { openaiProvider } from "./providers/openai";
import { anthropicProvider } from "./providers/anthropic";
import { sse, anthropicEvents, outputText } from "./testing/wire";
import { buildTools } from "@/lib/tools/tools";
import { runAssistant } from "./loop";
import { runStream } from "./run-stream";
import { executionControl } from "./execution-control";
import { AssistantRevisions } from "./edit-revisions";
import { assistantWorkForTests } from "./retained-work";
import type { ModelProvider, ProviderReply } from "./provider";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { proveErasure, type ErasureProbe } from "../../../test-support/account-erasure-proof";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(root, "assistant-buffers-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); });
afterEach(async () => { vi.restoreAllMocks(); pendingActions.resetForTests(); assistantRuns.resetForTests(); closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
const inv = (ids: string[]) => ({ ...erasureInventory, stores: Object.fromEntries(ids.map(id => [id, erasureInventory.stores[id as keyof typeof erasureInventory.stores]])) });
it("erases populated parked native conversations, confirmations, traces and terminal receipts by account", async () => {
  const scopes = [testAccountScope(undefined, "target"), testAccountScope(undefined, "control")];
  const providers = [openaiProvider("fixture-key", "fixture-model", async () => sse([{ type: "response.completed", response: { status: "completed", model: "fixture", output: [outputText("native private answer")] } }])), anthropicProvider("fixture-key", "fixture-model", async () => sse(anthropicEvents([{ type: "text", text: "native private answer" }]), true))];
  const exchanges = providers.map(provider => scopes.map(() => provider.exchange({ system: "System", grounding: "private grounding", history: [{ role: "user", text: "private conversation" }], tools: buildTools().filter(t => t.name === "run_sql") })));
  const parked = (exchange: typeof exchanges[0][0]) => ({ exchange, policy: policyFor(undefined), calls: [{ id: "call", name: "run_sql", args: { sql: "private confirmation" } }], index: 0, outcomes: [{ toolCallId: "earlier", body: "private outcome", isError: false }], steps: 1, headers: {} });
  for (let i = 0; i < 2; i++) {
    for (const pair of exchanges) { await pair[i].send("private user message"); pendingActions.park(scopes[i], parked(pair[i])); }
    const trace = pendingActions.park(scopes[i], parked(providers[0].exchange({ system: "System", history: [], tools: [] })));
    pendingActions.claim(scopes[i], trace, "approved")!.exchange.dispose!();
    const id = assistantRuns.reserve(scopes[i]).id; assistantRuns.bind(scopes[i], id, { private: "fingerprint" });
    assistantRuns.record(scopes[i], id, { type: "text_delta", messageId: "m", text: "private receipt" });
    assistantRuns.record(scopes[i], id, { type: "confirm_required", id: "p", tool: "run_sql", args: { sql: "private confirmation" } });
    assistantRuns.resume(scopes[i], id); assistantRuns.finish(scopes[i], id);
  }
  const observations: Record<string, (index: number) => string[]> = {
    "pending.ts#pendingActions": i => [...pendingActions.entriesForTests(scopes[i].accountId).parked, ...pendingActions.entriesForTests(scopes[i].accountId).trace],
    "pending.ts#PendingActionStore.parked": i => pendingActions.entriesForTests(scopes[i].accountId).parked,
    "pending.ts#PendingActionStore.trace": i => pendingActions.entriesForTests(scopes[i].accountId).trace,
    "runs.ts#assistantRuns": i => assistantRuns.entriesForTests(scopes[i].accountId),
    "runs.ts#AssistantRunStore.entries": i => assistantRuns.entriesForTests(scopes[i].accountId),
    "runs.ts#AssistantRunStore.terminals": i => assistantRuns.terminalsForTests(scopes[i].accountId),
  };
  for (const [prefix, index, history] of [["providers/openai-responses.ts#responsesExchange", 0, "input"], ["providers/anthropic.ts#anthropicProvider.exchange", 1, "messages"]] as const) {
    for (const field of ["grounding", "tools", history]) observations[`${prefix}.${field}`] = i => { const state = exchanges[index][i].retainedForTests!(); return field === "grounding" ? state.grounding ? [state.grounding] : [] : field === "tools" ? state.tools : state.history.map(value => JSON.stringify(value)); };
  }
  observations["providers/openai.ts#openaiProvider.exchange.exchange"] = i => exchanges[0][i].retainedForTests!().history.map(value => JSON.stringify(value));
  const probes: Record<string, ErasureProbe> = Object.fromEntries(Object.entries(observations).map(([suffix, read]) => [`memory:src/lib/assistant/${suffix}`, { populate() {}, dispose() {}, observe: () => ({ target: read(0), control: read(1) }) }]));
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  vi.resetModules(); const other = await import("./account-erasure-work");
  const fresh = (await import("@/lib/test-support/accounts")).testAccountScope(undefined, "control");
  const second = (await import("./pending")).pendingActions;
  for (const id of pendingActions.entriesForTests("control").parked) expect(second.peek(fresh, id)?.accountId).toBe("control");
  await proveErasure(inv(Object.keys(probes)), probes, () => other.eraseAccountWork("target", { jobs: [], runs: [] }, metadataDb()));
  for (const pair of exchanges) { expect(pair[0].retainedForTests!()).toEqual({ history: [], grounding: undefined, tools: [] }); await expect(async () => pair[0].send("should be disposed")).rejects.toThrow("released"); expect((await pair[1].continueWith([])).text).toBe("native private answer"); }
});
it("waits for held provider promises and drops unread stream buffers, revisions and abort listeners before completion", async () => {
  const scopes = [testAccountScope(undefined, "target"), testAccountScope(undefined, "control")];
  const holds = scopes.map(() => Promise.withResolvers<ProviderReply>()), entered = scopes.map(() => Promise.withResolvers<void>());
  const revisions = scopes.map(() => { const r = new AssistantRevisions(); r.observe("/api/maps/private-map", { editRevision: "private-revision", layers: [{ id: "private-layer" }] }); return r; });
  const requests = scopes.map(() => new Request("http://instance.test/api/assistant/messages"));
  const responses = scopes.map((scope, i) => {
    const run = assistantRuns.reserve(scope); assistantRuns.bind(scope, run.id, {});
    const control = executionControl(scope, run.id, requests[i]);
    const provider: ModelProvider = { id: "held", model: "held", exchange() { return { send(_text, options) { options?.onTextDelta?.("queued private text"); entered[i].resolve(); return holds[i].promise; }, async continueWith() { return holds[i].promise; } }; } };
    return runStream(scope, runAssistant(provider, { message: "private input", history: [] }, { scope, revisions: revisions[i], baseUrl: "http://unused.invalid", runId: run.id, signal: control.signal }), run.id, control);
  });
  await Promise.all(entered.map(e => e.promise)); await new Promise(r => setImmediate(r));
  const ids = ["memory:src/lib/assistant/edit-revisions.ts#AssistantRevisions.parents", "memory:src/lib/assistant/edit-revisions.ts#AssistantRevisions.revisions", "memory:src/lib/assistant/execution-control.ts#executionControl.signal", "memory:assistant-work", "memory:assistant-cleanups"];
  const probes = Object.fromEntries(ids.map(id => [id, { populate() {}, dispose() {}, observe() {
    const read = (i: number): string[] => {
      if (id.endsWith(".parents")) return revisions[i].entriesForTests().parents.map(value => JSON.stringify(value));
      if (id.endsWith(".revisions")) return revisions[i].entriesForTests().revisions.map(value => JSON.stringify(value));
      if (id.endsWith(".signal")) return getEventListeners(requests[i].signal, "abort").map((_, index) => String(index));
      const state = assistantWorkForTests(scopes[i].accountId); return Array.from({ length: id === "memory:assistant-work" ? state.work : state.cleanups }, (_, index) => String(index));
    }; return { target: read(0), control: read(1) };
  } }]));
  try {
    await proveErasure(inv(ids), probes, async () => {
      metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'"); vi.resetModules(); const other = await import("./account-erasure-work");
      let done = false; const erased = other.eraseAccountWork("target", { jobs: [], runs: [] }, metadataDb()).then(() => { done = true; });
      await new Promise(r => setImmediate(r)); expect(done).toBe(false);
      await expect(responses[0].text()).rejects.toThrow("Sign in"); expect(done).toBe(false);
      holds[0].resolve({ text: "late private answer", toolCalls: [] }); await erased;
    });
  } finally { for (const hold of holds) hold.resolve({ text: "control answer", toolCalls: [] }); await responses[1].text(); }
});
