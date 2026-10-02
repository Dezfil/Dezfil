import shipped from "@/lib/assistant/model-catalogue.json";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { describeModel } from "@/lib/assistant/model-knowledge";
import type { RunReceipt } from "@/lib/assistant/runs";
import { conversation } from "./conversation-store";
import type { ModelChoice } from "./model-choice";
import { modelChoice } from "./model-choice-store";
import { ModelPicker } from "./ModelPicker";
import { useAssistantTurn } from "./use-assistant-turn";
import { DocumentEditorContext, type DocumentEditorPort } from "../../document-editor-context";
import { DocumentSequence } from "../../document-sequence";

/**
 * What the pane is left holding when a submission is refused ("a later
 * refusal preserves the person's message and reports the outcome"). Review
 * the findings, red-first.
 *
 * The hook itself is driven here, not a copy of its rules: it is rendered
 * once through the server renderer, which runs its body and hands back the
 * callbacks it returns, and those callbacks are then called with `fetch`
 * stubbed at the network boundary and the real conversation store
 * underneath. Effects do not run in that renderer, so the status read never
 * lands and this pane is one that has been told nothing about the instance
 * — which is itself a state the product has (the read is in flight, or it
 * failed) and the state that row is about. What a pane with a status
 * shows and sends is the browser suite's and the pure rows'
 * (`choice-memory.test.tsx`).
 */

const RUN = "run-1";
type Turn = ReturnType<typeof useAssistantTurn>;
/** What a recovered run reports it was bound to. */
const BOUND_PAIR = { model: "gpt-6-astra", effort: "xhigh", defaulted: { model: false, effort: false } };
const OFFERED = ["gpt-5.6-terra", "gpt-6-astra"].map((id) => describeModel("openai", id, shipped));

/** The control the pane would draw at rest for that pair: the lock is the
 * consequence the person meets, and it is read from the real component. */
const pickerFor = (bound: ModelChoice | undefined) =>
  renderToStaticMarkup(<ModelPicker models={OFFERED} instanceModel="gpt-5.6-terra" disabled={false} bound={bound} />);

/** The hook's own callbacks, over the tab's real conversation store. */
function paneTurn(editor: DocumentEditorPort | null = null): Turn {
  let captured: Turn | undefined;
  function Probe() { captured = useAssistantTurn(undefined, () => {}); return null; }
  renderToStaticMarkup(<DocumentEditorContext.Provider value={editor}><Probe /></DocumentEditorContext.Provider>);
  return captured!;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const receipt = (over: Partial<RunReceipt> = {}): RunReceipt =>
  ({ id: RUN, state: "reserved", text: "", actions: [], incomplete: false, ...over });
const refusal = (code: string, message: string) => json({ error: { code, message } }, 400);

type Call = { method: string; url: string; body?: Record<string, unknown> };
let sent: Call[] = [];
const original = globalThis.fetch;

/** The instance, as far as this pane can see it: whatever the row answers,
 * with the reads every path makes anyway answered once here. */
function answering(reply: (method: string, url: string) => Response | Promise<Response> | undefined) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push({ method, url, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) });
    const answer = await reply(method, url);
    if (answer) return answer;
    if (url === "/api/assistant/pending") return json({ pending: [] });
    throw new Error(`the pane asked something this row does not answer: ${method} ${url}`);
  }) as typeof fetch;
}
const seen = (method: string, url: string) => sent.some((call) => call.method === method && call.url === url);

beforeEach(() => { conversation.resetForTests(); modelChoice.resetForTests(); sent = []; });
afterEach(() => { globalThis.fetch = original; });

it("orders recovered assistant results before later editor intent", async () => {
  const sequence = new DocumentSequence("map");
  const events: string[] = [];
  let release!: () => void;
  const saving = sequence.enqueue(() => new Promise<void>((resolve) => { release = resolve; }));
  answering((_method, url) => url === `/api/assistant/runs/${RUN}` ? json(receipt({ state: "completed", actions: [{ id: "edit", tool: "update_map", status: "succeeded" }] })) : undefined);
  const editor: DocumentEditorPort = { sequence, request: fetch, turn: work => sequence.enqueue(async () => { await work(); events.push("accepted recovery"); }) };
  const recovery = paneTurn(editor).recover(RUN);
  const later = sequence.enqueue(async () => { events.push("later intent"); });
  expect(sent).toHaveLength(0);
  release();
  await Promise.all([saving, recovery, later]);
  expect(events).toEqual(["accepted recovery", "later intent"]);
});

describe("a run that is no longer there", () => {
  it("gives the picker back, instead of locking it on a pair no run holds", async () => {
    // A run recovered from the server displays its own bound pair and locks
    // the control while it owns the pane. When the next read
    // says the run is gone, nothing owns the pane any more: the picker must
    // return to the next message's selection, or it sits
    // disabled over an idle composer that will happily take a message and
    // send something else.
    let reads = 0;
    answering((method, url) => {
      if (url !== `/api/assistant/runs/${RUN}`) return undefined;
      reads += 1;
      if (reads === 1) return json(receipt({ state: "running", provenance: { requested: BOUND_PAIR } }));
      return json({ error: { code: "assistant_run_unknown", message: "This request is no longer available." } }, 404);
    });
    const turn = paneTurn();

    await turn.recover(RUN);
    expect(conversation.get().live.choice).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
    expect(pickerFor(conversation.get().live.choice), "a run that holds the pane locks the picker").toMatch(/data-model-picker[^>]*disabled/);

    await turn.recover(RUN);
    expect(conversation.get().live.choice).toBeUndefined();
    expect(pickerFor(conversation.get().live.choice), "the picker stayed locked on a run that is gone").not.toMatch(/data-model-picker[^>]*disabled/);
    // The rest of the unavailable path is and is unchanged.
    expect(conversation.get().recoveryId).toBeNull();
  });
});

describe("what a submission carries where no picker stands", () => {
  it("carries no choice at all, because the pane shows none and offers no way to reset one", async () => {
    // A pair the tab still remembers from when the instance offered
    // several models, in a pane that now knows of no choice at all — the
    // instance shrank to one model, or the status read has not landed.
    // Sending it would put a setting on the request that nobody can see
    // and nobody can take off again.
    modelChoice.set({ model: "gpt-6-astra", effort: "xhigh" });
    answering((method, url) => {
      if (url === "/api/assistant/runs" && method === "POST") return json(receipt());
      if (url === "/api/assistant/messages") return json(receipt({ state: "completed", text: "Done." }));
      return undefined;
    });
    await paneTurn().submitText("Colour the parks by area");

    const request = sent.find((call) => call.url === "/api/assistant/messages");
    expect(request?.body).toBeDefined();
    expect(request?.body).not.toHaveProperty("choice");
    // The rest of the request is untouched: this is the pre-picker request.
    expect(Object.keys(request!.body!).sort()).toEqual(["history", "message", "runId"]);
  });
});

describe("a refusal that arrives after the reservation", () => {
  it("keeps the route's own outcome, which the reserved cleanup used to overwrite", async () => {
    // The instance's offerings changed under a stale status read, so the
    // message this pane composed is refused. Nothing was bound, so the run
    // is still reserved when the outcome is read — and the person is owed
    // the reason, not a note that says only that nothing happened.
    answering((method, url) => {
      if (url === "/api/assistant/runs" && method === "POST") return json(receipt());
      if (url === "/api/assistant/messages") return refusal("assistant_model_not_offered", "This instance does not offer “gpt-6-astra”. It offers: gpt-5.6-terra.");
      if (url === `/api/assistant/runs/${RUN}` && method === "DELETE") return json(receipt({ state: "unavailable" }));
      if (url === `/api/assistant/runs/${RUN}`) return json(receipt());
      return undefined;
    });
    await paneTurn().submitText("Colour the parks by area");

    const { error, input, live } = conversation.get();
    expect(error?.code).toBe("assistant_model_not_offered");
    expect(error?.message).toContain("It offers: gpt-5.6-terra.");
    // behavior, unchanged by the fix: the words go back to the draft so a
    // retry is deliberate, the live turn is empty, and the unused
    // reservation is released rather than left to expire.
    expect(input).toBe("Colour the parks by area");
    expect(live.message).toBeUndefined();
    expect(seen("DELETE", `/api/assistant/runs/${RUN}`)).toBe(true);
  });

  it("still explains itself where nothing was reported, so the note is not suppressed wholesale", async () => {
    // The control for the row above. A connection that fails before the
    // route answers reports no outcome of its own, and the cleanup's note
    // is the only thing that says the message was not started.
    answering((method, url) => {
      if (url === "/api/assistant/runs" && method === "POST") return json(receipt());
      if (url === "/api/assistant/messages") throw new TypeError("Failed to fetch");
      if (url === `/api/assistant/runs/${RUN}` && method === "DELETE") return json(receipt({ state: "unavailable" }));
      if (url === `/api/assistant/runs/${RUN}`) return json(receipt());
      return undefined;
    });
    await paneTurn().submitText("Colour the parks by area");

    const { error, input } = conversation.get();
    expect(error).toEqual({ code: "pane", message: "The message wasn't started. You can send it again." });
    expect(input).toBe("Colour the parks by area");
  });
});
