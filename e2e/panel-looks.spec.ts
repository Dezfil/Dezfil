// The Panels looks, read off the running page: Glass (the shipped look),
// Liquid (one material on every card and panel) and Paper. Every account
// here is invited through the accounts API for this run and picks its look
// through the documented own-settings write or the Appearance tab, so the
// suite's fixture account keeps Dezfil's default look for every other
// journey. Every expected value is written out below from the shipped tones
// and the looks' own numbers; the page's tokens are never the expected side.
//
// Liquid's recipe, the same on every role in a theme: the panel tone under a
// faint tint as one clear fill, a 6 px blur, the light on the rim, and a drop that
// says only how high the surface sits (a contact drop inside a panel, one
// floating drop, a higher one on hover and on a dialog). A block inside a
// panel takes the fill, the light and the contact drop with no blur; the
// map's own frame keeps the floating drop alone.
//
// What it holds:
//
// - The tab: the second card is Panels and background with Panels leading,
//   three pictures each in its own look, and under each of the three
//   choices the card holds Panels and Background only. A pick changes the
//   page at once and shows Saved only after the answer; a refusal returns
//   the page to what is kept; the card's Reset returns the two and its Undo
//   puts them back; Reset to Dezfil's default and its Undo do the same. An
//   own-settings write naming one of Liquid's former kinds of surface is
//   refused by its position, and the look stays as it was.
// - Liquid on every role, by day and by night: a member of every role
//   computes the recipe (the header's buttons, a layer card, a node tile
//   with its group edge, a slider's thumb and a switch's knob, a gallery
//   card at rest and hovered), and so do the blocks inside panels (a legend
//   tab entry, a widget row, a basemap card, the Tools' picker and result)
//   and the widget card over the map, the blocks with no backdrop filter.
//   Under Liquid the header's and a map button's quiet text read at the
//   stepped ink (85 % of the way from the quiet ink to the full ink); under
//   Glass at the quiet ink.
// - Paper: every role at Paper's values, the Assistant pane with the side
//   panels, each map button its own sheet, menus and dialogs as shipped,
//   the blocks and the widget card at Glass's grounds, the lines inside a
//   panel at 7 % ink by day and 8 % by night, and More contrast's stronger
//   lines winning.
// - Glass after Liquid and Paper leaves no trace on the tab, a list page or
//   the builder: no look attribute, no filter, no inline property, nothing
//   moved.
// - The bend, in Chromium: a map button's backdrop is pulled inward across
//   its bezel (read with the button's own fill taken off, against the same
//   button with the bend taken off), its rim light is on, the map under it
//   is soft; the inspector resized and the query drawer sliding in keep
//   their blur and take the bend for their size once settled; a map button
//   does not grow under the pointer. In Firefox, and in WebKit where its
//   build is installed (the projects named fallback), the same button blurs
//   and carries the rim light with nothing bent and nothing written inline.
// - The computer's requests for less transparency and more contrast make
//   every translucent fill opaque under Glass, Liquid and Paper, a block's
//   and the widget card's among them, while the light and the shadow stay;
//   the rail opened over the page, the dialog's veil, the wash, an entry
//   screen and the status and data colours are the same under every look.
// - The export card's preview keeps the default look with no lens inside
//   it while the card takes the person's; a published page opened by its
//   author carries no look, lens or rim light, in both of its modes.
// - A fresh browser signed in with Liquid paints Liquid's fill, blur and
//   light from its first frame, and bends within the first second.
//
// The Assistant's own message is a block too; it needs a turn answered by a
// model, which these accounts never send, so it is named in the
// annotations rather than read.
//
// Seeds, each switched by DEZFIL_PANEL_LOOKS_SEED and each expected to turn
// named steps red (unset it for green):
//
//   typed-liquid  under Liquid the legend types a Liquid of its own by hand
//                 (a thinner fill and a 9 px blur): the every-role step and
//                 the requests case's Liquid step fail on the legend and
//                 only the legend.
//   preview-lens  a lens is laid inline on the legend inside the export
//                 card's preview: the preview step fails on the inline
//                 property and on the legend's blur.
//   late-look     the document's look is taken off its <html> tag and
//                 applied by a script after load: the first-frame step
//                 fails on the root's attributes at its creation and its
//                 first frame (the header card, drawn later, reads right).
//   late-sheets   the rules keyed on Liquid's root are held back from the
//                 stylesheets and added once the header card has been on
//                 the page for a frame, the served attributes right: the
//                 first-frame step fails on the header card's values alone.
//
// Environment: the documented gate (isolated server, fresh data dir), its
// browsers installed. Run with DEZFIL_BASE_URL at the server.
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { readThenWriteBrowserSetup } from "./edit-basis";
import { delayLook, describeEvidence, frameEvidence, frameProblems, installFrameRecorder, rootLook, setLook, type LookAttributes } from "./look-evidence";
import { closeAll, invitePerson, runTag, type Person } from "./sharing-support";
import {
  colour, fmt, layers, maxStep, oklabToRgb, paintersAcross, range, rgbToOklab, rowLuma, sameColour, STRIPES_STYLE, stripesGeoJson,
  type Layer, type RGBA,
} from "./surface-reads";
import { addLayer, consumeExpected, FIXTURES_DIR, patchLayer, patchMap, publishMap, routeHouse, seedCsv, seedFile, trackConsole, type ConsoleError } from "./support";

// ---- the expected values, written out ----

type Theme = "light" | "dark";
type Role =
  | "glass-chrome" | "glass-panel" | "overlay-panel" | "overlay-control" | "map-card"
  | "page-card" | "inner-card" | "block" | "menu" | "dialog" | "stage";
type Panels = "glass" | "liquid" | "paper";

/** A look as the own-settings write takes it: its Panels pick. */
const lookOf = (panels: Panels): Record<string, string> => ({ panels });
/** The root's attributes for that look: Glass, the default, carries none. */
const attrsOf = (panels: Panels): LookAttributes => (panels === "glass" ? {} : { "data-look-panels": panels });
/** Every pick of the look, in the order the own-settings read lists them. */
const PICKS = ["color", "contrast", "font", "background", "corners", "rail", "panels"];

/** Kelp's tones by day and by night, as the shipped palettes state them. */
interface Tones { panel: RGBA; ground: RGBA; raised: RGBA; hover: RGBA; ink: RGBA; muted: RGBA; accent: RGBA; border: RGBA; moreBorder: RGBA; shadow: RGBA }
const TONES: Record<Theme, Tones> = {
  light: {
    panel: [255, 255, 255, 1], ground: [237, 241, 236, 1], raised: [246, 248, 245, 1], hover: [231, 236, 230, 1], ink: [36, 50, 48, 1],
    muted: [95, 111, 107, 1], accent: [13, 125, 92, 1], border: [226, 231, 225, 1], moreBorder: [188, 199, 191, 1], shadow: [36, 50, 48, 0.16],
  },
  dark: {
    panel: [16, 20, 29, 1], ground: [11, 14, 20, 1], raised: [21, 27, 39, 1], hover: [26, 33, 48, 1], ink: [233, 236, 243, 1],
    muted: [152, 163, 184, 1], accent: [69, 197, 143, 1], border: [34, 42, 59, 1], moreBorder: [59, 71, 98, 1], shadow: [0, 0, 0, 0.4],
  },
};
const WHITE: RGBA = [255, 255, 255, 1];
const BLACK: RGBA = [0, 0, 0, 1];
const CLEAR: RGBA = [0, 0, 0, 0];

/** A mix in sRGB, each colour at its share, as the browser mixes them:
 * premultiplied, and shares that add up to less than whole thin it. */
function mix(...parts: [RGBA, number][]): RGBA {
  const total = parts.reduce((sum, [, share]) => sum + share, 0);
  const alpha = parts.reduce((sum, [c, share]) => sum + (c[3] * share) / total, 0);
  const rgb = [0, 1, 2].map((i) => (alpha === 0 ? 0 : parts.reduce((sum, [c, share]) => sum + (c[i] * c[3] * share) / total, 0) / alpha));
  return [rgb[0], rgb[1], rgb[2], alpha * Math.min(1, total)];
}
/** A colour at a share over nothing. */
const thin = (c: RGBA, share: number) => mix([c, share], [CLEAR, 1 - share]);
/** Two opaque colours mixed in OKLab. */
function mixOklab(a: RGBA, shareA: number, b: RGBA): RGBA {
  const [la, lb] = [rgbToOklab(a), rgbToOklab(b)];
  const m = [0, 1, 2].map((i) => la[i] * shareA + lb[i] * (1 - shareA));
  return [...oklabToRgb(m[0], m[1], m[2]), 1];
}

const layer = (x: number, y: number, blur: number, spread: number, c: RGBA, inset = false): Layer => ({ x, y, blur, spread, inset, colour: c });

/* Glass: the roles as shipped. */
const STEP = { hairline: [1, 4, 0.6], float: [3, 12, 1], overlay: [8, 26, 1], lift: [10, 30, 1], deep: [14, 40, 1], dialog: [30, 80, 1] } as const;
const step = (name: keyof typeof STEP, theme: Theme): Layer => {
  const [y, blur, share] = STEP[name];
  return layer(0, y, blur, 0, thin(TONES[theme].shadow, share));
};

/* Liquid: one clear recipe. The panel tone under a faint tint folded into
 * one fill (white at 10 % over the panel tone at 36 % by day, black at 6 %
 * over it at 50 % by night; a dialog, over its veil, at 40 % by day; at 8 %
 * over 92 % where a fill must be opaque), the light on the rim drawn inside
 * the edge, then a two-layer drop by height. */
function liquidFill(theme: Theme, opaque = false, dialog = false): RGBA {
  const { panel } = TONES[theme];
  if (opaque) return mix([theme === "light" ? WHITE : BLACK, 0.08], [panel, 0.92]);
  return theme === "light" ? mix([WHITE, 0.1], [panel, dialog ? 0.4 : 0.36]) : mix([BLACK, 0.06], [panel, 0.5]);
}
const LIQUID_BLUR = "blur(6px)";
/** Under Liquid the quiet ink steps 85 % of the way to the full ink. */
const stepped = (theme: Theme): RGBA => mix([TONES[theme].ink, 0.85], [TONES[theme].muted, 0.15]);
const RIM: Record<Theme, Layer[]> = {
  light: [layer(1, 1, 0, 0, [255, 255, 255, 0.9], true), layer(-1, -1, 0, 0, [255, 255, 255, 0.405], true), layer(0, 0, 14, 0, [255, 255, 255, 0.144], true)],
  dark: [layer(1, 1, 0, 0, [255, 255, 255, 0.42], true), layer(-1, -1, 0, 0, [255, 255, 255, 0.168], true), layer(0, 0, 14, 0, [255, 255, 255, 0.067], true)],
};
/** The drops by height: lying inside a panel, floating, and risen (hovered, lifted, dragged, a dialog). */
type Drop = "contact" | "float" | "high";
function liquidDrop(kind: Drop, theme: Theme): Layer[] {
  const s = TONES.light.shadow;
  const night = (a: number): RGBA => [0, 0, 0, a];
  const light: Record<Drop, Layer[]> = {
    contact: [layer(0, 1, 2, 0, thin(s, 0.4)), layer(0, 4, 12, -4, thin(s, 0.5))],
    float: [layer(0, 1, 1, 0, thin(s, 0.2)), layer(0, 12, 32, -6, thin(s, 0.85))],
    high: [layer(0, 1, 1, 0, thin(s, 0.2)), layer(0, 24, 64, -12, s)],
  };
  const dark: Record<Drop, Layer[]> = {
    contact: [layer(0, 1, 2, 0, night(0.45)), layer(0, 4, 12, -4, night(0.4))],
    float: [layer(0, 1, 1, 0, night(0.35)), layer(0, 14, 36, -6, night(0.55))],
    high: [layer(0, 1, 1, 0, night(0.4)), layer(0, 24, 64, -12, night(0.7))],
  };
  return (theme === "light" ? light : dark)[kind];
}
/** The rim light, then a drop. */
const lit = (drop: Drop, theme: Theme): Layer[] => [...RIM[theme], ...liquidDrop(drop, theme)];

/* Paper: opaque paper, no blur, no edge line, one gentle lift. */
const paperFill = (theme: Theme): RGBA => (theme === "light" ? mixOklab(TONES.light.panel, 0.96, TONES.light.ground) : TONES.dark.raised);
function paperDrop(kind: "lift" | "card" | "inner", theme: Theme): Layer[] {
  const s = TONES.light.shadow;
  const night = (a: number): RGBA => [0, 0, 0, a];
  if (theme === "light") {
    return {
      lift: [layer(0, 1, 1, 0, thin(s, 0.4)), layer(0, 8, 24, -4, thin(s, 0.7))],
      card: [layer(0, 1, 1, 0, thin(s, 0.3)), layer(0, 6, 20, -4, thin(s, 0.55))],
      inner: [layer(0, 1, 2, 0, thin(s, 0.4))],
    }[kind];
  }
  return {
    lift: [layer(0, 1, 1, 0, night(0.5)), layer(0, 10, 28, -4, night(0.55))],
    card: [layer(0, 1, 1, 0, night(0.45)), layer(0, 8, 24, -4, night(0.45))],
    inner: [layer(0, 1, 2, 0, night(0.4))],
  }[kind];
}

/** What a surface computes: its ground, its blur, its edge (none, or a line)
 * and its shadow's layers, the light on the rim among them. */
interface Edge { style: string; width: string; colour: RGBA }
interface Want { fill: RGBA; blur: string; edge: Edge | null; shadows: Layer[] }
const hairline = (theme: Theme): Edge => ({ style: "solid", width: "1px", colour: TONES[theme].border });
const clearLine: Edge = { style: "solid", width: "1px", colour: CLEAR };
/** Paper's softer line inside a panel: 7 % ink by day, 8 % by night. */
const paperLine = (theme: Theme): Edge => ({ style: "solid", width: "1px", colour: thin(TONES[theme].ink, theme === "light" ? 0.07 : 0.08) });

function glassWant(role: Role, theme: Theme, opaque = false): Want {
  const { panel, raised } = TONES[theme];
  const glass = opaque ? panel : thin(panel, 0.93);
  switch (role) {
    case "glass-chrome": return { fill: glass, blur: "blur(18px)", edge: null, shadows: [step("float", theme)] };
    case "glass-panel": return { fill: glass, blur: "blur(18px)", edge: null, shadows: [step("float", theme)] };
    case "overlay-panel": return { fill: glass, blur: "blur(8px)", edge: null, shadows: [step("overlay", theme)] };
    case "overlay-control": return { fill: glass, blur: "blur(8px)", edge: null, shadows: [step("float", theme)] };
    case "map-card": return { fill: panel, blur: "none", edge: hairline(theme), shadows: [] };
    case "page-card": return { fill: panel, blur: "none", edge: hairline(theme), shadows: [step("float", theme)] };
    case "inner-card": return { fill: panel, blur: "none", edge: hairline(theme), shadows: [step("hairline", theme)] };
    // On the raised tone; a member on the panel tone says so (see `panelTone`).
    case "block": return { fill: raised, blur: "none", edge: hairline(theme), shadows: [] };
    case "menu": return { fill: panel, blur: "none", edge: hairline(theme), shadows: [step("lift", theme)] };
    case "dialog": return { fill: panel, blur: "none", edge: hairline(theme), shadows: [step("dialog", theme)] };
    case "stage": return { fill: CLEAR, blur: "none", edge: null, shadows: [step("deep", theme)] };
  }
}
function liquidWant(role: Role, theme: Theme, opaque = false): Want {
  const fill = liquidFill(theme, opaque);
  switch (role) {
    case "glass-chrome": case "glass-panel": case "overlay-panel": case "overlay-control":
      return { fill, blur: LIQUID_BLUR, edge: null, shadows: lit("float", theme) };
    case "map-card": case "page-card": case "menu": return { fill, blur: LIQUID_BLUR, edge: clearLine, shadows: lit("float", theme) };
    case "inner-card": return { fill, blur: LIQUID_BLUR, edge: clearLine, shadows: lit("contact", theme) };
    case "block": return { fill, blur: "none", edge: clearLine, shadows: lit("contact", theme) };
    case "dialog": return { fill: liquidFill(theme, opaque, true), blur: LIQUID_BLUR, edge: clearLine, shadows: lit("high", theme) };
    case "stage": return { fill: CLEAR, blur: "none", edge: null, shadows: liquidDrop("float", theme) };
  }
}
function paperWant(role: Role, theme: Theme): Want {
  const sheet: Want = { fill: paperFill(theme), blur: "none", edge: null, shadows: paperDrop("lift", theme) };
  switch (role) {
    case "glass-chrome": case "glass-panel": case "overlay-panel": case "overlay-control": return sheet;
    case "page-card": return { fill: paperFill(theme), blur: "none", edge: clearLine, shadows: paperDrop("card", theme) };
    case "inner-card": return { fill: theme === "light" ? TONES.light.panel : TONES.dark.hover, blur: "none", edge: clearLine, shadows: paperDrop("inner", theme) };
    case "stage": return { fill: CLEAR, blur: "none", edge: null, shadows: paperDrop("lift", theme) };
    // Glass's grounds, the softer line inside a panel.
    case "block": case "map-card": return { ...glassWant(role, theme), edge: paperLine(theme) };
    case "menu": case "dialog": return glassWant(role, theme);
  }
}

/** The look a screen is under: its Panels pick, and whether a fill must be opaque. */
interface Under { panels: Panels; opaque?: boolean }
const GLASS: Under = { panels: "glass" };
const LIQUID: Under = { panels: "liquid" };
const PAPER: Under = { panels: "paper" };
function roleWant(role: Role, theme: Theme, under: Under): Want {
  if (under.panels === "liquid") return liquidWant(role, theme, under.opaque);
  if (under.panels === "paper") return paperWant(role, theme);
  return glassWant(role, theme, under.opaque);
}

// ---- the seeds ----

const SEED = process.env.DEZFIL_PANEL_LOOKS_SEED ?? "";
const SEEDS = ["", "typed-liquid", "preview-lens", "late-look", "late-sheets"];
if (!SEEDS.includes(SEED)) throw new Error(`DEZFIL_PANEL_LOOKS_SEED=${SEED} names no seed; known: ${SEEDS.filter(Boolean).join(", ")}`);
const css = (c: RGBA) => `rgba(${c.slice(0, 3).map((v) => v.toFixed(2)).join(", ")}, ${c[3].toFixed(4)})`;
/** Under Liquid the legend typing a Liquid of its own by hand: a firmer fill
 * (white at 8 % over the panel tone at 82.8 % by day, black at 8 % over it at
 * 71.76 % by night) and a 24 px blur, the recipe's light and drop kept. */
function typedLiquid(): string {
  return (["light", "dark"] as Theme[]).map((theme) => {
    const { panel } = TONES[theme];
    const fill = theme === "light" ? mix([WHITE, 0.08], [panel, 0.828]) : mix([BLACK, 0.08], [panel, 0.7176]);
    const root = theme === "dark" ? ':root[data-theme="dark"]' : ':root:not([data-theme="dark"])';
    return `${root}[data-look-panels="liquid"] [data-map-legend]:not([data-look-default] [data-map-legend]) {
      background-color: ${css(fill)} !important; backdrop-filter: blur(24px) !important; }`;
  }).join("\n");
}

/** Open a workspace page and lay the seed's style over it, if one is on. */
async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await reseed(page);
}
async function reseed(page: Page): Promise<void> {
  if (SEED === "typed-liquid") await page.addStyleTag({ content: typedLiquid() });
}

// ---- reading the page ----

interface Seen {
  fill: string; blur: string; edgeStyle: string; edgeWidth: string; edgeColor: string; shadow: string; transform: string; color: string;
  /** The filter a bent surface draws its backdrop through, and the blur inside it. */
  lens: { id: string; blur: string | null; size: string | null } | null;
  /** The custom properties set on the element itself, by name. */
  inline: Record<string, string>;
}

const readEl = (loc: Locator, pseudo?: string): Promise<Seen> =>
  loc.evaluate((el, pseudo) => {
    const cs = getComputedStyle(el, pseudo ?? null);
    const blur = cs.getPropertyValue("backdrop-filter");
    const url = /^url\(\s*["']?#([^"')]+)["']?\s*\)$/.exec(blur.trim());
    let lens: { id: string; blur: string | null; size: string | null } | null = null;
    if (url) {
      const filter = document.getElementById(url[1]);
      const std = filter?.querySelector("feGaussianBlur")?.getAttribute("stdDeviation");
      lens = { id: url[1], blur: std == null ? null : `blur(${2 * Number(std)}px)`, size: filter ? `${filter.getAttribute("width")}x${filter.getAttribute("height")}` : null };
    }
    const style = (el as HTMLElement).style;
    const inline: Record<string, string> = {};
    for (let i = 0; i < style.length; i += 1) {
      const name = style.item(i);
      if (name.startsWith("--")) inline[name] = style.getPropertyValue(name).trim();
    }
    return {
      fill: cs.backgroundColor, blur, edgeStyle: cs.borderTopStyle, edgeWidth: cs.borderTopWidth, edgeColor: cs.borderTopColor,
      shadow: cs.boxShadow, transform: cs.transform, color: cs.color, lens, inline,
    };
  }, pseudo);

/** A range input's thumb as the browser computed it. The thumb lives in the
 * input's own shadow tree, out of a page script's reach (a computed style
 * asked for its pseudo-element answers with the input's own), so it is read
 * through the devtools protocol: Chromium. */
async function readThumb(page: Page, loc: Locator): Promise<Seen> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await loc.evaluate((el) => el.setAttribute("data-reading-thumb", ""));
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-reading-thumb]" });
    const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: -1, pierce: true });
    type Node = typeof node;
    // Inside the input's own shadow root, the thumb is the element named "thumb" (older builds also mark it by its pseudo).
    const find = (n: Node): Node | null => {
      const attrs = n.attributes ?? [];
      for (let i = 0; i < attrs.length; i += 2) {
        if ((attrs[i] === "id" && attrs[i + 1] === "thumb") || (attrs[i] === "pseudo" && attrs[i + 1] === "-webkit-slider-thumb")) return n;
      }
      for (const child of n.children ?? []) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    const own = (node.shadowRoots ?? []).find((r) => r.shadowRootType === "user-agent");
    const thumb = own ? find(own) : null;
    if (!thumb) throw new Error("no thumb in the range input's shadow tree");
    const { nodeIds } = await cdp.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [thumb.backendNodeId] });
    const { computedStyle } = await cdp.send("CSS.getComputedStyleForNode", { nodeId: nodeIds[0] });
    const get = (name: string) => computedStyle.find((entry) => entry.name === name)?.value ?? "";
    return {
      fill: get("background-color"), blur: get("backdrop-filter"), edgeStyle: get("border-top-style"), edgeWidth: get("border-top-width"),
      edgeColor: get("border-top-color"), shadow: get("box-shadow"), transform: get("transform"), color: get("color"), lens: null, inline: {},
    };
  } finally {
    await loc.evaluate((el) => el.removeAttribute("data-reading-thumb")).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}

const fmtLayer = (l: Layer) => `${l.inset ? "inset " : ""}${l.x}px ${l.y}px ${l.blur}px ${l.spread}px ${fmt(l.colour)}`;
/** The blur a surface draws: its own, or the one inside the filter it is bent through. */
const drawnBlur = (seen: Seen) => (seen.lens ? (seen.lens.blur ?? `a lens with no filter (${seen.lens.id})`) : seen.blur);

/** Every way what the browser computed differs from what is wanted, one line each. */
function problems(seen: Seen, want: Want, own: readonly ("fill" | "edge" | "shadow")[] = []): string[] {
  const out: string[] = [];
  if (!own.includes("fill") && !sameColour(colour(seen.fill), want.fill)) out.push(`fill ${seen.fill}, want ${fmt(want.fill)}`);
  if (drawnBlur(seen) !== want.blur) out.push(`blur ${seen.blur}${seen.lens ? ` (${drawnBlur(seen)})` : ""}, want ${want.blur}`);
  if (!own.includes("edge")) {
    if (want.edge === null && seen.edgeStyle !== "none") out.push(`edge ${seen.edgeWidth} ${seen.edgeStyle} ${seen.edgeColor}, want none`);
    if (want.edge && (seen.edgeStyle !== want.edge.style || seen.edgeWidth !== want.edge.width || !sameColour(colour(seen.edgeColor), want.edge.colour))) {
      out.push(`edge ${seen.edgeWidth} ${seen.edgeStyle} ${seen.edgeColor}, want ${want.edge.width} ${want.edge.style} ${fmt(want.edge.colour)}`);
    }
  }
  if (!own.includes("shadow")) {
    const got = layers(seen.shadow);
    const same = got.length === want.shadows.length && got.every((l, i) => {
      const w = want.shadows[i];
      return l.inset === w.inset && l.x === w.x && l.y === w.y && l.blur === w.blur && l.spread === w.spread && w.colour !== null && sameColour(l.colour, w.colour);
    });
    if (!same) out.push(`shadow ${seen.shadow}, want ${want.shadows.map(fmtLayer).join(", ") || "none"}`);
  }
  return out;
}

/** A member of a role, as a person finds it; `own` names what it keeps of its own. */
interface Member {
  role: Role;
  what: string;
  at: (page: Page) => Locator;
  pseudo?: string;
  own?: ("fill" | "edge" | "shadow")[];
  /** What it computes in place of the role's ground (a node tile's group tint over it). */
  fill?: (want: Want) => RGBA;
  /** A block drawn on the panel tone where its role's ground is the raised one (Glass and Paper). */
  panelTone?: true;
  /** A block that draws no line around it under any look. */
  lineless?: true;
  /** What a state of the member (a hover) computes in place of the role's resting shadow. */
  shadows?: (theme: Theme, under: Under) => Layer[];
}

/** Soft and polled: a surface that eases its shadow reads mid-transition for
 * a beat after a change, and one read of a busy page can take a while. */
const settle = expect.configure({ soft: true });

/** What a member must compute under a look: its role's values, and what the member says of itself. */
function memberWant(m: Member, theme: Theme, under: Under): Want {
  let want = roleWant(m.role, theme, under);
  if (m.panelTone && under.panels !== "liquid") want = { ...want, fill: TONES[theme].panel };
  if (m.lineless) want = { ...want, edge: null };
  if (m.shadows) want = { ...want, shadows: m.shadows(theme, under) };
  return m.fill ? { ...want, fill: m.fill(want) } : want;
}

async function expectMember(page: Page, m: Member, theme: Theme, under: Under, where: string): Promise<void> {
  const loc = m.at(page);
  await expect.soft(loc, `${where}: ${m.what} is on screen`).toBeVisible();
  if (!(await loc.isVisible())) return;
  const want = memberWant(m, theme, under);
  await settle
    .poll(async () => problems(await (m.pseudo === "::-webkit-slider-thumb" ? readThumb(page, loc) : readEl(loc, m.pseudo)), want, m.own), { message: `${where}: ${m.what} (${m.role})`, timeout: 8_000 })
    .toEqual([]);
}

// ---- the members, by where they are found ----

const headerCard: Member = { role: "glass-chrome", what: "the header card", at: (p) => p.locator("header").getByRole("link", { name: "Dezfil", exact: true }).locator("xpath=..") };
const exportButton: Member = { role: "glass-chrome", what: "the header's Export button", at: (p) => p.locator("#header-actions-right").getByRole("button", { name: "Export", exact: true }) };
const themeButton: Member = { role: "glass-chrome", what: "the theme button", at: (p) => p.getByRole("button", { name: "Switch between dark and light theme" }) };
const inspector: Member = { role: "glass-panel", what: "the builder's inspector", at: (p) => p.locator("[data-builder-pane]") };
const legend: Member = {
  role: "overlay-panel", what: "the legend",
  at: (p) => p.locator("xpath=//*[@data-map-legend][not(ancestor::*[@data-look-default])]").filter({ visible: true }).first(),
};
const statusPill: Member = { role: "overlay-panel", what: "the status pill", at: (p) => p.locator("[data-status-bar]") };
const stageButton = (name: string): Member => ({ role: "overlay-control", what: `the map's ${name} button`, at: (p) => p.getByRole("button", { name, exact: true }).first() });
const zoomIn = stageButton("Zoom in");
const mapCard: Member = { role: "stage", what: "the map card", at: (p) => p.locator("[data-drag-canvas]").first().locator("xpath=..") };
const layerCard: Member = { role: "inner-card", what: "a layer card", at: (p) => p.locator('[data-layer-list] li[data-selected="false"]').first() };
const layerMenu: Member = { role: "menu", what: "the layer menu", at: (p) => p.getByRole("menu").filter({ visible: true }).first() };
/** A style slider's thumb: under Liquid the knob takes the recipe's fill; its accent ring is its own. */
const sliderThumb: Member = {
  role: "inner-card", what: "a style slider's thumb", pseudo: "::-webkit-slider-thumb", own: ["edge"],
  at: (p) => p.locator('[data-builder-pane] input[type="range"]').filter({ visible: true }).first(),
};
const exportDialog: Member = { role: "dialog", what: "the export dialog", at: (p) => p.getByRole("dialog", { name: "Export image" }) };
const BUILDER: Member[] = [headerCard, exportButton, themeButton, inspector, legend, statusPill, zoomIn, mapCard, layerCard];

/** The widget card over the map, and the blocks inside the inspector's tabs and the Tools drawer. */
const widgetCard: Member = { role: "map-card", what: "the widget card over the map", at: (p) => p.locator("[data-widget-rail] [data-widget-card]").first() };
const legendEntry: Member = { role: "block", what: "a legend entry in the Legend tab", at: (p) => p.locator("[data-builder-pane] [data-legend-row]").first() };
const widgetRow: Member = { role: "block", what: "a widget's row in the Widgets tab", panelTone: true, at: (p) => p.locator("[data-builder-pane] [data-widget-row]:not([data-expanded])").first() };
const widgetsSwitchKnob: Member = {
  role: "inner-card", what: "a switch's knob", pseudo: "::before", own: ["edge"],
  at: (p) => p.getByRole("switch", { name: "Show widgets on published view", exact: true }),
};
/** A basemap's card not in use: the one in use takes the accent as its own. */
const basemapCard: Member = {
  role: "block", what: "a basemap's card in the Basemap tab",
  at: (p) => p.locator('[data-builder-pane] button[class*="BasemapPanel-module"][class*="__card"][data-active="false"]').first(),
};
const toolsDrawer: Member = { role: "glass-panel", what: "the Tools drawer", at: (p) => p.locator("[data-recipe-drawer]") };
const toolResult: Member = { role: "block", what: "a tool's result block", at: (p) => p.locator("[data-recipe-drawer] [data-result-section]") };
const toolPicker: Member = { role: "block", what: "a tool's input picker", at: (p) => p.locator("[data-recipe-drawer] [data-parameter-form] input[type='search']").first().locator("xpath=..") };
const talkingChip: Member = { role: "block", what: "a chip of what the Assistant is talking about", at: (p) => p.locator('[data-assistant-pane][data-open="true"] [data-talking-about] [data-chip]').first() };
/** The header's quiet text: the section's link in the breadcrumb. */
const crumbLink = (p: Page) => p.locator("header").getByRole("navigation", { name: "Breadcrumb" }).getByRole("link").last();

/** Open one of the inspector's tabs, the pointer off every card after. */
async function inspectorTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tablist", { name: "Builder panels" }).getByRole("tab", { name, exact: true }).click();
  await page.mouse.move(5, 5);
}

/** The blocks inside the inspector's tabs and the Tools drawer, the knob of
 * the Widgets tab's switch and the Assistant's chips where a model is set
 * up, under a look; the inspector is left on its Layers tab. */
async function readBlocks(page: Page, api: Person["api"], theme: Theme, under: Under, where: string): Promise<void> {
  await inspectorTab(page, "Legend");
  await expectMember(page, legendEntry, theme, under, where);
  await inspectorTab(page, "Widgets");
  await expectMember(page, widgetRow, theme, under, where);
  await expectMember(page, widgetsSwitchKnob, theme, under, where);
  await inspectorTab(page, "Basemap");
  await expectMember(page, basemapCard, theme, under, where);
  await inspectorTab(page, "Layers");
  if ((await page.locator('[data-layer-list] li[data-selected="true"]').count()) === 0) await page.locator("[data-layer-list] [data-layer-select]").first().click();
  if (!(await toolsDrawer.at(page).isVisible())) await page.locator("[data-tools-control]").click();
  await page.locator("[data-operation='buffer']").click();
  await expect(page.locator("[data-parameter-form]")).toBeVisible();
  await page.mouse.move(5, 5);
  await expectMember(page, toolsDrawer, theme, under, where);
  await expectMember(page, toolResult, theme, under, where);
  // The input arrives filled from the selected layer; Change opens its picker.
  await page.locator("[data-recipe-drawer] [data-input-change]").first().click();
  await page.mouse.move(5, 5);
  await expectMember(page, toolPicker, theme, under, where);
  await page.locator("[data-tools-control]").click();
  await expect(toolsDrawer.at(page)).toBeHidden();
  const status = (await (await api.get("/api/assistant")).json()) as { enabled?: boolean };
  console.log(`[blocks] ${where} (${theme}): the Assistant is ${status.enabled ? "set up" : "not set up"} on this instance`);
  if (status.enabled) {
    await page.getByRole("button", { name: "Open assistant", exact: true }).click();
    await expectMember(page, talkingChip, theme, under, where);
    await page.locator("#header-actions-left").getByRole("button", { name: "Close assistant", exact: true }).click();
  } else {
    test.info().annotations.push({ type: "not shown", description: `${where} (${theme}): no model is set up on this instance, so the Assistant draws none of its blocks` });
  }
  test.info().annotations.push({ type: "not shown", description: `${where} (${theme}): the person's own message to the Assistant needs a turn a model answers; none is sent here` });
}

// ---- the fixtures ----

const THEMES: Theme[] = ["light", "dark"];
const rail = (page: Page) => page.getByRole("navigation", { name: "Product navigation" });

interface Fixture { mapId: string; mapName: string }

/** A map with two layers, the black and white stripes and the stations, as
 * the person; with `widget`, a histogram of the stations' riders over it. */
async function seed(page: Page, tag: string, { widget = false } = {}): Promise<Fixture> {
  await page.goto("/maps");
  const bands = (await seedFile(page, `pl_${tag}_bands.geojson`, stripesGeoJson(), "application/geo+json")).name;
  const points = (await seedCsv(page, `pl_${tag}_pts`, readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8"))).name;
  const mapName = `Panel looks ${tag}`;
  const mapId = await page.evaluate(async (name) => {
    const r = await fetch("/api/maps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    if (!r.ok) throw new Error(await r.text());
    return ((await r.json()) as { id: string }).id;
  }, mapName);
  const bandsLayer = await addLayer(page, mapId, "bands", `SELECT * FROM "${bands}"`);
  await patchLayer(page, bandsLayer, { style: STRIPES_STYLE });
  const stations = await addLayer(page, mapId, "stations", `SELECT * FROM "${points}"`);
  if (widget) {
    await patchMap(page, mapId, {
      widgets: [{ id: "w-riders", type: "histogram", layerId: stations, title: "Riders", field: "riders", agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }],
    });
  }
  return { mapId, mapName };
}

/** One invited person in the theme, the house route policy on their browser. */
async function personIn(browser: Parameters<typeof invitePerson>[0], request: Parameters<typeof invitePerson>[1], baseURL: string, first: string, theme: Theme) {
  const person = await invitePerson(browser, request, baseURL, first, runTag());
  await routeHouse(person.context, { basemapStyleStub: true });
  await person.context.addInitScript((t) => { window.localStorage.setItem("dezfil-theme", t); }, theme);
  const page = await person.context.newPage();
  return { person, page, errors: trackConsole(page) };
}

async function openBuilder(page: Page, mapId: string): Promise<void> {
  await visit(page, `/maps/${mapId}`);
  await expect(page.locator("[data-map-legend]").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-status-bar]")).toBeVisible();
}

/** The root carries the look (soft, so the surfaces are still read and say what a wrong root does to them) and the theme. */
async function expectRoot(page: Page, theme: Theme, attrs: LookAttributes): Promise<void> {
  await settle.poll(() => rootLook(page), { message: "the root carries the look" }).toEqual(attrs);
  if (theme === "dark") await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
}

function expectQuiet(errors: ConsoleError[]): void {
  const unexpected = errors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected, `console errors: ${JSON.stringify(unexpected)}`).toEqual([]);
}

/** Open the first layer card's menu, read it, close it. */
async function readLayerMenu(page: Page, theme: Theme, under: Under, where: string): Promise<void> {
  const card = page.locator("[data-layer-list] li").filter({ has: page.locator("[data-layer-select]") }).first();
  await card.getByRole("button", { name: "Layer menu", exact: true }).click();
  await expectMember(page, layerMenu, theme, under, where);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}
/** Open the export card from the header's Export menu. */
async function openExportCard(page: Page): Promise<void> {
  await exportButton.at(page).click();
  await page.getByRole("menuitem", { name: /Image/ }).first().click();
  await expect(page.getByRole("dialog", { name: "Export image" })).toBeVisible();
  await expect(page.locator("[data-export-card] [data-export-composition] [data-map-legend]").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
}
async function closeExportCard(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Export image" })).toHaveCount(0);
}

/** The builder's surfaces (and any `more` the fixture shows), a menu and the export dialog, under a look. */
async function readBuilder(page: Page, theme: Theme, under: Under, where: string, more: Member[] = []): Promise<void> {
  for (const m of [...BUILDER, ...more]) await expectMember(page, m, theme, under, where);
  await readLayerMenu(page, theme, under, where);
  await openExportCard(page);
  await expectMember(page, exportDialog, theme, under, where);
  await closeExportCard(page);
}

/** The map's gallery card on Maps, in the grid. */
const galleryCard = (mapName: string): Member => ({
  role: "page-card", what: "the map's gallery card", at: (p) => p.getByRole("link", { name: `Open ${mapName}`, exact: true }).locator("xpath=.."),
});
async function openMaps(page: Page): Promise<void> {
  await visit(page, "/maps");
  const grid = page.getByRole("button", { name: "Grid view", exact: true });
  if (await grid.count()) await grid.click();
}

/** A source and one buffer node reading it, the second stands unselected. */
async function seedWorkflow(page: Page, tag: string): Promise<string> {
  await page.goto("/workflows");
  const table = (await seedCsv(page, `pl_${tag}_src`, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n")).name;
  const made = await page.evaluate(async (name) => {
    const r = await fetch("/api/recipes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()) as { recipe: { id: string } };
  }, `Panel looks ${tag}`);
  const id = made.recipe.id;
  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({
    method: "POST", path: `/api/recipes/${id}/steps`, body: { operation: "buffer", parameters: { input: table, distance: 100, name: `${table}_rings` } },
  }));
  return id;
}
/** The group colours a node tile mixes into its ground. */
const GROUPS: Record<string, RGBA> = {
  Data: [59, 125, 216, 1], Overlay: [13, 156, 116, 1], Proximity: [28, 155, 160, 1],
  Geometry: [139, 111, 212, 1], Aggregation: [194, 129, 47, 1], Statistics: [194, 101, 136, 1],
};

// ---- the tab ----

test.describe("Panels in the Appearance tab", () => {
  test("Panels and background leads with three pictures, holds Panels and Background only under every choice, and every pick is kept as it is made", async ({ browser, request, baseURL }) => {
    const people: Person[] = [];
    try {
      const { person, page, errors } = await personIn(browser, request, baseURL!, "Picker", "light");
      people.push(person);
      await page.goto("/settings/appearance");
      const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Panels and background", exact: true }) });
      const panels = page.getByRole("radiogroup", { name: "Panels" });
      const background = page.getByRole("radiogroup", { name: "Background" });
      await expect(panels).toBeVisible();
      const saved = page.locator("#set-panels").getByRole("status");
      const settings = async () => (await (await person.api.get("/api/settings")).json()).look as Record<string, string>;
      /** The card's rows, and the switches in it: Panels and Background, and none. */
      const holdsTheTwo = async (choice: string) => {
        await expect.poll(async () => (await card.locator("[id^='set-']").evaluateAll((els) => els.map((el) => el.id))).filter((id) => !/-(label|error)$/.test(id)), { message: `under ${choice}, the card's rows` })
          .toEqual(["set-panels", "set-background"]);
        await expect(card.getByRole("switch"), `under ${choice}, no switch in the card`).toHaveCount(0);
      };

      await test.step("the second card is Panels and background, Panels first, three pictures with Glass marked", async () => {
        const titles = await page.locator("main section h2, main section h3").filter({ visible: true }).allTextContents();
        expect(titles.slice(0, 2), "the tab's first two cards").toEqual(["Color and contrast", "Panels and background"]);
        await holdsTheTwo("Glass");
        await expect(panels.getByRole("radio")).toHaveCount(3);
        for (const [at, name] of ["Glass", "Liquid", "Paper"].entries()) await expect(panels.getByRole("radio").nth(at)).toHaveAccessibleName(name);
        await expect(panels.getByRole("radio", { name: "Glass" })).toHaveAttribute("aria-checked", "true");
        expect(await rootLook(page)).toEqual({});
      });

      await test.step("each picture shows its own choice: its header card, side menu and card over a map", async () => {
        for (const [choice, under] of [["glass", GLASS], ["liquid", LIQUID], ["paper", PAPER]] as const) {
          const art = (p: Page) => p.locator(`[data-picture-panels="${choice}"]`);
          for (const [part, role] of [["pnHead", "glass-chrome"], ["pnRail", "glass-chrome"], ["pnCard", "overlay-panel"]] as const) {
            await expectMember(page, { role, what: `the ${choice} picture's ${part}`, own: ["edge"], at: (p) => art(p).locator(`[class*="${part}"]`).first() }, "light", under, "the Panels pictures");
          }
        }
      });

      const held: (() => void)[] = [];
      await test.step("a pick changes the page at once and shows Saved only after the answer", async () => {
        await page.evaluate(() => { (window as { __sameDocument?: boolean }).__sameDocument = true; });
        await page.route("**/api/settings", async (route) => {
          if (route.request().method() !== "PATCH") return route.continue();
          await new Promise<void>((release) => held.push(release));
          await route.continue();
        });
        await panels.getByRole("radio", { name: "Liquid" }).click();
        await expect.poll(() => rootLook(page)).toEqual(attrsOf("liquid"));
        await expect.poll(() => held.length).toBe(1);
        await expect(saved).toHaveCount(0);
        held.shift()!();
        await expect(saved).toHaveText("Saved");
        expect((await settings()).panels).toBe("liquid");
        await page.unroute("**/api/settings");
        expect(await page.evaluate(() => (window as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
        await holdsTheTwo("Liquid");
      });

      await test.step("a refused pick returns the page to what is kept", async () => {
        await page.route("**/api/settings", async (route) => {
          if (route.request().method() !== "PATCH") return route.continue();
          await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "invalid_request", message: "look.panels: refused for this journey" } }) });
        });
        await panels.getByRole("radio", { name: "Paper" }).click();
        // The page returns to what is kept; the row keeps the refused pick with its red line.
        await expect.poll(() => rootLook(page)).toEqual(attrsOf("liquid"));
        await expect(page.locator("#set-panels-error")).toBeVisible();
        await consumeExpected(errors, /\/api\/settings/, /400/);
        await page.unroute("**/api/settings");
        expect((await settings()).panels).toBe("liquid");
        await panels.getByRole("radio", { name: "Liquid" }).click();
        await expect(page.locator("#set-panels-error")).toHaveCount(0);
        await expect(panels.getByRole("radio", { name: "Liquid" })).toHaveAttribute("aria-checked", "true");
      });

      await test.step("the card's Reset returns Panels and Background, and its Undo puts them back", async () => {
        await panels.getByRole("radio", { name: "Paper" }).click();
        await background.getByRole("radio", { name: "Graticule" }).click();
        await expect.poll(() => rootLook(page)).toEqual({ ...attrsOf("paper"), "data-look-background": "graticule" });
        await holdsTheTwo("Paper");
        await expect.poll(async () => { const look = await settings(); return [look.panels, look.background]; }).toEqual(["paper", "graticule"]);
        const writes: Record<string, unknown>[] = [];
        page.on("request", (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === "/api/settings") writes.push(JSON.parse(r.postData() ?? "{}").look); });
        await card.getByRole("button", { name: "Reset to defaults: Panels and background" }).click();
        await expect.poll(() => rootLook(page)).toEqual({});
        await expect.poll(() => writes.length).toBe(1);
        expect(writes[0], "the card's Reset writes the two").toEqual({ panels: "glass", background: "atlantic" });
        await expect.poll(async () => { const look = await settings(); return [look.panels, look.background]; }).toEqual(["glass", "atlantic"]);
        await card.getByRole("button", { name: "Undo reset to defaults: Panels and background" }).click();
        await expect.poll(() => rootLook(page)).toEqual({ ...attrsOf("paper"), "data-look-background": "graticule" });
        await expect.poll(() => writes.length).toBe(2);
        expect(writes[1], "the Undo writes back what the Reset changed").toEqual({ panels: "paper", background: "graticule" });
        await expect.poll(async () => { const look = await settings(); return [look.panels, look.background]; }).toEqual(["paper", "graticule"]);
      });

      await test.step("Reset to Dezfil's default returns every pick in sight, and its Undo restores them all", async () => {
        await panels.getByRole("radio", { name: "Liquid" }).click();
        await page.getByRole("radiogroup", { name: "Color" }).getByRole("radio", { name: "Harbor" }).click();
        const picked = { ...attrsOf("liquid"), "data-look-background": "graticule", "data-look-color": "harbor" };
        await expect.poll(() => rootLook(page)).toEqual(picked);
        await expect.poll(async () => { const look = await settings(); return [look.panels, look.background, look.color]; }).toEqual(["liquid", "graticule", "harbor"]);
        await page.getByRole("button", { name: "Reset to Dezfil's default" }).click();
        await expect.poll(() => rootLook(page)).toEqual({});
        await holdsTheTwo("Glass, after Reset to Dezfil's default");
        await expect.poll(async () => { const look = await settings(); return [look.panels, look.background, look.color]; }).toEqual(["glass", "atlantic", "kelp"]);
        await page.getByRole("button", { name: "Undo reset to Dezfil's default" }).click();
        await expect.poll(() => rootLook(page)).toEqual(picked);
        await expect.poll(async () => { const look = await settings(); return [look.panels, look.background, look.color]; }).toEqual(["liquid", "graticule", "harbor"]);
        await expect(panels.getByRole("radio", { name: "Liquid" })).toHaveAttribute("aria-checked", "true");
        await holdsTheTwo("Liquid, after the Undo");
      });

      await test.step("an own-settings write naming one of Liquid's former kinds is refused by its position, and the look stays as it was", async () => {
        const before = await settings();
        expect(Object.keys(before).sort(), "the own-settings read lists the seven picks").toEqual([...PICKS].sort());
        const refused = await person.api.patch("/api/settings", { data: { look: { panels: "paper", liquidMenus: "on" } } });
        expect(refused.status()).toBe(400);
        const body = (await refused.json()) as { error: { code: string; message: string } };
        // The key is named by its position, never repeated: a posted key may hold a credential.
        expect(body).toEqual({ error: { code: "invalid_request", message: `look: Unknown setting at position 2. Expected one of: ${PICKS.join(", ")}.` } });
        expect(await settings(), "nothing of the refused write is kept").toEqual(before);
        await page.reload();
        await expect(panels).toBeVisible();
        expect(await rootLook(page), "the page after a reload").toEqual({ ...attrsOf("liquid"), "data-look-background": "graticule", "data-look-color": "harbor" });
        await holdsTheTwo("Liquid, after the refused write");
      });
      expectQuiet(errors);
    } finally {
      await closeAll(people);
    }
  });
});

// ---- Liquid ----

for (const theme of THEMES) {
  test(`Liquid on every role: a member of every role, the blocks inside panels and the widget card over the map compute the one recipe (${theme})`, async ({ browser, request, baseURL }) => {
    test.setTimeout(360_000);
    const people: Person[] = [];
    try {
      const { person, page, errors } = await personIn(browser, request, baseURL!, "Liquid", theme);
      people.push(person);
      const fx = await seed(page, `${runTag()}_${theme}_all`, { widget: true });
      const workflow = await seedWorkflow(page, `${runTag()}_${theme}`);
      await setLook(person.api, lookOf("liquid"));

      await test.step(`the builder, the widget card over the map, a menu and a dialog (${theme})`, async () => {
        await openBuilder(page, fx.mapId);
        await expectRoot(page, theme, attrsOf("liquid"));
        await expect(widgetCard.at(page)).toBeVisible({ timeout: 30_000 });
        await readBuilder(page, theme, LIQUID, "the builder", [widgetCard]);
      });
      await test.step(`the header's and a map button's quiet text read at the stepped ink (${theme})`, async () => {
        const want = stepped(theme);
        await expect(crumbLink(page)).toBeVisible();
        for (const [name, el] of [["the header's breadcrumb link", crumbLink(page)], ["the map's Zoom in button", zoomIn.at(page)]] as const) {
          const seen = await el.evaluate((node) => getComputedStyle(node).color);
          expect(sameColour(colour(seen), want), `${name}: ${seen}, want ${fmt(want)}`).toBe(true);
        }
        const own = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[style]"))
          .filter((el) => /--fg-/.test(el.style.cssText)).map((el) => `${el.tagName.toLowerCase()}: ${el.style.cssText}`));
        expect(own, "no element carries a quiet ink of its own").toEqual([]);
      });
      await test.step(`the blocks inside the inspector's tabs and the Tools drawer: the fill, the light and the contact drop, no blur (${theme})`, async () => {
        await readBlocks(page, person.api, theme, LIQUID, "the builder");
      });
      await test.step(`a layer's style: a slider's thumb (${theme})`, async () => {
        // The Tools step above left a layer selected; its style is in the inspector.
        if ((await page.locator('[data-layer-list] li[data-selected="true"]').count()) === 0) await page.locator("[data-layer-list] [data-layer-select]").first().click();
        await expectMember(page, sliderThumb, theme, LIQUID, "a layer's style");
      });
      await test.step(`a gallery card at rest and under the pointer, a Settings card and the tab column (${theme})`, async () => {
        await openMaps(page);
        await expectMember(page, galleryCard(fx.mapName), theme, LIQUID, "Maps");
        await galleryCard(fx.mapName).at(page).hover();
        await expectMember(page, { ...galleryCard(fx.mapName), what: "the hovered gallery card", shadows: (t) => lit("high", t) }, theme, LIQUID, "Maps");
        await page.mouse.move(5, 5);
        await visit(page, "/settings/appearance");
        await expectMember(page, { role: "page-card", what: "a Settings card", at: (p) => p.locator("section[aria-labelledby]").filter({ visible: true }).first() }, theme, LIQUID, "Settings");
        await expectMember(page, { role: "page-card", what: "the Settings tab column", at: (p) => p.getByRole("navigation", { name: "Settings" }) }, theme, LIQUID, "Settings");
      });
      await test.step(`a node tile keeps its group's edge and tint over the inner card's ground (${theme})`, async () => {
        await visit(page, `/workflows/${workflow}`);
        await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
        const tile = page.locator('[data-node][data-kind="node"] [data-v="badge"]').first();
        const group = await tile.evaluate((el) => el.closest("[data-grp]")?.getAttribute("data-grp") ?? "");
        expect(Object.keys(GROUPS), "the tile's group is one of the shipped groups").toContain(group);
        const tint = GROUPS[group];
        await expectMember(page, { role: "inner-card", what: "a node tile", own: ["edge"], fill: (want) => mix([tint, 0.12], [want.fill, 0.88]), at: () => tile }, theme, LIQUID, "the workflow canvas");
        const edge = await readEl(tile);
        // 1.5 px as written; a browser at one device pixel to the CSS pixel draws it on whole pixels.
        expect(["1px", "1.5px"], "the tile keeps its group's edge").toContain(edge.edgeWidth);
        expect(edge.edgeStyle).toBe("solid");
        expect(sameColour(colour(edge.edgeColor), thin(tint, 0.3)), `the tile's edge ${edge.edgeColor}`).toBe(true);
      });
      expectQuiet(errors);
    } finally {
      await closeAll(people);
    }
  });
}

// ---- Paper ----

for (const theme of THEMES) {
  test(`Paper: every role at its values, the buttons as separate sheets, menus and dialogs as shipped, the blocks at Glass's grounds, the lines inside panels softened (${theme})`, async ({ browser, request, baseURL }) => {
    test.setTimeout(360_000);
    const people: Person[] = [];
    try {
      const { person, page, errors } = await personIn(browser, request, baseURL!, "Paper", theme);
      people.push(person);
      const fx = await seed(page, `${runTag()}_${theme}_paper`, { widget: true });
      await setLook(person.api, lookOf("paper"));
      const tabsLine = (p: Page) => p.getByRole("tablist", { name: "Builder panels" });
      const lineColour = async () => colour(await tabsLine(page).evaluate((el) => getComputedStyle(el).borderBottomColor));

      await test.step(`the builder, each map button its own sheet, the menu and the dialog as shipped (${theme})`, async () => {
        await openBuilder(page, fx.mapId);
        await expectRoot(page, theme, attrsOf("paper"));
        await expect(widgetCard.at(page)).toBeVisible({ timeout: 30_000 });
        await readBuilder(page, theme, PAPER, "the builder", [widgetCard]);
        for (const name of ["Zoom out", "Fullscreen map"]) await expectMember(page, stageButton(name), theme, PAPER, "the builder");
      });
      await test.step(`the Assistant pane is paper with the side panels (${theme})`, async () => {
        await page.getByRole("button", { name: "Open assistant", exact: true }).click();
        await expectMember(page, { role: "glass-panel", what: "the Assistant pane", at: (p) => p.locator('[data-assistant-pane][data-open="true"]') }, theme, PAPER, "the builder");
        await page.locator("#header-actions-left").getByRole("button", { name: "Close assistant", exact: true }).click();
      });
      await test.step(`the lines inside a panel are ${theme === "light" ? "7" : "8"} % ink (${theme})`, async () => {
        const want = thin(TONES[theme].ink, theme === "light" ? 0.07 : 0.08);
        await expect.poll(async () => fmt(await lineColour()), { message: "the inspector's tab line" }).toBe(fmt(want));
        expect(sameColour(await lineColour(), want)).toBe(true);
      });
      await test.step(`the blocks inside the inspector's tabs and the Tools drawer keep Glass's grounds with the softer line (${theme})`, async () => {
        await readBlocks(page, person.api, theme, PAPER, "the builder");
      });
      await test.step(`a gallery card (${theme})`, async () => {
        await openMaps(page);
        await expectMember(page, galleryCard(fx.mapName), theme, PAPER, "Maps");
      });
      await test.step(`under More contrast the pick's stronger lines win (${theme})`, async () => {
        await setLook(person.api, { contrast: "more" });
        await openBuilder(page, fx.mapId);
        await expectRoot(page, theme, { ...attrsOf("paper"), "data-look-contrast": "more" });
        await expect.poll(async () => fmt(await lineColour()), { message: "the inspector's tab line under More contrast" }).toBe(fmt(TONES[theme].moreBorder));
        await expect(widgetCard.at(page), "the widget card's line under More contrast").toHaveCSS("border-top-color", `rgb(${TONES[theme].moreBorder.slice(0, 3).join(", ")})`);
      });
      expectQuiet(errors);
    } finally {
      await closeAll(people);
    }
  });
}

// ---- Glass leaves no trace ----

/** What a look could leave on a page: an attribute on the root, the lens's
 * filters, a custom property set on an element, the boxes of the chrome. */
async function traces(page: Page): Promise<{ attrs: LookAttributes; filters: number; inline: string[] }> {
  return {
    attrs: Object.fromEntries(Object.entries(await rootLook(page)).filter(([name]) => name === "data-look-panels")),
    filters: await page.locator("[data-panel-lens], filter[id^='dz-lens']").count(),
    inline: await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[style]")).flatMap((el) => {
      const out: string[] = [];
      for (let i = 0; i < el.style.length; i += 1) {
        const name = el.style.item(i);
        if (/^--(surface|fg)-/.test(name)) out.push(`${el.tagName.toLowerCase()}.${el.className}: ${name}`);
      }
      return out;
    })),
  };
}
const NO_TRACE = { attrs: {}, filters: 0, inline: [] };
async function boxes(page: Page, at: Record<string, (p: Page) => Locator>): Promise<Record<string, number[]>> {
  // At the top of every scroller, once no entrance or transition is still running: the page at rest.
  await page.evaluate(() => { for (const el of [document.scrollingElement, ...Array.from(document.querySelectorAll("*"))]) if (el && el.scrollTop) el.scrollTop = 0; });
  await expect.poll(() => page.evaluate(() => document.getAnimations()
    .filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity).length), { message: "the page has come to rest", timeout: 10_000 }).toBe(0);
  const out: Record<string, number[]> = {};
  for (const [name, find] of Object.entries(at)) {
    const b = await find(page).boundingBox();
    out[name] = b ? [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 2) / 2) : [];
  }
  return out;
}

for (const theme of THEMES) {
  test(`Glass after Liquid and Paper leaves no trace on the tab, a list page or the builder (${theme})`, async ({ browser, request, baseURL, browserName }) => {
    const people: Person[] = [];
    try {
      const { person, page, errors } = await personIn(browser, request, baseURL!, "Trace", theme);
      people.push(person);
      const fx = await seed(page, `${runTag()}_${theme}_trace`);
      const onMaps = { header: headerCard.at, rail, card: galleryCard(fx.mapName).at };
      const onBuilder = { header: headerCard.at, inspector: inspector.at, legend: legend.at, zoom: zoomIn.at, map: mapCard.at };
      // The tab's chrome and column; the Panels card itself shows its Saved marks.
      const onTab = { header: headerCard.at, rail, column: (p: Page) => p.getByRole("navigation", { name: "Settings" }), first: (p: Page) => p.locator("section[aria-labelledby]").first() };

      // Under Glass, fresh: what each page looks like with no look at all.
      await openMaps(page);
      await expect(galleryCard(fx.mapName).at(page)).toBeVisible();
      const mapsBefore = await boxes(page, onMaps);
      expect(await traces(page)).toEqual(NO_TRACE);
      await openBuilder(page, fx.mapId);
      await page.waitForTimeout(1_000);
      const builderBefore = await boxes(page, onBuilder);
      expect(await traces(page)).toEqual(NO_TRACE);
      await visit(page, "/settings/appearance");
      const panels = page.getByRole("radiogroup", { name: "Panels" });
      await expect(panels).toBeVisible();
      const tabBefore = await boxes(page, onTab);

      await test.step(`Liquid reaches the tab, Maps and the builder (${theme})`, async () => {
        await panels.getByRole("radio", { name: "Liquid" }).click();
        await expect.poll(() => rootLook(page)).toEqual(attrsOf("liquid"));
        await rail(page).getByRole("link", { name: "Maps" }).click();
        await expect(galleryCard(fx.mapName).at(page)).toBeVisible();
        await galleryCard(fx.mapName).at(page).getByRole("button", { name: `Open ${fx.mapName} in the builder` }).click();
        await expect(page.locator("[data-map-legend]").first()).toBeVisible({ timeout: 30_000 });
        // The harness: the look did reach the page, so its absence later is the switch's doing.
        const reached = await traces(page);
        expect(reached.attrs).toEqual(attrsOf("liquid"));
        if (browserName === "chromium") {
          await expect.poll(async () => (await traces(page)).filters, { message: "the bend reached the builder" }).toBeGreaterThan(0);
          await expect.poll(async () => (await traces(page)).inline.length, { message: "the bend's blur, held inline, reached the builder" }).toBeGreaterThan(0);
        }
      });

      await test.step(`Paper, then Glass, picked on the tab (${theme})`, async () => {
        await rail(page).getByRole("link", { name: "Settings" }).click();
        await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Appearance" }).click();
        await panels.getByRole("radio", { name: "Paper" }).click();
        await expect.poll(() => rootLook(page)).toEqual(attrsOf("paper"));
        await panels.getByRole("radio", { name: "Glass" }).click();
        await expect.poll(() => rootLook(page)).toEqual({});
        await expect.poll(() => traces(page), { message: "the tab after Glass" }).toEqual(NO_TRACE);
        expect(await boxes(page, onTab), "the tab's boxes after Glass").toEqual(tabBefore);
      });

      await test.step(`Maps and the builder, reached without a reload, carry nothing of either look (${theme})`, async () => {
        await rail(page).getByRole("link", { name: "Maps" }).click();
        await expect(galleryCard(fx.mapName).at(page)).toBeVisible();
        await expect.poll(() => traces(page), { message: "Maps after Glass" }).toEqual(NO_TRACE);
        expect(await boxes(page, onMaps), "Maps' boxes after Glass").toEqual(mapsBefore);
        await galleryCard(fx.mapName).at(page).getByRole("button", { name: `Open ${fx.mapName} in the builder` }).click();
        await expect(page.locator("[data-map-legend]").first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(1_000);
        await expect.poll(() => traces(page), { message: "the builder after Glass" }).toEqual(NO_TRACE);
        expect(await boxes(page, onBuilder), "the builder's boxes after Glass").toEqual(builderBefore);
        for (const m of BUILDER) await expectMember(page, m, theme, GLASS, "the builder after Glass");
        const crumb = await crumbLink(page).evaluate((node) => getComputedStyle(node).color);
        expect(sameColour(colour(crumb), TONES[theme].muted), `the header's quiet text after Glass: ${crumb}`).toBe(true);
      });
      expectQuiet(errors);
    } finally {
      await closeAll(people);
    }
  });
}

// ---- the bend ----

/** Bring the stripes in until each is 20 to 40 pixels wide, the pointer off
 * the stack: wide enough that the recipe's blur leaves them a contrast
 * to soften and to bend. */
async function stripesIn(page: Page): Promise<void> {
  const card = (await mapCard.at(page).boundingBox())!;
  const pane = (await inspector.at(page).boundingBox())!;
  const probe = { x: Math.round(card.x + card.width * 0.3), y: Math.round(card.y + card.height * 0.5), width: Math.round(card.width * 0.4) };
  await expect.poll(async () => range(await rowLuma(page, probe.x, probe.y, probe.width)), { message: "the stripes are drawn", timeout: 30_000 }).toBeGreaterThan(120);
  const still = async () => {
    let last = "";
    await expect.poll(async () => {
      const now = JSON.stringify(await rowLuma(page, probe.x, probe.y, probe.width));
      const same = now === last;
      last = now;
      return same;
    }, { message: "the map has settled", timeout: 30_000, intervals: [400] }).toBe(true);
  };
  let width = 0;
  for (let zoomed = 1; zoomed <= 5; zoomed += 1) {
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await page.waitForTimeout(600);
    await still();
    await expect(page.getByText("Saving…", { exact: true })).toBeHidden();
    await page.waitForTimeout(600);
    width = stripeWidth(await rowLuma(page, probe.x, probe.y, probe.width));
    if (width >= 20) break;
  }
  expect(width, `the harness: the stripes are 20 to 40 pixels wide (${width})`).toBeGreaterThanOrEqual(20);
  expect(width, `the harness: the stripes are 20 to 40 pixels wide (${width})`).toBeLessThanOrEqual(40);
}
function stripeWidth(v: number[]): number {
  const r = range(v);
  const edges: number[] = [];
  for (let i = 1; i < v.length; i += 1) {
    if (Math.abs(v[i] - v[i - 1]) >= 0.3 * r && (edges.length === 0 || i - edges[edges.length - 1] > 2)) edges.push(i);
  }
  const gaps = edges.slice(1).map((e, i) => e - edges[i]).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
}

/** Drag the map a few pixels sideways and let it come to rest, its camera kept. */
async function nudgeMap(page: Page, dx: number): Promise<void> {
  const card = (await mapCard.at(page).boundingBox())!;
  const at = { x: card.x + card.width * 0.5, y: card.y + card.height * 0.5 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i += 1) await page.mouse.move(at.x + (dx * i) / 5, at.y);
  // Held still before letting go, so the map is not thrown on.
  await page.waitForTimeout(400);
  await page.mouse.up();
  const pane = (await inspector.at(page).boundingBox())!;
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.waitForTimeout(800);
  await expect(page.getByText("Saving…", { exact: true })).toBeHidden();
}

/** Under a surface the stripes are soft and still show; beside it, in the same row, sharp. */
async function softUnder(page: Page, what: string, glass: Locator, fill: number): Promise<void> {
  const b = (await glass.boundingBox())!;
  const card = (await mapCard.at(page).boundingBox())!;
  // A row above the button's glyph, inside its rounded corners; beside it, the
  // nearest window toward the map's middle that crosses nothing but the map.
  const y = Math.round(b.y + 6);
  const under = { x: Math.round(b.x + 7), width: Math.round(b.width - 14) };
  const towardMiddle = b.x + b.width / 2 < card.x + card.width / 2;
  let beside: { x: number; width: number } | null = null;
  for (const gap of [40, 100, 160]) {
    const x = Math.round(towardMiddle ? b.x + b.width + gap : b.x - gap - 60);
    if ((await paintersAcross(page, x, y, 60)).length === 0) { beside = { x, width: 60 }; break; }
  }
  expect(beside, `the harness: a window of the row beside ${what} crosses only the map`).not.toBeNull();
  if (!beside) return;
  const x0 = Math.min(under.x, beside.x);
  const row = await rowLuma(page, x0, y, Math.max(under.x + under.width, beside.x + beside.width) - x0);
  const u = row.slice(under.x - x0, under.x - x0 + under.width);
  const s = row.slice(beside.x - x0, beside.x - x0 + beside.width);
  const through = (1 - fill) * range(s);
  await test.info().attach(`pixel row: ${what}`, { body: JSON.stringify({ y, under, beside, underRow: u.map(Math.round), besideRow: s.map(Math.round) }), contentType: "application/json" });
  expect.soft(range(s), `the stripes run beside ${what}`).toBeGreaterThan(120);
  expect.soft(maxStep(s), `beside ${what} an edge is sharp`).toBeGreaterThanOrEqual(0.45 * range(s));
  expect.soft(maxStep(u), `under ${what} the edges are soft (${maxStep(u).toFixed(2)}, sharp would be about ${through.toFixed(1)})`).toBeLessThanOrEqual(0.5 * through);
  expect.soft(range(u), `under ${what} the stripes still show through (${range(u).toFixed(2)} of ${through.toFixed(1)})`).toBeGreaterThanOrEqual(0.08 * through);
}

/** Whether this browser's screenshots show a backdrop blur at all: a plain one
 * over hard stripes, on a blank page of its own. Playwright's Firefox, for one,
 * captures the stripes sharp under it. */
async function drawsBackdropBlur(page: Page): Promise<boolean> {
  const probe = await page.context().newPage();
  try {
    await probe.setContent(`<style>body{margin:0}.s{position:absolute;top:0;left:0;width:300px;height:80px;background:repeating-linear-gradient(90deg,#000 0 16px,#fff 16px 32px)}
      .g{position:absolute;top:10px;left:60px;width:160px;height:60px;backdrop-filter:blur(6px)}</style><div class="s"></div><div class="g"></div>`);
    await probe.waitForTimeout(300);
    const row = await rowLuma(probe, 70, 40, 140);
    console.log(`[control] a plain backdrop blur over stripes: largest step ${maxStep(row).toFixed(1)} of ${range(row).toFixed(1)}`);
    return maxStep(row) < 0.5 * range(row);
  } finally {
    await probe.close();
  }
}

/** The shift that best lays one stretch of a row over another, within a few pixels. */
function bestShift(bent: number[], plain: number[], from: number, to: number): number {
  let best = 0;
  let score = Infinity;
  for (let s = -6; s <= 6; s += 1) {
    let sum = 0;
    for (let x = from; x <= to; x += 1) sum += Math.abs(bent[x] - (plain[x + s] ?? plain[x]));
    if (sum < score - 1e-6) { score = sum; best = s; }
  }
  return best;
}

/** Sample a surface's drawn blur and size every frame for a while, from the page. */
async function sampleFrames(page: Page, selector: string, ms: number, act: () => Promise<void>): Promise<{ t: number; blur: string; lens: string | null; size: string; inline: string }[]> {
  await page.evaluate(({ selector, ms }) => {
    const out: { t: number; blur: string; lens: string | null; size: string; inline: string }[] = [];
    (window as { __frames?: typeof out }).__frames = out;
    const start = performance.now();
    const tick = () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        const blur = getComputedStyle(el).getPropertyValue("backdrop-filter");
        const url = /#([^"')]+)/.exec(blur);
        const filter = url ? document.getElementById(url[1]) : null;
        const std = filter?.querySelector("feGaussianBlur")?.getAttribute("stdDeviation");
        const box = el.getBoundingClientRect();
        out.push({ t: performance.now() - start, blur, lens: url ? (std == null ? "missing" : `blur(${2 * Number(std)}px)`) : null, size: `${Math.round(box.width)}x${Math.round(box.height)}`, inline: el.style.cssText });
      }
      if (performance.now() - start < ms) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { selector, ms });
  await act();
  await page.waitForTimeout(ms + 200);
  return page.evaluate(() => (window as { __frames?: { t: number; blur: string; lens: string | null; size: string; inline: string }[] }).__frames ?? []);
}

test("the bend in Chromium: a map button's backdrop pulled inward across its bezel, its rim lit, the map soft; resized and sliding surfaces bend once settled; no button grows", async ({ browser, request, baseURL, browserName }) => {
  test.skip(browserName !== "chromium", "the bend is drawn in Chromium; the fallback case holds the others");
  test.setTimeout(360_000);
  const people: Person[] = [];
  try {
    const { person, page, errors } = await personIn(browser, request, baseURL!, "Bend", "light");
    people.push(person);
    const fx = await seed(page, `${runTag()}_bend`);
    await setLook(person.api, lookOf("liquid"));
    await openBuilder(page, fx.mapId);
    await stripesIn(page);
    const button = page.getByRole("button", { name: "Zoom out", exact: true });

    await test.step("the Zoom out button is bent at its size, its rim lit on the sides facing the light, its quiet ink stepped", async () => {
      const box = (await button.boundingBox())!;
      await expect.poll(async () => (await readEl(button)).lens?.size, { message: "the button is drawn through a filter of its size" })
        .toBe(`${Math.round(box.width)}x${Math.round(box.height)}`);
      const seen = await readEl(button);
      expect(problems(seen, liquidWant("overlay-control", "light"))).toEqual([]);
      const [first, far] = layers(seen.shadow);
      expect([first.inset, first.x, first.y], "the bright line faces the upper left").toEqual([true, 1, 1]);
      expect([far.inset, far.x, far.y], "the fainter one the far side").toEqual([true, -1, -1]);
      expect(Object.keys(seen.inline), "the button carries the bend's blur and nothing more").toEqual(["--surface-overlay-control-blur"]);
      expect(sameColour(colour(seen.color), stepped("light")), `the button's ink ${seen.color}`).toBe(true);
    });

    await test.step("across its bezel the stripes are pulled inward, read with the button's own fill taken off, against the same filter with its pull set to none", async () => {
      // A row through the button's middle: its left and right bezels each
      // side of the glyph. The recipe's fill lets less than a tenth of the
      // map through, so the button's own fill is taken off for the read (its
      // filter, its blur and its rim stay) and the row shows what the filter
      // draws. Each bezel is read in turn, the map moved a few pixels at a
      // time until a stripe's edge lies in it, so it has something to pull.
      const w = Math.round((await button.boundingBox())!.width);
      const left = { from: 1, to: 9 }, right = { from: w - 10, to: w - 2 }, middle = { from: 14, to: w - 15 };
      const across = async () => {
        const box = (await button.boundingBox())!;
        return { x: Math.round(box.x), y: Math.round(box.y + box.height / 2) };
      };
      const contrast = (row: number[], at: { from: number; to: number }) => range(row.slice(at.from, at.to + 1));
      const id = (await readEl(button)).lens!.id;
      const pull = async (scale: string | null) => page.evaluate(({ id, scale }) => {
        const map = document.getElementById(id)?.querySelector("feDisplacementMap");
        const was = map?.getAttribute("scale") ?? null;
        if (map && scale !== null) map.setAttribute("scale", scale);
        return was;
      }, { id, scale });
      const ownFill = (off: boolean) => button.evaluate((el, off) => {
        if (off) (el as HTMLElement).style.setProperty("background-color", "transparent");
        else (el as HTMLElement).style.removeProperty("background-color");
      }, off);
      /** The bent row and the same row with the pull set to none, at one place. */
      const pair = async (x: number, y: number) => {
        const bent = await rowLuma(page, x, y, w);
        const scale = await pull("0");
        expect(Number(scale), "the harness: the filter pulls").toBeGreaterThan(0);
        await page.waitForTimeout(300);
        const plain = await rowLuma(page, x, y, w);
        await pull(scale);
        await page.waitForTimeout(300);
        expect(await rowLuma(page, x, y, w), "the harness: the pull put back draws the bent row again").toEqual(bent);
        return { bent, plain, diff: bent.map((v, i) => Math.abs(v - plain[i])) };
      };
      const most = (diff: number[], at: { from: number; to: number }) => Math.max(...diff.slice(at.from, at.to + 1));
      const readBezel = async (side: "left" | "right") => {
        const at = side === "left" ? left : right;
        for (let nudge = 0; nudge <= 8; nudge += 1) {
          const { x, y } = await across();
          if (contrast(await rowLuma(page, x, y, w), at) >= 25) break;
          await nudgeMap(page, 5);
        }
        const { x, y } = await across();
        expect(contrast(await rowLuma(page, x, y, w), at), `the harness: a stripe's edge lies in the ${side} bezel`).toBeGreaterThanOrEqual(25);
        const read = await pair(x, y);
        // For the record, not held: the same pull as a person sees it, through the button's fill.
        await ownFill(false);
        await page.waitForTimeout(300);
        const seen = await pair(x, y);
        await ownFill(true);
        await page.waitForTimeout(300);
        return { y, moves: most(read.diff, at), middle: most(read.diff, middle), shift: bestShift(read.bent, read.plain, at.from, at.to), throughFill: most(seen.diff, at), bent: read.bent.map(Math.round), plain: read.plain.map(Math.round) };
      };
      await ownFill(true);
      try {
        await page.waitForTimeout(300);
        const l = await readBezel("left");
        const r = await readBezel("right");
        const measured = { left: l.moves, right: r.moves, middle: Math.max(l.middle, r.middle), leftShift: l.shift, rightShift: r.shift, throughFill: { left: l.throughFill, right: r.throughFill } };
        await test.info().attach("the bend, rows through the Zoom out button", { body: JSON.stringify({ measured, left: l, right: r }), contentType: "application/json" });
        console.log(`[bend] Zoom out ${w}px wide: ${JSON.stringify(measured)}`);
        expect.soft(measured.left, "the left bezel moves").toBeGreaterThanOrEqual(6);
        expect.soft(measured.right, "the right bezel moves").toBeGreaterThanOrEqual(6);
        expect.soft(measured.middle, "past the bezels nothing moves").toBeLessThanOrEqual(2);
        // Inward: the left bezel shows what lies to its right, the right bezel what lies to its left.
        expect.soft(measured.leftShift, "the left bezel is pulled inward").toBeGreaterThan(0);
        expect.soft(measured.rightShift, "the right bezel is pulled inward").toBeLessThan(0);
      } finally {
        await ownFill(false);
      }
    });

    await test.step("the map under the button is soft, and sharp beside it", async () => {
      await softUnder(page, "the Zoom out button", button, liquidFill("light")[3]);
    });

    await test.step("a map button does not grow under the pointer; its icon takes the accent", async () => {
      await zoomIn.at(page).hover();
      await expect.poll(async () => (await readEl(zoomIn.at(page))).color).toBe(`rgb(${TONES.light.accent.slice(0, 3).join(", ")})`);
      expect((await readEl(zoomIn.at(page))).transform).toBe("none");
      await page.mouse.move(5, 5);
    });

    await test.step("the inspector resized keeps its blur throughout and takes the bend for its new size once settled", async () => {
      const selector = "[data-builder-pane]";
      const before = (await readEl(inspector.at(page))).lens;
      expect(before?.blur, "the inspector is bent before the resize").toBe(LIQUID_BLUR);
      const frames = await sampleFrames(page, selector, 1_500, () => page.setViewportSize({ width: 1280, height: 600 }));
      const after = (await inspector.at(page).boundingBox())!;
      const size = `${Math.round(after.width)}x${Math.round(after.height)}`;
      await test.info().attach("the inspector's frames through a resize", { body: JSON.stringify(frames), contentType: "application/json" });
      expect(frames.length, "frames were read").toBeGreaterThan(10);
      expect(frames.filter((f) => f.blur === "none" || f.lens === "missing"), "never without its blur").toEqual([]);
      expect(frames.every((f) => (f.lens ?? f.blur) === LIQUID_BLUR), "always the panels' blur, bent or plain").toBe(true);
      expect(size, "the harness: the inspector changed size").not.toBe(before?.size);
      expect(frames.some((f) => f.lens === null), "plain while it changed size").toBe(true);
      await expect.poll(async () => (await readEl(inspector.at(page))).lens?.size, { message: "bent for its new size once settled" }).toBe(size);
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    await test.step("the query drawer sliding in keeps its blur and takes the bend once settled, at one size throughout", async () => {
      await page.getByRole("button", { name: "Add layer", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add layer" });
      await expect(dialog).toBeVisible();
      await dialog.getByText("OpenStreetMap", { exact: true }).first().click();
      await page.getByRole("button", { name: "Amenities", exact: true }).click();
      const selector = 'section[aria-label="Overpass query"]';
      const frames = await sampleFrames(page, selector, 1_200, () => page.getByRole("button", { name: "Edit query", exact: true }).click());
      await test.info().attach("the query drawer's frames as it slides in", { body: JSON.stringify(frames), contentType: "application/json" });
      expect(frames.length, "frames were read").toBeGreaterThan(10);
      expect(new Set(frames.map((f) => f.size)).size, "one size throughout").toBe(1);
      expect(frames.every((f) => (f.lens ?? f.blur) === LIQUID_BLUR), "always the menus' blur, bent or plain").toBe(true);
      expect(frames.slice(0, 5).every((f) => f.lens === null), "plain while it slides in").toBe(true);
      const drawer = page.locator(selector);
      const box = (await drawer.boundingBox())!;
      await expect.poll(async () => (await readEl(drawer)).lens?.size, { message: "bent once settled" }).toBe(`${Math.round(box.width)}x${Math.round(box.height)}`);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.keyboard.press("Escape");
    });
    expectQuiet(errors);
  } finally {
    await closeAll(people);
  }
});

test("@fallback where the bend is not drawn, a map button blurs and carries the rim light, the map soft and nothing bent", async ({ browser, request, baseURL, browserName }) => {
  test.skip(browserName === "chromium", "Chromium draws the bend; the case above holds it");
  const people: Person[] = [];
  try {
    const { person, page, errors } = await personIn(browser, request, baseURL!, "Fallback", "light");
    people.push(person);
    const fx = await seed(page, `${runTag()}_${browserName}`);
    await setLook(person.api, lookOf("liquid"));
    await openBuilder(page, fx.mapId);
    await expectRoot(page, "light", attrsOf("liquid"));
    await stripesIn(page);
    const button = page.getByRole("button", { name: "Zoom out", exact: true });
    await test.step(`in ${browserName}, the button computes Liquid's values with its own blur and no filter`, async () => {
      await page.waitForTimeout(1_000);
      const seen = await readEl(button);
      expect(problems(seen, liquidWant("overlay-control", "light"))).toEqual([]);
      expect(seen.lens, "no filter bends it").toBeNull();
      expect(seen.blur).toBe(LIQUID_BLUR);
      // Where the bend is not drawn the lens writes nothing at all: no role blur, plain or bent, and no ink of its own.
      expect.soft(seen.inline, "the button carries nothing inline").toEqual({});
      expect(sameColour(colour(seen.color), stepped("light")), `the button's ink ${seen.color}`).toBe(true);
      expect.soft((await traces(page)).inline, "nothing held inline anywhere on the page").toEqual([]);
      expect(await page.locator("[data-panel-lens], filter[id^='dz-lens']").count(), "no filter on the page").toBe(0);
      for (const m of [headerCard, inspector, legend]) await expectMember(page, m, "light", LIQUID, browserName);
    });
    await test.step(`in ${browserName}, the map under the button is soft, and sharp beside it`, async () => {
      if (await drawsBackdropBlur(page)) await softUnder(page, "the Zoom out button", button, liquidFill("light")[3]);
      else {
        // The control shows the screenshots cannot see any backdrop blur here, so the softness is not measured.
        test.info().annotations.push({ type: "unverified", description: `${browserName}'s screenshots show no backdrop blur, not even a plain one: the map's softness under the button is not measured` });
        await expect(button).toHaveCSS("backdrop-filter", LIQUID_BLUR);
      }
      expect.soft((await traces(page)).inline, "nothing held inline after the map has moved").toEqual([]);
    });
    expectQuiet(errors);
  } finally {
    await closeAll(people);
  }
});

// ---- the computer's requests, and what no look touches ----

for (const theme of THEMES) {
  test(`less transparency and more contrast make every translucent fill opaque under each look; the rail opened, the veil, the wash, an entry screen and the status and data colours stay (${theme})`, async ({ browser, request, baseURL, browserName }) => {
    test.skip(browserName !== "chromium", "the requests are emulated through Chromium's devtools protocol");
    test.setTimeout(420_000);
    const people: Person[] = [];
    try {
      const { person, page, errors } = await personIn(browser, request, baseURL!, "Request", theme);
      people.push(person);
      const fx = await seed(page, `${runTag()}_${theme}_request`, { widget: true });
      const cdp = await page.context().newCDPSession(page);
      const request_ = async (feature: string | null) => {
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-reduced-transparency", value: feature === "prefers-reduced-transparency" ? "reduce" : "no-preference" },
            { name: "prefers-contrast", value: feature === "prefers-contrast" ? "more" : "no-preference" },
          ],
        });
      };
      const untouched: Record<string, Record<string, string>> = {};
      const looks: [string, Under][] = [["Glass", GLASS], ["Liquid", LIQUID], ["Paper", PAPER]];
      const REQUESTS = ["prefers-reduced-transparency", "prefers-contrast"];
      for (const [name, under] of looks) {
        await test.step(`${name}: the fills go opaque on each request, a block's and the widget card's among them, the light and the shadow stay (${theme})`, async () => {
          const atRest = [headerCard, inspector, legend, zoomIn, layerCard, widgetCard];
          await setLook(person.api, lookOf(under.panels));
          await openBuilder(page, fx.mapId);
          await expectRoot(page, theme, attrsOf(under.panels));
          await expect(widgetCard.at(page)).toBeVisible({ timeout: 30_000 });
          for (const feature of REQUESTS) {
            await request_(feature);
            for (const m of atRest) await expectMember(page, m, theme, { ...under, opaque: true }, `${name} under ${feature}`);
          }
          await request_(null);
          for (const m of atRest) await expectMember(page, m, theme, under, `${name}, no request`);
          await inspectorTab(page, "Legend");
          for (const feature of REQUESTS) {
            await request_(feature);
            await expectMember(page, legendEntry, theme, { ...under, opaque: true }, `${name} under ${feature}`);
          }
          await request_(null);
          await expectMember(page, legendEntry, theme, under, `${name}, no request`);
          await inspectorTab(page, "Layers");
        });
        await test.step(`${name}: the veil, the rail opened by pointer and by key, the wash, an entry screen, the status and data colours (${theme})`, async () => {
          const seen: Record<string, string> = {};
          await openExportCard(page);
          const veil = await readEl(page.getByRole("dialog", { name: "Export image" }).locator("xpath=.."));
          expect(problems(veil, { fill: thin(TONES[theme].ink, 0.32), blur: "blur(4px)", edge: null, shadows: [] }), "the veil").toEqual([]);
          seen.veil = JSON.stringify([veil.fill, veil.blur]);
          await closeExportCard(page);
          const swatches = await page.locator("xpath=//*[@data-map-legend][not(ancestor::*[@data-look-default])]").first()
            .locator("li span:first-child").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
          seen.data = JSON.stringify(swatches);
          seen.status = JSON.stringify(await page.evaluate(() => ["--health-ok", "--warn", "--danger"].map((t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim())));
          await openMaps(page);
          const railNav = rail(page);
          const box = (await railNav.boundingBox())!;
          const railWant: Want = {
            fill: TONES[theme].panel, blur: "blur(18px)", edge: null,
            shadows: [step("lift", theme), layer(16, 0, 36, -18, TONES[theme].shadow)],
          };
          await page.mouse.move(box.x + 18, box.y + box.height / 2);
          await expect(railNav).toHaveAttribute("data-expanded", /.*/);
          await settle.poll(async () => problems(await readEl(railNav), railWant), { message: `${name}: the rail opened by pointer`, timeout: 8_000 }).toEqual([]);
          await page.mouse.move(box.x + 600, box.y + box.height / 2);
          await expect(railNav).not.toHaveAttribute("data-expanded", /.*/);
          await page.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="Product navigation"]')!;
            const focusable = Array.from(document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'))
              .filter((el) => el.getClientRects().length > 0);
            focusable[focusable.findIndex((el) => nav.contains(el)) - 1]?.focus();
          });
          await page.keyboard.press("Tab");
          await settle.poll(async () => problems(await readEl(railNav), railWant), { message: `${name}: the rail opened by key`, timeout: 8_000 }).toEqual([]);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await visit(page, "/connections/new");
          const wash = await readEl(page.getByLabel(/Paste a connection URL/).locator("xpath=../.."));
          expect(sameColour(colour(wash.fill), thin(TONES[theme].raised, 0.7)), `${name}: the wash ${wash.fill}`).toBe(true);
          seen.wash = wash.fill;
          await page.goto("/accept");
          const entry = page.locator("main").first();
          await expect(entry).toBeVisible();
          expect(await rootLook(page), `${name}: an entry screen carries no look`).toEqual({});
          const entryCard = await page.locator("main form, main section").first().evaluate((el) => {
            const cs = getComputedStyle(el.closest("[class]") ?? el);
            return [cs.backgroundColor, cs.getPropertyValue("backdrop-filter"), cs.boxShadow, cs.borderTopColor].join(" | ");
          });
          seen.entry = entryCard;
          for (const [what, value] of Object.entries(seen)) {
            untouched[what] ??= {};
            untouched[what][name] = value;
          }
        });
      }
      await test.step(`what no look touches computes the same under Glass, Liquid and Paper (${theme})`, async () => {
        await test.info().attach(`what no look touches (${theme})`, { body: JSON.stringify(untouched, null, 2), contentType: "application/json" });
        console.log(`[untouched] ${theme}: ${JSON.stringify(Object.fromEntries(Object.entries(untouched).map(([what, byLook]) => [what, byLook.Glass])))}`);
        expect(Object.keys(untouched).sort()).toEqual(["data", "entry", "status", "veil", "wash"]);
        for (const [what, byLook] of Object.entries(untouched)) {
          expect(new Set(Object.values(byLook)).size, `${what}: ${JSON.stringify(byLook)}`).toBe(1);
        }
      });
      expectQuiet(errors);
    } finally {
      await closeAll(people);
    }
  });
}

// ---- the export card's preview and a published page ----

for (const [name, under] of [["Liquid", LIQUID], ["Paper", PAPER]] as const) {
  test(`under ${name} the export card's preview keeps the default look with no lens inside it, and a published page carries no look`, async ({ browser, request, baseURL }) => {
    const people: Person[] = [];
    try {
      const { person, page, errors } = await personIn(browser, request, baseURL!, "Exporter", "light");
      people.push(person);
      const fx = await seed(page, `${runTag()}_export`);
      await setLook(person.api, lookOf(under.panels));

      await test.step(`${name}: the card takes the look, the preview inside it the default`, async () => {
        await openBuilder(page, fx.mapId);
        await openExportCard(page);
        const frame = page.locator("[data-export-card] [data-export-composition]");
        const inside = frame.locator("[data-look-default] [data-map-legend]").filter({ visible: true }).first();
        if (SEED === "preview-lens") await inside.evaluate((el) => (el as HTMLElement).style.setProperty("--surface-overlay-panel-blur", 'url("#dz-lens-seeded")'));
        await expectMember(page, exportDialog, "light", under, name);
        const menu = roleWant("menu", "light", under);
        await settle.poll(async () => {
          const seen = await readEl(frame);
          return problems(seen, { ...menu, fill: colour(seen.fill)!, edge: null });
        }, { message: `${name}: the preview's frame takes the menus' blur and shadow` }).toEqual([]);
        await expectMember(page, { role: "overlay-panel", what: "the legend inside the preview", at: () => inside }, "light", GLASS, `${name}, the preview`);
        const lensed = await frame.locator("[data-look-default]").first().evaluate((scope) =>
          [scope, ...Array.from(scope.querySelectorAll<HTMLElement>("*"))].flatMap((el) => {
            const out: string[] = [];
            const style = (el as HTMLElement).style;
            for (let i = 0; i < style.length; i += 1) if (/^--(surface|fg)-/.test(style.item(i))) out.push(`${el.tagName.toLowerCase()} ${style.item(i)}`);
            if (/url\(/.test(getComputedStyle(el).getPropertyValue("backdrop-filter"))) out.push(`${el.tagName.toLowerCase()} draws through a filter`);
            return out;
          }));
        expect(lensed, `${name}: nothing inside the preview is lensed`).toEqual([]);
        await closeExportCard(page);
      });

      const token = await publishMap(page, fx.mapId);
      for (const mode of THEMES) {
        await test.step(`${name}: a published page opened by its author, in its ${mode} mode`, async () => {
          await page.goto(`/v/${token}`);
          await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
          await expect(page.locator("[data-map-legend]").first()).toBeVisible({ timeout: 30_000 });
          const view = page.locator("[data-published-view]");
          if ((await view.getAttribute("data-view-theme")) !== mode) await page.getByRole("button", { name: `Switch to ${mode} theme`, exact: true }).click();
          await expect(view).toHaveAttribute("data-view-theme", mode);
          await page.waitForTimeout(1_000);
          expect(await rootLook(page), "a published page's root carries no look").toEqual({});
          expect(await traces(page), "no lens, filter or inline property").toEqual(NO_TRACE);
          for (const m of [
            { role: "overlay-panel", what: "the title bar", at: (p: Page) => p.getByRole("heading", { level: 1, name: fx.mapName }).locator("xpath=..") },
            { role: "overlay-panel", what: "the legend", at: (p: Page) => p.locator("[data-map-legend]").filter({ visible: true }).first() },
            zoomIn,
          ] as Member[]) await expectMember(page, m, mode, GLASS, `a published page (${mode})`);
        });
      }
      expectQuiet(errors);
    } finally {
      await closeAll(people);
    }
  });
}

// ---- the first frame ----

/** The member read at the first frame on Maps: the header card. */
const FIRST_FRAME_MEMBERS = { header: 'header [class*="headCard"]' };

test("a fresh browser signed in with Liquid paints Liquid from its first frame, and bends within the first second", async ({ browser, request, baseURL, browserName }) => {
  const people: Person[] = [];
  try {
    const person = await invitePerson(browser, request, baseURL!, "First", runTag());
    people.push(person);
    await routeHouse(person.context, { basemapStyleStub: true });
    await setLook(person.api, lookOf("liquid"));
    const page = await person.context.newPage();
    const errors = trackConsole(page);
    expect(await person.context.storageState().then((state) => state.origins.length), "the context has never loaded a page").toBe(0);
    await installFrameRecorder(page, FIRST_FRAME_MEMBERS);
    await page.addInitScript(() => {
      const w = window as { __bentAt?: number };
      new MutationObserver(() => {
        if (w.__bentAt !== undefined) return;
        if (document.querySelector('[style*="url(\\"#dz-lens"], [style*="url(#dz-lens"]')) w.__bentAt = performance.now();
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ["style"], childList: true });
    });
    if (SEED === "late-look") {
      await page.route((url) => url.pathname === "/maps", async (route) => {
        if (route.request().resourceType() !== "document") return route.continue();
        const response = await route.fetch();
        const headers = { ...response.headers() };
        delete headers["content-length"];
        await route.fulfill({ response, headers, body: delayLook(await response.text(), attrsOf("liquid")) });
      });
    }
    let held = "";
    if (SEED === "late-sheets") {
      await page.route("**/*.css", async (route) => {
        const response = await route.fetch();
        const text = await response.text();
        // A rule keyed on Liquid's root, its value quoted or bare as the build writes it.
        const keyed = /\[data-look-panels=(["']?)liquid\1\]/g;
        if (!keyed.test(text)) return route.fulfill({ response });
        held += text;
        await route.fulfill({ response, body: text.replace(keyed, "[data-look-held=$1liquid$1]") });
      });
    }
    await page.goto("/maps");
    if (SEED === "late-sheets") {
      await frameEvidence(page, Object.keys(FIRST_FRAME_MEMBERS));
      expect(held, "the harness: the Liquid rules were held back").not.toBe("");
      await page.addStyleTag({ content: held });
    }
    const evidence = await frameEvidence(page, Object.keys(FIRST_FRAME_MEMBERS));
    console.log(describeEvidence("Liquid, /maps", evidence));

    await test.step("the root and the header card carry Liquid at the first painted frame", async () => {
      expect.soft(frameProblems(evidence, attrsOf("liquid")), "the root at its creation and its first frame").toEqual([]);
      const header = evidence.members?.header ?? null;
      expect(header, "the header card was read in the first frame it was on the page").not.toBeNull();
      console.log(`[first-frame] the header card was first on the page at frame ${header!.frame}, ${header!.t.toFixed(1)} ms, paints before: ${header!.paintsBefore.length}`);
      const seen: Seen = { fill: header!.fill, blur: header!.blur, edgeStyle: "none", edgeWidth: "0px", edgeColor: "", shadow: header!.shadow, transform: "", color: "", lens: null, inline: {} };
      expect(problems(seen, liquidWant("glass-chrome", "light")), "the header card at the first frame: Liquid's fill, blur and light, no frame of Glass").toEqual([]);
    });

    await test.step("the bend arrives within the first second", async () => {
      test.skip(browserName !== "chromium", "the bend is drawn in Chromium");
      await expect.poll(() => page.evaluate(() => (window as { __bentAt?: number }).__bentAt ?? null), { message: "a surface is bent", timeout: 5_000 }).not.toBeNull();
      const at = await page.evaluate(() => (window as { __bentAt?: number }).__bentAt!);
      console.log(`[first-frame] the first surface bent at ${at.toFixed(0)} ms`);
      expect(at, "the first bend, in ms from the navigation").toBeLessThanOrEqual(1_000);
    });
    expectQuiet(errors);
  } finally {
    await closeAll(people);
  }
});
