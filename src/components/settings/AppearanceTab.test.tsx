import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLook, LOOK_KEYS, lookAttributes, lookChoices, type Look } from "@/lib/look";
import { closePrivateState } from "../auth/private-state";
import { SignedIn } from "../sharing/signed-in";
import { HostElement, HostEvent, installDomHost } from "../testing/dom-host";
import { AppearanceTab } from "./AppearanceTab";
import { choiceLabel, LOOK_CARDS } from "./look-tab";
import { FADE_MS, UNDO_MS } from "./save-unit";

/**
 * Appearance: four cards of picture rows over the own-settings read and
 * write, the kinds Liquid reaches as switches while Liquid is shown, the
 * page's root following each pick at once, and Reset to Dezfil's default
 * at the heading row's right. The server is a fake that
 * keeps the look the way the own-settings operation does and answers
 * with the whole read; a test can hold an answer, refuse a write the way
 * the operation refuses a look value, or fail it like a lost connection.
 */

type Mode = "accept" | "refuse" | "fail";
let stored: Look;
let mode: Mode;
/** Writes wait for the test to let each answer go. */
let holding: boolean;
let held: (() => void)[];
let requests: { method: string; body: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
let mounted: boolean;

const read = () => ({ displayName: "Ada", instanceName: null, viewPrefs: {}, sourceGrouping: "kind", look: { ...stored } });

beforeEach(() => {
  stored = { ...defaultLook(), color: "harbor", rail: "icons" };
  mode = "accept"; holding = false; held = []; requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url !== "/api/settings") return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    requests.push({ method, body });
    if (method === "GET") return Response.json(read());
    const answer = () => {
      if (mode === "refuse") {
        const [key] = Object.keys(body.look);
        return Response.json({ error: { code: "invalid_request", message: `look.${key}: Expected one of the offered choices.` } }, { status: 400 });
      }
      if (mode === "fail") return Response.json({ error: { code: "internal", message: "The settings could not be saved." } }, { status: 500 });
      stored = { ...stored, ...body.look };
      return Response.json(read());
    };
    if (holding) return new Promise<Response>(resolve => { held.push(() => resolve(answer())); });
    return answer();
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  mounted = false;
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  // The look lives at workspace scope for the account; the next test is another document.
  closePrivateState();
  host.uninstall();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); });
}
/** The served document already carries the stored look on its root. */
function served() {
  for (const [name, value] of Object.entries(lookAttributes(stored))) host.document.documentElement.setAttribute(name, value as string);
}
async function open() {
  served();
  await act(async () => root.render(<AppearanceTab />));
  mounted = true;
  await settle();
}

const cards = () => container.querySelectorAll("section");
const card = (title: string) => cards().find(section => section.querySelector("h2")?.textContent === title)!;
const row = (id: string) => container.querySelector(`[id="${id}"]`)!;
/** What a control is called: its words, leaving out what is hidden from the name (a picture's own words). */
const nameOf = (element: HostElement): string => element.childNodes
  .map(node => node instanceof HostElement ? (node.getAttribute("aria-hidden") === "true" ? "" : nameOf(node)) : node.textContent).join("");
const radios = (id: string) => row(id).querySelectorAll('[role="radio"]');
const names = (id: string) => radios(id).map(nameOf);
const picked = (id: string) => radios(id).filter(radio => radio.getAttribute("aria-checked") === "true").map(nameOf);
const pick = (id: string, name: string) => act(async () => { radios(id).find(radio => nameOf(radio) === name)!.click(); });
const button = (scope: HostElement, name: string) => scope.querySelectorAll("button").find(element => element.textContent === name || element.getAttribute("aria-label") === name);
const press = (scope: HostElement, name: string) => act(async () => { button(scope, name)!.click(); });
const writes = () => requests.filter(request => request.method === "PATCH").map(request => request.body);
const onRoot = () => Object.fromEntries(LOOK_KEYS.flatMap(key => {
  const value = host.document.documentElement.getAttribute(`data-look-${key}`);
  return value === null ? [] : [[key, value]];
}));
const saved = (id: string) => row(id).querySelectorAll('[role="status"]').map(element => element.textContent);
const top = () => container.querySelector("[data-appearance-top]")!;
/** The kinds the root names under Liquid, or null when it names none. */
const liquidOnRoot = () => host.document.documentElement.getAttribute("data-look-liquid");
/** The seven picks at Dezfil's default: what a reset returns while no kind is shown. */
const PICKS_DEFAULT = { color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover", panels: "glass" };
const KINDS = "set-liquid-panels";
/** The kinds row's switches, by their words, and whether each is on. */
const switches = () => row(KINDS).querySelectorAll("label").map(label =>
  [label.textContent, (label.querySelector('[role="switch"]') as unknown as { checked: boolean }).checked]);
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const flip = (name: string, on: boolean) => act(async () => {
  const input = row(KINDS).querySelectorAll("label").find(label => label.textContent === name)!.querySelector('[role="switch"]')!;
  props(input).onChange({ target: { checked: on } });
});

describe("the Appearance tab", () => {
  it("draws the four cards in order with the seven picture rows and no other, Color first, each pick marked", async () => {
    await open();
    expect(requests).toEqual([{ method: "GET", body: undefined }]);
    expect(cards().map(section => section.querySelector("h2")!.textContent)).toEqual(["Color and contrast", "Panels and background", "Text", "Layout"]);
    const rows = container.querySelectorAll("[data-stack]");
    expect(rows.map(element => element.getAttribute("id"))).toEqual(["set-color", "set-contrast", "set-panels", "set-background", "set-typeface", "set-corners", "set-side-menu"]);
    expect(names("set-color")).toEqual(["Kelp", "Harbor", "Heather", "Slate"]);
    expect(names("set-panels")).toEqual(["Glass", "Liquid", "Paper"]);
    expect(picked("set-panels")).toEqual(["Glass"]);
    expect(radios("set-panels")[1].querySelector('[data-picture-panels="liquid"]')).not.toBeNull();
    expect(names("set-background")).toEqual(["Atlantic chart", "Plain", "Graticule", "Hex lattice"]);
    expect(names("set-side-menu")).toEqual(["Opens on hover", "Always open", "Icons only"]);
    expect(picked("set-color")).toEqual(["Harbor"]);
    expect(picked("set-side-menu")).toEqual(["Icons only"]);
    expect(picked("set-typeface")).toEqual(["Inter"]);
    // Each card a picture: its option drawn in the card's box.
    expect(radios("set-color")[2].querySelector('[data-picture-color="heather"]')).not.toBeNull();
    // No row carries a hint, and nothing waits for a Save.
    expect(container.querySelectorAll("[data-hint]")).toEqual([]);
    expect(button(container, "Save")).toBeUndefined();
  });

  it("changes the page's root the moment a pick is made, and shows Saved only once the server kept it", async () => {
    await open();
    holding = true;
    await pick("set-color", "Slate");
    expect(onRoot()).toEqual({ color: "slate", rail: "icons" });
    expect(picked("set-color")).toEqual(["Slate"]);
    expect(saved("set-color")).toEqual([]);
    expect(writes()).toEqual([{ look: { color: "slate" } }]);
    await act(async () => { held.shift()!(); });
    await settle();
    expect(saved("set-color")).toEqual(["Saved"]);
    expect(stored.color).toBe("slate");
  });

  it("returns the root to the saved look on a refusal, with the red line under the row and never Saved", async () => {
    await open();
    mode = "refuse"; holding = true;
    await pick("set-corners", "Soft");
    expect(onRoot()).toEqual({ color: "harbor", rail: "icons", corners: "soft" });
    await act(async () => { held.shift()!(); });
    await settle();
    expect(onRoot()).toEqual({ color: "harbor", rail: "icons" });
    expect(saved("set-corners")).toEqual([]);
    expect(row("set-corners").textContent).toContain("Expected one of the offered choices.");
  });

  it("returns the root and the row to the saved look when the write fails, with the page's note", async () => {
    await open();
    mode = "fail";
    await pick("set-typeface", "System");
    await settle();
    expect(onRoot()).toEqual({ color: "harbor", rail: "icons" });
    expect(picked("set-typeface")).toEqual(["Inter"]);
    expect(saved("set-typeface")).toEqual([]);
    expect(card("Text").textContent).toContain("The settings could not be saved.");
  });

  it("resets one card's picks in one write of their defaults, then Undo writes them back in one", async () => {
    stored = { ...defaultLook(), corners: "soft", rail: "open", color: "slate" };
    await open();
    const layout = card("Layout");
    expect(button(card("Text"), "Reset to defaults: Text")).toBeUndefined();
    await press(layout, "Reset to defaults: Layout");
    await settle();
    expect(writes()).toEqual([{ look: { corners: "rounded", rail: "hover" } }]);
    expect(onRoot()).toEqual({ color: "slate" });
    await press(layout, "Undo reset to defaults: Layout");
    await settle();
    expect(writes()[1]).toEqual({ look: { corners: "soft", rail: "open" } });
    expect(onRoot()).toEqual({ color: "slate", corners: "soft", rail: "open" });
  });
});

describe("Reset to Dezfil's default", () => {
  it("shows at the heading row only while a pick differs, returns every pick in one write and moves focus to Undo", async () => {
    await open();
    await press(top(), "Reset to Dezfil's default");
    await settle();
    expect(writes()).toEqual([{ look: PICKS_DEFAULT }]);
    expect(onRoot()).toEqual({});
    expect(picked("set-color")).toEqual(["Kelp"]);
    expect(host.document.activeElement).toBe(button(top(), "Undo reset to Dezfil's default"));
    expect(button(top(), "Reset to Dezfil's default")).toBeUndefined();
  });

  it("writes the previous picks back in one write on Undo and returns focus to the reset", async () => {
    await open();
    await press(top(), "Reset to Dezfil's default");
    await settle();
    await press(top(), "Undo reset to Dezfil's default");
    await settle();
    expect(writes()[1]).toEqual({ look: { color: "harbor", rail: "icons" } });
    expect(onRoot()).toEqual({ color: "harbor", rail: "icons" });
    expect(picked("set-side-menu")).toEqual(["Icons only"]);
    expect(host.document.activeElement).toBe(button(top(), "Reset to Dezfil's default"));
  });

  it("is not offered at Dezfil's default", async () => {
    stored = defaultLook();
    await open();
    expect(top().querySelectorAll("button")).toEqual([]);
  });

  it("lets Undo go after six seconds unless focus rests on it, fading first", async () => {
    await open();
    vi.useFakeTimers();
    await press(top(), "Reset to Dezfil's default");
    for (let i = 0; i < 4; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const undo = button(top(), "Undo reset to Dezfil's default")!;
    expect(host.document.activeElement).toBe(undo);
    // The browser reports the focus the tab moved there, as it does for any focus().
    await act(async () => { undo.dispatchEvent(new HostEvent("focusin", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS + FADE_MS); });
    expect(button(top(), "Undo reset to Dezfil's default")).toBe(undo);
    await act(async () => { undo.dispatchEvent(new HostEvent("focusout", { bubbles: true })); });
    expect(undo.hasAttribute("data-leaving")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(FADE_MS); });
    expect(button(top(), "Undo reset to Dezfil's default")).toBeUndefined();
    expect(writes()).toHaveLength(1);
  });

  it("lets an Undo nobody rests on go after six seconds", async () => {
    await open();
    vi.useFakeTimers();
    await press(top(), "Reset to Dezfil's default");
    for (let i = 0; i < 4; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS - 1); });
    expect(button(top(), "Undo reset to Dezfil's default")!.hasAttribute("data-leaving")).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(button(top(), "Undo reset to Dezfil's default")!.hasAttribute("data-leaving")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(FADE_MS); });
    expect(top().querySelectorAll("button")).toEqual([]);
  });

  it("lets Undo go at a newer pick and at a card's Reset, so it writes nothing back", async () => {
    await open();
    await press(top(), "Reset to Dezfil's default");
    await settle();
    await pick("set-contrast", "More contrast");
    await settle();
    expect(button(top(), "Undo reset to Dezfil's default")).toBeUndefined();
    expect(writes()).toEqual([{ look: PICKS_DEFAULT }, { look: { contrast: "more" } }]);
    await press(top(), "Reset to Dezfil's default");
    await settle();
    expect(button(top(), "Undo reset to Dezfil's default")).toBeDefined();
    await pick("set-background", "Plain");
    await settle();
    await press(card("Panels and background"), "Reset to defaults: Panels and background");
    await settle();
    expect(button(top(), "Undo reset to Dezfil's default")).toBeUndefined();
  });

  it("goes after every pick made before it, so none lands after it: the kept look is the default while Undo is offered", async () => {
    await open();
    holding = true;
    // The first pick's answer is held; the second waits behind it in its card.
    await pick("set-color", "Slate");
    await pick("set-color", "Heather");
    await press(top(), "Reset to Dezfil's default");
    while (held.length) {
      await act(async () => { held.shift()!(); });
      await settle();
    }
    // The second pick was made before the reset, which returns every pick: it is never sent after it.
    expect(writes()).toEqual([{ look: { color: "slate" } }, { look: PICKS_DEFAULT }]);
    expect(stored).toEqual(defaultLook());
    expect(onRoot()).toEqual({});
    expect(picked("set-color")).toEqual(["Kelp"]);
    expect(saved("set-color")).toEqual([]);
    // Undo writes back what the screen showed when the reset was pressed.
    await press(top(), "Undo reset to Dezfil's default");
    while (held.length) {
      await act(async () => { held.shift()!(); });
      await settle();
    }
    expect(writes().at(-1)).toEqual({ look: { color: "heather", rail: "icons" } });
    expect(stored).toEqual({ ...defaultLook(), color: "heather", rail: "icons" });
    expect(onRoot()).toEqual({ color: "heather", rail: "icons" });
  });

  it("sends a pick made after the reset even when it repeats a write the reset overtakes, and ends there", async () => {
    await open();
    holding = true;
    // Slate's answer is held; Heather waits behind it; the reset goes past
    // Heather; then Slate again, after the reset.
    await pick("set-color", "Slate");
    await pick("set-color", "Heather");
    await press(top(), "Reset to Dezfil's default");
    await pick("set-color", "Slate");
    while (held.length) {
      await act(async () => { held.shift()!(); });
      await settle();
    }
    expect(writes()).toEqual([{ look: { color: "slate" } }, { look: PICKS_DEFAULT }, { look: { color: "slate" } }]);
    expect(stored.color).toBe("slate");
    expect(picked("set-color")).toEqual(["Slate"]);
    expect(onRoot()).toEqual({ color: "slate" });
  });

  it("returns a row whose pick the reset went past to what is kept when the reset is refused", async () => {
    await open();
    holding = true;
    await pick("set-color", "Slate");
    await pick("set-color", "Heather");
    await press(top(), "Reset to Dezfil's default");
    // The first pick is kept; the reset after it fails like a lost write.
    await act(async () => { held.shift()!(); });
    await settle();
    mode = "fail";
    while (held.length) {
      await act(async () => { held.shift()!(); });
      await settle();
    }
    expect(writes()).toEqual([{ look: { color: "slate" } }, { look: PICKS_DEFAULT }]);
    expect(stored).toEqual({ ...defaultLook(), color: "slate", rail: "icons" });
    expect(picked("set-color")).toEqual(["Slate"]);
    expect(onRoot()).toEqual({ color: "slate", rail: "icons" });
    expect(container.textContent).toContain("The settings could not be saved.");
  });

  it("lets Undo go when the tab is left: nothing is written after", async () => {
    await open();
    vi.useFakeTimers();
    await press(top(), "Reset to Dezfil's default");
    for (let i = 0; i < 4; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(button(top(), "Undo reset to Dezfil's default")).toBeDefined();
    act(() => root.unmount());
    mounted = false;
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(writes()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Panels, and the kinds Liquid reaches", () => {
  it("shows the kinds as switches between Panels and Background only while Liquid is shown, each at its first value", async () => {
    await open();
    expect(row(KINDS)).toBeNull();
    holding = true;
    await pick("set-panels", "Liquid");
    // At once, before the answer: the row, and the root under Liquid with the first kinds.
    const rows = container.querySelectorAll("[data-stack]").map(element => element.getAttribute("id"));
    expect(rows.slice(2, 5)).toEqual(["set-panels", KINDS, "set-background"]);
    expect(row(KINDS).querySelector("b")!.textContent).toBe("Liquid panels");
    expect(switches()).toEqual([["Header and side menu", true], ["Side panels", true], ["On the map", true], ["Map buttons", true],
      ["Page cards", false], ["Cards inside panels", false], ["Menus and pop-overs", false], ["Dialogs", false]]);
    expect(onRoot()).toMatchObject({ panels: "liquid" });
    expect(liquidOnRoot()).toBe("chrome panels map buttons");
    await act(async () => { held.shift()!(); });
    await settle();
    expect(saved("set-panels")).toEqual(["Saved"]);
    holding = false;
    await pick("set-panels", "Paper");
    await settle();
    expect(row(KINDS)).toBeNull();
    expect(onRoot()).toMatchObject({ panels: "paper" });
    expect(liquidOnRoot()).toBeNull();
    expect(writes()).toEqual([{ look: { panels: "liquid" } }, { look: { panels: "paper" } }]);
  });

  it("keeps a kind as it is switched: the root at once, Saved only after the response, and the saved look back on a refusal", async () => {
    stored = { ...stored, panels: "liquid" };
    await open();
    holding = true;
    await flip("Page cards", true);
    expect(liquidOnRoot()).toBe("chrome panels map buttons cards");
    expect(writes()).toEqual([{ look: { liquidCards: "on" } }]);
    expect(saved(KINDS)).toEqual([]);
    await act(async () => { held.shift()!(); });
    await settle();
    expect(saved(KINDS)).toEqual(["Saved"]);
    expect(stored.liquidCards).toBe("on");
    mode = "refuse";
    await flip("Header and side menu", false);
    expect(liquidOnRoot()).toBe("panels map buttons cards");
    expect(saved(KINDS)).toEqual([]);
    await act(async () => { held.shift()!(); });
    await settle();
    expect(liquidOnRoot()).toBe("chrome panels map buttons cards");
    expect(saved(KINDS)).toEqual([]);
    expect(row(KINDS).textContent).toContain("Expected one of the offered choices.");
    expect(stored.liquidChrome).toBe("on");
  });

  it("leaves a kind out of sight stored at the card's Reset, and returns the kinds shown under Liquid, Undo writing them back", async () => {
    stored = { ...defaultLook(), panels: "paper", liquidCards: "on" };
    await open();
    const panels = card("Panels and background");
    await press(panels, "Reset to defaults: Panels and background");
    await settle();
    expect(writes()).toEqual([{ look: { panels: "glass", background: "atlantic" } }]);
    expect(stored.liquidCards).toBe("on");
    expect(button(panels, "Undo reset to defaults: Panels and background")).toBeDefined();
    // Liquid again: the kind kept while out of sight is there as it was.
    await pick("set-panels", "Liquid");
    await settle();
    expect(switches().find(([name]) => name === "Page cards")).toEqual(["Page cards", true]);
    expect(liquidOnRoot()).toBe("chrome panels map buttons cards");
    await press(panels, "Reset to defaults: Panels and background");
    await settle();
    expect(writes().at(-1)).toEqual({ look: { panels: "glass", background: "atlantic", liquidChrome: "on", liquidPanels: "on", liquidMap: "on",
      liquidButtons: "on", liquidCards: "off", liquidInner: "off", liquidMenus: "off", liquidDialogs: "off" } });
    expect(row(KINDS)).toBeNull();
    await press(panels, "Undo reset to defaults: Panels and background");
    await settle();
    expect(writes().at(-1)).toEqual({ look: { panels: "liquid", liquidCards: "on" } });
    expect(switches().find(([name]) => name === "Page cards")).toEqual(["Page cards", true]);
    expect(liquidOnRoot()).toBe("chrome panels map buttons cards");
  });

  it("returns every kind shown with Reset to Dezfil's default, and Undo writes back the kinds it hid", async () => {
    stored = { ...stored, panels: "liquid", liquidCards: "on", liquidMap: "off" };
    await open();
    await press(top(), "Reset to Dezfil's default");
    await settle();
    expect(writes()).toEqual([{ look: defaultLook() }]);
    expect(row(KINDS)).toBeNull();
    expect(liquidOnRoot()).toBeNull();
    await press(top(), "Undo reset to Dezfil's default");
    await settle();
    expect(writes()[1]).toEqual({ look: { color: "harbor", rail: "icons", panels: "liquid", liquidCards: "on", liquidMap: "off" } });
    expect(liquidOnRoot()).toBe("chrome panels buttons cards");
    expect(switches().filter(([, on]) => on).map(([name]) => name)).toEqual(["Header and side menu", "Side panels", "Map buttons", "Page cards"]);
  });

  it("returns only the picks with Reset to Dezfil's default while the kinds are out of sight", async () => {
    stored = { ...stored, panels: "paper", liquidCards: "on" };
    await open();
    await press(top(), "Reset to Dezfil's default");
    await settle();
    expect(writes()).toEqual([{ look: PICKS_DEFAULT }]);
    expect(stored.liquidCards).toBe("on");
  });
});

describe("a write still on its way when the tab is left", () => {
  const leave = () => { act(() => root.unmount()); mounted = false; };
  const answer = async () => {
    while (held.length) {
      await act(async () => { held.shift()!(); });
      await settle();
    }
  };

  it("leaves the root on what the server accepted", async () => {
    await open();
    holding = true;
    await pick("set-color", "Slate");
    leave();
    // Another browser of the same account changed the contrast meanwhile: the answer reports the whole look kept.
    stored = { ...stored, contrast: "more" };
    await answer();
    expect(stored).toEqual({ ...defaultLook(), color: "slate", rail: "icons", contrast: "more" });
    expect(onRoot()).toEqual({ color: "slate", rail: "icons", contrast: "more" });
    // Back on the tab, the rows show what the root does.
    root = createRoot(container as unknown as Element);
    await act(async () => root.render(<AppearanceTab />));
    mounted = true;
    await settle();
    expect(picked("set-color")).toEqual(["Slate"]);
    expect(picked("set-contrast")).toEqual(["More contrast"]);
  });

  it("returns the root to the saved look when the write is refused after the tab is gone", async () => {
    await open();
    holding = true;
    await pick("set-typeface", "System");
    expect(onRoot()).toEqual({ color: "harbor", rail: "icons", font: "system" });
    leave();
    mode = "fail";
    await answer();
    expect(stored).toEqual({ ...defaultLook(), color: "harbor", rail: "icons" });
    expect(onRoot()).toEqual({ color: "harbor", rail: "icons" });
  });

  it("returns the root to the saved look when the server refuses the value after the tab is gone", async () => {
    await open();
    holding = true;
    await pick("set-corners", "Soft");
    leave();
    mode = "refuse";
    await answer();
    expect(onRoot()).toEqual({ color: "harbor", rail: "icons" });
  });

  it("belongs to the account that made it: a change of account ends it, and a late answer never touches the root", async () => {
    const ada = { name: "Ada", sqlName: "ada" }, bob = { name: "Bob", sqlName: "bob" };
    served();
    await act(async () => root.render(<SignedIn account={ada}><AppearanceTab /></SignedIn>));
    mounted = true;
    await settle();
    holding = true;
    await pick("set-typeface", "System");
    leave();
    // The account changes: the workspace's private state closes before the next account's opens.
    closePrivateState();
    host.document.documentElement.removeAttribute("data-look-font");
    await answer();
    expect(onRoot()).toEqual({ color: "harbor", rail: "icons" });
    holding = false;
    stored = { ...defaultLook(), corners: "soft" };
    root = createRoot(container as unknown as Element);
    await act(async () => root.render(<SignedIn account={bob}><AppearanceTab /></SignedIn>));
    mounted = true;
    await settle();
    // The next account reads its own look; nothing of the first one's carries over.
    expect(requests.filter(request => request.method === "GET")).toHaveLength(2);
    expect(picked("set-corners")).toEqual(["Soft"]);
    expect(picked("set-typeface")).toEqual(["Inter"]);
    expect(picked("set-color")).toEqual(["Kelp"]);
  });
});

describe("the tab's words", () => {
  /** Every text the tab draws, its pictures' own drawings left out. */
  const said = (element: HostElement): string[] => element.childNodes.flatMap(node => node instanceof HostElement
    ? (node.getAttribute("aria-hidden") === "true" ? [] : said(node)) : [node.textContent.trim()]).filter(Boolean);
  /** Every text and attribute value, the pictures' included. */
  const everything = () => [container.textContent,
    ...container.descendants().flatMap(element => [...element.attributes.values()])];
  /** The only things the tab says: its titles, labels, choices and actions. */
  const SAYS = new Set([
    ...LOOK_CARDS.flatMap(card => [card.title, ...card.rows.flatMap(row => row.kind === "kinds"
      ? [row.label, ...row.kinds.map(kind => kind.label)]
      : [row.label, ...lookChoices(row.key).map(value => choiceLabel(row.key, value))])]),
    "Reset to defaults", "Reset to Dezfil's default", "Undo", "Saved",
  ]);
  const holdsTheCopyRules = () => {
    // No hint of any kind: no meta line, note or words after a control, and no tooltip.
    expect(said(container).filter(text => !SAYS.has(text))).toEqual([]);
    expect(container.descendants().filter(element => element.hasAttribute("data-hint") || element.hasAttribute("title"))
      .map(element => element.tagName)).toEqual([]);
    expect(everything().filter(text => text.includes("—"))).toEqual([]);
    // The product's word is color.
    expect(everything().filter(text => /colour/i.test(text))).toEqual([]);
  };

  it("says only its titles, labels, choices and actions: no hint, no em dash, and the word color", async () => {
    stored = { ...defaultLook(), color: "slate", corners: "soft", panels: "liquid" };
    await open();
    expect(said(container)).toContain("Menus and pop-overs");
    expect(said(container)).toContain("Reset to Dezfil's default");
    expect(said(container)).toContain("Reset to defaults");
    holdsTheCopyRules();
    await pick("set-typeface", "System");
    await settle();
    expect(saved("set-typeface")).toEqual(["Saved"]);
    holdsTheCopyRules();
    await press(top(), "Reset to Dezfil's default");
    await settle();
    expect(button(top(), "Undo reset to Dezfil's default")).toBeDefined();
    holdsTheCopyRules();
  });
});
