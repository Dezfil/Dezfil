import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { PublishingTab } from "./PublishingTab";
import { instanceReadFixture } from "./read-fixture";

/**
 * Publishing: who may publish and which other sites may embed a published
 * page (the Public links card), then where a fresh image export card
 * starts, both drawn from the configuration read, each choice kept at once
 * through the write, the listed sites typed and kept on Save, with Reset
 * and Undo per card. The server is a fake that applies a write the way
 * the foundation does, keeps each site as its origin, refuses a site that
 * is not one and Listed sites with none listed in the server's own words,
 * and answers with the whole read.
 */

const NONE_LISTED = "publishing.embedSites must list at least one site while publishing.embedding is listed.";
const NOT_A_SITE = "publishing.embedSites: Expected each site as http or https with a host and an optional port, nothing else; entry 2 is not.";

let stored: Record<string, unknown>;
/** While set, a write waits here for its answer until the test releases it. */
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
      const patch = { ...body as Record<string, unknown> };
      if (Array.isArray(patch["publishing.embedSites"])) {
        const sites = patch["publishing.embedSites"] as string[];
        if (sites.some(site => !/^https?:\/\/[^/]+\/?$/i.test(site))) {
          return Response.json({ error: { code: "invalid_request", message: NOT_A_SITE } }, { status: 400 });
        }
        patch["publishing.embedSites"] = sites.length ? sites.map(site => site.toLowerCase().replace(/\/$/, "")) : null;
      }
      const next = Object.fromEntries(Object.entries({ ...stored, ...patch }).filter(([, value]) => value !== null));
      if (next["publishing.embedding"] === "listed" && !(next["publishing.embedSites"] as unknown[] | undefined)?.length) {
        return Response.json({ error: { code: "invalid_request", message: NONE_LISTED } }, { status: 400 });
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
  await act(async () => root.render(<PublishingTab />));
  await settle();
}
const cards = () => container.querySelectorAll("section");
const row = (label: string) => container.querySelector(`[id="${container.querySelectorAll("b").find(b => b.textContent === label)!.id.replace(/-label$/, "")}"]`)!;
const radios = (group: string) => container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!.querySelectorAll('[role="radio"]');
const checked = (group: string) => radios(group).filter(radio => radio.getAttribute("aria-checked") === "true").map(radio => radio.textContent);
const pick = (group: string, name: string) => act(async () => { radios(group).find(radio => radio.textContent === name)!.click(); });
const writes = () => requests.filter(request => request.method === "PATCH").map(request => request.body);
const saved = (label: string) => row(label).querySelectorAll('[role="status"]').map(element => element.textContent);
const press = (label: string) => act(async () => { container.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
const resets = () => container.querySelectorAll("[data-unit-slot]").map(button => button.getAttribute("aria-label"));
const release = () => act(async () => { for (const respond of held!.splice(0)) respond(); });
const sitesField = () => container.querySelectorAll("textarea").find(element => element.getAttribute("aria-label") === "Sites that may embed published maps");
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const typeSites = (text: string) => act(async () => props(sitesField()!).onChange({ target: { value: text } }));
const card = (title: string) => cards().find(section => section.querySelector("h2")?.textContent === title)!;
const buttons = (scope: HostElement) => scope.querySelectorAll("button").map(button => button.textContent);
const submit = () => act(async () => { props(card("Public links").querySelector("form")!).onSubmit({ preventDefault() {} }); });

describe("Publishing", () => {
  it("draws the Public links card above Image export, their rows and no other", async () => {
    await open();
    expect(requests.map(request => request.url)).toEqual(["/api/instance/settings"]);
    expect(cards().map(section => section.querySelector("h2")!.textContent)).toEqual(["Public links", "Image export"]);
    expect(container.querySelectorAll("b").map(b => b.textContent)).toEqual(["Who may publish", "Embedding on other sites", "Starting width", "Starting shape"]);
    for (const word of ["made with", "Published maps", "Unpublish"]) {
      expect(container.textContent).not.toContain(word);
    }
    expect(radios("Who may publish").map(radio => radio.textContent)).toEqual(["Everyone", "Admins only", "No one"]);
    expect(checked("Who may publish")).toEqual(["Everyone"]);
    expect(radios("Embedding on other sites").map(radio => radio.textContent)).toEqual(["Any site", "Listed sites", "Off"]);
    expect(checked("Embedding on other sites")).toEqual(["Any site"]);
    // The list opens under Listed sites alone.
    expect(sitesField()).toBeUndefined();
    expect(radios("Starting width").map(radio => radio.textContent)).toEqual(["1280 px", "1920 px", "2560 px"]);
    expect(checked("Starting width")).toEqual(["1920 px"]);
    expect(radios("Starting shape").map(radio => radio.textContent)).toEqual(["16:9", "4:3", "1:1"]);
    expect(checked("Starting shape")).toEqual(["4:3"]);
    expect(resets()).toEqual([]);
  });

  it("keeps the starting width and shape at once, with Saved by each row only on the response", async () => {
    await open();
    held = [];
    await pick("Starting width", "2560 px");
    expect(writes()).toEqual([{ "imageExport.width": "2560" }]);
    expect(checked("Starting width")).toEqual(["2560 px"]);
    expect(saved("Starting width")).toEqual([]);
    await release();
    await settle();
    expect(saved("Starting width")).toEqual(["Saved"]);
    held = null;
    await pick("Starting shape", "1:1");
    await settle();
    expect(writes()[1]).toEqual({ "imageExport.shape": "1:1" });
    expect(saved("Starting shape")).toEqual(["Saved"]);
    expect([checked("Starting width"), checked("Starting shape")]).toEqual([["2560 px"], ["1:1"]]);
  });

  it("resets the card to the read's defaults in one write, then offers Undo", async () => {
    stored = { "imageExport.width": "1280", "imageExport.shape": "16:9" };
    await open();
    expect(resets()).toEqual(["Reset to defaults: Image export"]);
    await press("Reset to defaults");
    await settle();
    expect(writes()).toEqual([{ "imageExport.width": null, "imageExport.shape": null }]);
    expect([checked("Starting width"), checked("Starting shape")]).toEqual([["1920 px"], ["4:3"]]);
    await press("Undo");
    await settle();
    expect(writes()[1]).toEqual({ "imageExport.width": "1280", "imageExport.shape": "16:9" });
    expect([checked("Starting width"), checked("Starting shape")]).toEqual([["1280 px"], ["16:9"]]);
  });
});

describe("Public links", () => {
  it("keeps who may publish at once, Saved by its row only on the response, with its note under a narrowed rule", async () => {
    await open();
    held = [];
    await pick("Who may publish", "Admins only");
    expect(writes()).toEqual([{ "publishing.publish": "admins" }]);
    expect(saved("Who may publish")).toEqual([]);
    await release();
    await settle();
    expect(saved("Who may publish")).toEqual(["Saved"]);
    expect(row("Who may publish").textContent).toContain("Maps already published stay public until they are unpublished.");
    held = null;
    await pick("Who may publish", "No one");
    await settle();
    expect(writes()[1]).toEqual({ "publishing.publish": "none" });
    await pick("Who may publish", "Everyone");
    await settle();
    expect(row("Who may publish").textContent).not.toContain("stay public");
  });

  it("keeps Off at once with its note, and Listed sites at once while sites are listed", async () => {
    stored = { "publishing.embedSites": ["https://www.stadtwerke.example"] };
    await open();
    await pick("Embedding on other sites", "Off");
    await settle();
    expect(writes()).toEqual([{ "publishing.embedding": "off" }]);
    expect(row("Embedding on other sites").textContent).toContain("Embed code already on other sites stops showing the map.");
    expect(sitesField()).toBeUndefined();
    await pick("Embedding on other sites", "Listed sites");
    await settle();
    expect(writes()[1]).toEqual({ "publishing.embedding": "listed" });
    expect(saved("Embedding on other sites")).toEqual(["Saved"]);
    expect(sitesField()!.value).toBe("https://www.stadtwerke.example");
    expect(buttons(card("Public links"))).not.toContain("Save");
  });

  it("holds Listed sites chosen with none listed for the card's Save, which sends the choice and the sites in one write", async () => {
    await open();
    await pick("Embedding on other sites", "Listed sites");
    await settle();
    expect(writes()).toEqual([]);
    expect(checked("Embedding on other sites")).toEqual(["Listed sites"]);
    expect(sitesField()!.value).toBe("");
    expect(buttons(card("Public links"))).toEqual(expect.arrayContaining(["Save", "Cancel"]));
    // Nothing listed yet: the card's own check, before any request.
    await submit();
    await settle();
    expect(writes()).toEqual([]);
    expect(row("Embedding on other sites").textContent).toContain("Add at least one site, or choose Any site.");
    await typeSites("  https://WWW.Stadtwerke.example/ \n\n http://intranet.example:8080\n");
    expect(writes()).toEqual([]);
    await submit();
    await settle();
    expect(writes()).toEqual([{ "publishing.embedding": "listed", "publishing.embedSites": ["https://WWW.Stadtwerke.example/", "http://intranet.example:8080"] }]);
    expect(stored).toEqual({ "publishing.embedding": "listed", "publishing.embedSites": ["https://www.stadtwerke.example", "http://intranet.example:8080"] });
    // The field shows the sites as the server kept them, one per line.
    expect(sitesField()!.value).toBe("https://www.stadtwerke.example\nhttp://intranet.example:8080");
    expect(saved("Embedding on other sites")).toEqual(["Saved"]);
    expect(buttons(card("Public links"))).not.toContain("Save");
  });

  it("draws a refused site as the red line under its row, keeping nothing, and Cancel puts back what is kept", async () => {
    stored = { "publishing.embedding": "listed", "publishing.embedSites": ["https://a.example"] };
    await open();
    expect(sitesField()!.value).toBe("https://a.example");
    await typeSites("https://a.example\nhttps://a.example/maps");
    await submit();
    await settle();
    expect(writes()).toEqual([{ "publishing.embedSites": ["https://a.example", "https://a.example/maps"] }]);
    expect(stored["publishing.embedSites"]).toEqual(["https://a.example"]);
    const text = row("Embedding on other sites").textContent;
    expect(text).toContain("Expected each site as http or https with a host and an optional port, nothing else; entry 2 is not.");
    expect(text).not.toContain("publishing.");
    await press("Cancel");
    expect(sitesField()!.value).toBe("https://a.example");
    expect(buttons(card("Public links"))).not.toContain("Save");
  });

  it("refuses emptying the list while Listed sites holds, before any request", async () => {
    stored = { "publishing.embedding": "listed", "publishing.embedSites": ["https://a.example"] };
    await open();
    await typeSites(" \n ");
    await submit();
    await settle();
    expect(writes()).toEqual([]);
    expect(row("Embedding on other sites").textContent).toContain("Add at least one site, or choose Any site.");
  });

  it("resets the whole card in one write, the listed sites cleared with the choices, then Undo restores the list with them", async () => {
    stored = { "publishing.publish": "admins", "publishing.embedding": "listed", "publishing.embedSites": ["https://a.example", "http://intranet.example:8080"] };
    await open();
    expect(resets()).toEqual(["Reset to defaults: Public links"]);
    await press("Reset to defaults");
    await settle();
    expect(writes()).toEqual([{ "publishing.publish": null, "publishing.embedding": null, "publishing.embedSites": null }]);
    expect([checked("Who may publish"), checked("Embedding on other sites")]).toEqual([["Everyone"], ["Any site"]]);
    expect(stored).toEqual({});
    expect(sitesField()).toBeUndefined();
    await press("Undo");
    await settle();
    expect(writes()[1]).toEqual({ "publishing.publish": "admins", "publishing.embedding": "listed",
      "publishing.embedSites": ["https://a.example", "http://intranet.example:8080"] });
    expect([checked("Who may publish"), checked("Embedding on other sites")]).toEqual([["Admins only"], ["Listed sites"]]);
    expect(sitesField()!.value).toBe("https://a.example\nhttp://intranet.example:8080");
    expect(stored).toEqual({ "publishing.publish": "admins", "publishing.embedding": "listed",
      "publishing.embedSites": ["https://a.example", "http://intranet.example:8080"] });
  });

  it("offers Reset while only a list kept from an earlier Listed sites differs, and clears it", async () => {
    stored = { "publishing.embedSites": ["https://a.example"] };
    await open();
    expect(checked("Embedding on other sites")).toEqual(["Any site"]);
    expect(resets()).toEqual(["Reset to defaults: Public links"]);
    await press("Reset to defaults");
    await settle();
    expect(writes()).toEqual([{ "publishing.publish": null, "publishing.embedding": null, "publishing.embedSites": null }]);
    expect(stored).toEqual({});
    await press("Undo");
    await settle();
    expect(writes()[1]).toEqual({ "publishing.embedSites": ["https://a.example"] });
    expect(stored).toEqual({ "publishing.embedSites": ["https://a.example"] });
  });
});
