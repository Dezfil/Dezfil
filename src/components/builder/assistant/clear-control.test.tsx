import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRef } from "react";
import type { PendingReceipt } from "@/lib/assistant/runs";
import { ASSISTANT_INPUT, clearControl, focusComposer, type ClearState } from "./clear-control";
import { conversation } from "./conversation-store";
import { modelChoice } from "./model-choice-store";
import { emptyTurn } from "./assistant-turn-state";
import { AssistantPane } from "./AssistantShell";
import { AssistantComposer } from "./AssistantComposer";

/**
 * The clear control's own three states: absent with nothing to clear,
 * disabled wherever the conversation is not the person's to end yet, ready
 * otherwise. Each case is decided from the conversation's state alone,
 * which is the state the recovery door reads, so the two can never
 * disagree about whether a run is still outstanding.
 */

const PENDING: PendingReceipt = { id: "p1", runId: "r1", tool: "delete_table", args: {},
  confirmation: { target: "Delete parks_raw?", consequence: "Layers stop drawing." } };
const REST: ClearState = { turns: 0, live: emptyTurn(), busy: false, recoveryId: null };
const state = (over: Partial<ClearState>): ClearState => ({ ...REST, ...over });
const TALKED: Partial<ClearState> = { turns: 2 };

describe("whether there is anything to clear", () => {
  it("is absent with an empty conversation, rather than present and dead", () => {
    expect(clearControl(REST)).toBe("absent");
    // A draft alone is not a conversation: nothing has been said yet.
    expect(clearControl(state({ turns: 0 }))).toBe("absent");
  });

  it("is present once a turn stands, settled or still live", () => {
    expect(clearControl(state(TALKED))).toBe("ready");
    expect(clearControl(state({ live: { ...emptyTurn(), message: "Buffer the parks" } }))).not.toBe("absent");
  });
});

describe("when the conversation is not the person's to end yet", () => {
  it("is disabled with a turn in flight", () => {
    expect(clearControl(state({ ...TALKED, busy: true }))).toBe("disabled");
  });

  it("is disabled with a confirmation card waiting", () => {
    expect(clearControl(state({ ...TALKED, live: { ...emptyTurn(), pending: PENDING } }))).toBe("disabled");
  });

  it("is disabled with a departed run's recovery door shown, which is the door's own state", () => {
    expect(clearControl(state({ ...TALKED, recoveryId: "r1" }))).toBe("disabled");
  });

  it("is disabled while the settlement read is out", () => {
    // The outcome read is about to change the conversation; ending it
    // underneath the read would decide the run's turn by a race.
    expect(clearControl(state({ ...TALKED, busy: true, recoveryId: "r1" }))).toBe("disabled");
  });

  it("is ready again once the turn has settled and no door is shown", () => {
    expect(clearControl(state(TALKED))).toBe("ready");
  });
});

describe("the control as the pane's header draws it (page 05)", () => {
  beforeEach(() => { conversation.resetForTests(); });
  const shell = () =>
    renderToStaticMarkup(
      <AssistantPane
        popRef={createRef<HTMLDivElement>()}
        open
        overlay={false}
        onClose={() => {}}
        onMutate={() => {}}
        layerDataDownloads={{} as never}
      />,
    );

  it("is absent from the header while the conversation is empty", () => {
    expect(shell()).not.toContain("data-clear-conversation");
  });

  it("stands before the close control, named, once a turn stands", () => {
    conversation.set({ turns: [{ role: "user", text: "Buffer the parks", runId: "r1" }] });
    const html = shell();
    expect(html).toContain("data-clear-conversation");
    expect(html).toContain('aria-label="Clear conversation"');
    expect(html.indexOf("data-clear-conversation")).toBeLessThan(html.indexOf('aria-label="Close assistant"'));
    expect(html).not.toMatch(/data-clear-conversation[^>]*disabled/);
    // Nothing explains an enabled control its own name already explains.
    expect(html).not.toMatch(/data-clear-conversation[^>]*title=/);
  });

  it("is greyed and says why while a turn is in flight", () => {
    conversation.set({ turns: [{ role: "user", text: "Buffer the parks", runId: "r1" }], busy: true });
    const html = shell();
    expect(html).toMatch(/data-clear-conversation[^>]*disabled/);
    expect(html).toContain("Press Stop first");
    expect(html).not.toContain("—");
  });
});

describe("what clearing takes with it", () => {
  beforeEach(() => { conversation.resetForTests(); });

  it("takes the turns and the record entries they retain", () => {
    conversation.set({ turns: [
      { role: "user", text: "Buffer the parks", runId: "r1" },
      { role: "assistant", text: "Done.", runId: "r1", entries: [
        { id: "c1", tool: "run_sql", title: "Ran SQL", status: "succeeded" } as never] },
    ] });
    conversation.clear();
    expect(conversation.get().turns).toEqual([]);
  });

  it("takes the live turn, so nothing of the old conversation is left on screen", () => {
    conversation.set({ live: { ...emptyTurn(), message: "Buffer the parks", text: "Working on it" } });
    conversation.clear();
    expect(conversation.get().live).toEqual(emptyTurn());
  });

  it("takes the draft, which belongs to the conversation and not to the page", () => {
    conversation.set({ turns: [{ role: "user", text: "Buffer the parks", runId: "r1" }], input: "and the stations too" });
    conversation.clear();
    expect(conversation.get().input).toBe("");
  });

  it("takes what the pane is still saying about the old turn", () => {
    conversation.set({
      turns: [{ role: "user", text: "Buffer the parks", runId: "r1" }],
      announcements: ["Working on it."],
      error: { code: "assistant_failed", message: "The request failed." },
    });
    conversation.clear();
    expect(conversation.get().announcements).toEqual([]);
    expect(conversation.get().error).toBeNull();
  });

  it("leaves the next message nothing to compose a history from", () => {
    // The pane composes history from the settled list alone. That this
    // reaches the route as an empty history is read from the request the
    // route receives, in e2e/assistant-clear.spec.ts; here it is the
    // list the composition reads.
    conversation.set({ turns: [
      { role: "user", text: "Remember the number 41", runId: "r1" },
      { role: "assistant", text: "Noted.", runId: "r1" }] });
    conversation.clear();
    expect(conversation.get().turns.map(({ role, text }) => ({ role, text }))).toEqual([]);
  });
});

describe("what clearing leaves alone", () => {
  beforeEach(() => { conversation.resetForTests(); modelChoice.resetForTests(); });

  it("leaves the remembered model and effort, which belong to the pane and not to the conversation", () => {
    modelChoice.set({ model: "gpt-6-astra", effort: "xhigh" });
    conversation.set({ turns: [{ role: "user", text: "Buffer the parks", runId: "r1" }] });
    conversation.clear();
    expect(modelChoice.get()).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
  });

  it("leaves a choice the person never made unmade, rather than writing one in passing", () => {
    conversation.set({ turns: [{ role: "user", text: "Buffer the parks", runId: "r1" }] });
    conversation.clear();
    expect(modelChoice.get()).toBeNull();
  });
});

describe("the clear control's reach and where focus goes", () => {
  beforeEach(() => { conversation.resetForTests(); });

  it("is a real button, so the keyboard reaches and activates it as it does the close", () => {
    conversation.set({ turns: [{ role: "user", text: "Buffer the parks", runId: "r1" }] });
    const html = renderToStaticMarkup(
      <AssistantPane popRef={createRef<HTMLDivElement>()} open overlay={false}
        onClose={() => {}} onMutate={() => {}} layerDataDownloads={{} as never} />);
    const control = html.match(/<button[^>]*data-clear-conversation[^>]*>/)?.[0] ?? "";
    expect(control).toContain('type="button"');
    expect(control).not.toContain("tabindex");
    expect(control).toContain('aria-label="Clear conversation"');
  });

  it("aims focus at a hook the composer actually carries, so the move cannot resolve to nothing", () => {
    const html = renderToStaticMarkup(
      <AssistantComposer phase="idle" input="" setInput={() => {}} onSubmit={() => {}} onStop={() => {}} blocked={false} />);
    expect(html).toMatch(new RegExp(`<textarea[^>]*${ASSISTANT_INPUT}`));
    expect(html).toContain('aria-label="Ask the assistant"');
  });

  it("asks for that one element and nothing else, and survives a pane that is not there", () => {
    const asked: string[] = [];
    const input = { focus: () => { asked.push("focused"); } };
    focusComposer({ querySelector: (selector: string) => { asked.push(selector); return input; } } as never);
    expect(asked).toEqual([`textarea[${ASSISTANT_INPUT}]`, "focused"]);
    expect(() => focusComposer(null)).not.toThrow();
  });
});
