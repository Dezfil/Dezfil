import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomPalette } from "@/lib/metadata/palettes";
import type { ServiceTestAnswer } from "@/lib/settings/service-test-answer";
import { HostElement, HostEvent, installDomHost } from "../testing/dom-host";
import { LibrariesTab } from "./LibrariesTab";
import type { LibraryStyleRead } from "./libraries-table";
import { evenStops } from "./palettes-table";
import { instanceReadFixture, type Resolution } from "./read-fixture";

/**
 * Libraries: Basemaps, Satellite imagery and Palettes, drawn from the
 * configuration read and the palette read. A built-in style's Offered and
 * the single-map switch are kept at once through the instance write, an
 * added style's Offered through the library's own operation, each Saved
 * only after the response; Reset returns the five switches, never an
 * added style. A style is added by its name and address and removed
 * behind a question. The tile address is the Data & services address row,
 * the credit typed text kept on Save. The server is a fake that keeps an
 * address as the read discloses it (scheme and host), applies a write the
 * way the foundation does (a null returns the default), refuses a private
 * address in the egress check's words, and answers with the whole read.
 */

const BLOCKED = "The requested address is not reachable from this server: loopback, private-network, link-local, and metadata addresses are blocked by default. Specific hosts can be allowed with DEZFIL_EGRESS_ALLOWLIST.";
const KEY = "SEEDED-KEY-0008-QUERY";
const USER_INFORMATION = "Browsers draw no tiles from an address that carries a user name or password. Put the key in the path or the query.";
const HARBOR: LibraryStyleRead = { id: "style-harbor", name: "Harbor chart", url: "https://tiles.harbor.example/styles/chart/style.json",
  attribution: [{ label: "Harbor Office" }], offered: true, addedAt: "2026-10-01T08:00:00.000Z" };

let stored: Record<string, unknown>;
let imagery: { set: true; origin: string; userInformation?: true } | { set: true; unreadable: true } | null;
let pinned: Record<string, Resolution>;
let library: LibraryStyleRead[];
let palettes: CustomPalette[];
let tile: ServiceTestAnswer;
let refuseOffer: boolean;
let held: (() => void)[] | null;
let requests: { url: string; method: string; body: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

const answer = () => instanceReadFixture({
  ...Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, source: "stored" as const, storedValue: value }])),
  ...(imagery ? { satelliteUrl: { value: imagery, source: "stored" as const, storedValue: null } } : {}),
  ...pinned,
}, { basemapStyles: library } as never);

beforeEach(() => {
  stored = {}; imagery = null; pinned = {}; held = null; requests = []; refuseOffer = false;
  library = [HARBOR];
  palettes = [{ name: "stadtwerke-blues", label: "Stadtwerke blues", stops: evenStops(["#e8f1fa", "#4a8fd0", "#0d3566"]) } as CustomPalette];
  tile = { service: "satellite", result: "passed", milliseconds: 240 } as ServiceTestAnswer;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url === "/api/instance/settings" && method === "GET") return Response.json(answer());
    if (url === "/api/palettes" && method === "GET") return Response.json({ custom: palettes });
    if (held && method !== "GET") await new Promise<void>(resolve => held!.push(resolve));
    if (url === "/api/instance/settings" && method === "PATCH") {
      const patch = body as Record<string, unknown>;
      const address = patch.satelliteUrl;
      if (typeof address === "string" && /\/\/(10\.|127\.|localhost)/.test(address)) {
        return Response.json({ error: { code: "invalid_request", message: `satelliteUrl: ${BLOCKED}` } }, { status: 400 });
      }
      for (const [key, value] of Object.entries(patch)) {
        if (key === "satelliteUrl") imagery = value === null ? null : { set: true, origin: new URL(String(value)).origin };
        else if (value === null) delete stored[key];
        else stored[key] = value;
      }
      return Response.json(answer());
    }
    if (url === "/api/instance/basemaps" && method === "POST") {
      const { name, url: address } = body as { name: string; url: string };
      if (/\/\/(10\.|127\.|localhost)/.test(address)) return Response.json({ error: { code: "invalid_request", message: BLOCKED } }, { status: 400 });
      const style = { id: `style-${library.length + 1}`, name, url: address, attribution: [{ label: new URL(address).hostname }], offered: true,
        addedAt: "2026-10-10T08:00:00.000Z" };
      library = [...library, style];
      return Response.json(style, { status: 201 });
    }
    const one = /^\/api\/instance\/basemaps\/([^/]+)$/.exec(url);
    if (one && method === "PATCH") {
      if (refuseOffer) return Response.json({ error: { code: "forbidden", message: "Only an admin can change the basemap library." } }, { status: 403 });
      library = library.map(style => style.id === one[1] ? { ...style, offered: (body as { offered: boolean }).offered } : style);
      return Response.json(library.find(style => style.id === one[1]));
    }
    if (one && method === "DELETE") {
      library = library.filter(style => style.id !== one[1]);
      return Response.json({ removed: true });
    }
    if (url === "/api/instance/services/satellite/test" && method === "POST") return Response.json(tile);
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
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function open() {
  await act(async () => root.render(<LibrariesTab />));
  await settle();
}
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const card = (id: string) => container.querySelector(`[id="${id}"]`)!;
const basemaps = () => card("card-basemaps"), satellite = () => card("card-satellite");
const head = (scope: HostElement) => scope.querySelector("h2")!.parentElement!;
const styleRows = () => basemaps().querySelectorAll("li").map(li => [li.getAttribute("id"), li.querySelector("strong")!.textContent,
  li.querySelectorAll("span").map(span => span.textContent).find(text => text?.includes("·") || text?.includes(".example")) ?? ""]);
const rowLabels = (scope: HostElement) => scope.querySelectorAll("b").map(b => b.textContent);
const row = (scope: HostElement, label: string) => {
  const name = scope.querySelectorAll("b").find(b => b.textContent === label)!;
  return scope.querySelector(`[id="${name.id.replace(/-label$/, "")}"]`)!;
};
const switchOf = (name: string) => container.querySelectorAll('[role="switch"]').find(element => element.getAttribute("aria-label") === name)!;
const flip = async (name: string, on: boolean) => { await act(async () => props(switchOf(name)).onChange({ target: { checked: on } })); await settle(); };
const input = (scope: HostElement, label: string) => scope.querySelectorAll("input").find(element => element.getAttribute("aria-label") === label)!;
const buttons = (scope: HostElement) => scope.querySelectorAll("button").map(button => button.getAttribute("aria-label") ?? button.textContent);
const press = async (scope: HostElement, label: string) => {
  const target = scope.querySelectorAll("button").find(button => button.textContent === label || button.getAttribute("aria-label") === label);
  expect(target, `no button ${label}`).toBeTruthy();
  await act(async () => { target!.click(); });
  await settle();
};
const type = (element: HostElement, text: string) => act(async () => props(element).onChange({ target: { value: text }, nativeEvent: { inputType: "insertText" } }));
const submit = async (scope: HostElement) => {
  await act(async () => { scope.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
  await settle();
};
const marks = (scope: HostElement) => scope.querySelectorAll('[role="status"]').map(mark => mark.textContent);
const changes = () => requests.filter(request => request.method !== "GET").map(({ url, method, body }) => ({ url, method, body }));
const writes = () => requests.filter(request => request.url === "/api/instance/settings" && request.method === "PATCH").map(request => request.body);
const release = async () => { await act(async () => { for (const respond of held!.splice(0)) respond(); }); await settle(); };
const dialog = () => host.document.querySelector('[role="dialog"]');
const inDialog = async (label: string) => {
  await act(async () => { dialog()!.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
  await settle();
};

describe("Libraries", () => {
  it("draws Basemaps, Satellite imagery and Palettes with their rows and no other, from the two reads", async () => {
    await open();
    expect(requests.map(request => request.url).sort()).toEqual(["/api/instance/settings", "/api/palettes"]);
    expect(container.querySelectorAll("section").map(section => section.getAttribute("id"))).toEqual(["card-basemaps", "card-satellite", "card-palettes"]);
    // The built-in styles with their captures, no Satellite without imagery, then the added style by its host.
    expect(styleRows()).toEqual([
      ["lib-style-dark", "Dark", "OpenFreeMap · built in"], ["lib-style-light", "Light", "OpenFreeMap · built in"],
      ["lib-style-streets", "Streets", "OpenFreeMap · built in"], ["lib-style-style-harbor", "Harbor chart", "tiles.harbor.example"],
    ]);
    expect(basemaps().querySelectorAll("[data-style]").map(thumb => thumb.getAttribute("data-style"))).toEqual(["dark", "light", "streets"]);
    expect(basemaps().querySelector("h2")!.textContent).toBe("Basemaps4");
    expect(container.querySelectorAll('[role="switch"]').map(element => [element.getAttribute("aria-label"), (element as unknown as { checked: boolean }).checked]))
      .toEqual([["Offer Dark", true], ["Offer Light", true], ["Offer Streets", true], ["Offer Harbor chart", true], ["Style addresses on single maps", true]]);
    expect(rowLabels(basemaps())).toEqual(["Style addresses on single maps"]);
    expect(buttons(head(basemaps()))).toEqual(["Add a style"]);
    expect(buttons(basemaps().querySelector('[id="lib-style-style-harbor"]')!)).toEqual(["Remove Harbor chart"]);
    for (const id of ["lib-style-dark", "lib-style-light", "lib-style-streets"]) expect(buttons(basemaps().querySelector(`[id="${id}"]`)!), id).toEqual([]);
    // Satellite imagery not set up: the tile address over an empty field, the credit, no Test, no Reset.
    expect(head(satellite()).textContent).toContain("Not set up");
    expect(buttons(head(satellite()))).toEqual([]);
    expect(rowLabels(satellite())).toEqual(["Tile address", "Credit"]);
    expect(input(satellite(), "Satellite tile address").value).toBe("");
    expect(input(satellite(), "Satellite tile address").getAttribute("placeholder")).toBe("https://imagery.example.org/{z}/{x}/{y}.jpg");
    expect(input(satellite(), "Credit").value).toBe("");
    expect(props(input(satellite(), "Credit")).maxLength).toBe(160);
    expect(card("card-palettes").querySelectorAll("li").map(li => li.getAttribute("id"))).toEqual(["palette-stadtwerke-blues"]);
    // At the defaults there is nothing to reset.
    expect(container.querySelectorAll("[data-unit-slot]")).toEqual([]);
  });

  it("keeps a built-in style's Offered at once, Saved only after the response", async () => {
    await open();
    held = [];
    await flip("Offer Streets", false);
    expect(writes()).toEqual([{ "basemaps.streets": false }]);
    expect(marks(card("lib-style-streets"))).toEqual([]);
    await release();
    expect(marks(card("lib-style-streets"))).toEqual(["Saved"]);
    expect((switchOf("Offer Streets") as unknown as { checked: boolean }).checked).toBe(false);
    held = null;
    await flip("Style addresses on single maps", false);
    expect(writes().at(-1)).toEqual({ "basemaps.singleMapStyles": false });
    expect(marks(row(basemaps(), "Style addresses on single maps"))).toEqual(["Saved"]);
    // Nothing reached the library.
    expect(changes().filter(change => change.url.startsWith("/api/instance/basemaps"))).toEqual([]);
  });

  it("keeps an added style's Offered through the library, Saved after the response, and puts it back on a refusal", async () => {
    await open();
    held = [];
    await flip("Offer Harbor chart", false);
    expect(changes()).toEqual([{ url: "/api/instance/basemaps/style-harbor", method: "PATCH", body: { offered: false } }]);
    expect(marks(card("lib-style-style-harbor"))).toEqual([]);
    await release();
    expect(marks(card("lib-style-style-harbor"))).toEqual(["Saved"]);
    expect((switchOf("Offer Harbor chart") as unknown as { checked: boolean }).checked).toBe(false);
    expect(writes()).toEqual([]);
    held = null; refuseOffer = true;
    await flip("Offer Harbor chart", true);
    expect(card("lib-style-style-harbor").textContent).toContain("Only an admin can change the basemap library.");
    expect((switchOf("Offer Harbor chart") as unknown as { checked: boolean }).checked).toBe(false);
  });

  it("returns the five switches on Reset, never an added style, and Undo writes them back", async () => {
    stored = { "basemaps.dark": false, "basemaps.singleMapStyles": false };
    library = [{ ...HARBOR, offered: false }];
    await open();
    await press(head(basemaps()), "Reset to defaults");
    expect(writes()).toEqual([{ "basemaps.dark": null, "basemaps.light": null, "basemaps.streets": null, "basemaps.satellite": null, "basemaps.singleMapStyles": null }]);
    expect((switchOf("Offer Dark") as unknown as { checked: boolean }).checked).toBe(true);
    expect((switchOf("Style addresses on single maps") as unknown as { checked: boolean }).checked).toBe(true);
    expect((switchOf("Offer Harbor chart") as unknown as { checked: boolean }).checked).toBe(false);
    expect(library[0].offered).toBe(false);
    await press(head(basemaps()), "Undo");
    expect(writes().at(-1)).toEqual({ "basemaps.dark": false, "basemaps.singleMapStyles": false });
    expect((switchOf("Offer Dark") as unknown as { checked: boolean }).checked).toBe(false);
    expect(changes().filter(change => change.url.startsWith("/api/instance/basemaps"))).toEqual([]);
  });

  it("adds a style by its name and address, says its address is public, and refuses in the server's words keeping what was typed", async () => {
    await open();
    await press(head(basemaps()), "Add a style");
    const form = basemaps().querySelector("form")!;
    expect(form.textContent).toContain("Its address is public to anyone who sees a map drawn on it, published readers included.");
    expect(buttons(head(basemaps()))).toEqual([]);
    const fields = form.querySelectorAll("input");
    expect(fields.map(field => [props(field).type ?? "text", props(field).maxLength])).toEqual([["text", 60], ["url", 2048]]);
    // Nothing typed yet: Add style is held back; a name alone is asked for its address.
    expect(form.querySelectorAll("button").find(button => button.textContent === "Add style")!.disabled).toBe(true);
    await type(fields[0], "Coast");
    await submit(basemaps());
    expect(form.textContent).toContain("Enter the style’s address.");
    expect(changes()).toEqual([]);
    await type(fields[1], "http://10.0.0.8/style.json");
    await submit(basemaps());
    expect(basemaps().textContent).toContain(BLOCKED);
    expect(basemaps().querySelector("form")!.querySelectorAll("input").map(field => (field as unknown as { value: string }).value))
      .toEqual(["Coast", "http://10.0.0.8/style.json"]);
    await type(basemaps().querySelector("form")!.querySelectorAll("input")[1], "https://tiles.coast.example/style.json");
    await submit(basemaps());
    expect(changes().at(-1)).toEqual({ url: "/api/instance/basemaps", method: "POST", body: { name: "Coast", url: "https://tiles.coast.example/style.json" } });
    expect(basemaps().querySelector("form")).toBeNull();
    expect(styleRows().at(-1)).toEqual(["lib-style-style-2", "Coast", "tiles.coast.example"]);
    expect(marks(card("lib-style-style-2"))).toEqual(["Added"]);
    expect(basemaps().querySelector("h2")!.textContent).toBe("Basemaps5");
    expect(buttons(head(basemaps()))).toEqual(["Add a style"]);
  });

  it("closes the Add a style form on Cancel and on Escape, sending nothing", async () => {
    await open();
    await press(head(basemaps()), "Add a style");
    await type(basemaps().querySelector("form")!.querySelectorAll("input")[0], "Coast");
    await press(basemaps().querySelector("form")!, "Cancel");
    expect(basemaps().querySelector("form")).toBeNull();
    await press(head(basemaps()), "Add a style");
    await act(async () => props(basemaps().querySelector("form")!).onKeyDown({ key: "Escape", preventDefault() {} }));
    await settle();
    expect(basemaps().querySelector("form")).toBeNull();
    expect(changes()).toEqual([]);
  });

  it("removes an added style only after the question", async () => {
    await open();
    await press(card("lib-style-style-harbor"), "Remove Harbor chart");
    expect(changes()).toEqual([]);
    expect(dialog()?.textContent).toContain("Remove Harbor chart?");
    expect(dialog()?.textContent).toContain("Maps that already use it keep it.");
    await inDialog("Cancel");
    expect(dialog()).toBeNull();
    expect(changes()).toEqual([]);
    await press(card("lib-style-style-harbor"), "Remove Harbor chart");
    await inDialog("Remove style");
    expect(changes()).toEqual([{ url: "/api/instance/basemaps/style-harbor", method: "DELETE", body: undefined }]);
    expect(dialog()).toBeNull();
    expect(styleRows().map(([id]) => id)).toEqual(["lib-style-dark", "lib-style-light", "lib-style-streets"]);
  });
});

describe("Satellite imagery", () => {
  it("keeps a typed tile address only on Save, then shows its scheme and host, offers Satellite in Basemaps and a Test", async () => {
    await open();
    const template = `https://imagery.example/tiles/${KEY}/{z}/{x}/{y}.jpg?key=${KEY}`;
    await type(input(satellite(), "Satellite tile address"), template);
    expect(writes()).toEqual([]);
    expect(buttons(row(satellite(), "Tile address"))).toEqual(["Save", "Cancel"]);
    held = [];
    await submit(row(satellite(), "Tile address"));
    expect(writes()).toEqual([{ satelliteUrl: template }]);
    expect(marks(row(satellite(), "Tile address"))).not.toContain("Saved");
    await release();
    expect(input(satellite(), "Satellite tile address").value).toBe("");
    expect(row(satellite(), "Tile address").textContent).toContain("https://imagery.example");
    expect(row(satellite(), "Tile address").textContent).toContain("Set");
    expect(marks(row(satellite(), "Tile address"))).toContain("Saved");
    expect(buttons(head(satellite()))).toEqual(["Test"]);
    // Satellite joins the basemaps, its host under its name, offered.
    expect(styleRows().find(([id]) => id === "lib-style-satellite")).toEqual(["lib-style-satellite", "Satellite", "imagery.example"]);
    expect((switchOf("Offer Satellite") as unknown as { checked: boolean }).checked).toBe(true);
    // Nothing on the page holds the key once the field is cleared.
    expect(container.textContent).not.toContain(KEY);
    expect(container.descendants().flatMap(element => [...element.attributes.values(), (element as unknown as { value?: string }).value ?? ""])
      .filter(text => text.includes(KEY))).toEqual([]);
  });

  it("refuses a tile address in the server's words, naming the field and echoing nothing", async () => {
    await open();
    await type(input(satellite(), "Satellite tile address"), "http://10.0.0.5/{z}/{x}/{y}.png");
    await submit(row(satellite(), "Tile address"));
    expect(row(satellite(), "Tile address").textContent).toContain(BLOCKED);
    expect(row(satellite(), "Tile address").textContent).not.toContain("satelliteUrl");
    expect(input(satellite(), "Satellite tile address").value).toBe("http://10.0.0.5/{z}/{x}/{y}.png");
  });

  it("removes the tile address behind its question, and Satellite leaves Basemaps", async () => {
    imagery = { set: true, origin: "https://imagery.example" };
    await open();
    expect(styleRows().map(([id]) => id)).toContain("lib-style-satellite");
    await press(row(satellite(), "Tile address"), "Remove Satellite tile address");
    expect(writes()).toEqual([]);
    expect(dialog()?.textContent).toContain("Satellite leaves the basemap pickers. Maps on it keep their choice and draw the default style until an address is saved again.");
    await inDialog("Remove address");
    expect(writes()).toEqual([{ satelliteUrl: null }]);
    expect(head(satellite()).textContent).toContain("Not set up");
    expect(styleRows().map(([id]) => id)).not.toContain("lib-style-satellite");
  });

  it("keeps a typed credit only on Save, Saved after the response", async () => {
    imagery = { set: true, origin: "https://imagery.example" };
    await open();
    await type(input(satellite(), "Credit"), "Imagery © Stadtwerke");
    expect(writes()).toEqual([]);
    expect(buttons(row(satellite(), "Credit"))).toEqual(["Save", "Cancel"]);
    held = [];
    await submit(row(satellite(), "Credit"));
    expect(writes()).toEqual([{ satelliteAttribution: "Imagery © Stadtwerke" }]);
    expect(marks(row(satellite(), "Credit"))).toEqual([]);
    await release();
    expect(marks(row(satellite(), "Credit"))).toEqual(["Saved"]);
    expect(input(satellite(), "Credit").value).toBe("Imagery © Stadtwerke");
    expect(buttons(row(satellite(), "Credit"))).toEqual([]);
  });

  it("answers the Test in its line, a tile's time or its reason, and changes nothing", async () => {
    imagery = { set: true, origin: "https://imagery.example" };
    await open();
    await press(head(satellite()), "Test");
    expect(changes()).toEqual([{ url: "/api/instance/services/satellite/test", method: "POST", body: undefined }]);
    const line = () => head(satellite()).querySelector("[data-answer]")!;
    expect([line().textContent, line().getAttribute("data-answer")]).toEqual(["A tile arrived in 240 ms", "passed"]);
    tile = { service: "satellite", result: "failed", reason: "unexpected_answer" } as ServiceTestAnswer;
    await press(head(satellite()), "Test");
    expect([line().textContent, line().getAttribute("data-answer")]).toEqual(["Answered, but not with a tile image.", "failed"]);
    expect(writes()).toEqual([]);
  });

  it("names the variable of each row the environment sets, with no field, Save or Remove there", async () => {
    pinned = {
      satelliteUrl: { value: { set: true, origin: "https://imagery.stadtwerke.example" }, source: "environment", locked: true },
      satelliteAttribution: { value: "Imagery © Stadtwerke", source: "environment", locked: true },
    };
    await open();
    expect(input(satellite(), "Satellite tile address")).toMatchObject({ value: "https://imagery.stadtwerke.example", disabled: true });
    expect(row(satellite(), "Tile address").textContent).toContain("Set in the server's environment by DEZFIL_SATELLITE_URL.");
    expect(input(satellite(), "Credit")).toMatchObject({ value: "Imagery © Stadtwerke", disabled: true });
    expect(row(satellite(), "Credit").textContent).toContain("Set in the server's environment by DEZFIL_SATELLITE_ATTRIBUTION.");
    expect(buttons(satellite())).toEqual(["Test"]);
    expect(satellite().querySelectorAll("[data-unit-slot]")).toEqual([]);
  });

  it.each([
    ["saved", () => { imagery = { set: true, origin: "https://imagery.example", userInformation: true }; }],
    ["set by the variable", () => { pinned = { satelliteUrl: { value: { set: true, origin: "https://imagery.example", userInformation: true }, source: "environment", locked: true } }; }],
  ])("says under a tile address %s with a user name or password that it draws no tiles, and where the key belongs", async (_how, arrange) => {
    arrange();
    await open();
    expect(row(satellite(), "Tile address").textContent).toContain(USER_INFORMATION);
    expect(satellite().textContent?.split(USER_INFORMATION)).toHaveLength(2);
  });

  it("says a tile address the instance's key cannot read, with Remove and the Test, and no Satellite among the basemaps", async () => {
    imagery = { set: true, unreadable: true };
    await open();
    expect(row(satellite(), "Tile address").textContent).toContain("Set");
    expect(row(satellite(), "Tile address").textContent).toContain("The instance’s encryption key cannot read the saved address. Save it again.");
    expect(buttons(row(satellite(), "Tile address"))).toEqual(["Remove Satellite tile address"]);
    expect(buttons(head(satellite()))).toEqual(["Test"]);
    expect(styleRows().map(([id]) => id)).not.toContain("lib-style-satellite");
  });
});

describe("the words of Libraries", () => {
  it("says nothing but its titles, labels, values, actions and the lines that each name a surprise, with no em dash", async () => {
    imagery = { set: true, origin: "https://imagery.example" };
    stored = { satelliteAttribution: "Imagery © Example" };
    await open();
    const said = (element: HostElement): string[] => element.childNodes.flatMap(node => node instanceof HostElement
      ? (node.getAttribute("aria-hidden") === "true" ? [] : said(node)) : [node.textContent.trim()]).filter(Boolean);
    const expected = new Set([
      "Basemaps", "5", "Satellite imagery", "Palettes", "1",
      "Reset to defaults", "Add a style", "Add a palette", "Test",
      "Dark", "Light", "Streets", "Satellite", "Harbor chart", "OpenFreeMap · built in", "imagery.example", "tiles.harbor.example", "Offered",
      "Style addresses on single maps", "Allowed",
      "Tile address", "Credit", "https://imagery.example", "Set", "Remove",
      "Stadtwerke blues", "3 colors",
    ]);
    expect(said(container).filter(text => !expected.has(text))).toEqual([]);
    // An icon's button is named by its action and its hint says the same words; nothing else carries a hint.
    expect(container.descendants().filter(element => ["title", "data-hint"]
      .some(name => element.hasAttribute(name) && element.getAttribute(name) !== element.getAttribute("aria-label"))).map(element => element.tagName)).toEqual([]);
    await press(head(basemaps()), "Add a style");
    const everything = [container.textContent, ...container.descendants().flatMap(element => [...element.attributes.values()])];
    expect(everything.filter(text => text.includes("—"))).toEqual([]);
    expect(container.textContent).not.toMatch(/coming soon/i);
  });
});
