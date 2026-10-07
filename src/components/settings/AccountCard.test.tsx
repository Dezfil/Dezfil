import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { DISPLAY_NAME_EVENT } from "../UserBadge";
import { AccountCard } from "./AccountCard";

/**
 * The Account card under the page's Save rule: typed text waits for a
 * Save that shows only while a field differs from what was saved, Saved
 * only on the server's answer, the email's current password asked only
 * while the email changes, and Change password on its own button. The
 * server is a fake answered by hand.
 */

const ADA: Account = {
  id: "ada", name: "Ada Okafor", email: "ada@example.test", sqlName: "ada_okafor", isAdmin: true, status: "active",
  isOriginal: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastSignInAt: null,
};

interface Call { url: string; method: string; body: Record<string, unknown>; answer: (status: number, body: unknown) => Promise<void> }
let calls: Call[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
let renamed: string[];

beforeEach(async () => {
  calls = []; renamed = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit = {}) => new Promise<Response>(resolve => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : {},
      answer: async (status, body) => { await act(async () => { resolve(Response.json(body, { status })); await new Promise(r => setTimeout(r, 0)); }); } });
  })));
  host = installDomHost();
  host.window.addEventListener(DISPLAY_NAME_EVENT, (event: unknown) => { renamed.push((event as CustomEvent<string>).detail); });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<AccountCard account={ADA} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

/** The field a label names. */
function field(label: string): HostElement | null {
  const tag = container.querySelectorAll("label").find(element => element.textContent === label || element.firstChild?.textContent === label);
  if (!tag) return null;
  const target = tag.getAttribute("for");
  return target ? container.querySelector(`[id="${target}"]`) : tag.querySelector("input");
}
async function type(label: string, text: string) {
  const input = field(label)!;
  const key = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
  await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { value: text } }));
}
const buttons = () => container.querySelectorAll("button").map(button => button.textContent);
const button = (label: string) => container.querySelectorAll("button").find(element => element.textContent === label)!;
const statuses = () => container.querySelectorAll('[role="status"]').map(element => element.textContent);
const reds = () => container.querySelectorAll("p").filter(p => /\bfieldError\b/.test(p.className) || p.getAttribute("id")?.endsWith("-error")).map(p => p.textContent);
async function save() {
  const form = container.querySelector("form")!;
  await act(async () => { form.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
}

describe("the Account card", () => {
  it("shows Save and Cancel only while a field differs from what was saved, and Cancel puts it back", async () => {
    expect(buttons()).not.toContain("Save");
    await type("Display name", "Ada Lovelace");
    expect(buttons()).toEqual(expect.arrayContaining(["Save", "Cancel"]));
    await type("Display name", "Ada Okafor");
    expect(buttons()).not.toContain("Save");
    await type("Display name", "Ada L.");
    await act(async () => { button("Cancel").click(); });
    expect(field("Display name")!.value).toBe("Ada Okafor");
    expect(buttons()).not.toContain("Cancel");
  });

  it("writes the name and shows Saved by it only once the server has answered, then tells the rail", async () => {
    await type("Display name", "Ada Lovelace");
    await save();
    expect(calls.map(call => [call.method, call.url, call.body])).toEqual([["PATCH", "/api/account", { name: "Ada Lovelace" }]]);
    expect(statuses()).toEqual([]);
    await calls[0].answer(200, { account: { ...ADA, name: "Ada Lovelace" } });
    expect(statuses()).toEqual(["Saved"]);
    expect(buttons()).not.toContain("Save");
    expect(renamed).toEqual(["Ada Lovelace"]);
  });

  it("asks the current password only while the email changes, and sends it with the email", async () => {
    expect(field("Current password to change email")).toBeNull();
    await type("Email", "ada@lovelace.test");
    await type("Current password to change email", "old secret");
    await type("Email", "ADA@example.test ");
    expect(field("Current password to change email")).toBeNull();
    await type("Email", "ada@lovelace.test");
    expect(field("Current password to change email")!.value).toBe("");
    await type("Current password to change email", "old secret");
    await save();
    expect(calls[0].body).toEqual({ name: "Ada Okafor", email: "ada@lovelace.test", currentPassword: "old secret" });
    await calls[0].answer(200, { account: { ...ADA, email: "ada@lovelace.test" } });
    expect(field("Current password to change email")).toBeNull();
    expect(field("Email")!.value).toBe("ada@lovelace.test");
    expect(statuses()).toEqual(["Saved"]);
  });

  it("checks its fields on Save, with the red line under each and nothing sent", async () => {
    await type("Display name", "  ");
    await save();
    expect(reds()).toEqual(["Enter a display name."]);
    await type("Display name", "Ada");
    await type("Email", "ada at example");
    await save();
    expect(reds()).toEqual(["Enter an email address like name@example.com."]);
    await type("Email", "ada@lovelace.test");
    await save();
    expect(reds()).toEqual(["Enter your current password to change your email."]);
    expect(calls).toEqual([]);
  });

  it("keeps a refusal as the card's note in the server's words, the text still unsaved", async () => {
    await type("Email", "ada@lovelace.test");
    await type("Current password to change email", "wrong");
    await save();
    await calls[0].answer(403, { error: { code: "current_password_required", message: "Enter your current password." } });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter your current password.");
    expect(statuses()).toEqual([]);
    expect(buttons()).toContain("Save");
    expect(field("Email")!.value).toBe("ada@lovelace.test");
  });

  it("keeps Change password on its own button, always shown, with its shipped words", async () => {
    const details = container.querySelector("details")!;
    expect(details.getAttribute("id")).toBe("password");
    expect(details.querySelector("summary")?.textContent).toBe("Change password");
    expect(button("Change password").disabled).toBe(true);
    await type("Current password", "old secret");
    await type("New password", "new secret words");
    expect(button("Change password").disabled).toBe(false);
    const form = details.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
    expect(calls.map(call => [call.method, call.url, call.body])).toEqual([["POST", "/api/account/password", { currentPassword: "old secret", password: "new secret words" }]]);
    await calls[0].answer(200, { changed: true });
    expect(statuses()).toEqual(["Password changed"]);
    expect(container.textContent).toContain("Your other browser sessions will end. API tokens stay valid.");
  });
});
