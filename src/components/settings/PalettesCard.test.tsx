import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "@/lib/metadata/db";
import { createCustomPalette, listCustomPalettes, type CustomPalette } from "@/lib/metadata/palettes";
import { PALETTES as CURATED } from "@/lib/style/palettes";
import { GET as readPalettes, POST as savePalette } from "@/app/api/palettes/route";
import { DELETE as deletePalette } from "@/app/api/palettes/[name]/route";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { HostElement, HostEvent, installDomHost } from "../testing/dom-host";
import { PalettesCard } from "./PalettesCard";
import { evenStops, PALETTE_LIMITS, rampGradient, STARTING_COLORS } from "./palettes-table";

/**
 * Libraries' Palettes card over the shipped palette operations: the fetch
 * the card makes is answered by the palette routes themselves, on a store
 * of their own, as an admin's session. So the list is the palette read's,
 * a palette the card adds is one the builder's picker lists (the picker
 * reads the same route), and a delete is the route's.
 */

const origin = "http://instance.test";
let db: Database;
let requests: { url: string; method: string; body: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

/** What a member sees in the builder's picker: the palette read's saved palettes. */
async function pickerList(): Promise<CustomPalette[]> {
  const response = await readPalettes(testAccountRequest(new Request(`${origin}/api/palettes`), db, "member"));
  return (await response.json()).custom;
}

beforeEach(() => {
  db = metadata.open(":memory:");
  vi.spyOn(metadata, "metadataDb").mockReturnValue(db);
  testAccountScope(db, "admin");
  db.prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
  testAccountScope(db, "member");
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    requests.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const request = testAccountRequest(new Request(origin + url, { method, headers: init.headers, body: init.body }), db, "admin");
    if (url === "/api/palettes" && method === "GET") return readPalettes(request);
    if (url === "/api/palettes" && method === "POST") return savePalette(request);
    const named = /^\/api\/palettes\/([^/?]+)$/.exec(url);
    if (named && method === "DELETE") return deletePalette(request, { params: Promise.resolve({ name: decodeURIComponent(named[1]) }) });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function open() {
  await act(async () => root.render(<PalettesCard />));
  await settle();
}
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const card = () => container.querySelector("section")!;
const rows = () => card().querySelectorAll("li");
const listed = () => rows().map(row => [row.querySelector("strong")!.textContent, row.querySelector("span")!.textContent]);
const button = (scope: HostElement, name: string) =>
  scope.querySelectorAll("button").find(each => each.textContent === name || each.getAttribute("aria-label") === name);
const press = async (scope: HostElement, name: string) => {
  const target = button(scope, name);
  expect(target, `no button ${name}`).toBeTruthy();
  await act(async () => { target!.click(); });
  await settle();
};
const colorInputs = () => card().querySelectorAll("input").filter(input => input.getAttribute("type") === "color");
const nameInput = () => card().querySelectorAll("input").find(input => input.getAttribute("type") === "text")!;
const ramp = (key: string) => card().querySelector(`[data-ramp="${key}"]`)!.querySelector("i")!.style.background;
const type = (element: HostElement, text: string) => act(async () => props(element).onChange({ target: { value: text } }));
const submit = async () => {
  await act(async () => { card().querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
  await settle();
};
const dialog = () => host.document.querySelector('[role="dialog"]');
const changes = () => requests.filter(request => request.method !== "GET");

describe("the Palettes card", () => {
  it("lists exactly the palette read's saved palettes, each with its name, its ramp and how many colors", async () => {
    const blues = createCustomPalette({ label: "Stadtwerke blues", stops: evenStops(["#e8f1fa", "#9ec3e6", "#4a8fd0", "#1f5fa3", "#0d3566"]) }, db);
    const depth = createCustomPalette({ label: "Flood depth", stops: [{ color: "#f2f7f9", position: 0 }, { color: "#4aa3c2", position: 0.3 }, { color: "#0b3a5c", position: 1 }] }, db);
    await open();
    expect(requests.map(request => request.url)).toEqual(["/api/palettes"]);
    expect(listed()).toEqual([["Stadtwerke blues", "5 colors"], ["Flood depth", "3 colors"]]);
    expect(card().querySelector("h2")!.textContent).toBe("Palettes2");
    // Each ramp is the palette's own colors at their own places.
    expect(ramp(blues.name)).toBe(rampGradient(blues.stops));
    expect(ramp(depth.name)).toBe("linear-gradient(90deg, #f2f7f9 0%, #4aa3c2 30%, #0b3a5c 100%)");
    // None of the built-in palettes, no type and no owner: the saved ones only.
    for (const palette of CURATED) expect(card().textContent).not.toContain(palette.label);
    expect(card().textContent).not.toMatch(/Sequential|Diverging|Categorical|added by/i);
    expect(rows().map(row => row.getAttribute("id"))).toEqual([`palette-${blues.name}`, `palette-${depth.name}`]);
  });

  it("says when there are none, and adds a palette the builder's picker then lists, its colors evenly spaced", async () => {
    await open();
    expect(card().textContent).toContain("No saved palettes yet.");
    expect(card().querySelector("form")).toBeNull();
    await press(card(), "Add a palette");
    expect(button(card(), "Add a palette")).toBeUndefined();
    expect(colorInputs().map(input => input.value)).toEqual(STARTING_COLORS);
    expect(ramp("new")).toBe(rampGradient(evenStops(STARTING_COLORS)));
    // Nothing changed yet: Add palette waits.
    expect(button(card(), "Add palette")!.disabled).toBe(true);

    // The ramp follows each color as it changes, and the count both ways within 2 to 16.
    await type(colorInputs()[1], "#ff0000");
    expect(ramp("new")).toBe("linear-gradient(90deg, #f1eef6 0%, #ff0000 25%, #74a9cf 50%, #2b8cbe 75%, #045a8d 100%)");
    for (let i = 0; i < 3; i += 1) await press(card(), "Remove the last color");
    expect(colorInputs().map(input => input.value)).toEqual(["#f1eef6", "#ff0000"]);
    expect(button(card(), "Remove the last color")!.disabled).toBe(true);
    expect(ramp("new")).toBe("linear-gradient(90deg, #f1eef6 0%, #ff0000 100%)");
    for (let i = 0; i < PALETTE_LIMITS.colors.max - 2; i += 1) await press(card(), "Add a color");
    expect(colorInputs()).toHaveLength(16);
    expect(button(card(), "Add a color")!.disabled).toBe(true);
    for (let i = 0; i < 13; i += 1) await press(card(), "Remove the last color");
    await type(colorInputs()[2], "#00aa00");
    expect(colorInputs().map(input => input.value)).toEqual(["#f1eef6", "#ff0000", "#00aa00"]);

    // A name is asked for before anything is sent.
    await submit();
    expect(changes()).toEqual([]);
    expect(card().textContent).toContain("Name the palette.");
    await type(nameInput(), "  Network heat  ");
    expect(card().textContent).not.toContain("Name the palette.");
    await submit();
    expect(changes()).toEqual([{ url: "/api/palettes", method: "POST", body: {
      label: "Network heat", stops: [{ color: "#f1eef6", position: 0 }, { color: "#ff0000", position: 0.5 }, { color: "#00aa00", position: 1 }],
    } }]);
    // Kept by the operation, listed by the picker, and in the card with Added.
    const [saved] = await pickerList();
    expect(saved).toMatchObject({ label: "Network heat", stops: [{ color: "#f1eef6", position: 0 }, { color: "#ff0000", position: 0.5 }, { color: "#00aa00", position: 1 }] });
    expect(listCustomPalettes(db)).toEqual([saved]);
    expect(card().querySelector("form")).toBeNull();
    expect(listed()).toEqual([["Network heat", "3 colors"]]);
    expect(rows()[0].textContent).toContain("Added");
    expect(ramp(saved.name)).toBe(rampGradient(saved.stops));
    expect(host.document.activeElement?.textContent).toBe("Add a palette");
  });

  it("puts the form back as it started on Cancel, sending nothing", async () => {
    await open();
    await press(card(), "Add a palette");
    await type(nameInput(), "Draft");
    await press(card(), "Add a color");
    await press(card(), "Cancel");
    expect(card().querySelector("form")).toBeNull();
    expect(changes()).toEqual([]);
    await press(card(), "Add a palette");
    expect(nameInput().value).toBe("");
    expect(colorInputs().map(input => input.value)).toEqual(STARTING_COLORS);
  });

  it("deletes a palette only once asked, with the sentence that layers keep their colors", async () => {
    const kept = createCustomPalette({ label: "Kept ramp", stops: evenStops(["#000000", "#ffffff"]) }, db);
    const gone = createCustomPalette({ label: "Old ramp", stops: evenStops(["#112233", "#445566", "#778899"]) }, db);
    await open();
    await press(rows()[1], "Delete Old ramp");
    expect(changes()).toEqual([]);
    expect(dialog()!.getAttribute("aria-label")).toBe("Delete Old ramp");
    expect(dialog()!.textContent).toContain("Delete Old ramp?");
    expect(dialog()!.textContent).toContain("Layers that use it keep their colors.");
    await press(dialog()!, "Cancel");
    expect(dialog()).toBeNull();
    expect(changes()).toEqual([]);
    expect((await pickerList()).map(palette => palette.name)).toEqual([kept.name, gone.name]);

    await press(rows()[1], "Delete Old ramp");
    await press(dialog()!, "Delete palette");
    expect(changes()).toEqual([{ url: `/api/palettes/${gone.name}`, method: "DELETE", body: undefined }]);
    expect(dialog()).toBeNull();
    expect(listed()).toEqual([["Kept ramp", "2 colors"]]);
    expect((await pickerList()).map(palette => palette.name)).toEqual([kept.name]);
  });

  it("shows the operation's refusal and keeps the form, and a failed read with Try again", async () => {
    await open();
    await press(card(), "Add a palette");
    await type(nameInput(), "x".repeat(PALETTE_LIMITS.name + 1));
    await submit();
    expect(card().textContent).toContain(`label must be 1 to ${PALETTE_LIMITS.name} characters.`);
    expect(card().querySelector("form")).not.toBeNull();
    expect(await pickerList()).toEqual([]);
    // The card's bounds are the operation's: the most it takes, and one past it refused.
    const at = (count: number) => savePalette(testAccountRequest(new Request(`${origin}/api/palettes`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "n".repeat(PALETTE_LIMITS.name), stops: evenStops(Array(count).fill("#123456")) }) }), db, "member"));
    expect((await at(PALETTE_LIMITS.colors.max)).status).toBe(201);
    expect((await at(PALETTE_LIMITS.colors.max + 1)).status).toBe(400);
    expect((await at(PALETTE_LIMITS.colors.min)).status).toBe(201);
    expect((await at(PALETTE_LIMITS.colors.min - 1)).status).toBe(400);

    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "internal", message: "The palettes could not be read." } }, { status: 500 })));
    await open();
    expect(card().textContent).toContain("The palettes could not be read.");
    expect(button(card(), "Add a palette")).toBeUndefined();
  });
});
