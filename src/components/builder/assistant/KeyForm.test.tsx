import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostEvent, installDomHost, type HostElement } from "@/components/testing/dom-host";
import { KeyForm, type KeyStatus } from "./KeyForm";

/** The form alone: what is typed, what is sent, and that nothing else goes anywhere. */

const SAVED: KeyStatus = { key: { provider: "openai", lastFour: "wxyz", savedAt: "2026-10-31T12:00:00.000Z" }, unreadable: false };
let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>, container: HostElement;
let requests: { url: string; method?: string; body?: unknown }[], answer: () => Response;

beforeEach(() => {
  requests = []; answer = () => Response.json(SAVED);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return answer();
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); });

const keyField = () => { const label = container.querySelectorAll("label").find(element => element.textContent === "API key"); return label ? container.querySelector(`[id="${label.getAttribute("for")}"]`) : null; };
async function settle() { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
const field = () => keyField()!;
const buttons = () => container.querySelectorAll("button").map(button => button.textContent?.trim() || button.getAttribute("aria-label"));
const props = (element: HostElement) => (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[Object.keys(element).find(name => name.startsWith("__reactProps$"))!];
const type = (value: string) => act(async () => props(field()).onChange({ target: { value } }));
const click = (label: string) => act(async () => { container.querySelectorAll("button").find(button => (button.textContent?.trim() || button.getAttribute("aria-label")) === label)!.dispatchEvent(new HostEvent("click", { bubbles: true, cancelable: true })); });
const submit = async () => { await act(async () => { container.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); }); await settle(); };

describe("the key form", () => {
  it("shows Save only once text is typed, and hides the text behind its eye", async () => {
    await act(async () => root.render(<KeyForm onSaved={() => {}} />));
    expect(buttons()).not.toContain("Save");
    expect(field().getAttribute("type")).toBe("password");
    await type("   ");
    expect(buttons()).not.toContain("Save");
    await type("sk-a-real-looking-value-1234");
    expect(buttons()).toContain("Save");
    await click("Show key");
    expect(field().getAttribute("type")).toBe("text");
    await click("Hide key");
    expect(field().getAttribute("type")).toBe("password");
    expect(container.textContent).toContain("Use a key with a spending limit, and revoke it at the provider if it leaks.");
  });

  it("sends the provider and the key to the one address, clears the field and reports the save", async () => {
    const saved = vi.fn();
    await act(async () => root.render(<KeyForm initialProvider="openai" onSaved={saved} />));
    await type("sk-a-real-looking-value-wxyz");
    await submit();
    expect(requests).toEqual([{ url: "/api/account/assistant-key", method: "PUT", body: { provider: "openai", key: "sk-a-real-looking-value-wxyz" } }]);
    expect(saved).toHaveBeenCalledWith(SAVED);
    expect(field().getAttribute("value") ?? "").toBe("");
    expect(buttons()).not.toContain("Save");
  });

  it("keeps the text and says why when the save is refused, and reports no save", async () => {
    const saved = vi.fn();
    answer = () => Response.json({ error: { code: "invalid_request", message: "Choose Anthropic or OpenAI and enter a key of 16 to 512 characters with no spaces." } }, { status: 400 });
    await act(async () => root.render(<KeyForm onSaved={saved} />));
    await type("too short");
    await submit();
    expect(saved).not.toHaveBeenCalled();
    expect(container.textContent).toContain("enter a key of 16 to 512 characters");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("value")).toBe("too short");
  });

  it("holds the page while something is typed, and lets go after the save", async () => {
    const holding: boolean[] = [];
    const onHolding = (value: boolean) => { holding.push(value); };
    await act(async () => root.render(<KeyForm onSaved={() => {}} onHolding={onHolding} />));
    expect(holding.at(-1)).toBe(false);
    await type("sk-a-real-looking-value-wxyz");
    expect(holding.at(-1)).toBe(true);
    await submit();
    expect(holding.at(-1)).toBe(false);
  });
});
