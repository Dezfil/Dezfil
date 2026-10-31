import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostElement, installDomHost } from "../testing/dom-host";
import { instanceReadFixture } from "./read-fixture";
import { SecurityTab } from "./SecurityTab";

/**
 * Security: the Sign-in and API tokens cards drawn from the configuration
 * read, each choice kept at once through the write, each count kept when
 * typed on Enter or leaving, Saved only once the write is answered, the
 * refusals as the red line under their row, and Reset then Undo per card.
 * The server is a fake that applies a write the way the foundation does (a
 * null returns the default), refuses the two sign-in counts that do not
 * hold together in the server's own words, and answers with the whole read.
 */

const TOGETHER = "security.failedPerAddress must be at least security.failedPerAccount.";

let stored: Record<string, unknown>;
let held: (() => void)[] | null;
let requests: { url: string; method: string; body: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

const answer = () => instanceReadFixture(Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, source: "stored", storedValue: value }])));

beforeEach(() => {
  stored = {}; held = null; requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url === "/api/instance/settings" && method === "GET") return Response.json(answer());
    if (url === "/api/instance/settings" && method === "PATCH") {
      if (held) await new Promise<void>(resolve => held!.push(resolve));
      const next = Object.fromEntries(Object.entries({ ...stored, ...body as Record<string, unknown> }).filter(([, value]) => value !== null));
      if (Number(next["security.failedPerAddress"] ?? 20) < Number(next["security.failedPerAccount"] ?? 5)) {
        return Response.json({ error: { code: "invalid_request", message: TOGETHER } }, { status: 400 });
      }
      stored = next;
      return Response.json(answer());
    }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function open() {
  await act(async () => root.render(<SecurityTab />));
  await settle();
}
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const cards = () => container.querySelectorAll("section");
const card = (title: string) => cards().find(section => section.querySelector("h2")?.textContent === title)!;
const row = (label: string) => container.querySelector(`[id="${container.querySelectorAll("b").find(b => b.textContent === label)!.id.replace(/-label$/, "")}"]`)!;
const field = (label: string) => container.querySelectorAll("input").find(input => input.getAttribute("aria-label") === label)!;
const select = (label: string) => container.querySelectorAll("select").find(element => element.getAttribute("aria-label") === label)!;
/** The value a select is drawn with, and the words of its options. */
const chosen = (label: string) => (props(select(label)) as unknown as { value: string }).value;
const options = (label: string) => select(label).querySelectorAll("option").map(option => [option.getAttribute("value"), option.textContent]);
const choose = (label: string, value: string) => act(async () => props(select(label)).onChange({ target: { value } }));
const radios = (group: string) => container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!.querySelectorAll('[role="radio"]');
const checked = (group: string) => radios(group).filter(radio => radio.getAttribute("aria-checked") === "true").map(radio => radio.textContent);
const pick = (group: string, name: string) => act(async () => { radios(group).find(radio => radio.textContent === name)!.click(); });
const typed = { inputType: "insertText" };
const type = (label: string, text: string) => act(async () => props(field(label)).onChange({ target: { value: text }, nativeEvent: typed }));
const leave = (label: string) => act(async () => props(field(label)).onBlur({}));
const enter = (label: string) => act(async () => props(field(label)).onKeyDown({ key: "Enter", preventDefault() {}, nativeEvent: {} }));
const writes = () => requests.filter(request => request.method === "PATCH").map(request => request.body);
const saved = (label: string) => row(label).querySelectorAll('[role="status"]').map(element => element.textContent);
const press = (scope: HostElement, label: string) => act(async () => { scope.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
const resets = () => container.querySelectorAll("[data-unit-slot]").map(button => button.getAttribute("aria-label"));
const release = () => act(async () => { for (const respond of held!.splice(0)) respond(); });

describe("Security", () => {
  it("draws the Sign-in and API tokens cards with their rows, at the read's values, and Sign everyone out below them", async () => {
    await open();
    expect(requests.map(request => request.url)).toEqual(["/api/instance/settings"]);
    expect(cards().map(section => section.querySelector("h2")!.textContent)).toEqual(["Sign-in", "API tokens", "Sign everyone out"]);
    expect(container.querySelectorAll("b").map(b => b.textContent)).toEqual([
      "Stay signed in for", "Invite and reset links last", "Failed sign-ins before a pause", "Shortest password",
      "Who may create tokens", "New tokens expire after",
    ]);
    expect(options("Stay signed in for")).toEqual([["1", "1 day"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]]);
    expect(chosen("Stay signed in for")).toBe("30");
    expect(row("Stay signed in for").textContent).toContain("Counted from the last visit.");
    expect(options("Invite and reset links last")).toEqual([["1", "1 day"], ["3", "3 days"], ["7", "7 days"], ["14", "14 days"]]);
    expect(chosen("Invite and reset links last")).toBe("7");
    expect([field("Failed sign-ins per account").value, field("Failed sign-ins per address").value]).toEqual(["5", "20"]);
    expect([field("Failed sign-ins per account").getAttribute("min"), field("Failed sign-ins per account").getAttribute("max")]).toEqual(["3", "100"]);
    expect([field("Failed sign-ins per address").getAttribute("min"), field("Failed sign-ins per address").getAttribute("max")]).toEqual(["10", "1000"]);
    expect(row("Failed sign-ins before a pause").textContent).toContain("per account");
    expect(row("Failed sign-ins before a pause").textContent).toContain("per address");
    expect(row("Failed sign-ins before a pause").textContent).toContain("within 15 minutes");
    expect(field("Shortest password").value).toBe("8");
    expect([field("Shortest password").getAttribute("min"), field("Shortest password").getAttribute("max")]).toEqual(["8", "64"]);
    expect(row("Shortest password").textContent).toContain("characters");
    expect(radios("Who may create tokens").map(radio => radio.textContent)).toEqual(["Everyone", "Admins only"]);
    expect(checked("Who may create tokens")).toEqual(["Everyone"]);
    expect(options("New tokens expire after")).toEqual([["never", "Never"], ["30d", "30 days"], ["90d", "90 days"], ["1y", "1 year"]]);
    expect(chosen("New tokens expire after")).toBe("never");
    // At the defaults there is nothing to reset and no note opened by a choice.
    expect(resets()).toEqual([]);
    expect(container.textContent).not.toContain("keep working");
    expect(container.textContent).not.toContain("keep their own expiry");
  });

  it("keeps a choice at once, with Saved by its row only on the response", async () => {
    await open();
    held = [];
    await choose("Stay signed in for", "1");
    expect(writes()).toEqual([{ "security.sessionDays": "1" }]);
    expect(chosen("Stay signed in for")).toBe("1");
    expect(saved("Stay signed in for")).toEqual([]);
    await release();
    await settle();
    expect(saved("Stay signed in for")).toEqual(["Saved"]);
    held = null;
    await pick("Who may create tokens", "Admins only");
    await settle();
    expect(writes()[1]).toEqual({ "tokens.create": "admins" });
    expect(saved("Who may create tokens")).toEqual(["Saved"]);
    expect(row("Who may create tokens").textContent).toContain("Tokens members already have keep working.");
    await choose("New tokens expire after", "90d");
    await settle();
    expect(writes()[2]).toEqual({ "tokens.expiry": "90d" });
    expect(row("New tokens expire after").textContent).toContain("Tokens made earlier keep their own expiry.");
  });

  it("keeps a typed count on Enter or leaving, never while typing", async () => {
    await open();
    await type("Failed sign-ins per account", "7");
    expect(writes()).toEqual([]);
    await leave("Failed sign-ins per account");
    await settle();
    expect(writes()).toEqual([{ "security.failedPerAccount": 7 }]);
    expect(saved("Failed sign-ins before a pause")).toEqual(["Saved"]);
    await type("Shortest password", "12");
    await enter("Shortest password");
    await settle();
    expect(writes()[1]).toEqual({ "security.passwordMin": 12 });
    expect(saved("Shortest password")).toEqual(["Saved"]);
  });

  it("refuses a count outside the read's range before any request, with the red line under its row", async () => {
    await open();
    await type("Failed sign-ins per account", "2");
    await leave("Failed sign-ins per account");
    await type("Shortest password", "65");
    await leave("Shortest password");
    await settle();
    expect(writes()).toEqual([]);
    expect(row("Failed sign-ins before a pause").textContent).toContain("Per account: Enter a number from 3 to 100.");
    expect(field("Failed sign-ins per account").getAttribute("aria-invalid")).toBe("true");
    expect(row("Shortest password").textContent).toContain("Enter a number from 8 to 64.");
  });

  it("draws the server's refusal of counts that do not hold together under their row, in the page's words, keeping nothing", async () => {
    await open();
    await type("Failed sign-ins per account", "30");
    await leave("Failed sign-ins per account");
    await settle();
    expect(writes()).toEqual([{ "security.failedPerAccount": 30 }]);
    expect(stored).toEqual({});
    const text = row("Failed sign-ins before a pause").textContent;
    expect(text).toContain("Allow at least as many per address as per account.");
    expect(text).not.toContain("security.");
    expect(text).not.toContain("Per account:");
    expect(saved("Failed sign-ins before a pause")).toEqual([]);
  });

  it("resets a card to the read's defaults in one write, then offers Undo", async () => {
    stored = { "security.sessionDays": "90", "security.failedPerAccount": 10, "security.passwordMin": 12, "tokens.expiry": "30d" };
    await open();
    expect(resets()).toEqual(["Reset to defaults: Sign-in", "Reset to defaults: API tokens"]);
    await press(card("Sign-in"), "Reset to defaults");
    await settle();
    expect(writes()).toEqual([{
      "security.sessionDays": null, "security.linkDays": null, "security.failedPerAccount": null,
      "security.failedPerAddress": null, "security.passwordMin": null,
    }]);
    expect([chosen("Stay signed in for"), field("Failed sign-ins per account").value, field("Shortest password").value]).toEqual(["30", "5", "8"]);
    // The other card keeps its own.
    expect(chosen("New tokens expire after")).toBe("30d");
    await press(card("Sign-in"), "Undo");
    await settle();
    expect(writes()[1]).toEqual({ "security.sessionDays": "90", "security.failedPerAccount": 10, "security.passwordMin": 12 });
    expect([chosen("Stay signed in for"), field("Failed sign-ins per account").value, field("Shortest password").value]).toEqual(["90", "10", "12"]);
  });
});

describe("the words of Security", () => {
  /** Every word the tab may draw, written out by hand: titles, labels, the
   * choices' words, the counts' units, the actions, and the quiet lines that
   * each name a surprise. */
  const SAYS = new Set([
    "Sign-in", "Stay signed in for", "Invite and reset links last", "Failed sign-ins before a pause", "Shortest password",
    "1 day", "3 days", "7 days", "14 days", "30 days", "90 days", "per account", "per address", "within 15 minutes", "characters",
    "API tokens", "Who may create tokens", "Everyone", "Admins only", "New tokens expire after", "Never", "1 year",
    "Reset to defaults", "Undo", "Saved",
    // A session's length runs from its last use, not from signing in.
    "Counted from the last visit.",
    // Passwords already set are not checked again.
    "Checked when a password is next set.",
    // Sign everyone out, and what it ends, which no setting's save does.
    "Sign everyone out", "Ends every session and API token of every account, yours included.",
    // Narrowing who may create tokens takes none away.
    "Tokens members already have keep working.",
    // A new expiry reaches no token already made.
    "Tokens made earlier keep their own expiry.",
  ]);
  /** Every text the tab draws, its drawings left out. */
  const said = (element: HostElement): string[] => element.childNodes.flatMap(node => node instanceof HostElement
    ? (node.getAttribute("aria-hidden") === "true" ? [] : said(node)) : [node.textContent.trim()]).filter(Boolean);
  const everything = () => [container.textContent, ...container.descendants().flatMap(element => [...element.attributes.values()])];
  function holdsTheCopyRules() {
    expect(said(container).filter(text => !SAYS.has(text))).toEqual([]);
    expect(container.descendants().filter(element => element.hasAttribute("data-hint") || element.hasAttribute("title")).map(element => element.tagName)).toEqual([]);
    expect(everything().filter(text => text.includes("\u2014"))).toEqual([]);
  }

  it("says only its titles, labels, choices, units, actions and its surprises", async () => {
    stored = { "security.linkDays": "3" };
    await open();
    holdsTheCopyRules();
    await pick("Who may create tokens", "Admins only");
    await choose("New tokens expire after", "1y");
    await settle();
    expect(said(container)).toEqual(expect.arrayContaining(["Saved", "Tokens members already have keep working.", "Tokens made earlier keep their own expiry."]));
    holdsTheCopyRules();
    await press(card("Sign-in"), "Reset to defaults");
    await settle();
    expect(said(container)).toContain("Undo");
    holdsTheCopyRules();
  });
});
