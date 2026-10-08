import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { WorkflowsTab } from "./WorkflowsTab";
import { instanceReadFixture } from "./read-fixture";

/**
 * Workflows & SQL: what the workflow canvas and the SQL console open with,
 * two cards drawn from the configuration read, each choice kept at once
 * through the write, each card with its own Reset and Undo. The server is
 * a fake that applies a write the way the foundation does (a null returns
 * the default), refuses where a case says, and answers with the whole read.
 */

let stored: Record<string, unknown>;
let refuse: { status: number; code: string; message: string } | null;
/** While set, a write waits here for its answer until the test releases it. */
let held: (() => void)[] | null;
let requests: { url: string; method: string; body: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

const answer = () => instanceReadFixture(Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, source: "stored", storedValue: value }])));

beforeEach(() => {
  stored = {}; refuse = null; held = null; requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url === "/api/instance/settings" && method === "GET") return Response.json(answer());
    if (url === "/api/instance/settings" && method === "PATCH") {
      if (held) await new Promise<void>(resolve => held!.push(resolve));
      if (refuse) return Response.json({ error: { code: refuse.code, message: refuse.message } }, { status: refuse.status });
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
  await act(async () => root.render(<WorkflowsTab />));
  await settle();
}
const cards = () => container.querySelectorAll("section");
const card = (title: string) => cards().find(section => section.querySelector("h2")?.textContent === title)!;
const labels = (scope: HostElement) => scope.querySelectorAll("b").map(b => b.textContent);
const row = (label: string) => container.querySelector(`[id="${container.querySelectorAll("b").find(b => b.textContent === label)!.id.replace(/-label$/, "")}"]`)!;
const radios = (group: string) => container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!.querySelectorAll('[role="radio"]');
const nameOf = (radio: HostElement) => radio.getAttribute("aria-label") ?? radio.textContent;
const checked = (group: string) => radios(group).filter(radio => radio.getAttribute("aria-checked") === "true").map(nameOf);
const pick = (group: string, name: string) => act(async () => { radios(group).find(radio => nameOf(radio) === name)!.click(); });
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const wrap = () => container.querySelectorAll('[role="switch"]').find(element => element.getAttribute("aria-label") === "Line wrap")!;
const turn = (on: boolean) => act(async () => props(wrap()).onChange({ target: { checked: on } }));
const writes = () => requests.filter(request => request.method === "PATCH").map(request => request.body);
const saved = (label: string) => row(label).querySelectorAll('[role="status"]').map(element => element.textContent);
const press = (scope: HostElement, label: string) => act(async () => { scope.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
const resets = () => container.querySelectorAll("[data-unit-slot]").map(button => button.getAttribute("aria-label"));
const sample = () => container.querySelector("[data-editor-sample]")!;
const release = () => act(async () => { for (const respond of held!.splice(0)) respond(); });

describe("Workflows & SQL", () => {
  it("draws Workflow canvas and SQL console from the configuration read, with their rows and no other", async () => {
    await open();
    expect(requests.map(request => request.url)).toEqual(["/api/instance/settings"]);
    expect(cards().map(section => section.querySelector("h2")!.textContent)).toEqual(["Workflow canvas", "SQL console"]);
    expect(labels(card("Workflow canvas"))).toEqual(["Canvas opens", "Minimap", "Results band"]);
    expect(labels(card("SQL console"))).toEqual(["Text size", "Line wrap"]);
    expect(card("Workflow canvas").textContent).toContain("Someone’s own choice on the canvas still wins.");
    expect(row("Minimap").textContent).toContain("Automatic shows it at 6 nodes or more.");
    expect(row("Results band").textContent).toContain("A closed band opens at the first run.");
    for (const word of ["Snap to grid", "History kept", "Tables grouped", "By person", "Last 40 runs"]) expect(container.textContent).not.toContain(word);
    expect(radios("Canvas opens").map(nameOf)).toEqual(["Full screen", "Framed"]);
    expect(checked("Canvas opens")).toEqual(["Full screen"]);
    expect(radios("Canvas opens").map(radio => radio.querySelector("[data-canvas-picture]")!.getAttribute("data-canvas-picture"))).toEqual(["full", "framed"]);
    expect(radios("Minimap").map(nameOf)).toEqual(["Automatic", "Always", "Never"]);
    expect(checked("Minimap")).toEqual(["Automatic"]);
    expect(radios("Results band").map(nameOf)).toEqual(["Closed", "Open"]);
    expect(checked("Results band")).toEqual(["Closed"]);
    expect(radios("Text size").map(nameOf)).toEqual(["11 px", "12 px", "13 px", "14 px", "16 px"]);
    expect(checked("Text size")).toEqual(["12 px"]);
    expect(wrap().checked).toBe(false);
    expect(resets()).toEqual([]);
  });

  it("keeps each canvas choice at once, with Saved by its row only on the response", async () => {
    await open();
    held = [];
    await pick("Canvas opens", "Framed");
    expect(writes()).toEqual([{ "canvas.opens": "framed" }]);
    expect(checked("Canvas opens")).toEqual(["Framed"]);
    expect(saved("Canvas opens")).toEqual([]);
    await release();
    await settle();
    expect(saved("Canvas opens")).toEqual(["Saved"]);
    held = null;
    await pick("Minimap", "Never");
    await settle();
    await pick("Results band", "Open");
    await settle();
    expect(writes().slice(1)).toEqual([{ "canvas.minimap": "never" }, { "canvas.resultsBand": "open" }]);
    expect([checked("Canvas opens"), checked("Minimap"), checked("Results band")]).toEqual([["Framed"], ["Never"], ["Open"]]);
    expect(stored).toEqual({ "canvas.opens": "framed", "canvas.minimap": "never", "canvas.resultsBand": "open" });
  });

  it("draws the console's editor sample as static text in the code colors, not an editor", async () => {
    await open();
    const drawing = sample();
    expect(drawing.getAttribute("aria-hidden")).toBe("true");
    expect(drawing.querySelectorAll("input")).toEqual([]);
    expect(drawing.querySelectorAll("textarea")).toEqual([]);
    expect(drawing.querySelectorAll("[contenteditable]")).toEqual([]);
    const lines = drawing.querySelectorAll("[data-line]");
    expect(lines.map(line => line.querySelector("[data-gutter]")!.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    expect(lines.map(line => line.querySelector("[data-code]")!.textContent)).toEqual([
      "-- Stations within 500 m of a 2026 flood zone",
      "SELECT s.name, s.capacity, ST_Distance(s.geom, f.geom) AS metres",
      "FROM stations s JOIN flood_zones_2026 f ON ST_DWithin(s.geom, f.geom, 500)",
      "WHERE s.status = 'active'",
      "ORDER BY metres;",
    ]);
    const kind = (token: string) => drawing.querySelectorAll(`[data-token="${token}"]`).map(span => span.textContent);
    expect(kind("keyword")).toEqual(["SELECT", "AS", "FROM", "JOIN", "ON", "WHERE", "ORDER BY"]);
    expect(kind("function")).toEqual(["ST_Distance", "ST_DWithin"]);
    expect(kind("number")).toEqual(["500"]);
    expect(kind("string")).toEqual(["'active'"]);
    expect(kind("comment")).toEqual(["-- Stations within 500 m of a 2026 flood zone"]);
  });

  it("draws the editor sample at the kept text size, never at a size the server refused", async () => {
    await open();
    expect(sample().style.fontSize).toBe("12px");
    await pick("Text size", "16 px");
    expect(writes()).toEqual([{ "sqlConsole.textSize": "16" }]);
    await settle();
    expect(saved("Text size")).toEqual(["Saved"]);
    expect(sample().style.fontSize).toBe("16px");
    refuse = { status: 400, code: "invalid_request", message: "sqlConsole.textSize: Expected one of: 11, 12, 13, 14, 16." };
    await pick("Text size", "11 px");
    await settle();
    expect(row("Text size").textContent).toContain("Expected one of: 11, 12, 13, 14, 16.");
    expect(saved("Text size")).toEqual([]);
    expect(sample().style.fontSize).toBe("16px");
    expect(stored).toEqual({ "sqlConsole.textSize": "16" });
  });

  it("wraps the editor sample's long lines while the kept line wrap is on, the switch kept at once", async () => {
    await open();
    expect(sample().hasAttribute("data-wrap")).toBe(false);
    await turn(true);
    expect(writes()).toEqual([{ "sqlConsole.lineWrap": true }]);
    expect(wrap().checked).toBe(true);
    await settle();
    expect(saved("Line wrap")).toEqual(["Saved"]);
    expect(sample().hasAttribute("data-wrap")).toBe(true);
    await turn(false);
    await settle();
    expect(writes()[1]).toEqual({ "sqlConsole.lineWrap": false });
    expect(sample().hasAttribute("data-wrap")).toBe(false);
  });

  it("resets each card to the read's defaults in one write, then offers Undo", async () => {
    stored = { "canvas.minimap": "never", "sqlConsole.textSize": "14", "sqlConsole.lineWrap": true };
    await open();
    expect(sample().style.fontSize).toBe("14px");
    expect(sample().hasAttribute("data-wrap")).toBe(true);
    expect(resets()).toEqual(["Reset to defaults: Workflow canvas", "Reset to defaults: SQL console"]);
    await press(card("SQL console"), "Reset to defaults");
    await settle();
    expect(writes()).toEqual([{ "sqlConsole.textSize": null, "sqlConsole.lineWrap": null }]);
    expect(checked("Text size")).toEqual(["12 px"]);
    expect(wrap().checked).toBe(false);
    expect(sample().style.fontSize).toBe("12px");
    expect(sample().hasAttribute("data-wrap")).toBe(false);
    await press(card("SQL console"), "Undo");
    await settle();
    expect(writes()[1]).toEqual({ "sqlConsole.textSize": "14", "sqlConsole.lineWrap": true });
    expect(sample().style.fontSize).toBe("14px");
    expect(checked("Minimap")).toEqual(["Never"]);
  });
});
