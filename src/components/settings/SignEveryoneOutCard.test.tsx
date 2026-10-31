import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ACCOUNT_STORAGE_KEY } from "@/components/auth/private-state";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { SignEveryoneOutCard } from "./SignEveryoneOutCard";

/**
 * Sign everyone out: nothing is sent until the admin answers a question that
 * says what ends, their own session included; then the browser goes to the
 * sign-in page. A refusal stays in the question. The operation is a fake.
 */

let answer: () => Response;
let calls: { url: string; method: string }[];
let replaced: string[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; },
  };
}

beforeEach(async () => {
  calls = []; replaced = [];
  answer = () => Response.json({ signOutGeneration: 1, doorGeneration: 0 });
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => { calls.push({ url, method: init.method ?? "GET" }); return answer(); }));
  host = installDomHost();
  Object.assign(host.window, { location: { origin: "https://dezfil.example", replace: (href: string) => { replaced.push(href); } } });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<SignEveryoneOutCard />));
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

const dialog = () => host.document.querySelector('[role="dialog"]');
const press = (scope: HostElement, label: string) => act(async () => { scope.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

it("sends nothing until the question is answered, and the question says every account's session and token end, the admin's too", async () => {
  await press(container, "Sign everyone out");
  expect(calls).toEqual([]);
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Sign everyone out?");
  expect(dialog()?.textContent).toContain("Every session and API token of every account ends, your own included.");
});

it("leaves everything as it was on Cancel", async () => {
  await press(container, "Sign everyone out");
  await press(dialog()!, "Cancel");
  expect(dialog()).toBeNull();
  expect(calls).toEqual([]);
  expect(replaced).toEqual([]);
});

it("posts to the operation once answered, closes this browser's private memory and goes to sign-in", async () => {
  localStorage.setItem("dezfil:draft", "private");
  await press(container, "Sign everyone out");
  await press(dialog()!, "Sign everyone out");
  await settle();
  expect(calls).toEqual([{ url: "/api/instance/sign-out", method: "POST" }]);
  expect(localStorage.getItem("dezfil:draft")).toBeNull();
  expect(localStorage.getItem(ACCOUNT_STORAGE_KEY)).toBe("");
  expect(replaced).toEqual(["https://dezfil.example/sign-in"]);
});

it("keeps a refusal in the question, in the server's words, and stays on the page", async () => {
  answer = () => Response.json({ error: { code: "admin_required", message: "Only an admin can do this." } }, { status: 403 });
  await press(container, "Sign everyone out");
  await press(dialog()!, "Sign everyone out");
  await settle();
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Only an admin can do this.");
  expect(replaced).toEqual([]);
  expect(dialog()!.querySelectorAll("button").find(button => button.textContent === "Cancel")!.disabled).toBeFalsy();
});
