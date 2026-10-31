import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostEvent, installDomHost, type HostElement } from "@/components/testing/dom-host";
import { conversation } from "./assistant/conversation-store";
import { AssistantPanel } from "./AssistantPanel";

/**
 * The pane with no usable key is the form, and a save shows the composer at once,
 * with no reload: the real turn hook and pane, over fake routes that keep a key.
 */

let saved: string | null, reads: number;
let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>, container: HostElement;

beforeEach(() => {
  saved = null; reads = 0; conversation.resetForTests();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "/api/account/assistant-key" && init.method === "PUT") {
      saved = (JSON.parse(String(init.body)) as { key: string }).key;
      return Response.json({ key: { provider: "anthropic", lastFour: saved.slice(-4), savedAt: "2026-10-31T12:00:00.000Z" }, unreadable: false });
    }
    if (url === "/api/assistant") {
      reads += 1;
      return Response.json(saved
        ? { enabled: true, provider: "anthropic", model: "claude-sonnet-5", stepBudget: 8, instanceKey: false, payer: { kind: "own", provider: "anthropic", lastFour: saved.slice(-4), savedAt: "2026-10-31T12:00:00.000Z" } }
        : { enabled: false, reason: "Add your own API key to use the assistant.", instanceKey: false });
    }
    return Response.json({ pending: [] });
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  // The transcript follows its end, which the host does not lay out.
  Object.getPrototypeOf(container).scrollTo ??= () => {};
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); conversation.resetForTests(); });

const keyField = () => { const label = container.querySelectorAll("label").find(element => element.textContent === "API key"); return label ? container.querySelector(`[id="${label.getAttribute("for")}"]`) : null; };
async function settle() { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
const props = (element: HostElement) => (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[Object.keys(element).find(name => name.startsWith("__reactProps$"))!];

it("reads who pays again when the person comes back to the tab", async () => {
  let payer: { kind: "own" | "instance" } = { kind: "instance" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/assistant"
    ? Response.json({ enabled: true, provider: "anthropic", model: "claude-sonnet-5", stepBudget: 8, instanceKey: true, payer })
    : Response.json({ pending: [] })));
  await act(async () => root.render(<AssistantPanel onMutate={() => {}} layerDataDownloads={{} as never} />));
  await settle();
  expect(container.textContent).toContain("instance key");
  // The key was saved in another tab.
  payer = { kind: "own" };
  await act(async () => { window.dispatchEvent(new HostEvent("focus") as unknown as Event); });
  await settle();
  expect(container.textContent).toContain("your key");
});

it("takes the key in place of the sentence alone, then shows the composer without a reload", async () => {
  await act(async () => root.render(<AssistantPanel onMutate={() => {}} layerDataDownloads={{} as never} />));
  await settle();
  expect(container.textContent).toContain("Add your own API key to use the assistant.");
  const field = keyField()!;
  expect(field).not.toBeNull();
  expect(container.querySelector('[aria-label="Ask the assistant"]')).toBeNull();

  await act(async () => props(field).onChange({ target: { value: "sk-a-real-looking-value-9abc" } }));
  await act(async () => { container.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
  await settle();

  expect(saved).toBe("sk-a-real-looking-value-9abc");
  expect(reads).toBe(2);
  expect(container.querySelector('[aria-label="Ask the assistant"]')).not.toBeNull();
  expect(keyField()).toBeNull();
  expect(container.textContent).not.toContain("sk-a-real-looking-value");
});

describe("a personal key the provider rejects", () => {
  const send = async (message: string) => {
    const composer = container.querySelector('[aria-label="Ask the assistant"]')!;
    await act(async () => props(composer).onChange({ target: { value: message } }));
    await act(async () => { composer.closest("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
    await settle();
  };
  const click = async (label: string) => { await act(async () => { container.querySelectorAll("button").find(button => button.textContent?.trim() === label)!.dispatchEvent(new HostEvent("click", { bubbles: true, cancelable: true })); }); await settle(); };

  it("offers Replace key in the note, with the form in place and the conversation kept", async () => {
    saved = "sk-a-rejected-looking-value-0000";
    const replying = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url === "/api/account/assistant-key" && init.method === "PUT") {
        saved = (JSON.parse(String(init.body)) as { key: string }).key;
        return Response.json({ key: { provider: "anthropic", lastFour: saved.slice(-4), savedAt: "2026-10-31T12:00:00.000Z" }, unreadable: false });
      }
      if (url === "/api/assistant") return Response.json({ enabled: true, provider: "anthropic", model: "claude-sonnet-5", stepBudget: 8, instanceKey: false, payer: { kind: "own", provider: "anthropic", lastFour: saved!.slice(-4), savedAt: "2026-10-31T12:00:00.000Z" } });
      if (url === "/api/assistant/runs") return Response.json({ id: "run-1", state: "reserved", text: "", actions: [], incomplete: false }, { status: 201 });
      if (url === "/api/assistant/messages") return new Response(`${JSON.stringify({ type: "error", code: "assistant_auth", message: "Your Anthropic key was rejected.", detail: "401 invalid x-api-key" })}\n${JSON.stringify({ type: "done", reason: "error" })}\n`, { headers: { "content-type": "application/x-ndjson" } });
      return Response.json({ pending: [] });
    });
    vi.stubGlobal("fetch", replying);
    await act(async () => root.render(<AssistantPanel onMutate={() => {}} layerDataDownloads={{} as never} />));
    await settle();
    await send("Colour the parks.");
    expect(container.textContent).toContain("Your Anthropic key was rejected.");
    expect(container.textContent).toContain("401 invalid x-api-key");

    await click("Replace key");
    expect(keyField()).not.toBeNull();
    expect(container.querySelector('[aria-label="Ask the assistant"]')).toBeNull();
    expect(container.textContent).toContain("Colour the parks.");
    await act(async () => props(keyField()!).onChange({ target: { value: "sk-a-better-looking-value-1111" } }));
    await act(async () => { keyField()!.closest("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
    await settle();

    expect(saved).toBe("sk-a-better-looking-value-1111");
    expect(container.querySelector('[aria-label="Ask the assistant"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Your Anthropic key was rejected.");
    expect(container.textContent).toContain("Colour the parks.");
  });
});
