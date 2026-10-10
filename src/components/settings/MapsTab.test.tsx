import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { MapsTab } from "./MapsTab";
import { instanceReadFixture } from "./read-fixture";

/**
 * Maps: what new maps and new layers start with, three cards drawn from
 * the configuration read, each value kept as it changes through the
 * write, each card with its own Reset and Undo. The server is a fake that
 * applies a write the way the foundation does (a null returns the
 * default), refuses where a case says, and answers with the whole read.
 * The colors expected are the palettes' and the basemaps' own, written
 * out here by hand.
 */

let stored: Record<string, unknown>;
let imagery: boolean | "unreadable";
let refuse: { status: number; code: string; message: string } | null;
let requests: { url: string; method: string; body: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

function answer() {
  return instanceReadFixture({
    ...Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, source: "stored", storedValue: value }])),
    ...(imagery === "unreadable" ? { satelliteUrl: { value: { set: true, unreadable: true }, source: "stored", storedValue: null } }
      : imagery ? { satelliteUrl: { value: { set: true, origin: "https://imagery.example" }, source: "environment", locked: true } } : {}),
  });
}

beforeEach(() => {
  stored = {}; imagery = false; refuse = null; requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url === "/api/instance/settings" && method === "GET") return Response.json(answer());
    if (url === "/api/instance/settings" && method === "PATCH") {
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
  await act(async () => root.render(<MapsTab />));
  await settle();
}
const cards = () => container.querySelectorAll("section");
const card = (title: string) => cards().find(section => section.querySelector("h2")?.textContent === title)!;
const labels = (scope: HostElement) => scope.querySelectorAll("b").map(b => b.textContent);
const row = (label: string) => container.querySelector(`[id="${container.querySelectorAll("b").find(b => b.textContent === label)!.id.replace(/-label$/, "")}"]`)!;
const field = (name: string) => container.querySelectorAll("input").find(input => input.getAttribute("aria-label") === name)!;
const select = (name: string) => container.querySelectorAll("select").find(element => element.getAttribute("aria-label") === name)!;
/** The value a select is drawn with. (The host does not unmark the option
 * a browser unmarks when another is chosen, so its options cannot say.) */
const chosen = (name: string) => (props(select(name)) as unknown as { value: string }).value;
const radios = (group: string) => container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!.querySelectorAll('[role="radio"]');
const nameOf = (radio: HostElement) => radio.getAttribute("aria-label") ?? radio.textContent;
const checked = (group: string) => radios(group).filter(radio => radio.getAttribute("aria-checked") === "true").map(nameOf);
const pick = (group: string, name: string) => act(async () => { radios(group).find(radio => nameOf(radio) === name)!.click(); });
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const type = (name: string, text: string) => act(async () => props(field(name)).onChange({ target: { value: text }, nativeEvent: { inputType: "insertText" } }));
const leave = (name: string) => act(async () => props(field(name)).onBlur({}));
const enter = (name: string) => act(async () => props(field(name)).onKeyDown({ key: "Enter", preventDefault() {}, nativeEvent: {} }));
async function typeAndLeave(name: string, text: string) { await type(name, text); await leave(name); await settle(); }
const writes = () => requests.filter(request => request.method === "PATCH").map(request => request.body);
const saved = (label: string) => row(label).querySelectorAll('[role="status"]').map(element => element.textContent);
const press = (scope: HostElement, label: string) => act(async () => { scope.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
const resets = () => container.querySelectorAll("[data-unit-slot]").map(button => button.getAttribute("aria-label"));

/** The New layers sample, read back from what it draws. */
function sample() {
  const drawing = container.querySelector("[data-layer-sample]")!;
  const one = (part: string) => drawing.querySelector(`[data-sample="${part}"]`)!;
  return {
    ground: one("ground").getAttribute("fill"),
    points: drawing.querySelectorAll('[data-sample="point"]').map(point => [point.getAttribute("fill"), point.getAttribute("fill-opacity"), point.getAttribute("r")]),
    line: [one("line").getAttribute("stroke"), one("line").getAttribute("stroke-opacity"), one("line").getAttribute("stroke-width")],
    area: [one("area").getAttribute("fill"), one("area").getAttribute("fill-opacity")],
  };
}
const swatches = () => container.querySelector("[data-swatches]")!.querySelectorAll("i").map(swatch => String(swatch.style.background));

const VIZ_QUALITATIVE = ["#12939A", "#DDB27C", "#88572C", "#FF991F", "#F15C17", "#223F9A", "#DA70BF", "#125C77", "#4DC19C", "#776E57"];
const BOLD = ["#7f3c8d", "#11a579", "#3969ac", "#f2b701", "#e73f74", "#80ba5a", "#e68310", "#008695", "#cf1c90", "#f97b72"];
/** A latitude's place down the world's height, from its top, as a share of it: the textbook form of Web Mercator. */
const mercator = (latitude: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) / Math.PI) / 2;

describe("Maps", () => {
  it("draws New maps, Legend and New layers from the configuration read, with their rows and no other", async () => {
    await open();
    expect(requests.map(request => request.url)).toEqual(["/api/instance/settings"]);
    expect(cards().map(section => section.querySelector("h2")!.textContent)).toEqual(["New maps", "Legend", "New layers"]);
    expect(labels(card("New maps"))).toEqual(["Basemap", "Starting view"]);
    expect(labels(card("Legend"))).toEqual(["Legend corner"]);
    expect(labels(card("New layers"))).toEqual(["Color cycle", "Opacity", "Line width", "Point radius"]);
    expect(card("New maps").textContent).toContain("Maps you already have keep their settings.");
    for (const word of ["Opens with", "Panel opens on", "Use a map", "Scale bar", "Status bar", "Units", "Coordinates", "Numbers", "Labels", "Halo", "Palettes", "Sequential"]) {
      expect(container.textContent).not.toContain(word);
    }
    const numbers = container.querySelectorAll("input").filter(input => input.getAttribute("type") === "number");
    expect(numbers.map(input => [input.getAttribute("aria-label"), input.value, input.getAttribute("min"), input.getAttribute("max"), input.getAttribute("step")])).toEqual([
      ["Latitude", "40", "-85", "85", "any"], ["Longitude", "0", "-180", "180", "any"], ["Zoom", "1.3", "0", "22", "any"],
      ["Points opacity", "72", "10", "100", "1"], ["Lines opacity", "95", "10", "100", "1"], ["Areas opacity", "50", "10", "100", "1"],
      ["Line width", "2", "0.5", "50", "0.5"], ["Point radius", "3", "0.5", "100", "0.5"],
    ]);
    expect(row("Opacity").textContent).toBe("OpacityPoints%Lines%Areas%");
    expect(row("Line width").textContent).toBe("Line widthpx");
    expect(chosen("Color cycle")).toBe("uber_viz_qualitative");
    expect(select("Color cycle").querySelectorAll("option").map(option => option.textContent)).toEqual(["Viz Qualitative", "Bold", "Tab10", "Paired", "Dark2", "Set3"]);
    expect(checked("Legend corner")).toEqual(["Bottom left"]);
    // At the product's values, no card has anything to reset.
    expect(resets()).toEqual([]);
  });

  it("offers the basemaps this instance offers, drawn from their captures, and keeps a pick at once", async () => {
    await open();
    expect(radios("Basemap").map(nameOf)).toEqual(["Auto", "Dark", "Light", "Streets"]);
    expect(checked("Basemap")).toEqual(["Auto"]);
    const thumbs = radios("Basemap").map(radio => radio.querySelector("[data-style]")!);
    expect(thumbs.map(thumb => thumb.getAttribute("data-style"))).toEqual(["auto", "dark", "light", "streets"]);
    expect(thumbs.every(thumb => thumb.getAttribute("data-fill") === "true")).toBe(true);
    await pick("Basemap", "Streets");
    expect(writes()).toEqual([{ "newMap.basemap": "streets" }]);
    await settle();
    expect(checked("Basemap")).toEqual(["Streets"]);
    expect(saved("Basemap")).toEqual(["Saved"]);
  });

  it("offers Satellite where imagery is set up, and shows Auto picked for a stored Satellite once it is not", async () => {
    imagery = true;
    stored = { "newMap.basemap": "satellite" };
    await open();
    expect(radios("Basemap").map(nameOf)).toEqual(["Auto", "Dark", "Light", "Streets", "Satellite"]);
    expect(checked("Basemap")).toEqual(["Satellite"]);
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    imagery = false;
    await open();
    expect(radios("Basemap").map(nameOf)).toEqual(["Auto", "Dark", "Light", "Streets"]);
    // What a new map starts on: the stored choice it cannot draw is Auto.
    expect(checked("Basemap")).toEqual(["Auto"]);
  });

  it("offers only the styles Libraries offers, Satellite not while its address is unreadable, and shows Auto picked for a stored one now hidden", async () => {
    imagery = true;
    stored = { "newMap.basemap": "streets", "basemaps.streets": false, "basemaps.dark": false };
    await open();
    expect(radios("Basemap").map(nameOf)).toEqual(["Auto", "Light", "Satellite"]);
    expect(checked("Basemap")).toEqual(["Auto"]);
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    imagery = "unreadable";
    stored = { "newMap.basemap": "satellite" };
    await open();
    expect(radios("Basemap").map(nameOf)).toEqual(["Auto", "Dark", "Light", "Streets"]);
    expect(checked("Basemap")).toEqual(["Auto"]);
    expect(writes()).toEqual([]);
  });

  it("keeps a typed coordinate on leaving, a decimal as given, and refuses one out of range before any request, naming the field", async () => {
    await open();
    await type("Latitude", "51.5");
    expect(writes()).toEqual([]);
    await leave("Latitude");
    await settle();
    expect(writes()).toEqual([{ "newMap.latitude": 51.5 }]);
    expect(saved("Starting view")).toEqual(["Saved"]);
    await typeAndLeave("Zoom", "23");
    expect(writes()).toHaveLength(1);
    expect(row("Starting view").textContent).toContain("Zoom: Enter a number from 0 to 22.");
    expect(field("Zoom").getAttribute("aria-invalid")).toBe("true");
  });

  it("sets latitude and longitude in one write from a click on the world locator, leaving the zoom, and moves its mark", async () => {
    await open();
    const locator = container.querySelector("[data-locator]")!;
    expect(locator.getAttribute("aria-hidden")).toBe("true");
    const mark = () => locator.querySelector("[data-view]")!;
    const centre = () => Number(mark().getAttribute("x")) + Number(mark().getAttribute("width")) / 2;
    expect(centre()).toBeCloseTo(88, 0);
    // The box sits at (100, 50) on the page, 176 by 110; its top edge is 78 degrees north.
    const box = { left: 100, top: 50, width: 176, height: 110 };
    const y = box.top + ((mercator(51.5) - mercator(78)) * 176 / 110) * box.height;
    await act(async () => props(locator).onClick({ clientX: box.left + 0.75 * box.width, clientY: y, currentTarget: { getBoundingClientRect: () => box } }));
    expect(writes()).toEqual([{ "newMap.latitude": 51.5, "newMap.longitude": 90 }]);
    expect([field("Latitude").value, field("Longitude").value, field("Zoom").value]).toEqual(["51.5", "90", "1.3"]);
    await settle();
    expect(saved("Starting view")).toEqual(["Saved"]);
    expect(centre()).toBeCloseTo(132, 0);
  });

  it("never shows a shared row's Saved beside a red line or a field being changed, and shows it again once the row's next write is kept with none refused", async () => {
    await open();
    await typeAndLeave("Latitude", "51.5074");
    expect(saved("Starting view")).toEqual(["Saved"]);
    // Within the latitude's hold: the zoom typed clears the row's Saved, and its refusal brings none back.
    await type("Zoom", "30");
    expect(saved("Starting view")).toEqual([]);
    await enter("Zoom");
    expect(row("Starting view").textContent).toContain("Zoom: Enter a number from 0 to 22.");
    expect(saved("Starting view")).toEqual([]);
    await leave("Zoom");
    await settle();
    expect(saved("Starting view")).toEqual([]);
    // A click on the locator while the zoom is refused: kept, with no Saved beside the red line.
    const box = { left: 100, top: 50, width: 176, height: 110 };
    const y = box.top + ((mercator(51.5) - mercator(78)) * 176 / 110) * box.height;
    const locator = container.querySelector("[data-locator]")!;
    await act(async () => props(locator).onClick({ clientX: box.left + 0.75 * box.width, clientY: y, currentTarget: { getBoundingClientRect: () => box } }));
    await settle();
    expect(writes().at(-1)).toEqual({ "newMap.latitude": 51.5, "newMap.longitude": 90 });
    expect(row("Starting view").textContent).toContain("Zoom: Enter a number from 0 to 22.");
    expect(saved("Starting view")).toEqual([]);
    // The zoom corrected and kept: the row's Saved returns.
    await typeAndLeave("Zoom", "3");
    expect(row("Starting view").textContent).not.toContain("Enter a number");
    expect(saved("Starting view")).toEqual(["Saved"]);
    // The opacities share one mark the same way.
    await typeAndLeave("Points opacity", "40");
    expect(saved("Opacity")).toEqual(["Saved"]);
    await type("Lines opacity", "5");
    expect(saved("Opacity")).toEqual([]);
    await leave("Lines opacity");
    await settle();
    expect(row("Opacity").textContent).toContain("Lines: Enter a number from 10 to 100.");
    expect(saved("Opacity")).toEqual([]);
    expect(writes()).toEqual([
      { "newMap.latitude": 51.5074 }, { "newMap.latitude": 51.5, "newMap.longitude": 90 }, { "newMap.zoom": 3 }, { "newLayer.pointOpacity": 40 },
    ]);
  });

  it("keeps the legend corner picked with the builder's corner picker, at once", async () => {
    await open();
    expect(radios("Legend corner").map(nameOf)).toEqual(["Top left", "Top right", "Bottom left", "Bottom right"]);
    await pick("Legend corner", "Top right");
    await settle();
    expect(writes()).toEqual([{ "newMap.legendCorner": "top-right" }]);
    expect(checked("Legend corner")).toEqual(["Top right"]);
    expect(saved("Legend corner")).toEqual(["Saved"]);
  });

  it("draws the New layers sample from the kept values: the cycle's colors in creation order, each opacity, the line's width, the points' radius", async () => {
    await open();
    expect(sample()).toEqual({
      ground: "#f2f3f0",
      points: [["#12939A", "0.72", "3"], ["#12939A", "0.72", "3"], ["#12939A", "0.72", "3"]],
      line: ["#DDB27C", "0.95", "2"],
      area: ["#88572C", "0.5"],
    });
    expect(swatches()).toEqual(VIZ_QUALITATIVE);
    await act(async () => props(select("Color cycle")).onChange({ target: { value: "bold" } }));
    await settle();
    expect(writes()).toEqual([{ "newLayer.colorCycle": "bold" }]);
    expect(chosen("Color cycle")).toBe("bold");
    expect(saved("Color cycle")).toEqual(["Saved"]);
    expect(swatches()).toEqual(BOLD);
    await typeAndLeave("Points opacity", "40");
    await typeAndLeave("Lines opacity", "30");
    await typeAndLeave("Areas opacity", "65");
    await typeAndLeave("Line width", "4.5");
    await typeAndLeave("Point radius", "6");
    expect(writes().slice(1)).toEqual([
      { "newLayer.pointOpacity": 40 }, { "newLayer.lineOpacity": 30 }, { "newLayer.areaOpacity": 65 },
      { "newLayer.lineWidth": 4.5 }, { "newLayer.pointRadius": 6 },
    ]);
    expect(sample()).toEqual({
      ground: "#f2f3f0",
      points: [["#7f3c8d", "0.4", "6"], ["#7f3c8d", "0.4", "6"], ["#7f3c8d", "0.4", "6"]],
      line: ["#11a579", "0.3", "4.5"],
      area: ["#3969ac", "0.65"],
    });
  });

  it("keeps the sample at what is kept while a number is typed, and when the server refuses it, showing no Saved", async () => {
    await open();
    await type("Point radius", "8");
    expect(sample().points[0]).toEqual(["#12939A", "0.72", "3"]);
    refuse = { status: 400, code: "invalid_request", message: "newLayer.pointRadius: Expected a number from 0.5 to 100." };
    await leave("Point radius");
    await settle();
    expect(writes()).toEqual([{ "newLayer.pointRadius": 8 }]);
    expect(row("Point radius").textContent).toContain("Expected a number from 0.5 to 100.");
    expect(saved("Point radius")).toEqual([]);
    expect(field("Point radius").value).toBe("8");
    expect(sample().points[0]).toEqual(["#12939A", "0.72", "3"]);
    expect(stored).toEqual({});
  });

  it("draws the sample on the basemap the New maps card keeps, Auto as the light theme", async () => {
    await open();
    expect(sample().ground).toBe("#f2f3f0");
    await pick("Basemap", "Dark");
    await settle();
    expect(sample().ground).toBe("#0e0e0e");
    await pick("Basemap", "Streets");
    await settle();
    expect(sample().ground).toBe("#f8f4f0");
  });

  it("resets each card to the read's defaults in one write, then offers Undo, card by card", async () => {
    stored = { "newLayer.lineWidth": 4.5, "newLayer.pointOpacity": 40, "newMap.zoom": 3 };
    await open();
    expect(resets()).toEqual(["Reset to defaults: New maps", "Reset to defaults: New layers"]);
    await press(card("New layers"), "Reset to defaults");
    await settle();
    expect(writes()).toEqual([{
      "newLayer.colorCycle": null, "newLayer.pointOpacity": null, "newLayer.lineOpacity": null,
      "newLayer.areaOpacity": null, "newLayer.lineWidth": null, "newLayer.pointRadius": null,
    }]);
    expect([field("Points opacity").value, field("Line width").value]).toEqual(["72", "2"]);
    expect(sample().line[2]).toBe("2");
    expect(field("Zoom").value).toBe("3");
    expect(resets()).toEqual(["Reset to defaults: New maps", "Undo reset to defaults: New layers"]);
    await press(card("New layers"), "Undo");
    await settle();
    expect(writes()[1]).toEqual({ "newLayer.pointOpacity": 40, "newLayer.lineWidth": 4.5 });
    expect([field("Points opacity").value, field("Line width").value]).toEqual(["40", "4.5"]);
  });
});
