import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostElement, installDomHost } from "../testing/dom-host";
import { MapsTab } from "./MapsTab";
import { PublishingTab } from "./PublishingTab";
import { instanceReadFixture, type Resolution } from "./read-fixture";
import { WorkflowsTab } from "./WorkflowsTab";

/**
 * The words of the three tabs that hold what new things start with, held
 * to the copy rules. Each tab says nothing but its card titles, its row
 * labels, the names and units of its numbers, the words of its choices and
 * its actions, and the four quiet lines that each name a surprise; no
 * element carries a tooltip or a title; and no text or attribute value,
 * the drawings' included, holds an em dash or the spelling "colour". The
 * search keyword "colour" stays: it finds the Color cycle row and is never
 * shown. Every word expected is written out here by hand.
 */

/** The only quiet lines, each naming what would surprise without it. */
const SURPRISES = [
  // A changed default does not reach maps already made.
  "Maps you already have keep their settings.",
  // A person's own minimap or band choice overrides the default.
  "Someone’s own choice on the canvas still wins.",
  // Automatic hides the minimap on a small workflow.
  "Automatic shows it at 6 nodes or more.",
  // A closed band does not stay closed.
  "A closed band opens at the first run.",
];
const ACTIONS = ["Reset to defaults", "Undo", "Saved"];
const SAYS: Readonly<Record<string, readonly string[]>> = {
  maps: [
    "New maps", "Basemap", "Auto", "Dark", "Light", "Streets", "Satellite", "Starting view", "Latitude", "Longitude", "Zoom",
    "Legend", "Legend corner",
    "New layers", "Color cycle", "Viz Qualitative", "Bold", "Tab10", "Paired", "Dark2", "Set3", "Opacity", "Points", "Lines", "Areas", "%",
    "Line width", "Point radius", "px",
  ],
  workflows: [
    "Workflow canvas", "Canvas opens", "Full screen", "Framed", "Minimap", "Automatic", "Always", "Never", "Results band", "Closed", "Open",
    "SQL console", "Text size", "11 px", "12 px", "13 px", "14 px", "16 px", "Line wrap",
  ],
  publishing: ["Image export", "Starting width", "1280 px", "1920 px", "2560 px", "Starting shape", "16:9", "4:3", "1:1"],
};

let stored: Record<string, unknown>;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

/** Imagery set up, so the Maps tab offers Satellite and says its word too. */
const IMAGERY: Record<string, Resolution> = { satelliteUrl: { value: { set: true, origin: "https://imagery.example" }, source: "environment", locked: true } };
const answer = () => instanceReadFixture({
  ...Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, source: "stored" as const, storedValue: value }])),
  ...IMAGERY,
});

beforeEach(() => {
  stored = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "/api/instance/settings" && method === "GET") return Response.json(answer());
    if (url === "/api/instance/settings" && method === "PATCH") {
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
async function open(tab: ReactElement) {
  await act(async () => root.render(tab));
  await settle();
}
const radios = (group: string) => container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!.querySelectorAll('[role="radio"]');
const nameOf = (radio: HostElement) => radio.getAttribute("aria-label") ?? radio.textContent;
async function pick(group: string, name: string) {
  await act(async () => { radios(group).find(radio => nameOf(radio) === name)!.click(); });
  await settle();
}
const card = (title: string) => container.querySelectorAll("section").find(section => section.querySelector("h2")?.textContent === title)!;
async function press(scope: HostElement, label: string) {
  await act(async () => { scope.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
  await settle();
}

/** Every text the tab draws, its drawings left out. */
const said = (element: HostElement): string[] => element.childNodes.flatMap(node => node instanceof HostElement
  ? (node.getAttribute("aria-hidden") === "true" ? [] : said(node)) : [node.textContent.trim()]).filter(Boolean);
/** Every text and attribute value, the drawings' included. */
const everything = () => [container.textContent, ...container.descendants().flatMap(element => [...element.attributes.values()])];

function holdsTheCopyRules(tab: keyof typeof SAYS) {
  const says = new Set([...SAYS[tab], ...SURPRISES, ...ACTIONS]);
  // No hint of any kind beyond the four surprises: no other meta line, note or words after a control, and no tooltip.
  expect(said(container).filter(text => !says.has(text))).toEqual([]);
  expect(container.descendants().filter(element => element.hasAttribute("data-hint") || element.hasAttribute("title"))
    .map(element => element.tagName)).toEqual([]);
  expect(everything().filter(text => text.includes("—"))).toEqual([]);
  // The product's word is color.
  expect(everything().filter(text => /colour/i.test(text))).toEqual([]);
}

describe("the words of what new things start with", () => {
  it("Maps says only its titles, labels, numbers' names and units, choices, actions and its one surprise", async () => {
    stored = { "newMap.zoom": 3, "newMap.legendCorner": "top-right", "newLayer.lineWidth": 4.5 };
    await open(<MapsTab />);
    expect(said(container)).toContain("Maps you already have keep their settings.");
    expect(said(container)).toContain("Reset to defaults");
    expect(said(container)).toContain("Satellite");
    holdsTheCopyRules("maps");
    await pick("Basemap", "Streets");
    expect(said(card("New maps"))).toContain("Saved");
    holdsTheCopyRules("maps");
    await press(card("New layers"), "Reset to defaults");
    expect(said(card("New layers"))).toContain("Undo");
    holdsTheCopyRules("maps");
  });

  it("Workflows & SQL says only its titles, labels, choices, actions and its three surprises", async () => {
    stored = { "canvas.minimap": "always", "sqlConsole.lineWrap": true };
    await open(<WorkflowsTab />);
    for (const line of SURPRISES.slice(1)) expect(said(container)).toContain(line);
    holdsTheCopyRules("workflows");
    await pick("Results band", "Open");
    expect(said(card("Workflow canvas"))).toContain("Saved");
    holdsTheCopyRules("workflows");
    await press(card("SQL console"), "Reset to defaults");
    expect(said(card("SQL console"))).toContain("Undo");
    holdsTheCopyRules("workflows");
  });

  it("Publishing says only its title, labels, choices and actions", async () => {
    stored = { "imageExport.shape": "16:9" };
    await open(<PublishingTab />);
    holdsTheCopyRules("publishing");
    await pick("Starting width", "2560 px");
    expect(said(container)).toContain("Saved");
    holdsTheCopyRules("publishing");
    await press(card("Image export"), "Reset to defaults");
    expect(said(container)).toContain("Undo");
    holdsTheCopyRules("publishing");
  });
});
