import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceTestAnswer } from "@/lib/settings/service-test-answer";
import { HostElement, HostEvent, installDomHost } from "../testing/dom-host";
import { DataTab } from "./DataTab";
import { governedNote } from "./data-table";
import { instanceReadFixture, type Resolution } from "./read-fixture";
import { SETTLE_MS } from "./save-unit";

/**
 * Data & services: one card per outside service, the private hosts and
 * who may connect or import from links, drawn from the configuration
 * read. Each number is shown in the page's unit and written in its
 * variable's; each address is its own small form outside its card's
 * numbers, typed and kept on Save, shown afterwards as scheme and host
 * only, removed behind a confirmation; a Test answers in its line; a
 * cache is cleared. The server is a fake that keeps an address as the
 * read discloses it (scheme and host), applies a write the way the
 * foundation does (a null returns the default), refuses a private address
 * in the egress check's words, and answers with the whole read.
 */

const MIB = 1024 * 1024;
const BLOCKED = "The requested address is not reachable from this server: loopback, private-network, link-local, and metadata addresses are blocked by default. Specific hosts can be allowed with DEZFIL_EGRESS_ALLOWLIST.";
const KEY = "SEEDED-KEY-0002-QUERY";

let stored: Record<string, unknown>;
let addresses: Record<string, { set: true; origin: string } | { set: true; unreadable: true }>;
let pinned: Record<string, Resolution>;
let services: { geocode: { bytes: number; answers: number; budgetMb: number }; isochrone: { bytes: number; answers: number; budgetMb: number };
  overpass: { bytes: number; answers: number; budgetMb: number }; overture: { listed: false } | { listed: true; releases: number; newest: string; listedAt: string } };
let tests: Record<string, ServiceTestAnswer | { status: number; code: string; message: string }>;
let held: (() => void)[] | null;
let requests: { url: string; method: string; body: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

const answer = () => instanceReadFixture({
  ...Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, source: "stored" as const, storedValue: value }])),
  ...Object.fromEntries(Object.entries(addresses).map(([key, value]) => [key, { value, source: "stored" as const, storedValue: null }])),
  ...pinned,
}, { services } as never);

beforeEach(() => {
  stored = {}; pinned = {}; held = null; requests = [];
  addresses = { geocoderUrl: { set: true, origin: "https://geocoder.example" } };
  services = {
    geocode: { bytes: 3.1 * MIB, answers: 1284, budgetMb: 64 }, isochrone: { bytes: 0, answers: 0, budgetMb: 64 },
    overpass: { bytes: 0, answers: 0, budgetMb: 2048 },
    overture: { listed: true, releases: 5, newest: "2026-09-17.0", listedAt: new Date(Date.now() - 2 * 3_600_000 - 60_000).toISOString() },
  };
  tests = {
    geocode: { service: "geocode", result: "passed", milliseconds: 180 },
    overpass: { service: "overpass", result: "failed", reason: "status", status: 503 },
    s3: { service: "s3", result: "failed", reason: "refused", message: BLOCKED },
    overture: { service: "overture", result: "passed", releases: 6, newest: "2026-10-01.0" },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url === "/api/instance/settings" && method === "GET") return Response.json(answer());
    if (held && method !== "GET") await new Promise<void>(resolve => held!.push(resolve));
    if (url === "/api/instance/settings" && method === "PATCH") {
      const problems: string[] = [];
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (!(key in answer().settings) || !["geocoderUrl", "isochroneUrl", "overpassUrl", "s3Endpoint"].includes(key) || value === null) continue;
        if (typeof value !== "string" || !/^https?:\/\//.test(value)) problems.push(`${key}: Expected an http or https address of at most 2048 characters.`);
        else if (/\/\/(10\.|127\.|localhost)/.test(value)) problems.push(`${key}: ${BLOCKED}`);
      }
      if (problems.length) return Response.json({ error: { code: "invalid_request", message: problems.join(" ") } }, { status: 400 });
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        const address = ["geocoderUrl", "isochroneUrl", "overpassUrl", "s3Endpoint"].includes(key);
        if (value === null) { delete stored[key]; delete addresses[key]; }
        else if (address) addresses[key] = { set: true, origin: new URL(String(value)).origin };
        else stored[key] = value;
      }
      return Response.json(answer());
    }
    const tested = /^\/api\/instance\/services\/(\w+)\/test$/.exec(url);
    if (tested && method === "POST") {
      const result = tests[tested[1]];
      if (result && "code" in result) return Response.json({ error: { code: result.code, message: result.message } }, { status: result.status });
      return Response.json(result);
    }
    if (url === "/api/templates" && method === "GET") {
      return Response.json({ templates: [], catalogue: { state: "not_read", host: "https://github.com", folder: false, readAt: null, reason: null, status: null },
        downloads: { versions: 0, bytes: 0 } });
    }
    const cleared = /^\/api\/instance\/caches\?service=(\w+)$/.exec(url);
    if (cleared && method === "DELETE") {
      const cache = cleared[1] as "geocode" | "isochrone" | "overpass";
      services = { ...services, [cache]: { ...services[cache], bytes: 0, answers: 0 } };
      return Response.json({ cleared: [cache] });
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
  await act(async () => root.render(<DataTab />));
  await settle();
}
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const cards = () => container.querySelectorAll("section");
const card = (title: string) => cards().find(section => section.querySelector("h2")?.textContent === title)!;
const head = (title: string) => card(title).querySelector("h2")!.parentElement!;
const labels = (title: string) => card(title).querySelectorAll("b").map(b => b.textContent);
const row = (title: string, label: string) => {
  const name = card(title).querySelectorAll("b").find(b => b.textContent === label)!;
  return card(title).querySelector(`[id="${name.id.replace(/-label$/, "")}"]`)!;
};
const input = (scope: HostElement, label: string) => scope.querySelectorAll("input").find(element => element.getAttribute("aria-label") === label)!;
const buttons = (scope: HostElement) => scope.querySelectorAll("button").map(button => button.textContent);
const press = async (scope: HostElement, label: string) => {
  await act(async () => { scope.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
  await settle();
};
const typed = { inputType: "insertText" };
const type = (element: HostElement, text: string) => act(async () => props(element).onChange({ target: { value: text }, nativeEvent: typed }));
const enter = (element: HostElement) => act(async () => props(element).onKeyDown({ key: "Enter", preventDefault() {}, nativeEvent: {} }));
const submit = async (scope: HostElement) => {
  await act(async () => { scope.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
  await settle();
};
const writes = () => requests.filter(request => request.method === "PATCH").map(request => request.body);
const release = async () => { await act(async () => { for (const respond of held!.splice(0)) respond(); }); await settle(); };
const answerLine = (scope: HostElement) => scope.querySelector("[data-answer]");
const dialog = () => host.document.querySelector('[role="dialog"]');

describe("Data & services", () => {
  it("draws the eight cards with their rows and no other, at the read's values in the page's units", async () => {
    pinned = { egressAllowlist: { value: ["10.20.0.0/16", "gis-db.internal"], source: "environment", locked: true } };
    await open();
    // The read, and the template list for the Templates card's downloads; both stay on this server.
    expect(requests.map(request => request.url)).toEqual(["/api/instance/settings", "/api/templates"]);
    expect(cards().map(section => section.querySelector("h2")!.textContent)).toEqual([
      "Address finder", "Travel time", "OpenStreetMap", "Overture Maps", "Cloud storage", "Templates", "Private network", "Connections and imports",
    ]);
    expect(labels("Address finder")).toEqual(["Address", "Gap between requests", "Answer time limit", "Keep found addresses for", "Cache"]);
    // Travel time has no address: Not set up, and its address row alone.
    expect(labels("Travel time")).toEqual(["Address"]);
    expect(head("Travel time").textContent).toContain("Not set up");
    expect(buttons(head("Travel time"))).toEqual([]);
    expect(labels("OpenStreetMap")).toEqual(["Address", "Time budget per query", "Keep answers for", "Cache"]);
    expect(labels("Overture Maps")).toEqual(["Release list"]);
    expect(labels("Cloud storage")).toEqual(["S3 address", "Read with the server’s credentials"]);
    expect(labels("Templates")).toEqual(["Catalogue", "Catalogue address", "Downloaded"]);
    expect(labels("Private network")).toEqual(["Hosts the server may reach"]);
    expect(labels("Connections and imports")).toEqual(["Who may add database connections", "Who may import from links"]);
    // A Test at the head of each service card; Overture's is Check now, in its row.
    for (const title of ["Address finder", "OpenStreetMap", "Cloud storage", "Templates"]) expect(buttons(head(title)), title).toEqual(["Test"]);
    for (const title of ["Overture Maps", "Private network", "Connections and imports"]) expect(buttons(head(title)), title).toEqual([]);
    expect(buttons(row("Overture Maps", "Release list"))).toEqual(["Check now"]);

    // Numbers in the page's units, with the page's bounds.
    const gap = input(card("Address finder"), "Gap between requests");
    expect([gap.value, gap.getAttribute("min"), gap.getAttribute("max"), gap.getAttribute("step")]).toEqual(["1", "0", "60", "0.1"]);
    expect(row("Address finder", "Gap between requests").textContent).toContain("seconds");
    expect(input(card("Address finder"), "Answer time limit").value).toBe("10");
    const keep = input(card("Address finder"), "Keep found addresses for");
    expect([keep.value, keep.getAttribute("min"), keep.getAttribute("max")]).toEqual(["30", "1", "365"]);
    expect(row("Address finder", "Keep found addresses for").textContent).toContain("days");
    expect(input(card("OpenStreetMap"), "Time budget per query").value).toBe("60");
    expect(input(card("OpenStreetMap"), "Keep answers for").value).toBe("24");
    expect(row("OpenStreetMap", "Keep answers for").textContent).toContain("hours");

    // Addresses: a saved one as scheme and host with Set and Remove, a default with Default, each over an empty field.
    expect(row("Address finder", "Address").textContent).toContain("https://geocoder.example");
    expect(row("Address finder", "Address").textContent).toContain("Set");
    expect(buttons(row("Address finder", "Address"))).toEqual(["Remove"]);
    expect(input(card("Address finder"), "Address finder address").value).toBe("");
    expect(row("OpenStreetMap", "Address").textContent).toContain("https://overpass-api.de");
    expect(row("OpenStreetMap", "Address").textContent).toContain("Default");
    expect(buttons(row("OpenStreetMap", "Address"))).toEqual([]);
    expect(row("Cloud storage", "S3 address").textContent).toContain("Amazon S3");
    expect(row("Cloud storage", "S3 address").textContent).toContain("Default");
    expect(input(card("Travel time"), "Travel time address").value).toBe("");

    // Caches, the release list, the locked rows and the rules.
    expect(row("Address finder", "Cache").textContent).toContain("3.1 MB of 64 MB · 1,284 addresses");
    expect(card("Address finder").querySelectorAll("button").find(button => button.textContent === "Clear")!.disabled).toBe(false);
    expect(row("OpenStreetMap", "Cache").textContent).toContain("Empty");
    expect(card("OpenStreetMap").querySelectorAll("button").find(button => button.textContent === "Clear")!.disabled).toBe(true);
    expect(row("Overture Maps", "Release list").textContent).toContain("5 releases, newest 2026-09-17.0 · Checked 2 hours ago");
    expect(input(card("Cloud storage"), "Read with the server’s credentials").value).toBe("Off");
    expect(row("Cloud storage", "Read with the server’s credentials").textContent).toContain("Changes with DEZFIL_OBJECT_STORE_CREDENTIALS when the server restarts.");
    const hosts = card("Private network").querySelector("textarea")!;
    expect([hosts.value, hosts.disabled]).toEqual(["10.20.0.0/16\ngis-db.internal", true]);
    expect(row("Private network", "Hosts the server may reach").textContent).toContain("Set in the server's environment by DEZFIL_EGRESS_ALLOWLIST.");
    expect(row("Private network", "Hosts the server may reach").textContent).toContain(governedNote());
    const checked = (group: string) => container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!.querySelectorAll('[role="radio"]')
      .filter(radio => radio.getAttribute("aria-checked") === "true").map(radio => radio.textContent);
    expect(checked("Who may add database connections")).toEqual(["Everyone"]);
    expect(checked("Who may import from links")).toEqual(["Everyone"]);
    // At the defaults there is nothing to reset.
    expect(container.querySelectorAll("[data-unit-slot]")).toEqual([]);
  });

  it("names the variable of every row the server's environment sets, and offers no field there", async () => {
    pinned = {
      geocoderUrl: { value: { set: true, origin: "https://nominatim.stadtwerke.example" }, source: "environment", locked: true },
      geocodePaceMs: { value: 1500, source: "environment", locked: true },
      objectStoreCredentials: { value: true, source: "environment", locked: true },
    };
    await open();
    const address = row("Address finder", "Address");
    expect(input(address, "Address finder address")).toMatchObject({ value: "https://nominatim.stadtwerke.example", disabled: true });
    expect(address.textContent).toContain("Set in the server's environment by DEZFIL_GEOCODER_URL.");
    expect(buttons(address)).toEqual([]);
    expect(address.querySelectorAll("input")).toHaveLength(1);
    expect(input(card("Address finder"), "Gap between requests")).toMatchObject({ value: "1.5 seconds", disabled: true });
    expect(row("Address finder", "Gap between requests").textContent).toContain("Set in the server's environment by DEZFIL_GEOCODE_PACE_MS.");
    expect(input(card("Cloud storage"), "Read with the server’s credentials").value).toBe("On");
    expect(row("Cloud storage", "Read with the server’s credentials").textContent).toContain("Set in the server's environment by DEZFIL_OBJECT_STORE_CREDENTIALS.");
    // No hosts set: None, and the variable that would set them.
    expect(input(card("Private network"), "Hosts the server may reach").value).toBe("None");
    expect(row("Private network", "Hosts the server may reach").textContent).toContain("Changes with DEZFIL_EGRESS_ALLOWLIST when the server restarts.");
  });

  it("shows a number in the page's unit and writes it in the variable's, Saved only after the response", async () => {
    await open();
    const gap = input(card("Address finder"), "Gap between requests");
    await type(gap, "1.2");
    expect(writes()).toEqual([]);
    held = [];
    await enter(gap);
    await settle();
    expect(writes()).toEqual([{ geocodePaceMs: 1200 }]);
    expect(row("Address finder", "Gap between requests").querySelectorAll('[role="status"]')).toEqual([]);
    await release();
    expect(input(card("Address finder"), "Gap between requests").value).toBe("1.2");
    expect(row("Address finder", "Gap between requests").querySelectorAll('[role="status"]').map(mark => mark.textContent)).toEqual(["Saved"]);
    held = null;
    await type(input(card("Address finder"), "Keep found addresses for"), "2");
    await enter(input(card("Address finder"), "Keep found addresses for"));
    await settle();
    expect(writes().at(-1)).toEqual({ geocodeMatchCacheHours: 48 });
    expect(input(card("Address finder"), "Keep found addresses for").value).toBe("2");
    // Finer than tenths, or out of the page's range, is refused before any request.
    for (const [text, words] of [["1.25", "Enter a number with at most one decimal place."], ["61", "Enter a number from 0 to 60."]]) {
      await type(input(card("Address finder"), "Gap between requests"), text);
      await enter(input(card("Address finder"), "Gap between requests"));
      await settle();
      expect(row("Address finder", "Gap between requests").textContent, text).toContain(words);
    }
    expect(writes()).toHaveLength(2);
  });

  it("keeps a stepped number at once, the settled value only, in the variable's unit", async () => {
    await open();
    vi.useFakeTimers();
    const time = input(card("OpenStreetMap"), "Time budget per query");
    for (const text of ["61", "62", "63"]) await act(async () => props(time).onChange({ target: { value: text }, nativeEvent: {} }));
    expect(writes()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_MS); });
    expect(writes()).toEqual([{ overpassTimeoutS: 63 }]);
  });

  it("takes travel time's gap in whole seconds", async () => {
    addresses.isochroneUrl = { set: true, origin: "https://router.example" };
    await open();
    const gap = input(card("Travel time"), "Gap between requests");
    expect(gap.getAttribute("step")).toBe("1");
    await type(gap, "1.5");
    await enter(gap);
    await settle();
    expect(row("Travel time", "Gap between requests").textContent).toContain("Enter a whole number.");
    await type(gap, "3");
    await enter(gap);
    await settle();
    expect(writes()).toEqual([{ isochronePaceMs: 3000 }]);
  });

  it("returns a card's numbers on Reset, never its address, and Undo writes them back", async () => {
    stored = { geocodePaceMs: 2000, geocodeMatchCacheHours: 240 };
    await open();
    await press(head("Address finder"), "Reset to defaults");
    expect(writes()).toEqual([{ geocodePaceMs: null, geocodeRequestTimeoutS: null, geocodeMatchCacheHours: null }]);
    expect(input(card("Address finder"), "Gap between requests").value).toBe("1");
    expect(input(card("Address finder"), "Keep found addresses for").value).toBe("30");
    expect(row("Address finder", "Address").textContent).toContain("https://geocoder.example");
    expect(addresses.geocoderUrl).toEqual({ set: true, origin: "https://geocoder.example" });
    await press(head("Address finder"), "Undo");
    expect(writes().at(-1)).toEqual({ geocodePaceMs: 2000, geocodeMatchCacheHours: 240 });
    expect(input(card("Address finder"), "Gap between requests").value).toBe("2");
  });

  it("keeps a typed address only on Save, then shows its scheme and host with Set and opens the card", async () => {
    await open();
    const field = input(card("Travel time"), "Travel time address");
    const address = `https://seed-user:${KEY}@router.example/isochrone?key=${KEY}`;
    await type(field, address);
    expect(writes()).toEqual([]);
    expect(buttons(row("Travel time", "Address"))).toEqual(["Save", "Cancel"]);
    held = [];
    await submit(row("Travel time", "Address"));
    expect(writes()).toEqual([{ isochroneUrl: address }]);
    expect(row("Travel time", "Address").querySelectorAll('[role="status"]').map(mark => mark.textContent)).not.toContain("Saved");
    await release();
    expect(input(card("Travel time"), "Travel time address").value).toBe("");
    expect(row("Travel time", "Address").textContent).toContain("https://router.example");
    expect(row("Travel time", "Address").textContent).toContain("Set");
    expect(row("Travel time", "Address").querySelectorAll('[role="status"]').map(mark => mark.textContent)).toContain("Saved");
    expect(labels("Travel time")).toEqual(["Address", "Gap between requests", "Answer time limit", "Keep areas for", "Cache"]);
    expect(buttons(head("Travel time"))).toEqual(["Test"]);
    // Nothing on the page holds the key once the field is cleared.
    expect(container.textContent).not.toContain(KEY);
    expect(container.descendants().flatMap(element => [...element.attributes.values(), (element as unknown as { value?: string }).value ?? ""])
      .filter(text => text.includes(KEY))).toEqual([]);
  });

  it("refuses an address in the server's words, echoing nothing, keeps what was typed, and Cancel clears it", async () => {
    await open();
    const field = input(card("OpenStreetMap"), "OpenStreetMap address");
    await type(field, "http://10.0.0.5/api/interpreter");
    await submit(row("OpenStreetMap", "Address"));
    expect(row("OpenStreetMap", "Address").textContent).toContain(BLOCKED);
    expect(row("OpenStreetMap", "Address").textContent).not.toContain("overpassUrl");
    expect(input(card("OpenStreetMap"), "OpenStreetMap address").value).toBe("http://10.0.0.5/api/interpreter");
    expect(row("OpenStreetMap", "Address").textContent).toContain("Default");
    await press(row("OpenStreetMap", "Address"), "Cancel");
    expect(input(card("OpenStreetMap"), "OpenStreetMap address").value).toBe("");
    expect(row("OpenStreetMap", "Address").textContent).not.toContain(BLOCKED);
    expect(buttons(row("OpenStreetMap", "Address"))).toEqual([]);
  });

  it("removes a saved address only after the confirmation, OpenStreetMap's back to the public server", async () => {
    addresses.overpassUrl = { set: true, origin: "https://osm.stadtwerke.example" };
    await open();
    await press(row("OpenStreetMap", "Address"), "Remove");
    expect(writes()).toEqual([]);
    expect(dialog()?.textContent).toContain("OpenStreetMap imports go to the public Overpass server again.");
    await act(async () => { dialog()!.querySelectorAll("button").find(button => button.textContent === "Cancel")!.click(); });
    await settle();
    expect(dialog()).toBeNull();
    expect(writes()).toEqual([]);
    await press(row("OpenStreetMap", "Address"), "Remove");
    await act(async () => { dialog()!.querySelectorAll("button").find(button => button.textContent === "Remove address")!.click(); });
    await settle();
    expect(writes()).toEqual([{ overpassUrl: null }]);
    expect(dialog()).toBeNull();
    expect(row("OpenStreetMap", "Address").textContent).toContain("https://overpass-api.de");
    expect(row("OpenStreetMap", "Address").textContent).toContain("Default");
    // The address finder without its address: Not set up, the address row alone.
    await press(row("Address finder", "Address"), "Remove");
    expect(dialog()?.textContent).toContain("Place search and geocoding stop until an address is saved again.");
    await act(async () => { dialog()!.querySelectorAll("button").find(button => button.textContent === "Remove address")!.click(); });
    await settle();
    expect(labels("Address finder")).toEqual(["Address"]);
    expect(head("Address finder").textContent).toContain("Not set up");
  });

  it("says a saved address the instance's key cannot read, with Remove", async () => {
    addresses.overpassUrl = { set: true, unreadable: true };
    await open();
    expect(row("OpenStreetMap", "Address").textContent).toContain("Set");
    expect(row("OpenStreetMap", "Address").textContent).toContain("The instance’s encryption key cannot read the saved address. Save it again.");
    expect(buttons(row("OpenStreetMap", "Address"))).toEqual(["Remove"]);
  });

  it("answers each Test in its line from the closed shape, and Check now updates the release list", async () => {
    await open();
    await press(head("Address finder"), "Test");
    expect(requests.at(-1)).toMatchObject({ url: "/api/instance/services/geocode/test", method: "POST" });
    expect([answerLine(head("Address finder"))?.textContent, answerLine(head("Address finder"))?.getAttribute("data-answer")]).toEqual(["Answered in 180 ms", "passed"]);
    await press(head("OpenStreetMap"), "Test");
    expect([answerLine(head("OpenStreetMap"))?.textContent, answerLine(head("OpenStreetMap"))?.getAttribute("data-answer")]).toEqual(["Answered with status 503.", "failed"]);
    await press(head("Cloud storage"), "Test");
    expect(answerLine(head("Cloud storage"))?.textContent).toBe(BLOCKED);
    tests.s3 = { status: 400, code: "service_address_unreadable", message: "The saved address for \"S3 endpoint\" cannot be read with this instance's encryption key." };
    await press(head("Cloud storage"), "Test");
    expect(answerLine(head("Cloud storage"))?.textContent).toBe("The saved address for \"S3 endpoint\" cannot be read with this instance's encryption key.");
    // Nothing a Test does changes a setting.
    expect(writes()).toEqual([]);
    await press(row("Overture Maps", "Release list"), "Check now");
    expect(requests.at(-1)).toMatchObject({ url: "/api/instance/services/overture/test", method: "POST" });
    expect(answerLine(row("Overture Maps", "Release list"))?.textContent).toBe("6 releases, newest 2026-10-01.0");
    expect(row("Overture Maps", "Release list").textContent).toContain("6 releases, newest 2026-10-01.0 · Checked just now");
  });

  it("holds a Test while it runs, so a second press sends nothing", async () => {
    await open();
    held = [];
    await press(head("Address finder"), "Test");
    const test = head("Address finder").querySelectorAll("button").find(button => button.textContent === "Test")!;
    expect([test.disabled, test.getAttribute("aria-busy")]).toEqual([true, "true"]);
    await act(async () => { test.click(); });
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
    await release();
    expect(answerLine(head("Address finder"))?.textContent).toBe("Answered in 180 ms");
  });

  it("clears a cache at once and says Cleared, Clear then held back while it is empty", async () => {
    await open();
    await press(row("Address finder", "Cache"), "Clear");
    expect(requests.at(-1)).toMatchObject({ url: "/api/instance/caches?service=geocode", method: "DELETE" });
    expect(row("Address finder", "Cache").textContent).toContain("Empty");
    expect(row("Address finder", "Cache").querySelectorAll('[role="status"]').map(mark => mark.textContent)).toEqual(["Cleared"]);
    expect(card("Address finder").querySelectorAll("button").find(button => button.textContent === "Clear")!.disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("keeps who may connect and import from links at once", async () => {
    await open();
    await act(async () => {
      container.querySelector('[role="radiogroup"][aria-label="Who may import from links"]')!.querySelectorAll('[role="radio"]')
        .find(radio => radio.textContent === "Admins only")!.click();
    });
    await settle();
    expect(writes()).toEqual([{ "imports.links": "admins" }]);
    await act(async () => {
      container.querySelector('[role="radiogroup"][aria-label="Who may add database connections"]')!.querySelectorAll('[role="radio"]')
        .find(radio => radio.textContent === "Admins only")!.click();
    });
    await settle();
    expect(writes().at(-1)).toEqual({ "connections.create": "admins" });
    expect(card("Connections and imports").textContent).toContain("Members keep the connections they already have.");
  });
});

describe("the words of Data & services", () => {
  it("says nothing but its titles, labels, units, values, actions and the lines that each name a surprise, with no em dash", async () => {
    addresses.isochroneUrl = { set: true, origin: "https://router.example" };
    await open();
    const said = (element: HostElement): string[] => element.childNodes.flatMap(node => node instanceof HostElement
      ? (node.getAttribute("aria-hidden") === "true" ? [] : said(node)) : [node.textContent.trim()]).filter(Boolean);
    const expected = new Set([
      "Address finder", "Travel time", "OpenStreetMap", "Overture Maps", "Cloud storage", "Templates", "Private network", "Connections and imports",
      "Catalogue", "In use", "Catalogue address", "Downloaded", "None", "Remove all", "https://github.com",
      "Address", "Gap between requests", "Answer time limit", "Keep found addresses for", "Keep areas for", "Time budget per query", "Keep answers for",
      "Cache", "Release list", "S3 address", "Read with the server’s credentials", "Hosts the server may reach",
      "Who may add database connections", "Who may import from links", "Everyone", "Admins only",
      "seconds", "days", "hours", "Test", "Clear", "Check now", "Remove", "Set", "Default",
      "https://geocoder.example", "https://router.example", "https://overpass-api.de", "Amazon S3",
      "3.1 MB of 64 MB · 1,284 addresses", "Empty", "5 releases, newest 2026-09-17.0 · Checked 2 hours ago",
      "Web addresses and cloud storage",
      // The surprises: the S3 address serves only links read without credentials, the credentials lend
      // the server's reach to every importer, and the private network note names what the check governs.
      "For s3:// links read without the server’s credentials.", "Anyone who may import from links can then read what the server can.",
      governedNote(),
      // The locked rows' sentences.
      "Changes with", "DEZFIL_OBJECT_STORE_CREDENTIALS", "when the server restarts.", "DEZFIL_EGRESS_ALLOWLIST",
    ]);
    expect(said(container).filter(text => !expected.has(text))).toEqual([]);
    expect(container.descendants().filter(element => element.hasAttribute("title") || element.hasAttribute("data-hint")).map(element => element.tagName)).toEqual([]);
    const everything = [container.textContent, ...container.descendants().flatMap(element => [...element.attributes.values()])];
    expect(everything.filter(text => text.includes("—"))).toEqual([]);
  });
});
