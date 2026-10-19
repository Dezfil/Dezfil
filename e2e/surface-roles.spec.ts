// The surface roles, read off the running page: every card and panel takes
// one of eleven roles, and each role holds its fill, blur, edge, corner and
// shadow in one place. This journey reads what the browser computes for a
// member of every role on the screens a person meets (the builder and its
// full screen, a published page, Maps, Data, Projects, Settings, the SQL
// page, a workflow, Connections and Home), in both themes, and compares it
// with the role's values written out below as literals. The page's own
// tokens are never the expected side: a comparison whose two sides come
// from one declaration cannot fail.
//
// What it holds:
//
// - Each member computes its role's values, light and dark, the panes the
//   Tools drawer and the Assistant open docked and overlaying, the
//   Settings cards and column as page cards, the map's buttons as glass in
//   the builder, in full screen and on a published page.
// - The blocks inside the builder's panels (a legend entry in the Legend
//   tab, a widget's row, a basemap's card, a tool's picker and result) lie
//   on the raised or the panel tone with the hairline and no shadow, and
//   the widget card over the map is the panel tone with the hairline, no
//   blur and no shadow.
// - Every glass and overlay surface computes its blur, never none; the five
//   surfaces the workflow page's own blur check names are among them.
// - The blur is drawn, not only computed: a hard edge of a drawn layer goes
//   soft under the legend and under a map button inside the map card, and
//   stays sharp in the same pixel row beside them.
// - What stays deliberate: the rail opened over the page is solid on the
//   lift with its one side layer, a menu and a dialog open solid, the
//   note's colour bar is glass, the veil behind a dialog is as it was.
// - A published page in its dark mode draws on the dark tones.
// - A role restated on the root (the way a look will restate it) moves
//   every member of that role on the screen and nothing else, and the
//   legend inside the export card's preview, in the image's default scope,
//   does not follow; a step restated on the root reaches the members of
//   every role that reads it, through the role.
//
// A role with no member on a screen is said so in the test's annotations,
// never passed over: every screen accounts for all eleven roles.
//
// Seeds, each switched by DEZFIL_SURFACE_ROLES_SEED and each expected to
// turn named steps red (unset it for green):
//
//   typed-shadow   the builder's legend types a shadow of its own by hand:
//                  every step that reads it fails, on the builder, behind
//                  the export dialog's veil and in full screen.
//   typed-member   the legend types the overlay panel's values by hand, and
//                  the theme button the float step's: every step that
//                  restates a role or a step on the root fails, while the
//                  values steps stay green.
//   scope-forgets  the image's default scope stops restating the overlay
//                  panel: the export card's preview legend follows the
//                  root, and the dialog's restatement step fails.
//   light-tones    a published page's dark root stops restating the steps
//                  and the glass fill: the dark published page's title bar,
//                  legend and Zoom in button resolve against the light tones
//                  and fail.
//
// The pixel case reads the map card on the build it runs against; on a
// build where the map card's entrance keeps the card on its own compositing
// layer it fails (see the case).
//
// Environment: the documented gate (isolated server, fresh data dir).
// Run with DEZFIL_BASE_URL at the server.
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { isAllowedConsoleError } from "./console-allowlist";
import { readThenWriteBrowserSetup } from "./edit-basis";
import { rootLook } from "./look-evidence";
import { colour, fmt, layers, maxStep, paintersAcross, range, rowLuma, sameColour, STRIPES_STYLE, stripesGeoJson, type Layer, type RGBA } from "./surface-reads";
import {
  FIXTURES_DIR,
  addLayer,
  patchLayer,
  patchMap,
  publishMap,
  routeHouse,
  seedCsv,
  seedFile,
  trackConsole,
} from "./support";

// ---- the expected values, written out ----

type Theme = "light" | "dark";
type Step = "hairline" | "float" | "overlay" | "lift" | "deep" | "dialog";
type Role =
  | "glass-chrome" | "glass-panel" | "overlay-panel" | "overlay-control" | "map-card"
  | "page-card" | "inner-card" | "block" | "menu" | "dialog" | "stage";
/** A role, or one of the surfaces that stay their own by name. */
type Kind = Role | "veil" | "rail-opened" | "credit";

const ROLES: Role[] = [
  "glass-chrome", "glass-panel", "overlay-panel", "overlay-control", "map-card",
  "page-card", "inner-card", "block", "menu", "dialog", "stage",
];

/** Each theme's tones, as the shipped light and night palettes state them:
 * the panel, the raised step, the page's ground, the ink, the hairline
 * border and the shadow tone. The roles hold no tone of their own; the
 * theme supplies it. */
const TONES: Record<Theme, { panel: number[]; raised: number[]; ground: number[]; ink: number[]; border: number[]; shadow: RGBA }> = {
  light: { panel: [255, 255, 255], raised: [246, 248, 245], ground: [237, 241, 236], ink: [36, 50, 48], border: [226, 231, 225], shadow: [36, 50, 48, 0.16] },
  dark: { panel: [16, 20, 29], raised: [21, 27, 39], ground: [11, 14, 20], ink: [233, 236, 243], border: [34, 42, 59], shadow: [0, 0, 0, 0.4] },
};

/** The six shadow steps: y offset, blur, and the share of the shadow tone
 * (the hairline is 60 % of it). No step has an x offset or a spread. */
const STEPS: Record<Step, [y: number, blur: number, share: number]> = {
  hairline: [1, 4, 0.6],
  float: [3, 12, 1],
  overlay: [8, 26, 1],
  lift: [10, 30, 1],
  deep: [14, 40, 1],
  dialog: [30, 80, 1],
};

/** The roles' values after the move: how much of the tone the fill is
 * (0.93 the glass level, 1 solid, 0 no fill of its own) and which tone (the
 * panel's, or the raised step), the background blur, whether the edge is
 * the hairline (else none), the shadow step (or none), and the corner where
 * the role has one (else each member keeps its own). */
const ROLE_VALUES: Record<Role, { fill: number; tone?: "raised"; blur: string; edge: boolean; shadow: Step | null; corner?: string }> = {
  "glass-chrome": { fill: 0.93, blur: "blur(18px)", edge: false, shadow: "float" },
  "glass-panel": { fill: 0.93, blur: "blur(18px)", edge: false, shadow: "float", corner: "20px" },
  "overlay-panel": { fill: 0.93, blur: "blur(8px)", edge: false, shadow: "overlay" },
  "overlay-control": { fill: 0.93, blur: "blur(8px)", edge: false, shadow: "float" },
  "map-card": { fill: 1, blur: "none", edge: true, shadow: null },
  "page-card": { fill: 1, blur: "none", edge: true, shadow: "float", corner: "20px" },
  "inner-card": { fill: 1, blur: "none", edge: true, shadow: "hairline" },
  // A block on the panel tone says so (see `panelTone`).
  block: { fill: 1, tone: "raised", blur: "none", edge: true, shadow: null },
  menu: { fill: 1, blur: "none", edge: true, shadow: "lift" },
  dialog: { fill: 1, blur: "none", edge: true, shadow: "dialog", corner: "20px" },
  stage: { fill: 0, blur: "none", edge: false, shadow: "deep", corner: "20px" },
};

/** The veil behind a dialog: 32 % of the ink under a 4 px blur. The rail
 * opened over the page: solid, the lift and its one side layer. A
 * published page's credit chip: 55 % of the page's ground, the overlay
 * strength. */
const VEIL = { fill: 0.32, blur: "blur(4px)" };
const RAIL_SIDE = { x: 16, y: 0, blur: 36, spread: -18 };
const CREDIT = { fill: 0.55, blur: "blur(8px)" };

/** The corners of the default look, for members that keep their own. */
const CORNER = { control: "12px", rail: "18px", stage: "13px", legend: "16px", lg: "14px", pill: "999px", base: "9px", sm: "4px", card: "20px" };

/** One role's values restated on the root, as a look would restate them,
 * and what its members must then compute. */
interface Restatement { name: string; vars: Record<string, string>; roles: Role[]; follows: Want }
const MARK: RGBA = [200, 30, 120, 1];
const ROLE_RESTATED: Restatement = {
  name: "the overlay panel's values",
  vars: {
    "--surface-overlay-panel-fill": "color-mix(in srgb, rgb(200, 30, 120) 80%, transparent)",
    "--surface-overlay-panel-blur": "blur(5px)",
    "--surface-overlay-panel-shadow": "0 5px 9px rgb(200, 30, 120)",
  },
  roles: ["overlay-panel"],
  follows: { fill: [200, 30, 120, 0.8], blur: "blur(5px)", shadows: [{ x: 0, y: 5, blur: 9, spread: 0, inset: false, colour: MARK }] },
};
/** The float step restated: it reaches every role that reads it, through
 * the role's own token. */
const STEP_RESTATED: Restatement = {
  name: "the float step",
  vars: { "--shadow-float": "0 4px 10px rgb(200, 30, 120)" },
  roles: ["glass-chrome", "glass-panel", "overlay-control", "page-card"],
  follows: { shadows: [{ x: 0, y: 4, blur: 10, spread: 0, inset: false, colour: MARK }] },
};

// ---- the seeds ----

const SEED = process.env.DEZFIL_SURFACE_ROLES_SEED ?? "";
const typed = (theme: Theme) => {
  const t = TONES[theme];
  const shadow = `rgba(${t.shadow.join(", ")})`;
  const root = theme === "dark" ? ':root[data-theme="dark"]' : ':root:not([data-theme="dark"])';
  return `${root} [data-map-legend]:not([data-look-default] [data-map-legend]) {
    background-color: color-mix(in srgb, rgb(${t.panel.join(", ")}) 93%, transparent) !important;
    backdrop-filter: blur(8px) !important;
    box-shadow: 0 8px 26px ${shadow} !important;
  }
  ${root} [aria-label="Switch between dark and light theme"] { box-shadow: 0 3px 12px ${shadow} !important; }`;
};
const SEEDS: Record<string, { workspace?: string; published?: string }> = {
  "": {},
  "typed-shadow": { workspace: "[data-map-legend]:not([data-look-default] [data-map-legend]) { box-shadow: 0 4px 14px var(--shadow) !important; }" },
  "typed-member": { workspace: `${typed("light")}\n${typed("dark")}` },
  "scope-forgets": {
    workspace: "[data-look-default] { --surface-overlay-panel-fill: inherit !important; --surface-overlay-panel-blur: inherit !important; --surface-overlay-panel-shadow: inherit !important; }",
  },
  "light-tones": { published: '[data-view-theme="dark"] { --fill-glass: inherit !important; --shadow-overlay: inherit !important; --shadow-float: inherit !important; }' },
};
if (!(SEED in SEEDS)) throw new Error(`DEZFIL_SURFACE_ROLES_SEED=${SEED} names no seed; known: ${Object.keys(SEEDS).filter(Boolean).join(", ")}`);

/** Open a page and lay the seed's style over it, if one is switched on. */
async function visit(page: Page, url: string, where: "workspace" | "published" = "workspace"): Promise<void> {
  await page.goto(url);
  await reseed(page, where);
}
async function reseed(page: Page, where: "workspace" | "published" = "workspace"): Promise<void> {
  const css = SEEDS[SEED][where];
  if (css) await page.addStyleTag({ content: css });
}

// ---- reading the page ----

interface Want { fill?: RGBA; solid?: true; blur?: string; edge?: { width: string; colour: RGBA } | null; corner?: string; shadows?: Layer[] }
interface Seen { fill: string; blur: string; edgeStyle: string; edgeWidth: string; edgeColor: string; corner: string; shadow: string }

/** A drop shadow is a layer with an offset; rings and inset lines are not. */
const drops = (all: Layer[]) => all.filter((l) => !l.inset && (l.x !== 0 || l.y !== 0));
const fmtLayer = (l: Layer) => `${l.x}px ${l.y}px ${l.blur}px ${l.spread}px ${fmt(l.colour)}`;

const stepLayer = (step: Step, theme: Theme): Layer => {
  const [y, blur, share] = STEPS[step];
  const [r, g, b, a] = TONES[theme].shadow;
  return { x: 0, y, blur, spread: 0, inset: false, colour: [r, g, b, a * share] };
};

/** Every way the computed values differ from the wanted ones, one line each. */
function problems(seen: Seen, want: Want): string[] {
  const out: string[] = [];
  if (want.fill && !sameColour(colour(seen.fill), want.fill)) out.push(`fill ${seen.fill}, want ${fmt(want.fill)}`);
  if (want.solid && (colour(seen.fill)?.[3] ?? 0) < 0.995) out.push(`fill ${seen.fill}, want a solid fill`);
  if (want.blur !== undefined && seen.blur !== want.blur) out.push(`blur ${seen.blur}, want ${want.blur}`);
  if (want.edge === null && seen.edgeStyle !== "none") out.push(`edge ${seen.edgeWidth} ${seen.edgeStyle} ${seen.edgeColor}, want none`);
  if (want.edge && (seen.edgeStyle !== "solid" || seen.edgeWidth !== want.edge.width || !sameColour(colour(seen.edgeColor), want.edge.colour))) {
    out.push(`edge ${seen.edgeWidth} ${seen.edgeStyle} ${seen.edgeColor}, want ${want.edge.width} solid ${fmt(want.edge.colour)}`);
  }
  if (want.corner !== undefined && seen.corner !== want.corner) out.push(`corner ${seen.corner}, want ${want.corner}`);
  if (want.shadows) {
    const got = drops(layers(seen.shadow));
    const same = got.length === want.shadows.length && got.every((l, i) => {
      const w = want.shadows![i];
      return l.x === w.x && l.y === w.y && l.blur === w.blur && l.spread === w.spread && w.colour !== null && sameColour(l.colour, w.colour);
    });
    if (!same) out.push(`shadow ${seen.shadow}, want ${want.shadows.map(fmtLayer).join(", ") || "none"}`);
  }
  return out;
}

const read = (loc: Locator): Promise<Seen> =>
  loc.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      fill: cs.backgroundColor,
      blur: cs.getPropertyValue("backdrop-filter"),
      edgeStyle: cs.borderTopStyle,
      edgeWidth: cs.borderTopWidth,
      edgeColor: cs.borderTopColor,
      corner: cs.borderTopLeftRadius,
      shadow: cs.boxShadow,
    };
  });

// ---- the members ----

type Part = "fill" | "blur" | "edge" | "corner" | "shadow";
interface Member {
  kind: Kind;
  /** What it is to a person. */
  what: string;
  at: (page: Page) => Locator;
  /** The member's own corner under the default look, where its role has none. */
  corner?: string;
  /** Parts the member keeps as its own (a node tile's group tint and edge,
   * the framed canvas's ground and strong edge): not compared, except that
   * a fill kept on a solid role must still be solid. */
  own?: Part[];
  /** Inside an image's default scope: never follows a look. */
  image?: true;
  /** A block drawn on the panel tone where its role's ground is the raised step. */
  panelTone?: true;
}

/** What a member must compute: its role's values in the theme, a
 * restatement's values where it reaches the member, its own parts left out. */
function want(m: Member, theme: Theme, restated?: Restatement): Want {
  const t = TONES[theme];
  let w: Want;
  if (m.kind === "veil") w = { fill: [...t.ink, VEIL.fill] as RGBA, blur: VEIL.blur, edge: null, shadows: [] };
  else if (m.kind === "rail-opened") {
    w = { fill: [...t.panel, 1] as RGBA, edge: null, corner: CORNER.rail, shadows: [stepLayer("lift", theme), { ...RAIL_SIDE, inset: false, colour: t.shadow }] };
  } else if (m.kind === "credit") w = { fill: [...t.ground, CREDIT.fill] as RGBA, blur: CREDIT.blur };
  else {
    const r = ROLE_VALUES[m.kind];
    const tone = r.tone === "raised" && !m.panelTone ? t.raised : t.panel;
    w = {
      fill: r.fill === 0 ? [0, 0, 0, 0] : ([...tone, r.fill] as RGBA),
      blur: r.blur,
      edge: r.edge ? { width: "1px", colour: [...t.border, 1] as RGBA } : null,
      corner: m.corner ?? r.corner,
      shadows: r.shadow ? [stepLayer(r.shadow, theme)] : [],
    };
    if (restated && !m.image && restated.roles.includes(m.kind)) w = { ...w, ...restated.follows };
  }
  for (const part of m.own ?? []) {
    if (part === "fill" && w.fill?.[3] === 1) w.solid = true;
    if (part === "shadow") delete w.shadows;
    else delete w[part];
  }
  return w;
}

/** Soft, and polled: a surface that eases its shadow or its fill reads
 * mid-transition for a beat after a state change, and on a loaded machine
 * one read of a busy page can itself take seconds. */
const settle = expect.configure({ soft: true });

/** A member against its role's values; `state` replaces what a state of
 * the member (a hover) sets in place of the role's resting values. */
async function expectMember(m: Member, page: Page, theme: Theme, where: string, restated?: Restatement, state?: Want): Promise<void> {
  const loc = m.at(page);
  await expect.soft(loc, `${where}: ${m.what} is on screen`).toBeVisible();
  if (!(await loc.isVisible())) return;
  const w = { ...want(m, theme, restated), ...state };
  await settle
    .poll(async () => problems(await read(loc), w), { message: `${where}: ${m.what} (${m.kind})`, timeout: 8_000 })
    .toEqual([]);
}

async function restate(page: Page, vars: Record<string, string>): Promise<void> {
  await page.evaluate((v) => {
    for (const [name, value] of Object.entries(v)) document.documentElement.style.setProperty(name, value);
  }, vars);
  // The harness, not the product: the root must carry what was written.
  const carried = await page.evaluate((names) => names.map((n) => document.documentElement.style.getPropertyValue(n).trim()), Object.keys(vars));
  expect(carried, "the root carries the restatement").toEqual(Object.values(vars).map((v) => v.trim()));
}
async function unstate(page: Page, vars: Record<string, string>): Promise<void> {
  await page.evaluate((names) => {
    for (const name of names) document.documentElement.style.removeProperty(name);
  }, Object.keys(vars));
}

function annotate(text: string): void {
  test.info().annotations.push({ type: "surface roles", description: text });
}

/** One screen: every member against its role's values; then each
 * restatement on the root, its followers moved and every other member as
 * it was. Every role is either on the screen or named absent with why. */
async function readScreen(page: Page, theme: Theme, name: string, members: Member[], absent: Partial<Record<Role, string>>, restatements = [ROLE_RESTATED, STEP_RESTATED]): Promise<void> {
  const present = new Set(members.map((m) => m.kind));
  const unaccounted = ROLES.filter((r) => !present.has(r) && !absent[r]);
  expect(unaccounted, `${name}: every role is on the screen or named absent`).toEqual([]);
  for (const [role, why] of Object.entries(absent)) annotate(`${name} (${theme}): no ${role} member here: ${why}`);
  await test.step(`${name}: each surface computes its role's values (${theme})`, async () => {
    for (const m of members) await expectMember(m, page, theme, name);
  });
  for (const r of restatements) {
    await test.step(`${name}: ${r.name} restated on the root moves its members and nothing else (${theme})`, async () => {
      const followers = members.filter((m) => !m.image && (r.roles as Kind[]).includes(m.kind));
      if (followers.length === 0) annotate(`${name} (${theme}): ${r.name} restated reaches no member here (no ${r.roles.join(", ")} on this screen); every other member held`);
      await restate(page, r.vars);
      try {
        for (const m of members) await expectMember(m, page, theme, `${name}, ${r.name} restated`, r);
      } finally {
        await unstate(page, r.vars);
      }
    });
  }
}

// ---- the members, by where they are found ----

const headerCard: Member = {
  kind: "glass-chrome", what: "the header card", corner: CORNER.control,
  at: (p) => p.locator("header").getByRole("link", { name: "Dezfil", exact: true }).locator("xpath=.."),
};
const themeButton: Member = {
  kind: "glass-chrome", what: "the theme button", corner: CORNER.control,
  at: (p) => p.getByRole("button", { name: "Switch between dark and light theme" }),
};
const railAtRest: Member = {
  kind: "glass-chrome", what: "the side rail at rest", corner: CORNER.rail,
  at: (p) => p.getByRole("navigation", { name: "Product navigation" }),
};
const exportButton: Member = {
  kind: "glass-chrome", what: "the header's Export button", corner: CORNER.control,
  at: (p) => p.locator("#header-actions-right").getByRole("button", { name: "Export", exact: true }),
};
const inspector: Member = { kind: "glass-panel", what: "the builder's inspector", at: (p) => p.locator("[data-builder-pane]") };
const legend: Member = {
  kind: "overlay-panel", what: "the legend", corner: CORNER.legend,
  // The workspace's own legend, never the one inside an image's scope.
  at: (p) => p.locator("xpath=//*[@data-map-legend][not(ancestor::*[@data-look-default])]").filter({ visible: true }).first(),
};
const statusPill: Member = { kind: "overlay-panel", what: "the status pill", corner: CORNER.pill, at: (p) => p.locator("[data-status-bar]") };
const zoomIn: Member = {
  kind: "overlay-control", what: "the map's Zoom in button", corner: CORNER.stage,
  at: (p) => p.getByRole("button", { name: "Zoom in", exact: true }).first(),
};
const fullscreenButton = (pressed: boolean): Member => ({
  kind: "overlay-control", what: "the map's full screen button", corner: CORNER.stage,
  at: (p) => p.getByRole("button", { name: pressed ? "Exit fullscreen map" : "Fullscreen map", exact: true }),
});
/** The map card: the frame the stage's overlays sit in, the drag canvas's
 * parent. */
const mapCard = (corner: string): Member => ({
  kind: "stage", what: "the map card", corner,
  at: (p) => p.locator("[data-drag-canvas]").first().locator("xpath=.."),
});
const layerCard: Member = {
  kind: "inner-card", what: "a layer card, not selected", corner: CORNER.lg,
  at: (p) => p.locator('[data-layer-list] li[data-selected="false"]').first(),
};
const widgetCard: Member = {
  kind: "map-card", what: "the widget card over the map", corner: CORNER.legend,
  at: (p) => p.locator("[data-widget-rail] [data-widget-card]").first(),
};

/** Open one of the inspector's tabs, the pointer off every card after. */
async function inspectorTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tablist", { name: "Builder panels" }).getByRole("tab", { name, exact: true }).click();
  await page.mouse.move(5, 5);
}

/** The blocks inside the builder's panels, each read where it stands: a
 * legend entry in the Legend tab, a widget's row in the Widgets tab, a
 * basemap's card not in use (the one in use takes the accent as its own),
 * and a tool's picker and result in the Tools drawer. The inspector is
 * left on its Layers tab with a layer selected. */
async function readBlocks(page: Page, theme: Theme, where: string): Promise<void> {
  await inspectorTab(page, "Legend");
  await expectMember({ kind: "block", what: "a legend entry in the Legend tab", corner: CORNER.base, at: (p) => p.locator("[data-builder-pane] [data-legend-row]").first() }, page, theme, where);
  await inspectorTab(page, "Widgets");
  await expectMember({
    kind: "block", what: "a widget's row in the Widgets tab", corner: CORNER.control, panelTone: true,
    at: (p) => p.locator("[data-builder-pane] [data-widget-row]:not([data-expanded])").first(),
  }, page, theme, where);
  await inspectorTab(page, "Basemap");
  await expectMember({
    kind: "block", what: "a basemap's card not in use", corner: CORNER.lg,
    at: (p) => p.locator('[data-builder-pane] button[class*="BasemapPanel-module"][class*="__card"][data-active="false"]').first(),
  }, page, theme, where);
  await inspectorTab(page, "Layers");
  if ((await page.locator('[data-layer-list] li[data-selected="true"]').count()) === 0) await page.locator("[data-layer-list] [data-layer-select]").first().click();
  const drawer = page.locator("[data-recipe-drawer]");
  if (!(await drawer.isVisible())) await page.locator("[data-tools-control]").click();
  await page.locator("[data-operation='buffer']").click();
  await expect(page.locator("[data-parameter-form]")).toBeVisible();
  await page.mouse.move(5, 5);
  await expectMember({ kind: "block", what: "a tool's result block", corner: CORNER.control, at: (p) => p.locator("[data-recipe-drawer] [data-result-section]") }, page, theme, where);
  // The input arrives filled from the selected layer; Change opens its picker.
  await page.locator("[data-recipe-drawer] [data-input-change]").first().click();
  await page.mouse.move(5, 5);
  await expectMember({
    kind: "block", what: "a tool's input picker", corner: CORNER.control,
    at: (p) => p.locator("[data-recipe-drawer] [data-parameter-form] input[type='search']").first().locator("xpath=.."),
  }, page, theme, where);
  await page.locator("[data-tools-control]").click();
  await expect(drawer).toBeHidden();
}

// ---- the fixtures ----

const runId = Date.now().toString(36);
const THEMES: Theme[] = ["light", "dark"];

interface Fixture { mapId: string; mapName: string; projectName: string; bands: string; points: string }

async function post(page: Page, url: string, body: unknown): Promise<Record<string, unknown>> {
  return page.evaluate(async ({ url, body }) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`);
    return (await r.json()) as Record<string, unknown>;
  }, { url, body });
}

/** A project holding a map with two layers (the stripes, styled by band,
 * and the stations), and the two datasets under them; with `widget`, a
 * histogram of the stations' riders over the map. */
async function seed(page: Page, tag: string, withPoints = true, widget = false): Promise<Fixture> {
  await page.goto("/maps");
  const bands = (await seedFile(page, `sr_${runId}_${tag}_bands.geojson`, stripesGeoJson(), "application/geo+json")).name;
  const points = withPoints
    ? (await seedCsv(page, `sr_${runId}_${tag}_pts`, readFileSync(path.join(FIXTURES_DIR, "stations.csv"), "utf8"))).name
    : "";
  const projectName = `Surface roles ${runId} ${tag}`;
  const projectId = (await post(page, "/api/projects", { name: projectName })).id as string;
  const mapName = `Surface roles map ${runId} ${tag}`;
  const mapId = (await post(page, "/api/maps", { name: mapName, projectId })).id as string;
  const bandsLayer = await addLayer(page, mapId, "bands", `SELECT * FROM "${bands}"`);
  await patchLayer(page, bandsLayer, { style: STRIPES_STYLE });
  if (withPoints) {
    const stations = await addLayer(page, mapId, "stations", `SELECT * FROM "${points}"`);
    if (widget) {
      await patchMap(page, mapId, {
        widgets: [{ id: "w-riders", type: "histogram", layerId: stations, title: "Riders", field: "riders", agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }],
      });
    }
  }
  return { mapId, mapName, projectName, bands, points };
}

async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((t) => {
    window.localStorage.setItem("dezfil-theme", t);
  }, theme);
}

/** The corners and steps above are the default look's: a look left on the
 * fixture account by another journey would move them. */
async function expectDefaultLook(page: Page, theme: Theme): Promise<void> {
  expect(await rootLook(page), "the fixture account keeps the default look").toEqual({});
  if (theme === "dark") await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
}

async function openBuilder(page: Page, mapId: string): Promise<void> {
  await visit(page, `/maps/${mapId}`);
  await expect(page.locator("[data-map-legend]").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-status-bar]")).toBeVisible();
}

function expectNoConsoleErrors(errors: ReturnType<typeof trackConsole>): void {
  const unexpected = errors.filter((e) => !isAllowedConsoleError(e.text, e.url));
  expect(unexpected, `console errors: ${JSON.stringify(unexpected)}`).toEqual([]);
}

// ---- the builder, its menus and dialog, and full screen ----

for (const theme of THEMES) {
  test(`the builder and its full screen: each surface computes its role, and a role or a step restated on the root moves only its members (${theme})`, async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context, { basemapStyleStub: true });
    await useTheme(page, theme);
    const fx = await seed(page, `${theme}_builder`, true, true);
    await openBuilder(page, fx.mapId);
    await expectDefaultLook(page, theme);
    await expect(widgetCard.at(page)).toBeVisible({ timeout: 30_000 });

    await readScreen(page, theme, "the builder", [
      headerCard, exportButton, themeButton, inspector, legend, statusPill, zoomIn, fullscreenButton(false), mapCard(CORNER.card), layerCard, widgetCard,
    ], {
      "page-card": "no card stands on the builder's page",
      block: "the blocks lie in the inspector's other tabs and the Tools drawer, read below",
      menu: "menus open from a trigger and are read below",
      dialog: "the export dialog is read below",
    });

    await test.step(`a menu opened from its trigger is solid, on the lift (${theme})`, async () => {
      const card = page.locator("[data-layer-list] li").filter({ has: page.locator("[data-layer-select]") }).first();
      await card.getByRole("button", { name: "Layer menu", exact: true }).click();
      await expectMember({ kind: "menu", what: "the layer menu", corner: CORNER.lg, at: (p) => p.getByRole("menu").filter({ visible: true }).first() }, page, theme, "the builder");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await exportButton.at(page).click();
      await expectMember({ kind: "menu", what: "the export menu", corner: CORNER.lg, at: (p) => p.getByRole("menu", { name: "Export" }) }, page, theme, "the builder");
      await page.getByRole("menuitem", { name: /Image/ }).first().click();
      await expect(page.getByRole("dialog", { name: "Export image" })).toBeVisible();
      await expect(page.locator("[data-export-card] [data-export-composition] [data-map-legend]").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    });

    // The dialog over its veil, the legend inside the card's preview (in the
    // image's default scope, which never takes a look), and the builder's
    // own legend and inspector behind the veil, which do.
    await readScreen(page, theme, "the export dialog", [
      { kind: "dialog", what: "the export dialog", at: (p) => p.getByRole("dialog", { name: "Export image" }) },
      { kind: "veil", what: "the veil behind the dialog", at: (p) => p.getByRole("dialog", { name: "Export image" }).locator("xpath=..") },
      {
        kind: "overlay-panel", what: "the legend in the export card's preview", corner: CORNER.legend, image: true,
        at: (p) => p.locator("[data-export-card] [data-export-composition] [data-map-legend]").filter({ visible: true }).first(),
      },
      { ...legend, what: "the builder's legend behind the veil" },
      { ...inspector, what: "the builder's inspector behind the veil" },
    ], {
      "glass-chrome": "the header is read on the builder above",
      "overlay-control": "the map's buttons are read on the builder above",
      "map-card": "the widget card is read on the builder above",
      "page-card": "no card stands on the builder's page",
      "inner-card": "the layer cards are read on the builder above",
      block: "the blocks are read on the builder below",
      menu: "read above, opened from its trigger",
      stage: "the map card is read on the builder above",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Export image" })).toHaveCount(0);

    await page.getByRole("button", { name: "Fullscreen map", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-map-full", /.*/);
    // In full screen the map card opens to the screen's edges, its corner
    // squared as before; its shadow stays the stage's.
    await readScreen(page, theme, "the builder in full screen", [
      headerCard, exportButton, inspector, legend, statusPill, zoomIn, fullscreenButton(true), mapCard("0px"), layerCard, widgetCard,
    ], {
      "page-card": "no card stands on the builder's page",
      block: "the blocks are read on the docked builder below",
      menu: "menus are read on the docked builder above",
      dialog: "the export dialog is read above",
    });
    await page.getByRole("button", { name: "Exit fullscreen map", exact: true }).click();
    await expect(page.locator("body")).not.toHaveAttribute("data-map-full", /.*/);

    await test.step(`the blocks inside the inspector's tabs and the Tools drawer each lie on their tone with the hairline and no shadow (${theme})`, async () => {
      await readBlocks(page, theme, "the builder");
    });
    expectNoConsoleErrors(errors);
  });
}

// ---- the Tools drawer and the Assistant pane ----

for (const theme of THEMES) {
  test(`the Tools drawer and the Assistant pane float as glass panels, docked and overlaying the map (${theme})`, async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context, { basemapStyleStub: true });
    await useTheme(page, theme);
    const fx = await seed(page, `${theme}_helpers`);
    const drawer: Member = { kind: "glass-panel", what: "the Tools drawer", at: (p) => p.locator("[data-recipe-drawer]") };
    const pane: Member = { kind: "glass-panel", what: "the Assistant pane", at: (p) => p.locator('[data-assistant-pane][data-open="true"]') };
    // At 1440 a helper docks beside the stage; at 1100 it overlays the map.
    for (const [width, overlay] of [[1440, "false"], [1100, "true"]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await openBuilder(page, fx.mapId);
      await expectDefaultLook(page, theme);
      const where = `the builder at ${width}, ${overlay === "true" ? "overlaying" : "docked"}`;
      await test.step(`${where}: the Tools drawer computes the inspector's values (${theme})`, async () => {
        if ((await page.locator('li[data-selected="true"]').count()) === 0) await page.locator("[data-layer-select]").first().click();
        // The door toggles: a drawer the page reopened is left open.
        if (!(await drawer.at(page).isVisible())) await page.locator("[data-tools-control]").click();
        await expect(drawer.at(page)).toHaveAttribute("data-overlay", overlay);
        await expectMember(drawer, page, theme, where);
        await expectMember(inspector, page, theme, where);
      });
      await test.step(`${where}: the Assistant pane computes the inspector's values (${theme})`, async () => {
        await page.getByRole("button", { name: "Open assistant", exact: true }).click();
        await expect(pane.at(page)).toHaveAttribute("data-overlay", overlay);
        await expectMember(pane, page, theme, where);
      });
    }
    expectNoConsoleErrors(errors);
  });
}

// ---- the pages ----

for (const theme of THEMES) {
  test(`the pages: Home, Maps, Data, Projects, Settings and Connections, their cards as one page card (${theme})`, async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context, { basemapStyleStub: true });
    await useTheme(page, theme);
    const fx = await seed(page, `${theme}_pages`);
    const notHere = {
      "glass-panel": "no pane floats on this page",
      "overlay-panel": "nothing is read over a map or canvas here",
      "map-card": "no card floats over a map here",
      "inner-card": "no card sits inside a card here",
      block: "no panel holds a block here",
      menu: "no menu is open at rest",
      dialog: "no dialog is open at rest",
      stage: "no map card or canvas here",
    } as const;
    const grid = async () => {
      const toggle = page.getByRole("button", { name: "Grid view", exact: true });
      if (await toggle.count()) await toggle.click();
    };

    await visit(page, "/");
    await expectDefaultLook(page, theme);
    await readScreen(page, theme, "Home", [headerCard, themeButton, railAtRest], {
      ...notHere,
      "overlay-control": "no control floats over a picture here",
      "page-card": "the start page's cards are a tint kept as it is, not a page card",
    });

    await visit(page, "/maps");
    await grid();
    const mapCardOnPage = (p: Page) => p.getByRole("link", { name: `Open ${fx.mapName}`, exact: true }).locator("xpath=..");
    await readScreen(page, theme, "Maps", [headerCard, themeButton, railAtRest, { kind: "page-card", what: "the map's gallery card", at: mapCardOnPage }], {
      ...notHere,
      "overlay-control": "the card's hover pill is read below, on hover",
    });
    await test.step(`Maps: a hovered card lifts to the deep step and shows its hover pill as glass (${theme})`, async () => {
      await mapCardOnPage(page).hover();
      // On hover the card's edge darkens as its own state; the lift to the
      // deep step is the role's.
      await expectMember({ kind: "page-card", what: "the hovered gallery card", own: ["edge"], at: mapCardOnPage }, page, theme, "Maps", undefined, { shadows: [stepLayer("deep", theme)] });
      await expectMember({
        kind: "overlay-control", what: "the card's hover pill", corner: CORNER.control,
        at: (p) => mapCardOnPage(p).getByRole("button", { name: `Duplicate ${fx.mapName}`, exact: true }).locator("xpath=.."),
      }, page, theme, "Maps");
      await page.mouse.move(5, 5);
    });

    await visit(page, "/data");
    await grid();
    await readScreen(page, theme, "Data", [headerCard, themeButton, { kind: "page-card", what: "a dataset's gallery card", at: (p) => p.locator(`[data-table-card="${fx.points}"]`) }], {
      ...notHere,
      "overlay-control": "no control floats over a picture here",
    });

    await visit(page, "/projects");
    await grid();
    const projectCard = (p: Page) => p.getByRole("link", { name: `Open ${fx.projectName}`, exact: true }).locator("xpath=..");
    await readScreen(page, theme, "Projects", [
      headerCard, themeButton,
      { kind: "page-card", what: "the project's gallery card", at: projectCard },
      { kind: "overlay-control", what: "the kind mark on the project's picture", corner: CORNER.sm, at: (p) => projectCard(p).locator("[data-picture] [data-mark]").first() },
    ], notHere);

    await visit(page, "/settings");
    await readScreen(page, theme, "Settings", [
      headerCard, themeButton,
      { kind: "page-card", what: "the Settings tab column", at: (p) => p.getByRole("navigation", { name: "Settings" }) },
      { kind: "page-card", what: "a Settings card", at: (p) => p.locator("section[aria-labelledby]").filter({ visible: true }).first() },
    ], { ...notHere, "overlay-control": "no control floats over a picture here" });

    await visit(page, "/connections/new");
    await readScreen(page, theme, "Connections", [
      headerCard, themeButton,
      { kind: "page-card", what: "the new connection card", at: (p) => p.locator("main section").filter({ has: p.getByRole("textbox") }).first() },
    ], { ...notHere, "overlay-control": "no control floats over a picture here" });
    expectNoConsoleErrors(errors);
  });
}

// ---- the side rail opened over the page ----

for (const theme of THEMES) {
  test(`the side rail opened over the page is solid on the lift with its one side layer (${theme})`, async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context, { basemapStyleStub: true });
    await useTheme(page, theme);
    await visit(page, "/maps");
    await expectDefaultLook(page, theme);
    await expectMember(railAtRest, page, theme, "Maps");
    const rail = railAtRest.at(page);
    const box = (await rail.boundingBox())!;
    // A rest on the rail's left part opens it after its dwell.
    await page.mouse.move(box.x + 18, box.y + box.height / 2);
    await expect(rail).toHaveAttribute("data-expanded", /.*/);
    await expectMember({ kind: "rail-opened", what: "the side rail opened over the page", at: () => rail }, page, theme, "Maps");
    await page.mouse.move(box.x + 600, box.y + box.height / 2);
    expectNoConsoleErrors(errors);
  });
}

// ---- the SQL page ----

for (const theme of THEMES) {
  test(`the SQL page: its pane, its cards and the map readout (${theme})`, async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context, { basemapStyleStub: true });
    await useTheme(page, theme);
    await page.goto("/sql");
    const bands = (await seedFile(page, `sr_${runId}_${theme}_sql.geojson`, stripesGeoJson(), "application/geo+json")).name;
    await visit(page, "/sql");
    await expectDefaultLook(page, theme);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.keyboard.insertText(`SELECT * FROM "${bands}"`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Run query", exact: true }).click();
    const results = page.getByRole("region", { name: "Results", exact: true });
    await expect(results.getByRole("tab", { name: "Map", exact: true })).toBeEnabled({ timeout: 30_000 });
    await results.getByRole("tab", { name: "Map", exact: true }).click();
    const readout = (p: Page) => p.getByRole("region", { name: "Results", exact: true }).getByText(/^\d[\d,]* features/).locator("xpath=..");
    await expect(readout(page)).toBeVisible({ timeout: 30_000 });

    await readScreen(page, theme, "the SQL page", [
      headerCard, themeButton,
      { kind: "glass-panel", what: "the sources and history pane", at: (p) => p.getByRole("complementary", { name: "Sources and history" }) },
      { kind: "page-card", what: "the editor card", at: (p) => p.getByRole("region", { name: "Editor", exact: true }) },
      { kind: "page-card", what: "the results card", at: (p) => p.getByRole("region", { name: "Results", exact: true }) },
      { kind: "inner-card", what: "the chosen result view's tab", own: ["edge", "corner"], at: (p) => p.getByRole("tablist", { name: "Result view" }).getByRole("tab", { selected: true }) },
      { kind: "overlay-panel", what: "the map readout", corner: CORNER.base, at: readout },
    ], {
      "overlay-control": "the results map carries no floating control",
      "map-card": "the results map carries no widget card",
      block: "the SQL page's panes hold no block",
      menu: "no menu is open at rest; menus are read on the builder",
      dialog: "no dialog is open at rest",
      stage: "the results map sits inside its card, with no stage",
    });
    expectNoConsoleErrors(errors);
  });
}

// ---- the workflow canvas ----

async function api(page: Page, method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
  return page.evaluate(async ({ method, url, body }) => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${text}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }, { method, url, body });
}

/** A source and one buffer node reading it, laid off the dependency
 * arrangement (so Arrange is a move Undo can take back), with a note. */
async function seedWorkflow(page: Page, tag: string): Promise<string> {
  await page.goto("/workflows");
  const table = (await seedCsv(page, `sr_${runId}_${tag}_src`, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n")).name;
  const made = await api(page, "POST", "/api/recipes", { name: `Surface roles ${runId} ${tag}` });
  const id = (made.recipe as { id: string }).id;
  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({
    method: "POST", path: `/api/recipes/${id}/steps`,
    body: { operation: "buffer", parameters: { input: table, distance: 100, name: `${table}_rings` } },
  }));
  // A second step, so one tile stands unselected while the first one's panel is open.
  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({
    method: "POST", path: `/api/recipes/${id}/steps`,
    body: { operation: "buffer", parameters: { input: table, distance: 300, name: `${table}_wide` } },
  }));
  const recipe = (await api(page, "GET", `/api/recipes/${id}`)).recipe as { steps: { id: string }[] };
  await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({
    method: "PUT", path: `/api/recipes/${id}/layout`,
    body: {
      steps: { [recipe.steps[0].id]: { x: 288, y: 200 }, [recipe.steps[1].id]: { x: 288, y: 380 } },
      sources: { [table]: { x: 48, y: 40 } },
      notes: [{ id: "roles", x: 600, y: 40, w: 210, h: 120, color: "yellow", text: "A note" }],
    },
  }));
  return id;
}

async function canvasSettled(page: Page): Promise<void> {
  await expect(page.locator("[data-workflow-canvas]")).toBeVisible();
  await page.waitForTimeout(400);
}

const nodeTile = (p: Page) => p.locator('[data-node][data-kind="node"] [data-v="badge"]').first();
/** A tile at rest: a selected tile adds its ring and the lifted step. */
const restingTile = (p: Page) => p.locator('[data-node][data-kind="node"]:not([data-sel]) [data-v="badge"]').first();

for (const theme of THEMES) {
  test(`the workflow canvas: its panes, its overlays and its controls, the five blurred surfaces among them (${theme})`, async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context, { basemapStyleStub: true });
    await useTheme(page, theme);
    const id = await seedWorkflow(page, `${theme}_canvas`);
    await visit(page, `/workflows/${id}`);
    await canvasSettled(page);
    await expectDefaultLook(page, theme);

    await test.step(`the canvas notice computes the overlay panel while it stands (${theme})`, async () => {
      await page.getByRole("button", { name: "Arrange by dependency", exact: true }).click();
      await page.locator("#header-actions-left [data-undo]").click();
      await expect(page.locator("[data-canvas-notice]")).toHaveText("Undone: Arrange");
      // Read at once: the notice fades on its own after a few seconds.
      await expectMember({ kind: "overlay-panel", what: "the canvas notice", corner: CORNER.pill, at: (p) => p.locator("[data-canvas-notice]") }, page, theme, "the workflow canvas");
    });

    await test.step(`the note's colour bar is glass, an overlay control (${theme})`, async () => {
      const note = page.locator('[data-note][data-note-id="roles"]');
      const box = (await note.boundingBox())!;
      const spot = await page.evaluate((b) => {
        for (let fy = 0.8; fy >= 0.2; fy -= 0.1) for (let fx = 0.8; fx >= 0.2; fx -= 0.1) {
          const p = { x: b.x + b.width * fx, y: b.y + b.height * fy };
          if (document.elementFromPoint(p.x, p.y)?.closest("[data-note]")) return p;
        }
        return null;
      }, box);
      expect(spot, "a spot on the note is clear").not.toBeNull();
      await page.mouse.click(spot!.x, spot!.y);
      await expectMember({ kind: "overlay-control", what: "the note's colour bar", corner: CORNER.control, at: (p) => p.locator("[data-note-menu]") }, page, theme, "the workflow canvas");
    });

    await readThenWriteBrowserSetup(page, `/api/recipes/${id}`, () => ({ method: "POST", path: `/api/recipes/${id}/runs` }));
    await expect
      .poll(async () => ((await api(page, "GET", `/api/recipes/${id}`)).recipe as { steps: { output: unknown }[] }).steps[0]?.output ?? null, { timeout: 30_000 })
      .not.toBeNull();
    await page.reload();
    await reseed(page);
    await canvasSettled(page);
    await nodeTile(page).click();
    await expect(page.locator("[data-node-panel]")).toBeVisible();
    const mapTab = page.getByRole("tab", { name: "Map" });
    await expect(mapTab).toBeEnabled({ timeout: 15_000 });
    await mapTab.click();
    await expect(page.locator("[data-band-readout]")).toBeVisible({ timeout: 30_000 });
    // The lock pill: the notice that stands while the canvas is locked.
    await page.getByRole("button", { name: "Lock canvas", exact: true }).click();
    await expect(page.locator("[data-lock-pill]")).toBeVisible();

    await readScreen(page, theme, "the workflow canvas", [
      headerCard,
      { kind: "glass-chrome", what: "the header's Undo button", corner: CORNER.control, at: (p) => p.locator("#header-actions-left [data-undo]") },
      { kind: "glass-panel", what: "the canvas pane", at: (p) => p.locator("[data-canvas-pane]") },
      { kind: "glass-panel", what: "the node's inspector", at: (p) => p.locator("[data-node-panel]") },
      { kind: "overlay-panel", what: "the lock pill", corner: CORNER.pill, at: (p) => p.locator("[data-lock-pill]") },
      { kind: "overlay-panel", what: "the results band's readout", corner: CORNER.pill, at: (p) => p.locator("[data-band-readout]") },
      { kind: "overlay-control", what: "the canvas's Zoom in button", corner: CORNER.stage, at: (p) => p.locator("[data-canvas-stage]").getByRole("button", { name: "Zoom in", exact: true }) },
      // A node tile keeps its group tint (solid) and its group-coloured edge as its own.
      { kind: "inner-card", what: "a node tile at rest", corner: CORNER.card, own: ["fill", "edge"], at: restingTile },
    ], {
      "page-card": "no card stands on the canvas",
      "map-card": "no card floats over the canvas or its map",
      block: "the canvas's panes hold no block",
      menu: "no menu is open at rest; menus are read on the builder",
      dialog: "the run's confirmation is read below",
      stage: "the framed canvas is read below, in the framed view",
    });
    await page.getByRole("button", { name: "Unlock canvas", exact: true }).click();

    await test.step(`the run's confirmation opens solid over the veil (${theme})`, async () => {
      await page.getByRole("button", { name: "Run all", exact: true }).click();
      const dialog = page.getByRole("dialog").filter({ visible: true }).first();
      await expect(dialog).toBeVisible();
      await expectMember({ kind: "dialog", what: "the run's confirmation", at: () => dialog }, page, theme, "the workflow canvas");
      await expectMember({ kind: "veil", what: "the veil behind it", at: () => dialog.locator("xpath=..") }, page, theme, "the workflow canvas");
      await page.locator("[data-run-confirm]").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    await test.step(`the framed canvas is the stage: the deep step, its strong edge and its ground its own (${theme})`, async () => {
      await page.getByRole("button", { name: "Framed view", exact: true }).click();
      await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-view", "framed");
      await expectMember({ kind: "stage", what: "the framed canvas", own: ["fill", "edge"], at: (p) => p.locator("[data-flow-area]") }, page, theme, "the workflow canvas");
      await page.getByRole("button", { name: "Fill the screen", exact: true }).click();
    });
    expectNoConsoleErrors(errors);
  });
}

// ---- a published page ----

for (const theme of THEMES) {
  test(`a published page in its ${theme} mode: the title bar, the legend and the map's buttons on its own tones`, async ({ page, context }) => {
    const errors = trackConsole(page);
    await routeHouse(context, { basemapStyleStub: true });
    const fx = await seed(page, `${theme}_published`, false);
    const token = await publishMap(page, fx.mapId);
    await visit(page, `/v/${token}`, "published");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-map-legend]").first()).toBeVisible({ timeout: 30_000 });
    // The page opens in the author's mode; the reader's switch takes it to the other.
    const view = page.locator("[data-published-view]");
    if ((await view.getAttribute("data-view-theme")) !== theme) await page.getByRole("button", { name: `Switch to ${theme} theme`, exact: true }).click();
    await expect(view).toHaveAttribute("data-view-theme", theme);
    annotate(`a published page (${theme}): no restatement on the root; a published page never takes a look and reads the roles' default values`);
    await readScreen(page, theme, "a published page", [
      { kind: "overlay-panel", what: "the title bar", corner: CORNER.legend, at: (p) => p.getByRole("heading", { level: 1, name: fx.mapName }).locator("xpath=..") },
      { kind: "overlay-panel", what: "the legend", corner: CORNER.legend, at: (p) => p.locator("[data-map-legend]").filter({ visible: true }).first() },
      zoomIn,
      // The credit chip keeps its ground-tone fill and takes the overlay strength.
      { kind: "credit", what: "the credit chip", at: (p) => p.locator("[data-published-view] footer").first() },
    ], {
      "glass-chrome": "a published page carries no workspace chrome",
      "glass-panel": "no pane floats on a published page",
      "map-card": "the published fixture carries no widget",
      "page-card": "no card stands on a published page",
      "inner-card": "no card sits inside a card here",
      block: "no panel holds a block on a published page",
      menu: "no menu is open at rest",
      dialog: "no dialog is open at rest",
      stage: "the published map fills the page, with no map card",
    }, []);
    expectNoConsoleErrors(errors);
  });
}

// ---- the blur, drawn ----

/** The stripes' width on screen: the median distance between the hard
 * edges across a clear row. */
function stripeWidth(v: number[]): number {
  const r = range(v);
  const edges: number[] = [];
  for (let i = 1; i < v.length; i += 1) {
    if (Math.abs(v[i] - v[i - 1]) >= 0.3 * r && (edges.length === 0 || i - edges[edges.length - 1] > 2)) edges.push(i);
  }
  const gaps = edges.slice(1).map((e, i) => e - edges[i]).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
}

// The map card's glass blurs the map drawn under it. Black and white
// stripes run under the legend and under a map button; in one pixel row
// the window under the glass is compared with a window of the same row
// beside it. Beside the glass every stripe edge is sharp: the whole
// contrast between two neighbouring pixels. Under 93 % glass an unblurred
// map would show the same sharp edges at 7 % of that contrast; blurred,
// neighbouring pixels differ by a fraction of it while the stripes still
// show through. A surface that does not blur fails the first; a surface
// that is solid fails the second.
//
// On a build whose map card keeps its entrance animation filling forwards,
// the card stays on a compositing layer of its own and the glass inside it
// blurs only that layer: the legend shows the stripes sharp, only tinted,
// and this case fails there; the map buttons on such a build are solid and
// fail the second check as well.
test("the map card's glass blurs the map drawn under it: a hard edge goes soft under the legend and a map button, and stays sharp beside them", async ({ page, context }) => {
  const errors = trackConsole(page);
  await routeHouse(context, { basemapStyleStub: true });
  const fx = await seed(page, "pixels", false);
  await openBuilder(page, fx.mapId);
  await expectDefaultLook(page, "light");
  const card = (await mapCard(CORNER.card).at(page).boundingBox())!;
  const inspectorBox = (await page.locator("[data-builder-pane]").boundingBox())!;
  /** A clear row through the card's middle, to measure the stripes by. */
  const probe = { x: Math.round(card.x + card.width * 0.3), y: Math.round(card.y + card.height * 0.5), width: Math.round(card.width * 0.4) };
  const still = async () => {
    let last = "";
    await expect.poll(async () => {
      const now = JSON.stringify(await rowLuma(page, probe.x, probe.y, probe.width));
      const same = now === last;
      last = now;
      return same;
    }, { message: "the map has settled", timeout: 30_000, intervals: [400] }).toBe(true);
  };

  await test.step("the stripes are drawn, then brought in until each is 12 to 24 pixels wide and they fill the card", async () => {
    await expect.poll(async () => range(await rowLuma(page, probe.x, probe.y, probe.width)), { message: "the stripes are drawn", timeout: 30_000 }).toBeGreaterThan(120);
    // Bringing the map in doubles the stripes each time and spreads them
    // past the card's edges, under every overlay. At least once.
    let width = 0;
    for (let zoomed = 1; zoomed <= 4; zoomed += 1) {
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      // The pointer off the stack (no hover, no hint), and the camera's save
      // chip gone from the stage's corner before a row is read.
      await page.mouse.move(inspectorBox.x + inspectorBox.width / 2, inspectorBox.y + inspectorBox.height / 2);
      await page.waitForTimeout(600);
      await still();
      await expect(page.getByText("Saving…", { exact: true })).toBeHidden();
      await page.waitForTimeout(600);
      width = stripeWidth(await rowLuma(page, probe.x, probe.y, probe.width));
      if (width >= 12) break;
    }
    expect(width, `the harness: the stripes are 12 to 24 pixels wide (${width})`).toBeGreaterThanOrEqual(12);
    expect(width, `the harness: the stripes are 12 to 24 pixels wide (${width})`).toBeLessThanOrEqual(24);
    expect(await paintersAcross(page, probe.x, probe.y, probe.width), "the harness: the probe row crosses only the map").toEqual([]);
  });

  const readUnderAndBeside = async (what: string, glass: Locator, inset: number, rowFromTop: number, besideWidth: number) => {
    await expect(glass).toBeVisible();
    const b = (await glass.boundingBox())!;
    const y = Math.round(b.y + rowFromTop);
    const under = { x: Math.round(b.x + inset), width: Math.round(b.width - 2 * inset) };
    // Beside: the same row toward the card's middle, the nearest window that
    // crosses nothing but the drawn map.
    const towardMiddle = b.x + b.width / 2 < card.x + card.width / 2;
    let beside: { x: number; width: number } | null = null;
    const crossed: string[] = [];
    for (const gap of [40, 100, 160]) {
      const x = Math.round(towardMiddle ? b.x + b.width + gap : b.x - gap - besideWidth);
      const painters = await paintersAcross(page, x, y, besideWidth);
      if (painters.length === 0) {
        beside = { x, width: besideWidth };
        break;
      }
      crossed.push(...painters);
    }
    expect(beside, `the harness: a window of the row beside ${what} crosses only the map (crossed: ${crossed.join(", ")})`).not.toBeNull();
    if (!beside) return;
    const x0 = Math.min(under.x, beside.x);
    const row = await rowLuma(page, x0, y, Math.max(under.x + under.width, beside.x + beside.width) - x0);
    const u = row.slice(under.x - x0, under.x - x0 + under.width);
    const s = row.slice(beside.x - x0, beside.x - x0 + beside.width);
    const contrast = range(s);
    // What would show through the glass's 93 % fill if it did not blur.
    const through = (1 - 0.93) * contrast;
    const measured = { row: y, under, beside, contrast, sharpBeside: maxStep(s), through, stepUnder: maxStep(u), rangeUnder: range(u) };
    await test.info().attach(`pixel row: ${what}`, { body: JSON.stringify({ ...measured, underRow: u.map(Math.round), besideRow: s.map(Math.round) }, null, 2), contentType: "application/json" });
    expect.soft(contrast, `the stripes run beside ${what} (contrast ${contrast.toFixed(1)})`).toBeGreaterThan(120);
    expect.soft(maxStep(s), `beside ${what} an edge is sharp: the most two neighbouring pixels differ is ${maxStep(s).toFixed(1)} of ${contrast.toFixed(1)}`).toBeGreaterThanOrEqual(0.45 * contrast);
    expect.soft(maxStep(u), `under ${what} the edges are soft: the most two neighbouring pixels differ is ${maxStep(u).toFixed(2)}, sharp would be about ${through.toFixed(1)}`).toBeLessThanOrEqual(0.35 * through);
    expect.soft(range(u), `under ${what} the stripes still show through the glass (${range(u).toFixed(2)} of ${through.toFixed(1)})`).toBeGreaterThanOrEqual(0.08 * through);
  };

  await test.step("under the legend the stripes are soft; beside it, in the same row, sharp", async () => {
    // A row in the legend's top padding, clear of its rows and its corners.
    await readUnderAndBeside("the legend", legend.at(page), 10, 5, 120);
  });
  await test.step("under the Zoom out button the stripes are soft; beside it, in the same row, sharp", async () => {
    // A row above the button's glyph, inside its rounded corners.
    await readUnderAndBeside("the Zoom out button", page.getByRole("button", { name: "Zoom out", exact: true }), 7, 6, 60);
  });
  expectNoConsoleErrors(errors);
});
