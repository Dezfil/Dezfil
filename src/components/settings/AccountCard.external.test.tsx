import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { AccountCard } from "./AccountCard";
import { buildSearchIndex, searchSettings } from "./settings-search";
import { settingsDeclarations, type IndexSources } from "./settings-index";

/**
 * The Account card on an instance with a sign-in service: no password to
 * change, the email read-only with the line that says why, the name still
 * typed and saved. The search finds no password row. The server is a fake.
 */

const ADA: Account = {
  id: "ada", name: "Ada Okafor", email: "ada@corp", sqlName: "ada_okafor", isAdmin: false, status: "active",
  isOriginal: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastSignInAt: null,
};

let writes: { url: string; method: string; body: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(async () => {
  writes = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/config") throw new Error("the card asks nothing of the configuration read in the mode");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    writes.push({ url, method: init.method ?? "GET", body });
    return Response.json({ account: { ...ADA, ...body } });
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<AccountCard account={ADA} external />));
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

function field(label: string): HostElement {
  const tag = container.querySelectorAll("label").find(element => element.textContent === label)!;
  return container.querySelector(`[id="${tag.getAttribute("for")}"]`)!;
}
const handlers = (element: HostElement) => (element as unknown as Record<string, { onChange?: (event: unknown) => void; readOnly?: boolean; value?: string }>)[Object.keys(element).find(name => name.startsWith("__reactProps$"))!];
const type = (label: string, text: string) => act(async () => handlers(field(label)).onChange!({ target: { value: text } }));
const save = () => act(async () => {
  container.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
});

it("offers no password to change", () => {
  expect(container.querySelector("details")).toBeNull();
  expect(container.textContent).not.toContain("Change password");
  expect(container.textContent).not.toContain("password");
});

it("shows the email read-only, with the line that says where it comes from", () => {
  const props = handlers(field("Email"));
  expect(props.readOnly).toBe(true);
  expect(props.value).toBe("ada@corp");
  expect(props.onChange).toBeUndefined();
  expect(container.textContent).toContain("Your email comes from the sign-in service.");
});

it("still saves the name, sending the name alone, whatever shape the service's email has", async () => {
  await type("Display name", "Ada Lovelace");
  await save();
  expect(container.querySelectorAll("p").filter(p => /fieldError/.test(p.className))).toEqual([]);
  expect(writes).toEqual([{ url: "/api/account", method: "PATCH", body: { name: "Ada Lovelace" } }]);
  expect(handlers(field("Display name")).value).toBe("Ada Lovelace");
  expect(container.querySelectorAll('[role="status"]').map(element => element.textContent)).toEqual(["Saved"]);
});

it("still refuses a name left empty", async () => {
  await type("Display name", "  ");
  await save();
  expect(writes).toEqual([]);
  expect(container.textContent).toContain("Enter a display name.");
});

it("draws the Password card and an editable email with the mode off", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ passwordMin: 8 })));
  act(() => root.unmount());
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<AccountCard account={{ ...ADA, email: "ada@example.test" }} />));
  expect(container.querySelector("details")?.querySelector("summary")?.textContent).toBe("Change password");
  expect(handlers(field("Email")).readOnly).toBeFalsy();
  expect(container.textContent).not.toContain("Your email comes from the sign-in service.");
});

const search = (external: boolean, query: string) => {
  const sources: IndexSources = { account: ADA, external, tokens: [], look: null, instance: null, entry: null, health: null, assistant: null, palettes: null };
  return searchSettings(buildSearchIndex(settingsDeclarations(sources, false), false), query).map(hit => hit.name);
};
it("leaves the password rows out of the search in the mode, and only then", () => {
  expect(search(true, "change password")).toEqual([]);
  expect(search(false, "change password")).toContain("Change password");
  expect(search(true, "email")).toContain("Email");
});
