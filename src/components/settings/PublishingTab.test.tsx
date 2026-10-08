import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { PublishingTab } from "./PublishingTab";
import { instanceReadFixture } from "./read-fixture";

/**
 * Publishing: where a fresh image export card starts, its one card drawn
 * from the configuration read, each choice kept at once through the
 * write, with Reset and Undo. The server is a fake that applies a write
 * the way the foundation does and answers with the whole read.
 */

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
      stored = Object.fromEntries(Object.entries({ ...stored, ...body as Record<string, unknown> }).filter(([, value]) => value !== null));
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

describe("Publishing", () => {
  it("draws the Image export card alone, its starting width and shape and no other row", async () => {
    await open();
    expect(requests.map(request => request.url)).toEqual(["/api/instance/settings"]);
    expect(cards().map(section => section.querySelector("h2")!.textContent)).toEqual(["Image export"]);
    expect(container.querySelectorAll("b").map(b => b.textContent)).toEqual(["Starting width", "Starting shape"]);
    for (const word of ["Public links", "Who may publish", "Embedding", "made with", "Published maps", "Unpublish"]) {
      expect(container.textContent).not.toContain(word);
    }
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
