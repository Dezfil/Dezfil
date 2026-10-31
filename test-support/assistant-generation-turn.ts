import { vi } from "vitest";
import { accountScope } from "@/lib/auth/scope";
import type { AuthContext } from "@/lib/auth/credentials";
import { instanceFetch } from "@/lib/auth/instance-fetch";
import { createMap, mapWithLayers } from "@/lib/map-service";
import { AssistantRevisions } from "@/lib/assistant/edit-revisions";
import { executionControl } from "@/lib/assistant/execution-control";
import { runAssistant, type AssistantEvent } from "@/lib/assistant/loop";
import type { ModelProvider, ProviderCallOptions, ProviderReply, ToolOutcome } from "@/lib/assistant/provider";
import { assistantRuns } from "@/lib/assistant/runs";
import { runStream } from "@/lib/assistant/run-stream";
import { dispatchAssistantTestRoute } from "@/lib/assistant/testing/route-dispatch";
import { setLookDriverForTests } from "@/lib/export/map-look";
import { encodePng } from "@/lib/export/png-codec";

export type TurnHold = "tool continuation" | "before automatic check" | "automatic render" | "image continuation";
const baseUrl = "https://instance.test";
const png = encodePng({ width: 1024, height: 640, rgba: new Uint8Array(1024 * 640 * 4).fill(255) });

/** Real map writes and automatic checks, held only at provider, event or render seams. */
export function generationTurn(context: AuthContext, holdAt?: TurnHold) {
  const scope = accountScope(context), map = createMap(scope, "Before");
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>();
  const wait = async (at: TurnHold) => { if (at === holdAt) { entered.resolve(); await gate.promise; } };
  const requests: string[] = [], signals: (AbortSignal | undefined)[] = [], outcomes: ToolOutcome[][] = [];
  const done: ProviderReply = { text: "finished", toolCalls: [] };
  const note = (kind: string, options?: ProviderCallOptions) => { requests.push(kind); signals.push(options?.signal); };
  const provider: ModelProvider = { id: "generation-test", model: "generation-test", exchange: () => ({
    async send(_text, options) {
      note("send", options);
      return { text: "", toolCalls: [{ id: "edit", name: "update_map", args: { id: map.id, name: "After" } }] };
    },
    async continueWith(results, options) {
      note("tools", options); outcomes.push(results);
      await wait("tool continuation");
      // A late reply still asks for work: an uninterrupted turn would make another request.
      return holdAt === "tool continuation" ? { text: "", toolCalls: [{ id: "late", name: "get_map", args: { id: map.id } }] } : done;
    },
    async continueWithImage(_image, options) {
      note("image", options); await wait("image continuation"); return done;
    },
  }) };
  const render = vi.fn(async () => {
    await wait("automatic render");
    return { png, consumed: JSON.stringify({ map: map.id, layers: [], legend: { visible: false, corner: "bottom-left", order: [] }, widgets: [], attribution: "", failures: [] }) };
  });
  const kill = vi.fn();
  setLookDriverForTests({ launch: async () => ({ render, close: async () => {}, kill }) });
  const revisions = new AssistantRevisions(); revisions.observe(`/api/maps/${map.id}`, mapWithLayers(scope, map.id));
  const id = assistantRuns.reserve(scope).id; assistantRuns.bind(scope, id, {});
  const control = executionControl(scope, id, new Request(`${baseUrl}/api/assistant/messages`));
  const fetchImpl = instanceFetch(baseUrl, context, (input, init) => dispatchAssistantTestRoute(new Request(input, init)));
  const loop = runAssistant(provider, { message: "Rename the map", history: [], context: { page: "builder", mapId: map.id, selectedLayerId: null } },
    { scope, runId: id, baseUrl, revisions, fetchImpl, signal: control.signal, autoCheck: true });
  const events: AssistantEvent[] = [];
  async function* tracked() {
    try {
      for await (const event of loop) {
        events.push(event);
        if (event.type === "tool_call" && event.automatic) await wait("before automatic check");
        yield event;
      }
    } finally { completed.resolve(); }
  }
  const result = runStream(scope, tracked(), id, control).text().then(text => ({ text }), error => ({ error }));
  return { id, scope, requests, signals, outcomes, events, render, kill, signal: control.signal, result,
    entered: entered.promise, completed: completed.promise, release: () => gate.resolve() };
}
