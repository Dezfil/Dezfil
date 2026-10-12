import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostElement, HostEvent, installDomHost, type HostDocument } from "../testing/dom-host";
import {
  atRest, discoverMembers, INK_STEP, LENS_ROLES, SETTLE_MS, splitSelectors, startPanelLens, watchPanelLens,
  type PanelLens, type RuleLike, type SheetLike,
} from "./panel-lens";

/**
 * The bend of the liquid panels over a stored document tree: the members
 * found through stylesheets, what each is given while its kind is on, what
 * is left alone, the settle while a surface resizes or moves, and the stop.
 * The browser's part is played by hand here and named as such: a member's
 * computed blur is its own rule's (a `data-own-blur` attribute stands for a
 * rule drawing another blur), else its role's blur as the nearest inline
 * value or the root gives it, which is how a rule reading the role resolves.
 * Whether Chromium draws the bend is the journey's to show.
 */

const rule = (selectorText: string, cssText: string): RuleLike => ({ selectorText, style: { cssText } });
const sheet = (...rules: RuleLike[]): SheetLike => ({ cssRules: rules });

/** The roles' values on the root while Liquid's kinds are on. */
const ROOT: Record<string, string> = {
  "--surface-glass-chrome-blur": "blur(9px)", "--surface-glass-chrome-lens": "20",
  "--surface-glass-panel-blur": "blur(24px)", "--surface-glass-panel-lens": "18",
  "--surface-overlay-panel-blur": "blur(24px)", "--surface-overlay-panel-lens": "18",
  "--surface-overlay-control-blur": "blur(6px)", "--surface-overlay-control-lens": "12",
  "--surface-page-card-blur": "blur(14px)", "--surface-page-card-lens": "14",
  "--surface-inner-card-blur": "blur(6px)", "--surface-inner-card-lens": "8",
  "--surface-menu-blur": "blur(24px)", "--surface-menu-lens": "14",
  "--surface-dialog-blur": "blur(24px)", "--surface-dialog-lens": "18",
};

/** The page's stylesheets: a member per rule that draws its role's blur. */
const SHEETS = (): SheetLike[] => [
  sheet(
    rule(".head", "background: var(--surface-glass-chrome-fill); backdrop-filter: var(--surface-glass-chrome-blur); box-shadow: var(--surface-glass-chrome-shadow);"),
    rule(".rail", "backdrop-filter: var(--surface-glass-chrome-blur);"),
    rule(".rail[data-expanded]", "backdrop-filter: var(--blur-glass);"),
    rule(".menu", "background: var(--surface-menu-fill); backdrop-filter: var(--surface-menu-blur); border: var(--surface-menu-edge);"),
    rule(".card", "backdrop-filter: var(--surface-page-card-blur);"),
    rule(".card:hover", "box-shadow: var(--surface-page-card-shadow-hover);"),
    rule(".layer", "backdrop-filter: var(--surface-inner-card-blur);"),
    rule(".switch::before", "background: var(--surface-inner-card-knob); backdrop-filter: var(--surface-inner-card-blur);"),
  ),
  { cssRules: [{ cssRules: [rule(".legend", "backdrop-filter: var(--surface-overlay-panel-blur);")] }] },
];

let host: ReturnType<typeof installDomHost>;
let doc: HostDocument;
let frames: (() => void)[];
let observers: { callback: (records: unknown[]) => void; target: unknown; disconnected: boolean }[];
let sizes: { callback: (entries: { target: unknown }[]) => void; watched: Set<unknown>; disconnected: boolean }[];
const rects = new WeakMap<object, { left: number; top: number; width: number; height: number }>();
const animations = new WeakMap<object, { playState: string; transitionProperty?: string }[]>();

/** A role's token as it reaches an element: the nearest inline value, else the root's. */
function token(el: HostElement, name: string): string {
  for (let node: HostElement | null = el; node && node !== doc.documentElement; node = node.parentElement) {
    const value = node.style.getPropertyValue(name);
    if (value) return value;
  }
  return ROOT[name] ?? "";
}
function computed(el: HostElement) {
  return {
    getPropertyValue(name: string): string {
      if (el === doc.documentElement) return ROOT[name] ?? "";
      if (name.startsWith("--")) return token(el, name);
      if (name === "border-top-left-radius") return el.getAttribute("data-radius") ?? "12px";
      if (name !== "backdrop-filter") return "";
      const own = el.getAttribute("data-own-blur");
      if (own) return own;
      const role = el.getAttribute("data-reads");
      return role ? token(el, `--surface-${role}-blur`) : "none";
    },
  };
}

/** An element on the page, reading a role's blur when it is a member, at a size. */
function make(parent: HostElement, className: string, attributes: Record<string, string> = {}, box?: [number, number]): HostElement {
  const el = doc.createElement("div");
  el.className = className;
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  if (box) rects.set(el, { left: 0, top: 0, width: box[0], height: box[1] });
  Object.assign(el, {
    getBoundingClientRect: () => rects.get(el) ?? { left: 0, top: 0, width: 0, height: 0 },
    getAnimations: () => animations.get(el) ?? [],
  });
  parent.appendChild(el);
  return el;
}
const bodyObserver = () => observers.find(observer => observer.target === doc.body && !observer.disconnected)!;
function flush() {
  for (let guard = 0; frames.length && guard < 20; guard += 1) frames.shift()!();
}
/** The inline properties an element carries. */
const inline = (el: HostElement) => Object.fromEntries(Object.entries(el.style).filter(([, value]) => typeof value === "string"));
const encode = (_field: Uint8ClampedArray, w: number, h: number) => `data:map/${w}x${h}`;
const defsOf = () => doc.body.children.find(child => child.hasAttribute("data-panel-lens")) ?? null;
const filterIds = () => (defsOf()?.descendants() ?? []).filter(node => node.localName === "filter").map(node => node.getAttribute("id"));

function liquid(words: string) {
  doc.documentElement.setAttribute("data-look-panels", "liquid");
  doc.documentElement.setAttribute("data-look-liquid", words);
}

beforeEach(() => {
  host = installDomHost();
  doc = host.document;
  Object.assign(doc, { styleSheets: SHEETS(), adoptedStyleSheets: [] });
  frames = [];
  observers = [];
  sizes = [];
  vi.stubGlobal("getComputedStyle", computed);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
  vi.stubGlobal("MutationObserver", class {
    readonly entry: (typeof observers)[number];
    constructor(callback: (records: unknown[]) => void) { this.entry = { callback, target: null, disconnected: false }; observers.push(this.entry); }
    observe(target: unknown) { this.entry.target = target; }
    disconnect() { this.entry.disconnected = true; }
  });
  vi.stubGlobal("ResizeObserver", class {
    readonly entry: (typeof sizes)[number];
    constructor(callback: (entries: { target: unknown }[]) => void) { this.entry = { callback, watched: new Set(), disconnected: false }; sizes.push(this.entry); }
    observe(target: unknown) { this.entry.watched.add(target); }
    unobserve(target: unknown) { this.entry.watched.delete(target); }
    disconnect() { this.entry.disconnected = true; this.entry.watched.clear(); }
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  host.uninstall();
});

const start = (bend = true): PanelLens => startPanelLens(doc as unknown as Document, { bend, encode });

describe("finding the members through the stylesheets", () => {
  it("names every rule that draws a role's blur by its role, inside media rules too, and no rule that reads another part only", () => {
    const index = discoverMembers(SHEETS());
    expect(Object.fromEntries(index.members)).toEqual({
      "glass-chrome": [".head", ".rail"],
      menu: [".menu"],
      "page-card": [".card"],
      "inner-card": [".layer"],
      "overlay-panel": [".legend"],
    });
    expect(Object.fromEntries(index.carriers)).toEqual({ "inner-card": [".switch"] });
  });

  it("finds a member that reads its role only in a state at rest, splits a selector list at its top level, and passes over a sheet it cannot read", () => {
    const unreadable = { get cssRules(): ArrayLike<RuleLike> { throw new Error("another origin"); } };
    const imported: RuleLike = { styleSheet: sheet(rule(".peek", "backdrop-filter: var(--surface-menu-blur)")) };
    const index = discoverMembers([
      unreadable,
      sheet(rule(".chip:hover, :is(.a, .b) > .pill:focus-visible", "backdrop-filter:var(--surface-glass-chrome-blur)"), imported),
      { cssRules: [{ cssRules: [rule(".tip", "-webkit-backdrop-filter: var(--surface-menu-blur, none)")] }] },
    ]);
    expect(index.members.get("glass-chrome")).toEqual([".chip", ":is(.a, .b) > .pill"]);
    expect(index.members.get("menu")).toEqual([".peek", ".tip"]);
    expect(splitSelectors(':is(.a, .b) .c, .d[title="x, y"], .e')).toEqual([":is(.a, .b) .c", '.d[title="x, y"]', ".e"]);
    expect(atRest(".a:hover .b:focus-within:not(:hover)")).toBe(".a .b:not(:hover)");
  });

  it("reaches every kind the root can name", () => {
    expect(LENS_ROLES.map(role => role.word)).toEqual(["chrome", "panels", "map", "buttons", "cards", "inner", "menus", "dialogs"]);
    expect(LENS_ROLES.filter(role => role.ink).map(role => role.role)).toEqual(["glass-chrome", "overlay-control"]);
  });
});

describe("the bend", () => {
  it("bends each member of a kind that is on through its role's blur, at its size, steps the chrome's inks up, and leaves a kind that is off alone", () => {
    liquid("chrome menus");
    const head = make(doc.body, "head", { "data-reads": "glass-chrome" }, [200, 40]);
    const menu = make(doc.body, "menu", { "data-reads": "menu", "data-radius": "8px" }, [180, 120]);
    const card = make(doc.body, "card", { "data-reads": "page-card" }, [300, 200]);
    start();
    // A quarter of the header's 40 px side caps its 20 px lens at 10; the menu pulls its 14.
    expect(inline(head)).toEqual({ "--surface-glass-chrome-blur": 'url("#dz-lens-200x40-r12-b9-s10")', ...INK_STEP });
    expect(inline(menu)).toEqual({ "--surface-menu-blur": 'url("#dz-lens-180x120-r8-b24-s14")' });
    expect(inline(card)).toEqual({});
    expect(filterIds()).toEqual(["dz-lens-200x40-r12-b9-s10", "dz-lens-180x120-r8-b24-s14"]);
    // A menu opened inside a bent menu takes its own bend, never the one around it.
    const submenu = make(menu, "menu", { "data-reads": "menu", "data-radius": "8px" }, [120, 80]);
    bodyObserver().callback([{ type: "childList", target: menu, addedNodes: [submenu], removedNodes: [] }]);
    flush();
    expect(inline(submenu)).toEqual({ "--surface-menu-blur": 'url("#dz-lens-120x80-r8-b24-s14")' });
    // The filter blurs at half the role's strength, then bends by the map baked for the size.
    const filter = defsOf()!.descendants().find(node => node.getAttribute("id") === "dz-lens-200x40-r12-b9-s10")!;
    expect(filter.children.map(node => [node.tagName, Object.fromEntries(node.attributes)])).toEqual([
      ["feImage", { href: "data:map/200x40", x: "0", y: "0", width: "200", height: "40", preserveAspectRatio: "none", result: "map" }],
      ["feGaussianBlur", { in: "SourceGraphic", stdDeviation: "4.5", edgeMode: "duplicate", result: "soft" }],
      ["feDisplacementMap", { in: "soft", in2: "map", scale: "10", xChannelSelector: "R", yChannelSelector: "G" }],
    ]);
  });

  it("leaves alone a member inside an image's default look or a picture, and holds a pseudo-element's carrier at the plain blur inside a bent card", () => {
    liquid("menus inner");
    const image = make(doc.body, "frame", { "data-look-default": "" });
    const inImage = make(image, "menu", { "data-reads": "menu" }, [180, 120]);
    const picture = make(doc.body, "box", { "data-picture-panels": "liquid" });
    const inPicture = make(picture, "menu", { "data-reads": "menu" }, [60, 40]);
    const layer = make(doc.body, "layer", { "data-reads": "inner-card" }, [220, 56]);
    const knob = make(layer, "switch");
    start();
    expect(inline(inImage)).toEqual({});
    expect(inline(inPicture)).toEqual({});
    expect(inline(layer)).toEqual({ "--surface-inner-card-blur": 'url("#dz-lens-220x56-r12-b6-s8")' });
    // The knob reads its carrier's blur: the plain one, never the card's bend.
    expect(inline(knob)).toEqual({ "--surface-inner-card-blur": "blur(6px)" });
  });

  it("lets go of a member whose own rules draw another blur, and takes it up again when they stop", () => {
    liquid("chrome");
    const rail = make(doc.body, "rail", { "data-reads": "glass-chrome", "data-own-blur": "blur(18px)" }, [64, 600]);
    start();
    expect(inline(rail)).toEqual({});
    rail.removeAttribute("data-own-blur");
    bodyObserver().callback([{ type: "attributes", target: rail, attributeName: "data-expanded", addedNodes: [], removedNodes: [] }]);
    flush();
    expect(inline(rail)).toEqual({ "--surface-glass-chrome-blur": 'url("#dz-lens-64x600-r12-b9-s16")', ...INK_STEP });
    rail.setAttribute("data-own-blur", "blur(18px)");
    bodyObserver().callback([{ type: "attributes", target: rail, attributeName: "data-expanded", addedNodes: [], removedNodes: [] }]);
    flush();
    expect(inline(rail)).toEqual({});
    expect(filterIds()).toEqual([]);
  });

  it("lets go of the rail while a link inside it has keyboard focus, and bends it and steps its inks up again once focus leaves", () => {
    liquid("chrome");
    const rail = make(doc.body, "rail", { "data-reads": "glass-chrome" }, [64, 600]);
    const link = make(rail, "link");
    start();
    const lensed = { "--surface-glass-chrome-blur": 'url("#dz-lens-64x600-r12-b9-s16")', ...INK_STEP };
    expect(inline(rail)).toEqual(lensed);
    // Focus inside opens the rail, whose own rule then draws the glass strength.
    rail.setAttribute("data-own-blur", "blur(18px)");
    link.dispatchEvent(new HostEvent("focusin", { bubbles: true }));
    flush();
    expect(inline(rail)).toEqual({});
    rail.removeAttribute("data-own-blur");
    link.dispatchEvent(new HostEvent("focusout", { bubbles: true }));
    flush();
    expect(inline(rail)).toEqual(lensed);
  });

  it("finds a member that joins the page, and one a stylesheet that joins names", () => {
    liquid("map menus");
    start();
    const legend = make(doc.body, "legend", { "data-reads": "overlay-panel" }, [160, 90]);
    bodyObserver().callback([{ type: "childList", target: doc.body, addedNodes: [legend], removedNodes: [] }]);
    flush();
    expect(inline(legend)).toEqual({ "--surface-overlay-panel-blur": 'url("#dz-lens-160x90-r12-b24-s18")' });
    const peek = make(doc.body, "peek", { "data-reads": "menu" }, [240, 160]);
    bodyObserver().callback([{ type: "childList", target: doc.body, addedNodes: [peek], removedNodes: [] }]);
    flush();
    expect(inline(peek)).toEqual({});
    // A route's stylesheet arrives; the next look at the page reads it.
    Object.assign(doc, { adoptedStyleSheets: [sheet(rule(".peek", "backdrop-filter: var(--surface-menu-blur);"))] });
    bodyObserver().callback([{ type: "childList", target: doc.body, addedNodes: [make(doc.body, "note")], removedNodes: [] }]);
    flush();
    expect(inline(peek)).toEqual({ "--surface-menu-blur": 'url("#dz-lens-240x160-r12-b24-s14")' });
  });

  it("holds the plain blur while a surface changes size, and bends at its new size once it has rested", () => {
    liquid("panels");
    const pane = make(doc.body, "pane", { "data-reads": "glass-panel" }, [320, 700]);
    Object.assign(doc, { styleSheets: [sheet(rule(".pane", "backdrop-filter: var(--surface-glass-panel-blur);"))] });
    start();
    expect(inline(pane)["--surface-glass-panel-blur"]).toBe('url("#dz-lens-320x700-r12-b24-s18")');
    rects.set(pane, { left: 0, top: 0, width: 360, height: 700 });
    sizes[0].callback([{ target: pane }]);
    expect(inline(pane)["--surface-glass-panel-blur"]).toBe("blur(24px)");
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(inline(pane)["--surface-glass-panel-blur"]).toBe("blur(24px)");
    vi.advanceTimersByTime(1);
    expect(inline(pane)["--surface-glass-panel-blur"]).toBe('url("#dz-lens-360x700-r12-b24-s18")');
    flush();
    expect(filterIds()).toEqual(["dz-lens-360x700-r12-b24-s18"]);
  });

  it("holds the plain blur while a transition or animation moves the surface or what carries it, and not while one only changes a colour", () => {
    liquid("menus");
    const drawer = make(doc.body, "slot");
    const menu = make(drawer, "menu", { "data-reads": "menu" }, [300, 200]);
    start();
    const bent = 'url("#dz-lens-300x200-r12-b24-s14")';
    expect(inline(menu)["--surface-menu-blur"]).toBe(bent);
    const event = (type: string, propertyName?: string) => Object.assign(new HostEvent(type, { bubbles: true }), { propertyName });
    menu.dispatchEvent(event("transitionrun", "background-color"));
    expect(inline(menu)["--surface-menu-blur"]).toBe(bent);
    // What carries it slides in at the same size.
    animations.set(drawer, [{ playState: "running", transitionProperty: "transform" }]);
    drawer.dispatchEvent(event("transitionrun", "transform"));
    expect(inline(menu)["--surface-menu-blur"]).toBe("blur(24px)");
    vi.advanceTimersByTime(SETTLE_MS * 3);
    expect(inline(menu)["--surface-menu-blur"]).toBe("blur(24px)");
    animations.set(drawer, []);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(inline(menu)["--surface-menu-blur"]).toBe(bent);
    // An entrance on the surface itself.
    animations.set(menu, [{ playState: "running" }]);
    menu.dispatchEvent(event("animationstart"));
    expect(inline(menu)["--surface-menu-blur"]).toBe("blur(24px)");
    animations.set(menu, [{ playState: "finished" }]);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(inline(menu)["--surface-menu-blur"]).toBe(bent);
  });

  it("steps the inks up and bends nothing where the browser cannot draw the bend, writing no blur while a surface moves or resizes", () => {
    liquid("chrome inner");
    const slot = make(doc.body, "slot");
    const head = make(slot, "head", { "data-reads": "glass-chrome" }, [200, 40]);
    const layer = make(slot, "layer", { "data-reads": "inner-card" }, [220, 56]);
    const knob = make(layer, "switch");
    start(false);
    expect(inline(head)).toEqual(INK_STEP);
    expect(inline(layer)).toEqual({});
    expect(inline(knob)).toEqual({});
    expect(defsOf()).toBeNull();
    // An entrance on a surface, a slide of what carries both, a new size: nothing for the lens to hold or take back.
    const event = (type: string, propertyName?: string) => Object.assign(new HostEvent(type, { bubbles: true }), { propertyName });
    animations.set(head, [{ playState: "running" }]);
    head.dispatchEvent(event("animationstart"));
    animations.set(slot, [{ playState: "running", transitionProperty: "transform" }]);
    slot.dispatchEvent(event("transitionrun", "transform"));
    rects.set(layer, { left: 0, top: 0, width: 260, height: 56 });
    for (const observer of sizes) observer.callback([{ target: layer }]);
    expect(sizes, "no size is watched").toHaveLength(0);
    expect(inline(head)).toEqual(INK_STEP);
    expect(inline(layer)).toEqual({});
    expect(inline(knob)).toEqual({});
    animations.set(head, []);
    animations.set(slot, []);
    vi.advanceTimersByTime(SETTLE_MS * 2);
    flush();
    expect(inline(head)).toEqual(INK_STEP);
    expect(inline(layer)).toEqual({});
    expect(defsOf()).toBeNull();
  });

  it("stops leaving no trace: no inline property, no filter, no observer and no listener", () => {
    liquid("chrome panels map buttons cards inner menus dialogs");
    const head = make(doc.body, "head", { "data-reads": "glass-chrome" }, [200, 40]);
    const menu = make(doc.body, "menu", { "data-reads": "menu" }, [180, 120]);
    const layer = make(doc.body, "layer", { "data-reads": "inner-card" }, [220, 56]);
    const knob = make(layer, "switch");
    const lens = start();
    rects.set(menu, { left: 0, top: 0, width: 200, height: 120 });
    sizes[0].callback([{ target: menu }]);
    expect(Object.keys(inline(head)).length).toBeGreaterThan(0);
    expect(defsOf()).not.toBeNull();
    lens.stop();
    for (const el of [head, menu, layer, knob]) expect(inline(el)).toEqual({});
    expect(defsOf()).toBeNull();
    expect(observers.every(observer => observer.disconnected)).toBe(true);
    expect(sizes.every(observer => observer.disconnected)).toBe(true);
    // Nothing it watched reaches it any more: a settle due, an event, a frame.
    vi.advanceTimersByTime(SETTLE_MS * 2);
    head.dispatchEvent(Object.assign(new HostEvent("transitionrun", { bubbles: true }), { propertyName: "transform" }));
    flush();
    for (const el of [head, menu, layer, knob]) expect(inline(el)).toEqual({});
  });
});

describe("keeping the bend in step with the look", () => {
  it("starts with Liquid and a kind on, follows a kind switched off, and stops when Panels leaves Liquid", () => {
    const head = make(doc.body, "head", { "data-reads": "glass-chrome" }, [200, 40]);
    const menu = make(doc.body, "menu", { "data-reads": "menu" }, [180, 120]);
    const stop = watchPanelLens(doc as unknown as Document, { bend: true, encode });
    const rootObserver = observers.find(observer => observer.target === doc.documentElement)!;
    expect(inline(head)).toEqual({});
    liquid("chrome menus");
    rootObserver.callback([]);
    expect(Object.keys(inline(head))).toContain("--surface-glass-chrome-blur");
    expect(Object.keys(inline(menu))).toContain("--surface-menu-blur");
    doc.documentElement.setAttribute("data-look-liquid", "chrome");
    rootObserver.callback([]);
    flush();
    expect(inline(menu)).toEqual({});
    expect(filterIds()).toEqual(["dz-lens-200x40-r12-b9-s10"]);
    doc.documentElement.setAttribute("data-look-panels", "glass");
    doc.documentElement.removeAttribute("data-look-liquid");
    rootObserver.callback([]);
    expect(inline(head)).toEqual({});
    expect(defsOf()).toBeNull();
    stop();
    expect(observers.every(observer => observer.disconnected)).toBe(true);
  });

  it("is mounted by the workspace's root layout and by no other", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap(entry => {
      const file = path.join(dir, entry);
      return statSync(file).isDirectory() ? files(file) : /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) ? [file.split(path.sep).join("/")] : [];
    });
    const mounting = files("src").filter(file => /from "@\/components\/look\/PanelLens"|from "\.\/PanelLens"/.test(readFileSync(file, "utf8")));
    expect(mounting).toEqual(["src/app/(workspace)/layout.tsx"]);
    expect(readFileSync("src/app/(workspace)/layout.tsx", "utf8")).toMatch(/<PanelLens \/>/);
  });
});
