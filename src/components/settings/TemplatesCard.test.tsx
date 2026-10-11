import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceTestAnswer } from "@/lib/settings/service-test-answer";
import type { TemplateDownloads } from "@/lib/templates/card";
import { HostElement, HostEvent, installDomHost } from "../testing/dom-host";
import { DataTab } from "./DataTab";
import { instanceReadFixture, type Resolution } from "./read-fixture";
import { settingsColumn } from "./settings-tabs";

/**
 * Data & services' Templates card, drawn in its tab for an admin (the tab
 * is an admin's alone, so a member never sees it): whether the server
 * reads the template catalogue, kept at once, with Reset turning it back
 * on; the catalogue's address as a service address, its default the
 * release catalogue, a folder the variable names shown with no path; the
 * Test, answering how many the catalogue lists and the time, or 0230's
 * reasons, and offered only while the catalogue is in use; and the
 * downloaded templates from the template list, with Remove all behind its
 * question. The server is a fake that keeps an address as the read
 * discloses it, refuses anything but an http or https address in the
 * write's words, answers each Test as the test sets it, and removes the
 * downloads it holds.
 */

const MIB = 1024 * 1024;
const KEY = "SEEDED-KEY-0003-QUERY";
const NOT_AN_ADDRESS = "templatesCatalogueUrl: Expected an http or https address of at most 2048 characters.";
const FOLDER = "/srv/SEEDED-KEY-0003-PATH/catalogue";

let stored: Record<string, unknown>;
let addresses: Record<string, { set: true; origin: string }>;
let pinned: Record<string, Resolution>;
let downloads: TemplateDownloads;
let test: ServiceTestAnswer | { status: number; code: string; message: string };
let requests: { url: string; method: string; body: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

const answer = () => instanceReadFixture({
  ...Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, source: "stored" as const, storedValue: value }])),
  ...Object.fromEntries(Object.entries(addresses).map(([key, value]) => [key, { value, source: "stored" as const, storedValue: null }])),
  ...pinned,
});

beforeEach(() => {
  stored = {}; addresses = {}; pinned = {}; requests = [];
  downloads = { versions: 2, bytes: 4.1 * MIB };
  test = { service: "templates", result: "passed", templates: 3, milliseconds: 140 };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url === "/api/instance/settings" && method === "GET") return Response.json(answer());
    if (url === "/api/instance/settings" && method === "PATCH") {
      const value = (body as Record<string, unknown>).templatesCatalogueUrl;
      if (typeof value === "string" && !/^https?:\/\//.test(value)) {
        return Response.json({ error: { code: "invalid_request", message: NOT_AN_ADDRESS } }, { status: 400 });
      }
      for (const [key, each] of Object.entries(body as Record<string, unknown>)) {
        if (each === null) { delete stored[key]; delete addresses[key]; }
        else if (key === "templatesCatalogueUrl") addresses[key] = { set: true, origin: new URL(String(each)).origin };
        else stored[key] = each;
      }
      return Response.json(answer());
    }
    if (url === "/api/instance/services/templates/test" && method === "POST") {
      if ("code" in test) return Response.json({ error: { code: test.code, message: test.message } }, { status: test.status });
      return Response.json(test);
    }
    if (url === "/api/templates" && method === "GET") {
      return Response.json({ templates: [], catalogue: { state: "not_read", host: "https://github.com", folder: false, readAt: null, reason: null, status: null }, downloads });
    }
    if (url === "/api/templates/downloads" && method === "DELETE") {
      const gone = downloads;
      downloads = { versions: 0, bytes: 0 };
      return Response.json(gone);
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
  await act(async () => root.render(<DataTab />));
  await settle();
}
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const card = () => container.querySelectorAll("section").find(section => section.querySelector("h2")?.textContent === "Templates")!;
const head = () => card().querySelector("h2")!.parentElement!;
const labels = () => card().querySelectorAll("b").map(b => b.textContent);
const row = (label: string) => {
  const name = card().querySelectorAll("b").find(b => b.textContent === label)!;
  return card().querySelector(`[id="${name.id.replace(/-label$/, "")}"]`)!;
};
const buttons = (scope: HostElement) => scope.querySelectorAll("button").map(button => button.textContent);
const button = (scope: HostElement, label: string) => scope.querySelectorAll("button").find(each => each.textContent === label)!;
const press = async (scope: HostElement, label: string) => {
  await act(async () => { button(scope, label).click(); });
  await settle();
};
const field = () => card().querySelectorAll("input").find(element => element.getAttribute("aria-label") === "Template catalogue address")!;
const toggle = () => card().querySelector('[role="switch"]')!;
const flip = async (on: boolean) => { await act(async () => props(toggle()).onChange({ target: { checked: on } })); await settle(); };
const type = (element: HostElement, text: string) => act(async () => props(element).onChange({ target: { value: text }, nativeEvent: { inputType: "insertText" } }));
const submit = async (scope: HostElement) => {
  await act(async () => { scope.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
  await settle();
};
const writes = () => requests.filter(request => request.method === "PATCH").map(request => request.body);
const tests = () => requests.filter(request => request.url === "/api/instance/services/templates/test");
const answerLine = () => head().querySelector("[data-answer]");
const dialog = () => host.document.querySelector('[role="dialog"]');
const marks = (scope: HostElement) => scope.querySelectorAll('[role="status"]').map(mark => mark.textContent);

describe("the Templates card", () => {
  it("stands before the private network with the catalogue in use, the release catalogue by default, its Test and the downloads", async () => {
    await open();
    expect(container.querySelectorAll("section").map(section => section.querySelector("h2")!.textContent)).toEqual([
      "Address finder", "Travel time", "OpenStreetMap", "Overture Maps", "Cloud storage", "Templates", "Private network", "Connections and imports",
    ]);
    expect(labels()).toEqual(["Catalogue", "Catalogue address", "Downloaded"]);
    expect([toggle().getAttribute("aria-label"), (toggle() as unknown as { checked: boolean }).checked]).toEqual(["Use the catalogue", true]);
    expect(row("Catalogue").textContent).toContain("In use");
    expect(row("Catalogue address").textContent).toContain("https://github.com");
    expect(row("Catalogue address").textContent).toContain("Default");
    expect(buttons(row("Catalogue address"))).toEqual([]);
    expect(field().value).toBe("");
    expect(buttons(head())).toEqual(["Test"]);
    expect(row("Downloaded").textContent).toContain("2 versions · 4.1 MB");
    expect(button(row("Downloaded"), "Remove all").disabled).toBe(false);
    // The downloads come from the template list, which sends nothing outside; nothing else was asked.
    expect(requests.map(request => `${request.method} ${request.url}`).sort()).toEqual(["GET /api/instance/settings", "GET /api/templates"]);
    // At its default there is nothing to reset.
    expect(card().querySelectorAll("[data-unit-slot]")).toEqual([]);
  });

  it("is an admin's alone: a member's Settings has no Data & services tab to draw it in", () => {
    expect(settingsColumn(true).groups.flatMap(group => group.tabs.map(tab => tab.id))).toContain("data");
    expect(settingsColumn(false).groups.flatMap(group => group.tabs.map(tab => tab.id))).not.toContain("data");
  });

  it("answers the Test with how many the catalogue lists and the time, and with each of the services' reasons", async () => {
    await open();
    await press(head(), "Test");
    expect(tests()).toHaveLength(1);
    expect([answerLine()?.textContent, answerLine()?.getAttribute("data-answer")]).toEqual(["Lists 3 templates, answered in 140 ms", "passed"]);
    for (const [given, said] of [
      [{ service: "templates", result: "passed", templates: 1, milliseconds: 1200 }, "Lists 1 template, answered in 1,200 ms"],
      [{ service: "templates", result: "passed", templates: 0, milliseconds: 90 }, "Lists no templates, answered in 90 ms"],
      [{ service: "templates", result: "failed", reason: "status", status: 503 }, "Answered with status 503."],
      [{ service: "templates", result: "failed", reason: "unreachable" }, "Could not reach the service."],
      [{ service: "templates", result: "failed", reason: "timed_out" }, "No answer within the time limit."],
      [{ service: "templates", result: "failed", reason: "unexpected_answer" }, "Answered, but not as the service does."],
      [{ service: "templates", result: "failed", reason: "refused", message: "The requested address is not reachable from this server." }, "The requested address is not reachable from this server."],
    ] as const) {
      test = given as ServiceTestAnswer;
      await press(head(), "Test");
      expect(answerLine()?.textContent, said).toBe(said);
    }
    // Refused by the server, its words in the line.
    test = { status: 409, code: "templates_catalogue_off", message: "The template catalogue is turned off on this instance, so nothing is read from it. An admin turns it on in Settings." };
    await press(head(), "Test");
    expect(answerLine()?.textContent).toBe("The template catalogue is turned off on this instance, so nothing is read from it. An admin turns it on in Settings.");
    expect(writes()).toEqual([]);
  });

  it("keeps the switch at once, offers no Test while the catalogue is off, and Reset turns it back on", async () => {
    await open();
    await flip(false);
    expect(writes()).toEqual([{ "templates.catalogue": false }]);
    expect(marks(row("Catalogue"))).toContain("Saved");
    // The switch's words follow it: off reads as Settings' other switches read off.
    expect(row("Catalogue").querySelector("label")!.textContent).toBe("Off");
    expect(buttons(head())).toEqual(["Reset to defaults"]);
    // Off, the server reaches the catalogue for nothing, so there is no Test to press.
    expect(answerLine()).toBeNull();
    expect(tests()).toEqual([]);
    // The address and the downloads stay as they were.
    expect(row("Catalogue address").textContent).toContain("https://github.com");
    expect(button(row("Downloaded"), "Remove all").disabled).toBe(false);
    await press(head(), "Reset to defaults");
    expect(writes().at(-1)).toEqual({ "templates.catalogue": null });
    expect((toggle() as unknown as { checked: boolean }).checked).toBe(true);
    expect(row("Catalogue").querySelector("label")!.textContent).toBe("In use");
    expect(buttons(head())).toContain("Test");
  });

  it("keeps a typed address only on Save, shows its scheme and host with Set and Remove, and never the key", async () => {
    await open();
    const address = `https://seed-user:${KEY}@templates.example/${KEY}/index.json?key=${KEY}`;
    await type(field(), address);
    expect(writes()).toEqual([]);
    expect(buttons(row("Catalogue address"))).toEqual(["Save", "Cancel"]);
    await submit(row("Catalogue address"));
    expect(writes()).toEqual([{ templatesCatalogueUrl: address }]);
    expect(field().value).toBe("");
    expect(row("Catalogue address").textContent).toContain("https://templates.example");
    expect(row("Catalogue address").textContent).toContain("Set");
    expect(marks(row("Catalogue address"))).toContain("Saved");
    expect(container.textContent).not.toContain(KEY);
    expect(container.descendants().flatMap(element => [...element.attributes.values(), (element as unknown as { value?: string }).value ?? ""])
      .filter(text => text.includes(KEY))).toEqual([]);
    // Remove asks first, then the default catalogue is read again.
    await press(row("Catalogue address"), "Remove");
    expect(dialog()?.textContent).toContain("The default catalogue is read again.");
    await act(async () => { button(dialog()!, "Remove address").click(); });
    await settle();
    expect(writes().at(-1)).toEqual({ templatesCatalogueUrl: null });
    expect(row("Catalogue address").textContent).toContain("https://github.com");
    expect(row("Catalogue address").textContent).toContain("Default");
  });

  it("refuses a folder from the page in the server's words, under the row's own name, keeping what was typed", async () => {
    await open();
    await type(field(), FOLDER);
    await submit(row("Catalogue address"));
    expect(writes()).toEqual([{ templatesCatalogueUrl: FOLDER }]);
    expect(row("Catalogue address").textContent).toContain("Expected an http or https address of at most 2048 characters.");
    expect(row("Catalogue address").textContent).not.toContain("templatesCatalogueUrl");
    expect(field().value).toBe(FOLDER);
    expect(row("Catalogue address").textContent).toContain("Default");
  });

  it("shows a folder its variable names as a folder on the server, locked, naming the variable and never the path", async () => {
    pinned = { templatesCatalogueUrl: { value: { set: true, folder: true }, source: "environment", locked: true } };
    await open();
    const locked = row("Catalogue address");
    expect(field()).toMatchObject({ value: "A folder on the server", disabled: true });
    expect(field().getAttribute("data-mono")).toBeNull();
    expect(locked.textContent).toContain("Set in the server's environment by DEZFIL_TEMPLATES_CATALOGUE.");
    expect(buttons(locked)).toEqual([]);
    expect(container.textContent).not.toContain("SEEDED-KEY");
    // A variable naming an address shows it as scheme and host.
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    pinned = { templatesCatalogueUrl: { value: { set: true, origin: "https://mirror.example" }, source: "environment", locked: true } };
    await open();
    expect(field()).toMatchObject({ value: "https://mirror.example", disabled: true });
    expect(field().getAttribute("data-mono")).toBe("true");
  });

  it("removes the downloads only after its question, then says None and Removed, Remove all held back", async () => {
    await open();
    await press(row("Downloaded"), "Remove all");
    expect(dialog()?.textContent).toContain("Remove the downloaded templates?");
    expect(dialog()?.textContent).toContain("2 versions (4.1 MB) are removed. Shipped templates and every copy stay, and a template the catalogue lists downloads again when it is next opened.");
    await act(async () => { button(dialog()!, "Cancel").click(); });
    await settle();
    expect(dialog()).toBeNull();
    expect(requests.filter(request => request.method === "DELETE")).toEqual([]);
    await press(row("Downloaded"), "Remove all");
    await act(async () => { button(dialog()!, "Remove downloads").click(); });
    await settle();
    expect(requests.filter(request => request.method === "DELETE").map(request => request.url)).toEqual(["/api/templates/downloads"]);
    expect(dialog()).toBeNull();
    expect(row("Downloaded").textContent).toContain("None");
    expect(marks(row("Downloaded"))).toEqual(["Removed"]);
    expect(button(row("Downloaded"), "Remove all").disabled).toBe(true);
    // Nothing Remove all does touches a setting.
    expect(writes()).toEqual([]);
  });

  it("says None with Remove all held back when nothing was downloaded, and one version as one", async () => {
    downloads = { versions: 0, bytes: 0 };
    await open();
    expect(row("Downloaded").textContent).toContain("None");
    expect(button(row("Downloaded"), "Remove all").disabled).toBe(true);
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    downloads = { versions: 1, bytes: 50 * 1024 };
    await open();
    expect(row("Downloaded").textContent).toContain("1 version · 50 KB");
  });

  it("says nothing but its title, labels, values, actions and the question's surprise, with no em dash", async () => {
    await open();
    await press(row("Downloaded"), "Remove all");
    const said = (element: HostElement): string[] => element.childNodes.flatMap(node => node instanceof HostElement
      ? (node.getAttribute("aria-hidden") === "true" ? [] : said(node)) : [node.textContent.trim()]).filter(Boolean);
    const expected = new Set([
      "Templates", "Catalogue", "In use", "Catalogue address", "Downloaded", "Test", "Remove all", "Default", "https://github.com",
      "2 versions · 4.1 MB",
    ]);
    expect(said(card()).filter(text => !expected.has(text))).toEqual([]);
    expect(said(dialog() as unknown as HostElement)).toEqual([
      "Remove the downloaded templates?",
      "2 versions (4.1 MB) are removed. Shipped templates and every copy stay, and a template the catalogue lists downloads again when it is next opened.",
      "Remove downloads", "Cancel",
    ]);
    const everything = [card().textContent, dialog()!.textContent, ...card().descendants().flatMap(element => [...element.attributes.values()])];
    expect(everything.filter(text => text.includes("—"))).toEqual([]);
  });
});
