import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); conversation.resetForTests(); });

const keyField = () => { const label = container.querySelectorAll("label").find(element => element.textContent === "API key"); return label ? container.querySelector(`[id="${label.getAttribute("for")}"]`) : null; };
async function settle() { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
const props = (element: HostElement) => (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[Object.keys(element).find(name => name.startsWith("__reactProps$"))!];

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
