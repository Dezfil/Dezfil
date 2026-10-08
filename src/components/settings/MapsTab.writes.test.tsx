import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "@/app/api/instance/settings/route";
import { socketRequest } from "@/lib/assistant/testing/socket-request";
import { activateSettingsStore, readStoredSettings } from "@/lib/settings/store";
import { instanceSettingsFixture } from "../../../test-support/instance-settings";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { MapsTab } from "./MapsTab";
import { SAVED_HOLD_MS, SETTLE_MS } from "./save-unit";

/**
 * Every request the Maps tab sends, through the instance settings route
 * itself: the admin's session, the JSON check, the change operation's
 * validation and the store, as a browser's request meets them. A number
 * the card's own check refuses never leaves the card, and nothing the card
 * sends is refused, whether the fields are typed key by key or set whole
 * with no input type (as a browser tool may set them, which the field
 * reads as steps).
 */

interface Sent { readonly method: string; readonly body: Record<string, unknown> | null; readonly status: number; readonly refusal: string | null }

let fixture: ReturnType<typeof instanceSettingsFixture>;
let sent: Sent[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  fixture = instanceSettingsFixture();
  activateSettingsStore(fixture.db);
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (url !== "/api/instance/settings") return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    const request = socketRequest(new Request(`http://instance.test${url}`, {
      method, body: init.body ?? undefined,
      headers: { ...(init.headers as Record<string, string> | undefined), cookie: `dezfil_session=${fixture.admin.secret}`, origin: "http://instance.test" },
    }));
    const response = await (method === "PATCH" ? PATCH(request) : GET(request));
    const refusal = response.ok ? null : (await response.clone().json()).error.message as string;
    sent.push({ method, body: init.body ? JSON.parse(String(init.body)) : null, status: response.status, refusal });
    return response;
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  fixture.close();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
/** Long enough for stepped numbers to settle and be sent. */
async function settleSteps() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, SETTLE_MS + 30)); });
  await settle();
}
const card = (title: string) => container.querySelectorAll("section").find(section => section.querySelector("h2")?.textContent === title)!;
const row = (label: string) => container.querySelector(`[id="${container.querySelectorAll("b").find(b => b.textContent === label)!.id.replace(/-label$/, "")}"]`)!;
const field = (name: string) => container.querySelectorAll("input").find(input => input.getAttribute("aria-label") === name)!;
const saved = (label: string) => row(label).querySelectorAll('[role="status"]').map(element => element.textContent);
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const change = (name: string, text: string, inputType?: string) =>
  act(async () => props(field(name)).onChange({ target: { value: text }, nativeEvent: inputType ? { inputType } : {} }));
/** Typed key by key over the field's whole text, as a person types after selecting it. */
async function typeKeys(name: string, text: string) {
  for (let length = 1; length <= text.length; length += 1) await change(name, text.slice(0, length), "insertText");
}
/** Set whole, with no input type: the field reads it as a step. */
const setWhole = (name: string, text: string) => change(name, text);
const enter = (name: string) => act(async () => props(field(name)).onKeyDown({ key: "Enter", preventDefault() {}, nativeEvent: {} }));
const leave = (name: string) => act(async () => props(field(name)).onBlur({}));
const press = (scope: HostElement, label: string) => act(async () => { scope.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
const writes = () => sent.filter(request => request.method === "PATCH");
const stored = () => readStoredSettings(fixture.db);

/** A latitude's place down the world's height, from its top: the textbook form of Web Mercator. */
const mercator = (latitude: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) / Math.PI) / 2;
/** A click on the locator, its box at (100, 50), 176 by 110, its top edge 78 degrees north. */
async function clickLocator(longitudeShare: number, latitude: number) {
  const box = { left: 100, top: 50, width: 176, height: 110 };
  const y = box.top + ((mercator(latitude) - mercator(78)) * 176 / 110) * box.height;
  const locator = container.querySelector("[data-locator]")!;
  await act(async () => props(locator).onClick({ clientX: box.left + longitudeShare * box.width, clientY: y, currentTarget: { getBoundingClientRect: () => box } }));
}

describe.each([
  ["typed key by key", async (name: string, text: string) => { await typeKeys(name, text); }],
  ["set whole with no input type", async (name: string, text: string) => { await setWhole(name, text); await settleSteps(); }],
] as const)("the Maps tab's requests, its fields %s", (_how, enterText) => {
  it("sends nothing for a zoom its check refuses, and nothing it sends is refused, through a locator click, a Reset and an Undo", async () => {
    await act(async () => root.render(<MapsTab />));
    await settle();
    expect(sent.map(request => [request.method, request.status])).toEqual([["GET", 200]]);

    // The latitude, entered and left: kept exactly.
    await enterText("Latitude", "51.5074");
    await leave("Latitude");
    await settle();
    expect(writes().map(request => request.body)).toEqual([{ "newMap.latitude": 51.5074 }]);
    expect(stored()["newMap.latitude"]).toBe(51.5074);
    expect(saved("Starting view")).toEqual(["Saved"]);
    // The row's Saved, the latitude's, goes after its hold.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, SAVED_HOLD_MS + 50)); });
    expect(saved("Starting view")).toEqual([]);

    // The zoom, entered as 30, then Enter, then leaving the field: refused by the card, never sent.
    await enterText("Zoom", "30");
    await enter("Zoom");
    await settle();
    await leave("Zoom");
    await settleSteps();
    expect(writes().map(request => [request.body, request.status, request.refusal])).toEqual([[{ "newMap.latitude": 51.5074 }, 200, null]]);
    expect(row("Starting view").textContent).toContain("Zoom: Enter a number from 0 to 22.");
    expect(field("Zoom").value).toBe("30");
    expect(field("Zoom").getAttribute("aria-invalid")).toBe("true");
    expect(saved("Starting view")).toEqual([]);
    expect(stored()).not.toHaveProperty("newMap.zoom");

    // A click on the locator while the zoom field still holds 30: latitude and longitude alone.
    await clickLocator(0.75, 51.5);
    await settle();
    expect(writes().map(request => request.body).slice(1)).toEqual([{ "newMap.latitude": 51.5, "newMap.longitude": 90 }]);
    expect(field("Zoom").value).toBe("30");
    expect(row("Starting view").textContent).toContain("Zoom: Enter a number from 0 to 22.");

    // The card's Reset, then its Undo.
    await press(card("New maps"), "Reset to defaults");
    await settle();
    expect(writes()[2].body).toEqual({ "newMap.basemap": null, "newMap.latitude": null, "newMap.longitude": null, "newMap.zoom": null });
    expect(field("Zoom").value).toBe("1.3");
    expect(row("Starting view").textContent).not.toContain("Enter a number");
    await press(card("New maps"), "Undo");
    await settle();
    expect(writes()[3].body).toEqual({ "newMap.latitude": 51.5, "newMap.longitude": 90 });

    // Every request: the route accepted each, and none carried a zoom of 30.
    expect(sent.map(request => [request.method, request.status, request.refusal])).toEqual([
      ["GET", 200, null], ["PATCH", 200, null], ["PATCH", 200, null], ["PATCH", 200, null], ["PATCH", 200, null],
    ]);
    expect(writes().filter(request => request.body?.["newMap.zoom"] === 30)).toEqual([]);
    expect(stored()).toEqual({ "newMap.latitude": 51.5, "newMap.longitude": 90 });
  });
});
