import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, expect, it } from "vitest";
import { buildTools } from "@/lib/tools/tools";
import { runAssistant, resumeAssistant, type AssistantEvent } from "./loop";
import { PendingActionStore } from "./pending";
import { stubProvider } from "./providers/stub";
import type { ProviderReply } from "./provider";

/**
 * Loop mechanics: tools execute through the documented API,
 * confirmation-gated tools do not run without a decision, resolution
 * resumes the parked run instead of replaying the turn, and a step budget
 * bounds one turn across its pauses. The API is stubbed with a recording
 * fetch; the model is the scripted stub, which mints fresh tool-call ids
 * per exchange exactly as real providers do.
 */

function apiStub(routes: Record<string, { status: number; body: unknown }>) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const pathname = new URL(url).pathname;
    const route = routes[pathname] ?? { status: 200, body: {} };
    if (route.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A paused-and-resumable harness: one provider, one API stub, one store —
 * so a resume continues the same exchange, like the route does. */
function harness(
  script: ProviderReply[],
  routes: Record<string, { status: number; body: unknown }> = {},
  stepBudget?: number,
) {
  const { fetchImpl, calls } = apiStub(routes);
  const provider = stubProvider(script);
  const store = new PendingActionStore();
  const deps = {
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl,
    stepBudget,
    pending: store,
  };
  const collect = async (gen: AsyncGenerator<AssistantEvent>) => {
    const events: AssistantEvent[] = [];
    for await (const event of gen) events.push(event);
    return events;
  };
  return {
    calls,
    store,
    recording: provider.recording,
    run: (message: string) =>
      collect(runAssistant(provider, { message, history: [] }, { scope: testAccountScope(), ...deps })),
    resume: (pendingId: string, approved: boolean) => {
      const parked = store.claim(testAccountScope(), pendingId, approved ? "approved" : "declined");
      if (!parked) throw new Error(`No parked run for ${pendingId}`);
      return collect(resumeAssistant(parked, approved, { scope: testAccountScope(), ...deps }));
    },
  };
}

let seq = 0;
const tool = (name: string, args: Record<string, unknown> = {}, id?: string) => ({
  id: id ?? `c${++seq}`,
  name,
  args,
});

function pendingIdOf(events: AssistantEvent[]): string {
  const confirm = events.find((e) => e.type === "confirm_required");
  if (!confirm || confirm.type !== "confirm_required") {
    throw new Error("No confirm_required event");
  }
  return confirm.id;
}

describe("runAssistant", () => {
  it("runs a read tool through the API and feeds the result back", async () => {
    const h = harness(
      [
        { text: "Let me look.", toolCalls: [tool("list_tables")] },
        { text: "You have one table: parks.", toolCalls: [] },
      ],
      { "/api/tables": { status: 200, body: [{ name: "parks" }] } },
    );
    const events = await h.run("what tables exist?");

    expect(h.calls).toEqual([
      { url: "http://127.0.0.1:3000/api/tables", method: "GET" },
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "message",
      "tool_call",
      "tool_result",
      "message",
      "done",
    ]);
    // The tool result was returned to the model.
    const outcome = h.recording.exchanges[0].outcomes[0][0];
    expect(JSON.parse(outcome.body)).toEqual([{ name: "parks" }]);
    expect(outcome.isError).toBe(false);
  });

  it("pauses for confirmation before a destructive tool and does not call it", async () => {
    const gated = tool("delete_table", { name: "parks" });
    const h = harness([{ text: "Deleting.", toolCalls: [gated] }], {
      "/api/tables/parks": { status: 204, body: null },
    });
    const events = await h.run("delete parks");

    expect(h.calls).toEqual([{ url: "http://127.0.0.1:3000/api/catalogue/tables?names=parks", method: "GET" }]); // name read only, never deleted
    const confirm = events.find((e) => e.type === "confirm_required");
    expect(confirm).toMatchObject({ tool: "delete_table" });
    // The pending-action id is server-issued — binding to the provider's
    // call id is exactly what did not survive a real exchange.
    expect(pendingIdOf(events)).not.toBe(gated.id);
    expect(events.at(-1)).toEqual({ type: "done", reason: "end" });
  });

  it("approval resumes the same exchange and executes the parked call once", async () => {
    const h = harness(
      [
        { text: "Deleting.", toolCalls: [tool("delete_table", { name: "parks" })] },
        { text: "Done.", toolCalls: [] },
      ],
      { "/api/tables/parks": { status: 204, body: null } },
    );
    const paused = await h.run("delete parks");
    const events = await h.resume(pendingIdOf(paused), true);

    expect(h.calls).toEqual([
      { url: "http://127.0.0.1:3000/api/catalogue/tables?names=parks", method: "GET" },
      { url: "http://127.0.0.1:3000/api/tables/parks", method: "DELETE" },
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_result",
      "message",
      "done",
    ]);
    // One exchange for the whole turn: the resume continued it — the model
    // was never re-sent the user message.
    expect(h.recording.exchanges.length).toBe(1);
    expect(h.recording.exchanges[0].outcomes.length).toBe(1);
  });

  it("skips a declined destructive tool and tells the model it was not performed", async () => {
    const h = harness([
      { text: "", toolCalls: [tool("delete_table", { name: "parks" })] },
      { text: "Okay, keeping it.", toolCalls: [] },
    ]);
    const paused = await h.run("delete parks");
    const events = await h.resume(pendingIdOf(paused), false);

    expect(h.calls).toEqual([{ url: "http://127.0.0.1:3000/api/catalogue/tables?names=parks", method: "GET" }]);
    const outcome = h.recording.exchanges[0].outcomes[0][0];
    expect(JSON.parse(outcome.body).note).toContain("did not confirm");
    expect(outcome.isError).toBe(false);
    expect(events.some((e) => e.type === "tool_result" && !e.ok)).toBe(true);
    expect(h.recording.exchanges.length).toBe(1);
  });

  it("work before the gate is not re-run by resolution", async () => {
    const h = harness(
      [
        {
          text: "Creating, then publishing.",
          toolCalls: [
            tool("create_map", { name: "Berlin" }),
            tool("publish_map", { id: "m1" }),
          ],
        },
        { text: "Published.", toolCalls: [] },
      ],
      {
        "/api/maps": { status: 201, body: { id: "m1" } },
        "/api/maps/m1/publish": { status: 200, body: { url: "/v/x" } },
      },
    );
    const paused = await h.run("create a map and publish it");
    // The mutation ran once before the pause…
    expect(h.calls.filter((c) => c.method === "POST").length).toBe(1);

    const events = await h.resume(pendingIdOf(paused), true);
    // …and exactly once after resolution: the run continued, nothing replayed.
    const posts = h.calls.filter((c) => c.url.endsWith("/api/maps"));
    expect(posts.length).toBe(1);
    const publishes = h.calls.filter((c) => c.url.endsWith("/publish"));
    expect(publishes.length).toBe(1);
    expect(h.recording.exchanges.length).toBe(1);
    expect(events.at(-1)).toEqual({ type: "done", reason: "end" });
  });

  it("a second gated call parks again under a new pending action", async () => {
    const h = harness(
      [
        {
          text: "",
          toolCalls: [
            tool("delete_table", { name: "parks" }),
            tool("delete_table", { name: "stations" }),
          ],
        },
        { text: "Both gone.", toolCalls: [] },
      ],
      {
        "/api/tables/parks": { status: 204, body: null },
        "/api/tables/stations": { status: 204, body: null },
      },
    );
    const paused = await h.run("delete both tables");
    const first = pendingIdOf(paused);
    const second = await h.resume(first, true);
    expect(pendingIdOf(second)).not.toBe(first);

    const events = await h.resume(pendingIdOf(second), true);
    expect(h.calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:3000/api/catalogue/tables?names=parks",
      "http://127.0.0.1:3000/api/tables/parks",
      "http://127.0.0.1:3000/api/catalogue/tables?names=stations",
      "http://127.0.0.1:3000/api/tables/stations",
    ]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "end" });
    expect(h.recording.exchanges.length).toBe(1);
  });

  it("the step budget spans the pause", async () => {
    // Budget 2: one read before the gate, the gated call itself — after
    // approval executes it, the turn is out of budget, not restarted.
    const h = harness(
      [
        {
          text: "",
          toolCalls: [tool("list_tables"), tool("delete_table", { name: "parks" })],
        },
      ],
      {
        "/api/tables": { status: 200, body: [] },
        "/api/tables/parks": { status: 204, body: null },
      },
      2,
    );
    const paused = await h.run("clean up");
    const events = await h.resume(pendingIdOf(paused), true);

    // The approved call executed — approval is honored — but the turn
    // ends at the budget instead of asking the model for more.
    expect(h.calls.at(-1)?.method).toBe("DELETE");
    expect(events.at(-1)).toEqual({ type: "done", reason: "budget" });
    expect(h.recording.exchanges[0].outcomes.length).toBe(0);
  });

  it("stops at the step budget rather than looping forever", async () => {
    const script: ProviderReply[] = Array.from({ length: 10 }, () => ({
      text: "",
      toolCalls: [tool("list_tables")],
    }));
    const h = harness(
      script,
      { "/api/tables": { status: 200, body: [] } },
      3,
    );
    const events = await h.run("loop");

    expect(h.calls.length).toBe(3);
    expect(events.at(-1)).toEqual({ type: "done", reason: "budget" });
  });

  it("surfaces an API error as a tool_result the model can react to", async () => {
    const h = harness(
      [
        { text: "", toolCalls: [tool("get_map", { id: "nope" })] },
        { text: "That map does not exist.", toolCalls: [] },
      ],
      {
        "/api/maps/nope": {
          status: 404,
          body: { error: { code: "not_found", message: "No such map." } },
        },
      },
    );
    const events = await h.run("open map nope");

    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ ok: false });
    const outcome = h.recording.exchanges[0].outcomes[0][0];
    expect(outcome.isError).toBe(true);
    expect(JSON.parse(outcome.body).error.code).toBe("not_found");
  });

  it("passes the grounding system prompt and the whole tool set to the model", async () => {
    const h = harness([{ text: "hi", toolCalls: [] }]);
    await h.run("hello");
    const options = h.recording.exchanges[0].options;
    expect(options.system).toContain("Dezfil assistant");
    expect(options.system).toContain("read-only");
    expect(options.tools.length).toBe(buildTools().length);
  });

  it("reports a rejected credential as an assistant_auth error", async () => {
    const provider = {
      id: "boom",
      model: "x",
      exchange() {
        return {
          async send(): Promise<ProviderReply> {
            const { ProviderError } = await import("./provider");
            throw new ProviderError("key rejected", "auth");
          },
          async continueWith(): Promise<ProviderReply> {
            throw new Error("unused");
          },
        };
      },
    };
    const events: AssistantEvent[] = [];
    for await (const event of runAssistant(
      provider,
      { message: "hi", history: [] },
      { scope: testAccountScope(), baseUrl: "http://127.0.0.1:3000" },
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "error", code: "assistant_auth", message: "key rejected" },
    ]);
  });
});

/**
 * A conditional confirmation has to be **enforced**, not merely declared.
 *
 * The metadata is what a UI renders; this is what stops a model. A version
 * that only stored the field would let the one operation singled out as
 * needing confirmation run a whole recipe without one — a declaration nothing
 * consults.
 */
describe("a confirmation that depends on blast radius", () => {
  const call = (args: Record<string, unknown>): ProviderReply[] => [
    { text: "", toolCalls: [{ id: "c1", name: "run_recipe", args }] },
    { text: "done", toolCalls: [] },
  ];

  it("parks a run that would carry other steps", async () => {
    const h = harness(call({ id: "r1" }), {
      "/api/recipes/r1/runs": { status: 200, body: { editRevision: "planned", plan: { wide: true, members: ["first", "second"] } } },
    });
    const events = await h.run("run it");
    expect(events.map((e) => e.type)).toContain("confirm_required");
    // Plan probe and target-name read; execution remains parked.
    expect(h.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("does not park the same control aimed at a leaf", async () => {
    // The spec's fourth case, and the one an unconditional gate gets wrong:
    // prompting here trains a user to dismiss the prompt that matters.
    const h = harness(call({ id: "r1", fromStepId: "leaf" }), {
      "/api/recipes/r1/runs": { status: 200, body: { editRevision: "planned", plan: { wide: false, members: ["leaf"] } } },
    });
    const events = await h.run("re-run just that one");
    expect(events.map((e) => e.type)).not.toContain("confirm_required");
    // The probe and the run itself.
    expect(h.calls).toHaveLength(2);
  });

  it("refuses an unspecified action when the plan cannot be obtained", async () => {
    // An unavailable plan cannot authorize an unspecified wide action.
    const h = harness(call({ id: "r1" }), {
      "/api/recipes/r1/runs": { status: 500, body: {} },
    });
    const events = await h.run("run it");
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "assistant_plan_unavailable" }));
    expect(events.map((e) => e.type)).not.toContain("confirm_required");
  });

  it("lets the plan through ungated, because that is how a caller finds out", async () => {
    const h = harness(call({ id: "r1", plan: true }), {
      "/api/recipes/r1/runs": { status: 200, body: { editRevision: "planned", plan: { wide: true, members: ["first", "second"] } } },
    });
    const events = await h.run("what would this carry?");
    expect(events.map((e) => e.type)).not.toContain("confirm_required");
    expect(h.calls.map((c) => c.url)).toContain(
      "http://127.0.0.1:3000/api/recipes/r1/runs",
    );
  });
});
