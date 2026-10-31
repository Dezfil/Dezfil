import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { AssistantKeyCard } from "./AssistantKeyCard";

/** The card over fake routes that keep a key: every state the spec names, and each sentence. */

const FACTS = { provider: "anthropic", lastFour: "4f2a", savedAt: "2026-10-31T12:00:00.000Z" };
let key: typeof FACTS | null, unreadable: boolean, instanceKey: boolean, writes: { method: string; body?: unknown }[];
let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>, container: HostElement;

beforeEach(() => {
  key = null; unreadable = false; instanceKey = false; writes = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/assistant") return Response.json({ enabled: true, instanceKey });
    if (init.method === "PUT") { const body = JSON.parse(String(init.body)) as { provider: string; key: string }; writes.push({ method: "PUT", body }); key = { provider: body.provider, lastFour: body.key.slice(-4), savedAt: FACTS.savedAt }; unreadable = false; return Response.json({ key, unreadable }); }
    if (init.method === "DELETE") { writes.push({ method: "DELETE" }); const removed = key !== null; key = null; return Response.json({ removed }); }
    return Response.json({ key, unreadable });
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); });

const keyField = () => { const label = container.querySelectorAll("label").find(element => element.textContent === "API key"); return label ? container.querySelector(`[id="${label.getAttribute("for")}"]`) : null; };
async function settle() { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function open() { await act(async () => root.render(<AssistantKeyCard />)); await settle(); }
const text = () => container.textContent ?? "";
const everywhere = () => host.document.body.textContent ?? "";
const buttons = () => host.document.body.querySelectorAll("button").map(button => button.textContent?.trim());
const click = async (label: string) => { await act(async () => { host.document.body.querySelectorAll("button").find(button => button.textContent?.trim() === label)!.dispatchEvent(new HostEvent("click", { bubbles: true, cancelable: true })); }); await settle(); };
const props = (element: HostElement) => (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[Object.keys(element).find(name => name.startsWith("__reactProps$"))!];
const type = (value: string) => act(async () => props(keyField()!).onChange({ target: { value } }));
const submit = async () => { await act(async () => { container.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); }); await settle(); };

it("with no key says so, and adds one: the field clears and the saved state shows", async () => {
  await open();
  expect(text()).toContain("Not set up");
  expect(buttons()).toEqual(["Add key"]);
  await click("Add key");
  expect(buttons()).not.toContain("Save");
  await type("sk-a-real-looking-value-9abc");
  await submit();
  expect(writes).toEqual([{ method: "PUT", body: { provider: "anthropic", key: "sk-a-real-looking-value-9abc" } }]);
  expect(text()).toContain("Anthropic · ends in 9abc");
  expect(text()).toContain("Saved");
  expect(keyField()).toBeNull();
  expect(text()).not.toContain("sk-a-real-looking-value");
});

it("shows a saved key by its last four and its date, never more, with Replace and Remove", async () => {
  key = FACTS;
  await open();
  expect(text()).toContain("Anthropic · ends in 4f2a");
  expect(text()).toContain(`Added ${new Date(FACTS.savedAt).toLocaleDateString()}`);
  expect(buttons()).toEqual(["Replace", "Remove"]);
});

it("replacing says the saved key stays, starts from its provider, and Cancel leaves it", async () => {
  key = FACTS;
  await open();
  await click("Replace");
  expect(text()).toContain("The saved key stays until you save another.");
  expect(container.querySelectorAll('[role="radio"]').find(item => item.getAttribute("aria-checked") === "true")?.textContent).toBe("Anthropic");
  await click("Cancel");
  expect(text()).toContain("Anthropic · ends in 4f2a");
  expect(writes).toEqual([]);
});

it.each([
  [true, "Turns in progress stop. The assistant uses the instance's key for you."],
  [false, "Turns in progress stop. The assistant stops answering you until you add another."],
])("asks before removing, saying what follows (instance key: %s)", async (has, words) => {
  key = FACTS; instanceKey = has;
  await open();
  await click("Remove");
  expect(everywhere()).toContain("Remove your key?");
  expect(everywhere()).toContain(words);
  expect(writes).toEqual([]);
  await click("Cancel");
  expect(writes).toEqual([]);
  await click("Remove");
  await click("Remove key");
  expect(writes).toEqual([{ method: "DELETE" }]);
  expect(text()).toContain("Not set up");
});

it("says the one surprise where the instance has a key too, and nothing where it has none", async () => {
  instanceKey = true;
  await open();
  expect(text()).toContain("This instance's key is used until you add your own.");
  act(() => root.unmount());
  root = createRoot(container as unknown as Element);
  key = FACTS;
  await open();
  expect(text()).toContain("This instance has a key too. Your messages use yours.");
  act(() => root.unmount());
  root = createRoot(container as unknown as Element);
  instanceKey = false;
  await open();
  expect(text()).not.toContain("This instance");
});

it("says to add again a key that can no longer be read, and shows no last four", async () => {
  key = FACTS; unreadable = true;
  await open();
  expect(text()).toContain("Your saved API key can no longer be read. Add it again.");
  expect(text()).not.toContain("4f2a");
  expect(buttons()).toEqual(["Replace", "Remove"]);
});
