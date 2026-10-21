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
 * write, the page's root following each pick at once, and Reset to Dezfil's default
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
/** What an earlier version stamped for the kinds of surface Liquid reached, or null. */
const liquidOnRoot = () => host.document.documentElement.getAttribute("data-look-liquid");
/** The eight picks at Dezfil's default: what a reset returns. */
const PICKS_DEFAULT = {
  color: "kelp", contrast: "standard", font: "inter", background: "atlantic", corners: "rounded", rail: "hover", panels: "glass",
  transparency: "clear",
};
/** The row of switches an earlier version showed under Liquid. */
const KINDS = "set-liquid-panels";
/** The kinds an earlier version kept, as an account may still hold them. */
const RETIRED_KINDS = { liquidChrome: "off", liquidCards: "on", liquidDialogs: "on" };

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

describe("Panels, with Liquid in one recipe", () => {
  it("holds Panels and Background under every choice, with no row of switches, and stamps Liquid as Panels alone", async () => {
    await open();
    for (const choice of ["Liquid", "Paper", "Glass"]) {
      holding = true;
      await pick("set-panels", choice);
      const rows = card("Panels and background").querySelectorAll("[data-stack]").map(element => element.getAttribute("id"));
      expect(rows, choice).toEqual(["set-panels", "set-background"]);
      expect(row(KINDS), choice).toBeNull();
      expect(card("Panels and background").querySelectorAll('[role="switch"]'), choice).toHaveLength(0);
      expect(liquidOnRoot(), choice).toBeNull();
      await act(async () => { held.shift()!(); });
      await settle();
      holding = false;
    }
    expect(writes()).toEqual([{ look: { panels: "liquid" } }, { look: { panels: "paper" } }, { look: { panels: "glass" } }]);
  });

  it("returns Panels, Transparency and Background at the card's Reset under Liquid, an account's retired kinds left as they are", async () => {
    stored = { ...stored, panels: "liquid", transparency: "medium", background: "plain", ...RETIRED_KINDS } as Look;
    await open();
    expect(onRoot()).toMatchObject({ panels: "liquid", transparency: "medium", background: "plain" });
    const panels = card("Panels and background");
    await press(panels, "Reset to defaults: Panels and background");
    await settle();
    expect(writes()).toEqual([{ look: { panels: "glass", transparency: "clear", background: "atlantic" } }]);
    expect(stored).toMatchObject(RETIRED_KINDS);
    await press(panels, "Undo reset to defaults: Panels and background");
    await settle();
    expect(writes().at(-1)).toEqual({ look: { panels: "liquid", transparency: "medium", background: "plain" } });
    expect(liquidOnRoot()).toBeNull();
  });

  it("shows Transparency under Panels only while Panels is Liquid, as three segments that save as they are clicked", async () => {
    await open();
    expect(row("set-transparency")).toBeNull();
    await pick("set-panels", "Liquid");
    await settle();
    expect(names("set-transparency")).toEqual(["Clear", "Medium", "Firm"]);
    expect(picked("set-transparency")).toEqual(["Clear"]);
    // Beside its label, not under it as the picture rows are.
    expect(row("set-transparency").hasAttribute("data-stack")).toBe(false);
    await pick("set-transparency", "Medium");
    await settle();
    expect(writes().at(-1)).toEqual({ look: { transparency: "medium" } });
    expect(onRoot()).toMatchObject({ panels: "liquid", transparency: "medium" });
    expect(saved("set-transparency")).toEqual(["Saved"]);
    await pick("set-panels", "Paper");
    await settle();
    expect(row("set-transparency")).toBeNull();
    // Out of sight is not reset: the step stays kept for the next time Liquid is picked.
    expect(writes().at(-1)).toEqual({ look: { panels: "paper" } });
    expect(stored.transparency).toBe("medium");
    await pick("set-panels", "Liquid");
    await settle();
    expect(picked("set-transparency")).toEqual(["Medium"]);
  });

  it("returns the eight picks with Reset to Dezfil's default under Liquid, and Undo writes back what it changed", async () => {
    stored = { ...stored, panels: "liquid", ...RETIRED_KINDS } as Look;
    await open();
    await press(top(), "Reset to Dezfil's default");
    await settle();
    expect(writes()).toEqual([{ look: PICKS_DEFAULT }]);
    await press(top(), "Undo reset to Dezfil's default");
    await settle();
    expect(writes()[1]).toEqual({ look: { color: "harbor", rail: "icons", panels: "liquid" } });
    expect(liquidOnRoot()).toBeNull();
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
    ...LOOK_CARDS.flatMap(card => [card.title, ...card.rows.flatMap(row => [row.label, ...lookChoices(row.key).map(value => choiceLabel(row.key, value))])]),
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
    expect(said(container)).toContain("Liquid");
    expect(said(container)).not.toContain("Menus and pop-overs");
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
