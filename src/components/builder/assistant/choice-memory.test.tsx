import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelKnowledge } from "@/lib/assistant/model-knowledge";
import { messageAfterFailure } from "./assistant-turn-state";
import { LOCATOR_KEY } from "./conversation-store";
import { boundFor, choicePayload, reconcile } from "./model-choice";
import { CHOICE_KEY, ModelChoiceStore, modelChoice } from "./model-choice-store";
import { ModelPicker } from "./ModelPicker";

/**
 * What the pane remembers between pages, reloads and tabs, and what it
 * does when the instance it remembered against has moved on.
 *
 * The tab's own storage is stubbed here because the suite runs in node.
 * That holds the store's contract — what is written, what is read back,
 * what a second tab sees — and not the browser's; an actual reload and an
 * actual second tab are the browser pass's (task 26).
 */

const MODELS: ModelKnowledge[] = [
  { id: "gpt-5.6-terra", name: "Terra", efforts: [
    { value: "default", label: "Provider default" }, { value: "minimal", label: "Minimal" }, { value: "high", label: "High" }] },
  { id: "gpt-6-astra", name: "Astra", efforts: [
    { value: "default", label: "Provider default" }, { value: "xhigh", label: "XHigh" }] },
  { id: "gpt-5.6-plain", name: "Plain", efforts: [] },
];

/** A tab's session storage, faithful in what this store uses of it. */
function tab() {
  const held = new Map<string, string>();
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => { held.set(key, String(value)); },
    removeItem: (key: string) => { held.delete(key); },
    keys: () => [...held.keys()].sort(),
  };
}
let storage: ReturnType<typeof tab>;
beforeEach(() => {
  storage = tab();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = storage;
  modelChoice.resetForTests();
});
afterEach(() => { delete (globalThis as { sessionStorage?: unknown }).sessionStorage; });

describe("the remembered choice between pages, reloads and tabs", () => {
  it("is what a store built afterwards reads back, which is the reload within the tab", () => {
    modelChoice.set({ model: "gpt-6-astra", effort: "xhigh" });
    expect(new ModelChoiceStore().get()).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
  });

  it("is nothing in a tab that holds nothing, which is the fresh independent tab", () => {
    expect(new ModelChoiceStore().get()).toBeNull();
  });

  it("lives under its own key, so a settling run's locator cannot take it with it", () => {
    modelChoice.set({ model: "gpt-6-astra", effort: "xhigh" });
    storage.setItem(LOCATOR_KEY, JSON.stringify({ id: "r1", message: "Hello" }));
    expect(storage.keys()).toEqual([CHOICE_KEY, LOCATOR_KEY].sort());
    storage.removeItem(LOCATOR_KEY);
    expect(new ModelChoiceStore().get()).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
  });

  it("is dropped from the tab when it is cleared, rather than left behind as a ghost", () => {
    modelChoice.set({ model: "gpt-6-astra", effort: "xhigh" });
    modelChoice.set(null);
    expect(storage.keys()).toEqual([]);
  });

  it("survives nothing it cannot read: a damaged or foreign value is no choice at all", () => {
    for (const raw of ["", "{", '{"model":"gpt-6-astra"}', '{"model":5,"effort":"xhigh"}', '["gpt-6-astra"]']) {
      storage.setItem(CHOICE_KEY, raw);
      expect(new ModelChoiceStore().get(), raw).toBeNull();
    }
  });

  it("is kept even where the tab refuses to store it, so the pane still works", () => {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    const store = new ModelChoiceStore();
    expect(store.get()).toBeNull();
    store.set({ model: "gpt-6-astra", effort: "xhigh" });
    expect(store.get()).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
  });
});

describe("a choice the status read no longer supports", () => {
  it("falls back to the reported default when the model itself is gone", () => {
    expect(reconcile(MODELS, { model: "gpt-5.6-nova", effort: "high" }, "gpt-5.6-terra"))
      .toEqual({ model: "gpt-5.6-terra", effort: "default" });
  });

  it("falls back only in the half that went, when the model stands and the level is gone", () => {
    // The person's model is still offered, so taking it away too would
    // discard a choice the instance can still honour.
    expect(reconcile(MODELS, { model: "gpt-6-astra", effort: "minimal" }, "gpt-5.6-terra"))
      .toEqual({ model: "gpt-6-astra", effort: "default" });
    expect(reconcile(MODELS, { model: "gpt-5.6-plain", effort: "high" }, "gpt-5.6-terra"))
      .toEqual({ model: "gpt-5.6-plain", effort: "default" });
  });

  it("leaves a choice the status still supports exactly as it was, by identity", () => {
    const held = { model: "gpt-6-astra", effort: "xhigh" };
    expect(reconcile(MODELS, held, "gpt-5.6-terra")).toBe(held);
    expect(reconcile(MODELS, null, "gpt-5.6-terra")).toBeNull();
  });

  it("is what the chip shows, so the fallback is visible before another submission", () => {
    modelChoice.set({ model: "gpt-5.6-nova", effort: "high" });
    const html = renderToStaticMarkup(
      <ModelPicker models={MODELS} instanceModel="gpt-5.6-terra" disabled={false} />);
    const words = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(words).toContain("Terra");
    expect(words).not.toContain("nova");
    expect(words).not.toContain("High");
  });

  it("is what the next submission carries, so the ghost never reaches the request", () => {
    // Display and request read the remembered value through the same
    // reconciliation, so the chip cannot show one pair while the request
    // sends another.
    expect(choicePayload(reconcile(MODELS, { model: "gpt-6-astra", effort: "minimal" }, "gpt-5.6-terra")))
      .toEqual({ choice: { model: "gpt-6-astra", effort: "default" } });
    expect(choicePayload(reconcile(MODELS, { model: "gpt-5.6-nova", effort: "high" }, "gpt-5.6-terra")))
      .toEqual({ choice: { model: "gpt-5.6-terra", effort: "default" } });
    // A level-less model falls back the same way, and its neutral level
    // travels like any other: the route offers that entry for every model.
    expect(choicePayload(reconcile(MODELS, { model: "gpt-5.6-plain", effort: "high" }, "gpt-5.6-terra")))
      .toEqual({ choice: { model: "gpt-5.6-plain", effort: "default" } });
  });
});

describe("an instance with nothing to choose", () => {
  // A tab can hold a pair from an instance that has since shrunk to one
  // model, and read it back after a reload. The picker does not stand
  // there, so the pair is one the person can neither see nor reset.
  const ONE = [MODELS[0]];
  const HELD = { model: "gpt-5.6-terra", effort: "high" };

  it("supports no remembered pair, in each of the three ways a pane has nothing to choose", () => {
    expect(reconcile(ONE, HELD, "gpt-5.6-terra")).toBeNull();
    // An instance older than the picker, whose status reports no list.
    expect(reconcile([], HELD, "gpt-5.6-terra")).toBeNull();
    // A pane whose status read has not landed, or failed.
    expect(reconcile(MODELS, HELD, undefined)).toBeNull();
  });

  it("sends nothing, so a level nobody is shown never travels", () => {
    expect(choicePayload(reconcile(ONE, HELD, "gpt-5.6-terra"))).toEqual({});
    // The run is still displayed as bound to the instance's own answer,
    // which is what will in fact answer it.
    expect(boundFor(reconcile(ONE, HELD, "gpt-5.6-terra"), "gpt-5.6-terra"))
      .toEqual({ model: "gpt-5.6-terra", effort: "default" });
  });

  it("takes the pair up again when the instance widens and the status still offers it", () => {
    // Nothing is thrown away: the pair returns where a picker stands to
    // show it, which is where the person can see it and change it.
    expect(reconcile(MODELS, HELD, "gpt-5.6-terra")).toEqual(HELD);
  });
});

describe("a refusal that arrives after a fallback", () => {
  it("keeps the words in the transcript where the run was reserved under them", () => {
    // The refusal is the message request's, so the person's turn is already
    // on screen with its run: the words stay there and the failure is
    // reported beside them.
    expect(messageAfterFailure({ id: "r1", message: "Buffer the parks" }, "Buffer the parks")).toBe("transcript");
  });

  it("puts them back in the draft where no run was reserved under them", () => {
    expect(messageAfterFailure(null, "Buffer the parks")).toBe("draft");
    expect(messageAfterFailure({ id: "r1", message: "An older message" }, "Buffer the parks")).toBe("draft");
  });
});
