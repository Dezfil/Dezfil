import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cssRules } from "../testing/css-rules";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { SignedIn } from "./signed-in";
import { PEOPLE_CHANGED_EVENT } from "./use-project-people";
import type { ProjectPersonWire } from "./people";
import { ShareDialog } from "./ShareDialog";

/**
 * The share dialog, one sheet, as Ada (the owner) opens it on Berlin
 * housing study, shared with Bo as Editor and Cy (deactivated) as Viewer:
 * the people field with the Viewer or Editor choice and Add, the directory
 * behind it with its miss line; the members with Ada pinned first, a role
 * menu with Make owner, remove on hover, Cy's row dimmed and marked; the
 * hand-over revealed with its one sentence; the line naming a dataset that
 * refreshes through Ada's connection. Every change is a call to the API;
 * every refusal is the API's own sentence in the shipped note.
 */

// The menus as inline lists, so their items can be pressed in the node host.
vi.mock("../ui/Menu", () => ({
  Menu: ({ children, label, triggerLabel, trigger }: { children: React.ReactNode; label: string; triggerLabel?: string; trigger: React.ReactNode }) => (
    <div data-menu={label}>
      <button type="button" aria-label={triggerLabel ?? label}>{trigger}</button>
      {children}
    </div>
  ),
  MenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" role="menuitem" onClick={onSelect}>{children}</button>
  ),
}));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const person = (sqlName: string, name: string, role: ProjectPersonWire["role"], deactivated = false): ProjectPersonWire =>
  ({ sqlName, name, role, deactivated });

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let people: ProjectPersonWire[];
let directory: { name: string; sqlName: string; pictureVersion?: string }[];
let refuse: string | null;
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let transferred: string | null;
let peopleChanged: number;
beforeEach(() => {
  calls = [];
  refuse = null;
  transferred = null;
  peopleChanged = 0;
  people = [person("ada", "Ada Okafor", "owner"), person("bo", "Bo Lindqvist", "editor"), person("cy", "Cy Marsh", "viewer", true)];
  directory = [{ name: "Eli Brandt", sqlName: "eli" }, { name: "Bo Lindqvist", sqlName: "bo" }];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: input, method, body });
    if (input.startsWith("/api/accounts/search")) {
      const q = new URL(input, "http://x").searchParams.get("q")!.toLowerCase();
      return answer(200, { accounts: directory.filter((p) => p.name.toLowerCase().includes(q)) });
    }
    if (refuse && method !== "GET") return answer(400, { error: { code: "invalid_request", message: refuse } });
    const m = /^\/api\/projects\/berlin\/people(?:\/(\w+))?$/.exec(input);
    if (m && method === "GET") return answer(200, { people });
    if (m && method === "PUT") {
      const known = people.find((p) => p.sqlName === m[1]);
      people = known
        ? people.map((p) => (p.sqlName === m[1] ? { ...p, role: body.role } : p))
        : [...people, person(m[1], directory.find((p) => p.sqlName === m[1])!.name, body.role)];
      return answer(200, { people });
    }
    if (m && method === "DELETE") {
      people = people.filter((p) => p.sqlName !== m[1]);
      return answer(200, { people });
    }
    if (input === "/api/projects/berlin/transfer") return answer(200, { id: "berlin", owner: { name: "Bo Lindqvist", sqlName: "bo" } });
    throw new Error(`unexpected ${method} ${input}`);
  }));
  host = installDomHost();
  host.window.addEventListener(PEOPLE_CHANGED_EVENT, () => { peopleChanged += 1; });
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function open(tables: unknown[] = []) {
  await act(async () => {
    root.render(
      <SignedIn account={ada}>
        <ShareDialog projectId="berlin" projectName="Berlin housing study" counts={{ maps: 3, workflows: 1, datasets: 5 }}
          tables={tables as never} onClose={() => {}} onTransferred={(s) => { transferred = s; }} />
      </SignedIn>,
    );
  });
  await settle();
}
const doc = () => host.document;
const q = (selector: string) => doc().querySelector(selector);
const text = () => doc().body.textContent;
const button = (label: string) => doc().querySelectorAll("button").find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const click = (el: HostElement | null | undefined) => act(async () => { el!.click(); await new Promise((r) => setTimeout(r, 0)); });
/** React's own handler on a node: the node host fires no input events. */
function handler(el: HostElement, name: string) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key][name];
}
async function type(value: string) {
  const input = q('input[aria-label="Add people by name or email"]')!;
  await act(async () => handler(input, "onChange")({ target: { value } }));
  await wait(200);
}
async function key(name: string) {
  const input = q('input[aria-label="Add people by name or email"]')!;
  await act(async () => handler(input, "onKeyDown")({ key: name, preventDefault() {}, stopPropagation() {} }));
}

describe("the share dialog's faces", () => {
  const picture = (el: HostElement | null) => el?.querySelector("[data-face]")?.querySelector("img")?.getAttribute("src") ?? null;

  it("draws each person's picture where their initials stand: the members, the results and the person picked", async () => {
    people = [{ ...person("ada", "Ada Okafor", "owner"), pictureVersion: "a1" }, person("bo", "Bo Lindqvist", "editor"),
      { ...person("cy", "Cy Marsh", "viewer", true), pictureVersion: "c1" }];
    directory = [{ name: "Eli Brandt", sqlName: "eli", pictureVersion: "e1" }, { name: "Bo Lindqvist", sqlName: "bo" }];
    await open();
    expect(picture(q('[data-member="ada"]'))).toBe("/api/accounts/ada/picture?v=a1");
    expect(picture(q('[data-member="cy"]'))).toBe("/api/accounts/cy/picture?v=c1");
    expect(picture(q('[data-member="bo"]'))).toBeNull();
    expect(q('[data-member="bo"]')!.querySelector("[data-face]")?.textContent).toBe("BL");
    await type("b");
    expect(picture(q('[data-result="eli"]'))).toBe("/api/accounts/eli/picture?v=e1");
    expect(q('[data-result="eli"]')!.querySelector("[data-face]")?.textContent).toBe("EB");
    expect(picture(q('[data-result="bo"]'))).toBeNull();
    await click(q('[data-result="eli"]'));
    expect(picture(q('[data-picked="eli"]'))).toBe("/api/accounts/eli/picture?v=e1");
  });

  it("dims a deactivated member's picture with their row, as their initials are", async () => {
    people = [person("ada", "Ada Okafor", "owner"), { ...person("cy", "Cy Marsh", "viewer", true), pictureVersion: "c1" }];
    await open();
    const face = q('[data-member="cy"]')!.querySelector("[data-face]")!;
    expect(q('[data-member="cy"]')!.hasAttribute("data-off")).toBe(true);
    expect(face.className).toMatch(/avatar/);
    const dim = cssRules("src/components/sharing/ShareDialog.module.css").filter((rule) => rule.selector === ".row[data-off] .avatar");
    expect(dim.map((rule) => /opacity:\s*([^;]+);/.exec(rule.body)?.[1])).toEqual(["0.5"]);
  });
});

describe("the share dialog", () => {
  it("heads the sheet with the project and what people get", async () => {
    await open();
    expect(q('[role="dialog"]')?.getAttribute("aria-label")).toBe("Share Berlin housing study");
    expect(text()).toContain("People get everything in it: 3 maps, 1 workflow, 5 datasets.");
  });

  it("lists the owner first, marked as you, each person with their SQL name", async () => {
    await open();
    const rows = doc().querySelectorAll("[data-member]").map((r) => r.getAttribute("data-member"));
    expect(rows).toEqual(["ada", "bo", "cy"]);
    const own = q('[data-member="ada"]')!;
    expect(own.textContent).toContain("You");
    expect(own.textContent).toContain("ada");
    expect(own.querySelector('[aria-label="Remove Ada Okafor"]')).toBeNull();
    expect(q('[data-member="bo"]')!.textContent).toContain("bo");
  });

  it("dims and marks a deactivated member, keeps the role they held, and lets them be removed", async () => {
    await open();
    const cy = q('[data-member="cy"]')!;
    expect(cy.hasAttribute("data-off")).toBe(true);
    expect(cy.textContent).toContain("Deactivated");
    expect(cy.textContent).toContain("Viewer");
    expect(cy.querySelector("[data-menu]")).toBeNull();
    expect(cy.querySelector('[aria-label="Remove Cy Marsh"]')).toBeTruthy();
  });

  it("finds a person in the directory, marks one who already has access, and adds the one picked with the chosen role", async () => {
    await open();
    await type("b");
    expect(calls.some((c) => c.url === "/api/accounts/search?q=b")).toBe(true);
    const bo = q('[data-result="bo"]')!;
    expect(bo.disabled).toBe(true);
    expect(bo.textContent).toContain("Editor");
    await click(q('[data-result="eli"]'));
    expect(q('[data-picked="eli"]')).toBeTruthy();
    await click(button("Editor"));
    await click(button("Add"));
    expect(calls.filter((c) => c.method === "PUT")).toEqual([{ url: "/api/projects/berlin/people/eli", method: "PUT", body: { role: "editor" } }]);
    expect(q('[role="status"]')?.textContent).toBe("Added Eli Brandt as Editor.");
    expect(q('[data-member="eli"]')).toBeTruthy();
    expect(q('[data-picked="eli"]')).toBeNull();
    expect(peopleChanged).toBeGreaterThan(0);
  });

  it("picks with the keyboard and adds as Viewer by default", async () => {
    await open();
    await type("eli");
    await key("Enter");
    expect(q('[data-picked="eli"]')).toBeTruthy();
    await key("Enter");
    expect(calls.filter((c) => c.method === "PUT")[0]?.body).toEqual({ role: "viewer" });
  });

  it("says a miss in one sentence and where accounts come from", async () => {
    await open();
    await type("zed");
    expect(q("[data-share-miss]")?.textContent).toBe("No account with that name.An admin adds accounts on the Users page.");
    await type("zed@harbour.example");
    expect(q("[data-share-miss]")?.textContent).toContain("No account with that email.");
  });

  it("changes a member's role from the role menu", async () => {
    await open();
    const menu = q('[data-member="bo"]')!.querySelector("[data-menu]")!;
    expect(menu.querySelectorAll('[role="menuitem"]').map((i) => i.textContent)).toEqual(["Viewer", "Editor", "Make owner"]);
    await click(menu.querySelectorAll('[role="menuitem"]')[0]);
    expect(calls.find((c) => c.method === "PUT")).toEqual({ url: "/api/projects/berlin/people/bo", method: "PUT", body: { role: "viewer" } });
    expect(q('[role="status"]')?.textContent).toBe("Bo Lindqvist is now a Viewer.");
  });

  it("removes a member, and Undo gives them back the role they held", async () => {
    await open();
    await click(button("Remove Bo Lindqvist"));
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/projects/berlin/people/bo");
    expect(q('[data-member="bo"]')).toBeNull();
    expect(q('[role="status"]')?.textContent).toBe("Removed Bo Lindqvist.Undo");
    await click(button("Undo"));
    expect(calls.filter((c) => c.method === "PUT").at(-1)).toEqual({ url: "/api/projects/berlin/people/bo", method: "PUT", body: { role: "editor" } });
    expect(q('[data-member="bo"]')).toBeTruthy();
  });

  it("reveals the hand-over under the owner's row, with its one sentence, and hands the project over", async () => {
    await open();
    expect(q("[data-hand-over]")).toBeNull();
    const ownerMenu = q('[data-member="ada"]')!.querySelector("[data-menu]")!;
    await click(ownerMenu.querySelector('[role="menuitem"]'));
    const reveal = q("[data-hand-over]")!;
    expect(reveal.textContent).toContain("Bo becomes the owner of Berlin housing study. You stay as Editor.");
    // Only an active member can receive it.
    expect(reveal.querySelectorAll("option").map((o) => o.getAttribute("value"))).toEqual(["bo"]);
    await click(q("[data-hand-over-confirm]"));
    expect(calls.find((c) => c.method === "POST")).toEqual({ url: "/api/projects/berlin/transfer", method: "POST", body: { to: "bo" } });
    expect(transferred).toBe("Bo Lindqvist owns Berlin housing study now.");
  });

  it("opens the hand-over from a member's Make owner on that member", async () => {
    await open();
    const menu = q('[data-member="bo"]')!.querySelector("[data-menu]")!;
    await click(menu.querySelectorAll('[role="menuitem"]').find((i) => i.textContent === "Make owner"));
    expect(q("[data-hand-over]")?.textContent).toContain("Bo becomes the owner");
  });

  it("offers no hand-over while no active member could receive it", async () => {
    people = [person("ada", "Ada Okafor", "owner"), person("cy", "Cy Marsh", "viewer", true)];
    await open();
    expect(q('[data-member="ada"]')!.querySelector("[data-menu]")).toBeNull();
    expect(q('[data-member="ada"]')!.textContent).toContain("Owner");
  });

  it("says a refusal in the API's own sentence, in the shipped note", async () => {
    await open();
    refuse = "No active person has that SQL name.";
    await type("eli");
    await click(q('[data-result="eli"]'));
    await click(button("Add"));
    expect(text()).toContain("No active person has that SQL name.");
    expect(q('[data-member="eli"]')).toBeNull();
  });

  it("names a dataset that refreshes through the owner's connection, once, and nothing otherwise", async () => {
    const roads = { name: "roads", owner: ada, source: "postgis", sourceParams: { connectionName: "city_gis" } };
    await open([roads]);
    expect(q("[data-connection-line]")?.textContent).toBe("roads refreshes from your city_gis connection. Only you can refresh it.");
    act(() => root.unmount());
    root = createRoot(doc().body.appendChild(doc().createElement("div")) as unknown as Element);
    await open([{ ...roads, source: "upload", sourceParams: null }]);
    expect(q("[data-connection-line]")).toBeNull();
  });
});
