import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunReceipt } from "@/lib/assistant/runs";
import { DocumentEditorContext, type DocumentEditorPort } from "../../document-editor-context";
import { DocumentSequence } from "../../document-sequence";
import { AssistantComposer } from "./AssistantComposer";
import { clearControl } from "./clear-control";
import { conversation } from "./conversation-store";
import { useAssistantTurn } from "./use-assistant-turn";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function paneTurn(editor: DocumentEditorPort) {
  let turn!: ReturnType<typeof useAssistantTurn>;
  function Probe() { turn = useAssistantTurn(undefined, () => {}); return null; }
  renderToStaticMarkup(<DocumentEditorContext.Provider value={editor}><Probe /></DocumentEditorContext.Provider>);
  return turn;
}

const receipt = (id: string, state: RunReceipt["state"], text = ""): RunReceipt =>
  ({ id, state, text, actions: [], incomplete: false });
const clearState = () => {
  const state = conversation.get();
  return clearControl({ ...state, turns: state.turns.length });
};

beforeEach(() => conversation.resetForTests());
afterEach(() => { vi.unstubAllGlobals(); conversation.resetForTests(); });

it.each(["stream", "receipt"])("readies Clear and the composer after a %s while document adoption still holds later writes", async (transport) => {
  const sequence = new DocumentSequence("map");
  const adoption = deferred<void>();
  const adopting = deferred<void>();
  const editor: DocumentEditorPort = { sequence, request: fetch, turn: work => sequence.enqueue(async () => {
    await work();
    adopting.resolve();
    await adoption.promise;
    sequence.accept({ editRevision: "accepted" });
  }) };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/assistant/runs") return Response.json(receipt("run", "reserved"));
    if (url === "/api/assistant/messages") return transport === "receipt"
      ? Response.json(receipt("run", "completed", "Buffered."))
      : new Response(`${JSON.stringify({ type: "message", text: "Buffered." })}\n`);
    if (url === "/api/assistant/runs/run") return Response.json(receipt("run", "completed", "Buffered."));
    if (url === "/api/assistant/pending") return Response.json({ pending: [] });
    throw new Error(`Unexpected request: ${url}`);
  }));
  const submitted = paneTurn(editor).submitText("Buffer the parks");
  await adopting.promise;
  const laterWrite = vi.fn(async () => sequence.revision);
  const later = sequence.enqueue(laterWrite);
  try {
    expect(conversation.get().turns.at(-1)?.text).toBe("Buffered.");
    expect(conversation.get().recoveryId).toBeNull();
    expect(clearState()).toBe("ready");
    const turn = paneTurn(editor);
    const html = renderToStaticMarkup(<AssistantComposer phase={turn.phase} input="" setInput={() => {}}
      onSubmit={turn.submit} onStop={turn.stop} blocked={turn.busy || Boolean(turn.recoveryId)} />);
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
    expect(laterWrite).not.toHaveBeenCalled();
    expect(sequence.pending).toBe(true);
    conversation.clear();
  } finally {
    adoption.resolve();
    await submitted;
    await later;
  }
  expect(await later).toBe("accepted");
  expect(conversation.get().turns).toEqual([]);
  expect(conversation.get().input).toBe("");
  expect(conversation.get().error).toBeNull();
});

it.each([false, true])("keeps a cleared conversation empty when trailing document adoption fails: %s", async (clear) => {
  const adoption = deferred<void>();
  const adopting = deferred<void>();
  const sequence = new DocumentSequence("map");
  const editor: DocumentEditorPort = { sequence, request: fetch, turn: work => sequence.enqueue(async () => {
    await work(); adopting.resolve(); await adoption.promise;
  }) };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/assistant/runs") return Response.json(receipt("run", "reserved"));
    if (url === "/api/assistant/messages") return Response.json(receipt("run", "completed", "Buffered."));
    if (url === "/api/assistant/pending") return Response.json({ pending: [] });
    throw new Error(`Unexpected request: ${url}`);
  }));
  const submitted = paneTurn(editor).submitText("Buffer the parks");
  await adopting.promise;
  try {
    expect(clearState()).toBe("ready");
    if (clear) conversation.clear();
  } finally {
    adoption.reject(new Error("Document read failed."));
    await submitted;
  }
  expect(conversation.get().input).toBe("");
  expect(conversation.get().live.message).toBeUndefined();
  expect(conversation.get().turns).toHaveLength(clear ? 0 : 2);
  expect(conversation.get().error?.message ?? null).toBe(clear ? null : "Document read failed.");
  expect(conversation.locked).toBe(false);
});

it("accepts the next message after clearing, queues it behind adoption, and keeps that new flight locked", async () => {
  const adoption = deferred<void>();
  const adopting = deferred<void>();
  const answering = deferred<Response>();
  const started = deferred<void>();
  const sequence = new DocumentSequence("map");
  const editor: DocumentEditorPort = { sequence, request: fetch, turn: work => sequence.enqueue(async () => {
    await work(); adopting.resolve(); await adoption.promise;
    sequence.accept({ editRevision: "accepted" });
  }) };
  let reservations = 0;
  const messages: { message: string; history: unknown[]; revision: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/assistant/runs") return Response.json(receipt(`run-${++reservations}`, "reserved"));
    if (url === "/api/assistant/messages") {
      messages.push({ ...JSON.parse(init!.body as string), revision: sequence.revision });
      if (messages.length === 1) return Response.json(receipt("run-1", "completed", "Buffered."));
      started.resolve(); return answering.promise;
    }
    if (url === "/api/assistant/pending") return Response.json({ pending: [] });
    throw new Error(`Unexpected request: ${url}`);
  }));
  const turn = paneTurn(editor);
  const first = turn.submitText("Buffer the parks");
  await adopting.promise;
  let second: Promise<void> | undefined;
  try {
    expect(clearState()).toBe("ready");
    conversation.clear();
    second = turn.submitText("List the tables");
    expect(conversation.get().live.message).toBe("List the tables");
    expect(clearState()).toBe("disabled");
    expect(messages).toHaveLength(1);
    adoption.resolve();
    await started.promise;
    await first;
    expect(messages[1]).toMatchObject({ message: "List the tables", history: [], revision: "accepted" });
    expect(conversation.locked).toBe(true);
    expect(conversation.get().busy).toBe(true);
    await turn.submitText("Must not start another run");
    expect(reservations).toBe(2);
  } finally {
    adoption.resolve();
    answering.resolve(Response.json(receipt("run-2", "completed", "Listed.")));
    await first; await second;
  }
  expect(clearState()).toBe("ready");
  expect(conversation.get().turns.map(turn => turn.text)).toEqual(["List the tables", "Listed."]);
});

it("keeps Clear disabled through the settlement read and a parked confirmation", async () => {
  const outcome = deferred<Response>();
  const reading = deferred<void>();
  const adoption = deferred<void>();
  const adopting = deferred<void>();
  const sequence = new DocumentSequence("map");
  const pending = { id: "pending", runId: "run", tool: "delete_table", args: {} };
  const editor: DocumentEditorPort = { sequence, request: fetch, turn: work => sequence.enqueue(async () => {
    await work(); adopting.resolve(); await adoption.promise;
  }) };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/assistant/runs") return Response.json(receipt("run", "reserved"));
    if (url === "/api/assistant/messages") return new Response(`${JSON.stringify({ type: "message", text: "Shall I delete it?" })}\n`);
    if (url === "/api/assistant/runs/run") { reading.resolve(); return outcome.promise; }
    if (url === "/api/assistant/pending") return Response.json({ pending: [pending] });
    throw new Error(`Unexpected request: ${url}`);
  }));
  const submitted = paneTurn(editor).submitText("Delete the table");
  await reading.promise;
  try {
    expect(conversation.get().live.text).toBe("Shall I delete it?");
    expect(clearState()).toBe("disabled");
    outcome.resolve(Response.json({ ...receipt("run", "awaiting_confirmation"), pending }));
    await adopting.promise;
    expect(conversation.get().busy).toBe(false);
    expect(conversation.get().live.pending?.id).toBe("pending");
    expect(clearState()).toBe("disabled");
  } finally {
    outcome.resolve(Response.json({ ...receipt("run", "awaiting_confirmation"), pending }));
    adoption.resolve(); await submitted;
  }
});

it("releases the flight when the editor refuses work before it starts", async () => {
  const sequence = new DocumentSequence("map");
  const editor: DocumentEditorPort = { sequence, request: fetch, turn: async () => { throw new Error("This editor is closed."); } };
  const request = vi.fn(async () => Response.json(receipt("run", "reserved")));
  vi.stubGlobal("fetch", request);
  await paneTurn(editor).submitText("Buffer the parks");
  expect(request).toHaveBeenCalledTimes(1);
  expect(conversation.get().busy).toBe(false);
  expect(conversation.locked).toBe(false);
  expect(conversation.get().live.message).toBe("Buffer the parks");
  expect(conversation.get().error?.message).toBe("This editor is closed.");
});
