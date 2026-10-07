import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIMEOUT_RELATIONSHIP } from "@/lib/settings/relationships";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { LimitsTab } from "./LimitsTab";
import { instanceReadFixture } from "./read-fixture";
import { SETTLE_MS } from "./save-unit";

/**
 * Limits: five cards drawn from the configuration read, each number kept
 * as it changes through the write, the capacities taken from the write's
 * response. The server is a fake that applies a write the way the
 * foundation does (a null returns the default), refuses the timeout
 * relationship in the server's own words, and answers with the whole read.
 */

let stored: Record<string, unknown>;
let pinned: Record<string, unknown>;
let capacities: { geocodeRows: number; isochroneOrigins: number };
let refuse: { status: number; code: string; message: string } | null;
let failRead: boolean;
let requests: { url: string; method: string; body: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

function answer() {
  return instanceReadFixture({
    ...Object.fromEntries(Object.entries(stored).filter(([, value]) => value !== null).map(([key, value]) => [key, { value, source: "stored", storedValue: value }])),
    ...Object.fromEntries(Object.entries(pinned).map(([key, value]) => [key, { value, source: "environment", locked: true }])),
  }, { capacities });
}

beforeEach(() => {
  stored = {}; pinned = {}; refuse = null; failRead = false; requests = [];
  capacities = { geocodeRows: 27, isochroneOrigins: 13 };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url === "/api/instance/settings" && method === "GET") {
      return failRead ? Response.json({ error: { code: "internal", message: "Settings could not be read." } }, { status: 500 }) : Response.json(answer());
    }
    if (url === "/api/instance/settings" && method === "PATCH") {
      if (refuse) return Response.json({ error: { code: refuse.code, message: refuse.message } }, { status: refuse.status });
      const next = { ...stored, ...body as Record<string, unknown> };
      const query = Number(next.queryTimeoutS ?? 60), run = Number(next.operationTimeoutS ?? 600);
      if (query >= run) return Response.json({ error: { code: "invalid_request", message: TIMEOUT_RELATIONSHIP } }, { status: 400 });
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
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function open() {
  await act(async () => root.render(<LimitsTab />));
  await settle();
}
const cards = () => container.querySelectorAll("section");
const card = (title: string) => cards().find(section => section.querySelector("h2")?.textContent === title)!;
const row = (label: string) => container.querySelector(`[id="${container.querySelectorAll("b").find(b => b.textContent === label)!.id.replace(/-label$/, "")}"]`)!;
const field = (label: string) => container.querySelectorAll("input").find(input => input.getAttribute("aria-label") === label)!;
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const typed = { inputType: "insertText" };
const type = (label: string, text: string) => act(async () => props(field(label)).onChange({ target: { value: text }, nativeEvent: typed }));
const stepTo = (label: string, text: string) => act(async () => props(field(label)).onChange({ target: { value: text }, nativeEvent: {} }));
const leave = (label: string) => act(async () => props(field(label)).onBlur({}));
const enter = (label: string) => act(async () => props(field(label)).onKeyDown({ key: "Enter", preventDefault() {}, nativeEvent: {} }));
const writes = () => requests.filter(request => request.method === "PATCH").map(request => request.body);
const buttons = (scope: HostElement) => scope.querySelectorAll("button").map(button => button.textContent);
const press = (scope: HostElement, label: string) => act(async () => { scope.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
const saved = (label: string) => row(label).querySelectorAll('[role="status"]').map(element => element.textContent);

describe("Limits", () => {
  it("draws the five cards from the configuration read, each row under its label with the read's unit and range", async () => {
    await open();
    expect(requests.map(request => request.url)).toEqual(["/api/instance/settings"]);
    expect(cards().map(section => section.querySelector("h2")!.textContent)).toEqual(["Imports", "Queries", "Tools", "Image export", "Public requests"]);
    expect(field("Query time limit").value).toBe("60");
    expect([field("Query time limit").getAttribute("min"), field("Query time limit").getAttribute("max")]).toEqual(["5", "600"]);
    expect(row("Query time limit").textContent).toContain("seconds");
    expect(row("Query time limit").textContent).toContain("Also applies to published maps.");
    expect([field("Tools waiting").getAttribute("min"), field("Tools waiting").getAttribute("max")]).toEqual(["1", "200"]);
    // A count has no unit after it, and a rate window reads as the page says it.
    expect(row("Tools running at once").textContent).toBe("Tools running at onceThey share the query engine’s memory.");
    expect(row("Tools waiting").textContent).toBe("Tools waiting");
    expect(row("Images at once").textContent).toBe("Images at once");
    expect(row("Requests per visitor").textContent).toBe("Requests per visitorevery 10 seconds");
    expect(row("Tile requests per visitor").textContent).toBe("Tile requests per visitorevery 10 seconds");
    expect(row("OpenStreetMap area").textContent).toContain("km²");
    const editable = container.querySelectorAll("input").filter(input => !input.disabled);
    expect(editable).toHaveLength(14);
    expect(editable.every(input => input.getAttribute("type") === "number")).toBe(true);
  });

  it("keeps a typed number on leaving the field or Enter, and shows Saved only once the write is answered", async () => {
    await open();
    await type("Query time limit", "90");
    expect(writes()).toEqual([]);
    expect(buttons(card("Queries"))).not.toContain("Save");
    await leave("Query time limit");
    await settle();
    expect(writes()).toEqual([{ queryTimeoutS: 90 }]);
    expect(saved("Query time limit")).toEqual(["Saved"]);
    await type("Rows shown in results", "2000");
    await enter("Rows shown in results");
    await settle();
    expect(writes()[1]).toEqual({ previewRows: 2000 });
  });

  it("keeps a stepped number at once, sending only the value the steps settle on", async () => {
    await open();
    vi.useFakeTimers();
    for (const value of ["2", "3", "4"]) await stepTo("Images at once", value);
    expect(writes()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_MS); });
    expect(writes()).toEqual([{ exportRenderConcurrency: 4 }]);
  });

  it("refuses a number outside the read's range before any request, with the red line under its row", async () => {
    await open();
    await type("Time limit per image", "301");
    await leave("Time limit per image");
    await settle();
    expect(writes()).toEqual([]);
    expect(row("Time limit per image").textContent).toContain("Enter a number from 10 to 300.");
    expect(field("Time limit per image").getAttribute("aria-invalid")).toBe("true");
  });

  it("draws the feature cap and the largest image fixed, and a setting the environment pins locked", async () => {
    pinned = { uploadMaxMb: 8192, operationConcurrency: 3 };
    await open();
    // A pinned count reads bare, as the page writes every count.
    expect(field("Tools running at once").disabled).toBe(true);
    expect(field("Tools running at once").value).toBe("3");
    expect(field("Features drawn per layer").disabled).toBe(true);
    expect(field("Features drawn per layer").value).toBe("250,000 features");
    expect(row("Features drawn per layer").textContent).toContain("Changes with DEZFIL_RENDER_CAP_FEATURES when the server restarts.");
    expect(field("Largest image").disabled).toBe(true);
    expect(field("Largest image").value).toBe("4,096 px per side");
    expect(row("Largest image").textContent).toBe("Largest image");
    expect(field("Largest upload").disabled).toBe(true);
    expect(field("Largest upload").value).toBe("8,192 MB");
    expect(row("Largest upload").textContent).toContain("Set in the server's environment by DEZFIL_UPLOAD_MAX_MB.");
    // Pinned at a value other than its default, it still offers no Reset.
    expect(buttons(card("Imports"))).not.toContain("Reset to defaults");
  });

  it("marks a capacity Not set up while the read reports its service's address unset", async () => {
    pinned = { isochroneUrl: { set: true, origin: "https://travel.example" } };
    await open();
    expect(row("Geocode addresses").textContent).toContain("Up to 27 addresses per run");
    expect(row("Geocode addresses").textContent).toContain("Not set up");
    expect(row("Travel-time area").textContent).toContain("Up to 13 origins per run");
    expect(row("Travel-time area").textContent).not.toContain("Not set up");
    // A mark, not a way somewhere.
    expect(row("Geocode addresses").querySelector("a")).toBeNull();
  });

  it("draws no mark when the read does not say whether a service is set up", async () => {
    const read = answer();
    const settings = Object.fromEntries(Object.entries(read.settings).filter(([key]) => key !== "geocoderUrl" && key !== "isochroneUrl"));
    vi.mocked(fetch).mockImplementation(async () => Response.json({ ...read, settings }));
    await open();
    expect(row("Geocode addresses").textContent).not.toContain("Not set up");
    expect(row("Travel-time area").textContent).not.toContain("Not set up");
  });

  it("takes the capacities from the write's response, never from what is typed", async () => {
    await open();
    expect(row("Geocode addresses").textContent).toContain("Up to 27 addresses per run");
    expect(row("Travel-time area").textContent).toContain("Up to 13 origins per run");
    await type("Time limit per tool run", "70");
    expect(row("Geocode addresses").textContent).toContain("Up to 27 addresses per run");
    capacities = { geocodeRows: 1, isochroneOrigins: 0 };
    await leave("Time limit per tool run");
    await settle();
    expect(writes()).toEqual([{ operationTimeoutS: 70 }]);
    expect(row("Geocode addresses").textContent).toContain("Up to 1 address per run");
    expect(row("Travel-time area").textContent).toContain("None at these limits");
    // A limit in another card answers with the capacities too.
    capacities = { geocodeRows: 3, isochroneOrigins: 1 };
    await type("Query time limit", "50");
    await leave("Query time limit");
    await settle();
    expect(row("Geocode addresses").textContent).toContain("Up to 3 addresses per run");
    expect(row("Travel-time area").textContent).toContain("Up to 1 origin per run");
  });

  it("shows the server's refusal between the two time limits under the row's label, never the API's key, and keeps nothing", async () => {
    stored = { operationTimeoutS: 90 };
    await open();
    await type("Query time limit", "90");
    await leave("Query time limit");
    await settle();
    expect(writes()).toEqual([{ queryTimeoutS: 90 }]);
    const text = row("Query time limit").textContent;
    expect(text).toContain("Query time limit must be less than Time limit per tool run.");
    expect(text).not.toMatch(/queryTimeoutS|operationTimeoutS/);
    expect(saved("Query time limit")).toEqual([]);
    expect(field("Query time limit").value).toBe("90");
    expect(stored.queryTimeoutS).toBeUndefined();
  });

  it("draws a refusal that names no row as the card's error note, in the rows' words", async () => {
    await open();
    refuse = { status: 409, code: "setting_locked", message: "remoteMaxMb: Locked by DEZFIL_REMOTE_MAX_MB." };
    await type("Largest link import", "4096");
    await leave("Largest link import");
    await settle();
    const note = card("Imports").querySelector('[role="alert"]')!;
    expect(note.textContent).toContain("Largest link import: Locked by DEZFIL_REMOTE_MAX_MB.");
    expect(note.textContent).not.toContain("remoteMaxMb");
    expect(field("Largest link import").value).toBe("2048");
  });

  it("resets a card to the read's defaults in one write, then offers Undo", async () => {
    stored = { queryTimeoutS: 90, previewRows: 2000 };
    await open();
    expect(buttons(card("Image export"))).not.toContain("Reset to defaults");
    // Five cards may each offer it: the card's title tells them apart by name.
    const named = (scope: HostElement) => scope.querySelectorAll("[data-unit-slot]").map(button => button.getAttribute("aria-label"));
    expect(named(card("Queries"))).toEqual(["Reset to defaults: Queries"]);
    await press(card("Queries"), "Reset to defaults");
    await settle();
    expect(writes()).toEqual([{ queryTimeoutS: null, previewRows: null }]);
    expect(field("Query time limit").value).toBe("60");
    expect(field("Rows shown in results").value).toBe("1000");
    expect(buttons(card("Queries"))).toContain("Undo");
    expect(named(card("Queries"))).toEqual(["Undo reset to defaults: Queries"]);
    await press(card("Queries"), "Undo");
    await settle();
    expect(writes()[1]).toEqual({ queryTimeoutS: 90, previewRows: 2000 });
    expect(field("Query time limit").value).toBe("90");
  });

  it("draws a failed read as the error note with Try again", async () => {
    failRead = true;
    await open();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Settings could not be read.");
    expect(container.querySelectorAll("input")).toEqual([]);
    failRead = false;
    await press(container, "Try again");
    await settle();
    expect(field("Query time limit").value).toBe("60");
  });
});
