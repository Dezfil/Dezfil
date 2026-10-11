import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The surfaces of each role, as data: the stylesheet rule that dresses a
 * member, the role it plays and the role's parts the rule reads. Once a
 * member's role has moved, its rule reads those parts and types none of
 * the three values the roles hold (a drop shadow, a background blur, a
 * translucent fill of the panel or raised tone); until then it reads no
 * role at all, so a half-made move shows here. The members move in the
 * order below, and `MOVED_THROUGH` names the last step taken.
 */

type Role =
  | "glass-chrome" | "glass-panel" | "overlay-panel" | "overlay-control" | "stage"
  | "page-card" | "inner-card" | "menu" | "dialog";
type Part = "fill" | "blur" | "edge" | "shadow" | "corner" | "shadow-hover" | "shadow-lifted" | "shadow-dragged";
type Member = { step: number; role: Role; file: string; selector: string; parts: Part[]; what: string };

/** The steps, in the order the roles move. */
const STEP = {
  chrome: 4, panel: 5, overlay: 6, control: 7, stage: 8, page: 9, inner: 10, menu: 11, dialog: 12, pictures: 12,
} as const;

/** The last step whose members read their role. */
const MOVED_THROUGH = 10;

const C = "src/components/";
const LAYOUT = "src/app/(workspace)/layout.module.css";
const m = (step: number, role: Role, file: string, selector: string, parts: Part[], what: string): Member =>
  ({ step, role, file, selector, parts, what });
const GLASS: Part[] = ["fill", "blur", "shadow"];
/** A card on the page draws its ground, its edge and its shadow from its
 * role, so a look that restates any of them reaches every card. */
const CARD: Part[] = ["fill", "edge", "shadow"];
/** A chosen tab, entry or knob: drawn on the card's ground with its shadow,
 * and no edge. */
const CHOSEN: Part[] = ["fill", "shadow"];

/** The roles with no edge: what floats as glass or over a map draws its
 * shape with the fill and the shadow alone. */
const EDGELESS: Role[] = ["glass-chrome", "glass-panel", "overlay-panel", "overlay-control"];

/** What reads a step, a strength or a tone directly instead of a role, held
 * to the exact value it writes once its step has moved: a primary button's
 * shadow is a step, not a role, and a named exception keeps a value of its
 * own beside the step it reads. */
type Direct = { step: number; file: string; selector: string; property: string; value: string; what: string };
const OPENED_RAIL = [
  ':global(:root:not([data-look-rail="icons"]):not([data-look-rail="open"])) .rail:has(:focus-visible)',
  ".rail[data-expanded]",
];
export const DIRECT: Direct[] = [
  ...OPENED_RAIL.flatMap(selector => [
    { step: STEP.chrome, file: LAYOUT, selector, property: "background", value: "var(--bg-panel)", what: "the side rail opened over the page, solid" },
    {
      step: STEP.chrome, file: LAYOUT, selector, property: "box-shadow", value: "var(--shadow-lift), 16px 0 36px -18px var(--shadow)",
      what: "the side rail opened over the page: the lift and its one side layer",
    },
  ]),
  { step: STEP.chrome, file: C + "builder/publish/PublishControl.module.css", selector: ".trigger", property: "box-shadow", value: "var(--shadow-float)", what: "Publish before publishing" },
  { step: STEP.chrome, file: C + "workflow-canvas/WorkflowCanvas.module.css", selector: ".runChrome .runAction[data-run-action]", property: "box-shadow", value: "var(--shadow-float)", what: "Run all" },
  { step: STEP.chrome, file: C + "gallery.module.css", selector: ".ghost .plus", property: "box-shadow", value: "var(--shadow-float)", what: "the create tile's disc, the face of the New button" },
  { step: STEP.chrome, file: C + "projects/EmptyHome.module.css", selector: ".plateGlyph", property: "box-shadow", value: "var(--shadow-float)", what: "the empty project's glyph, the same face" },
  {
    step: STEP.overlay, file: C + "viewer/PublishedView.module.css", selector: ".attribution", property: "background", value: "color-mix(in srgb, var(--bg) 55%, transparent)",
    what: "a published page's credit chip keeps its ground-tone fill",
  },
  { step: STEP.overlay, file: C + "viewer/PublishedView.module.css", selector: ".attribution", property: "backdrop-filter", value: "var(--blur-overlay)", what: "a published page's credit chip takes the overlay strength" },
];

export const MEMBERS: Member[] = [
  // Floating glass, chrome: what floats over the page and carries an icon or one strong line
  m(STEP.chrome, "glass-chrome", LAYOUT, ".headCard", GLASS, "the header card"),
  m(STEP.chrome, "glass-chrome", LAYOUT, ".rail", GLASS, "the side rail at rest"),
  m(STEP.chrome, "glass-chrome", C + "builder/MapBuilder.module.css", ".chromeBtn", GLASS, "the header card's buttons"),
  m(STEP.chrome, "glass-chrome", C + "WorkflowScreen.module.css", ".histBtn", GLASS, "the workflow header's undo and redo"),
  m(STEP.chrome, "glass-chrome", C + "theme.module.css", ".toggle", GLASS, "the theme button"),
  m(STEP.chrome, "glass-chrome", C + "builder/search/SearchControl.module.css", ".field", GLASS, "the search field"),
  m(STEP.chrome, "glass-chrome", C + "builder/publish/PublishControl.module.css", '.trigger[data-published="true"]', GLASS, "Publish once published"),
  m(STEP.chrome, "glass-chrome", C + "ui/SaveStatusChip.module.css", ".chip", GLASS, "the save chip"),
  m(STEP.chrome, "glass-chrome", C + "builder/draw/draw.module.css", ".dock", GLASS, "the draw dock"),
  m(STEP.chrome, "glass-chrome", C + "builder/draw/draw.module.css", ".pill", GLASS, "the draw dock's pill"),
  // Floating glass, panel: what floats over the page and is read
  m(STEP.panel, "glass-panel", C + "builder/MapBuilder.module.css", ".rail", GLASS, "the builder's inspector"),
  m(STEP.panel, "glass-panel", C + "sql/SqlConsole.module.css", ".pane", GLASS, "the SQL page's left pane"),
  m(STEP.panel, "glass-panel", C + "workflow-canvas/WorkflowCanvas.module.css", ".pane", GLASS, "the workflow canvas's pane"),
  m(STEP.panel, "glass-panel", C + "workflow-canvas/WorkflowCanvas.module.css", ".inspector", GLASS, "the workflow canvas's inspector"),
  m(STEP.panel, "glass-panel", C + "builder/drawer/RecipeDrawer.module.css", ".drawer", GLASS, "the Tools drawer, and the Assistant pane that composes it"),
  m(STEP.panel, "glass-panel", C + "builder/drawer/RecipeDrawer.module.css", '.drawer[data-overlay="true"]', ["shadow"], "the drawer and the pane overlaying the stage"),
  // Overlay panel: what is read over a map or the canvas
  m(STEP.overlay, "overlay-panel", C + "map/LegendPanel.module.css", ".legend", GLASS, "the legend"),
  m(STEP.overlay, "overlay-panel", C + "builder/StatusBar.module.css", ".bar", GLASS, "the status pill"),
  m(STEP.overlay, "overlay-panel", C + "map/TimelineBar.module.css", ".bar", GLASS, "the timeline bar"),
  m(STEP.overlay, "overlay-panel", C + "viewer/PublishedView.module.css", ".titleBar", GLASS, "a published page's title bar"),
  m(STEP.overlay, "overlay-panel", C + "builder/MapBuilder.module.css", ".previewBadge", GLASS, "the builder's preview badge"),
  m(STEP.overlay, "overlay-panel", C + "workflow-canvas/WorkflowCanvas.module.css", ".notice", GLASS, "the canvas notice"),
  m(STEP.overlay, "overlay-panel", C + "workflow-canvas/WorkflowCanvas.module.css", ".minimap", GLASS, "the workflow minimap"),
  m(STEP.overlay, "overlay-panel", C + "workflow-canvas/ResultsBand.module.css", ".readout", GLASS, "the canvas results' readout"),
  m(STEP.overlay, "overlay-panel", C + "sql/SqlConsole.module.css", ".mapReadout", GLASS, "the SQL map's readout"),
  m(STEP.overlay, "overlay-panel", C + "TablePreviewMap.module.css", ".readout", GLASS, "the table preview's readout"),
  m(STEP.overlay, "overlay-panel", C + "MiniMap.module.css", ".legend", GLASS, "the mini-map's legend"),
  m(STEP.overlay, "overlay-panel", C + "MiniMap.module.css", ".hint", GLASS, "the mini-map's hint"),
  m(STEP.overlay, "overlay-panel", C + "set-geometry/WorldInset.module.css", ".inset", ["shadow"], "the world inset over the set-geometry map"),
  // Overlay control: a control floating over a map, canvas or picture
  m(STEP.control, "overlay-control", C + "map/StageStack.module.css", ".stageBtn", GLASS, "the zoom and stage buttons"),
  m(STEP.control, "overlay-control", C + "MiniMap.module.css", ".polyActions button", GLASS, "the mini-map's action buttons"),
  m(STEP.control, "overlay-control", C + "gallery.module.css", ".acts", GLASS, "a card's hover pill"),
  m(STEP.control, "overlay-control", C + "sharing/PeopleMarks.module.css", '.ownerPill[data-placement="corner"]', GLASS, "a card's owner mark"),
  m(STEP.control, "overlay-control", C + "projects/ProjectPicture.module.css", ".mark", GLASS, "a project picture's kind mark"),
  m(STEP.control, "overlay-control", C + "workflow-canvas/NoteNode.module.css", ".menu", GLASS, "the note's colour bar"),
  // The stage
  m(STEP.stage, "stage", C + "builder/MapBuilder.module.css", ".canvasCol", ["shadow"], "the map card"),
  m(STEP.stage, "stage", C + "workflow-canvas/WorkflowCanvas.module.css", '.host[data-view="framed"] .flowArea', ["shadow"], "the framed canvas"),
  // Page card: a card on a page
  m(STEP.page, "page-card", C + "gallery.module.css", ".card", CARD, "the gallery card"),
  m(STEP.page, "page-card", C + "gallery.module.css", ".card:hover", ["shadow-hover"], "the gallery card lifting on hover"),
  m(STEP.page, "page-card", C + "gallery.module.css", ".listCard", CARD, "the gallery's list view card"),
  m(STEP.page, "page-card", C + "settings/SettingsCard.module.css", ".card", CARD, "a Settings card"),
  m(STEP.page, "page-card", C + "settings/SettingsFrame.module.css", ".column", CARD, "the Settings tab column"),
  m(STEP.page, "page-card", C + "sql/SqlConsole.module.css", ".editorCard", CARD, "the SQL editor card"),
  m(STEP.page, "page-card", C + "sql/SqlConsole.module.css", ".resultsCard", CARD, "the SQL results card"),
  m(STEP.page, "page-card", C + "connections/ConnectionDetail.module.css", ".card", CARD, "the connection detail card"),
  m(STEP.page, "page-card", C + "connections/NewConnectionScreen.module.css", ".card", CARD, "the new-connection card"),
  m(STEP.page, "page-card", C + "set-geometry/SetGeometryPanel.module.css", ".dock", CARD, "the set-geometry panel"),
  // Its ground is the map's raised tone under a map still loading, kept.
  m(STEP.page, "page-card", C + "TablePreviewMap.module.css", ".pane", ["edge", "shadow"], "the dataset page's preview card"),
  // Inner card: a card inside a panel or card, and a control that carries a small shadow.
  // Its ground and edge are read wherever the member draws the panel tone
  // or the hairline today; a ground or edge of the member's own (a node
  // tile's group colour, a slider thumb's white and accent ring, an accent
  // grip or handle) stays its own.
  m(STEP.inner, "inner-card", C + "builder/LayerList.module.css", ".card", CARD, "a layer card"),
  m(STEP.inner, "inner-card", C + "builder/LayerList.module.css", ".floating", ["shadow-dragged"], "a layer card dragged"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".tBox", ["shadow"], "a node tile"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".member[data-sel] .tBox", ["shadow-lifted"], "a node tile selected"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".member[data-drag] .tBox", ["shadow-dragged"], "a node tile dragged"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".dragGhost", ["fill", "shadow-dragged"], "an operation dragged onto the canvas"),
  m(STEP.inner, "inner-card", C + "AddToMapDialog.module.css", ".card, .newCard", ["fill", "edge"], "a pickable card in a dialog"),
  m(STEP.inner, "inner-card", C + "AddToMapDialog.module.css", ".card:hover:not(:disabled), .newCard:hover:not(:disabled)", ["shadow-lifted"], "a pickable card in a dialog, on hover"),
  m(STEP.inner, "inner-card", C + "QueryAreaPicker.module.css", ".cats button[data-active], .subs button[data-active]", CHOSEN, "a pickable card in a dialog, picked"),
  m(STEP.inner, "inner-card", C + "AreaSemanticsToggle.module.css", ".seg button[data-active]", CHOSEN, "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "ui/Switch.module.css", ".switch::before", CHOSEN, "a switch's knob"),
  m(STEP.inner, "inner-card", C + "ui/Slider.module.css", ".slider::-webkit-slider-thumb", ["shadow"], "a slider's thumb"),
  m(STEP.inner, "inner-card", C + "ui/Slider.module.css", ".slider::-moz-range-thumb", ["shadow"], "a slider's thumb"),
  m(STEP.inner, "inner-card", C + "builder/drawer/ParameterForm.module.css", '.modeBtn[aria-pressed="true"]', CHOSEN, "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "builder/style-panel/BreakBrush.module.css", ".thumb::-webkit-slider-thumb", CHOSEN, "the break brush's thumb"),
  m(STEP.inner, "inner-card", C + "builder/style-panel/BreakBrush.module.css", ".thumb::-moz-range-thumb", CHOSEN, "the break brush's thumb"),
  m(STEP.inner, "inner-card", C + "builder/export/ExportImageCard.module.css", ".frameSashGrip", ["shadow"], "a drag grip"),
  m(STEP.inner, "inner-card", C + "MiniMap.module.css", ".handle", ["shadow"], "the mini-map's handles"),
  m(STEP.inner, "inner-card", C + "MiniMap.module.css", ".measure", ["shadow"], "the mini-map's labels"),
  m(STEP.inner, "inner-card", C + "connections/PostgisPane.module.css", '.segmented button[aria-pressed="true"]', CHOSEN, "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/ResultsBand.module.css", ".scopeBtn[data-on]", CHOSEN, "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "sql/SqlConsole.module.css", ".tabs button[data-on]", CHOSEN, "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "sql/SqlConsole.module.css", ".card", ["fill", "edge"], "a history card in the SQL pane"),
  m(STEP.inner, "inner-card", C + "sql/SqlConsole.module.css", ".card:hover", ["shadow-lifted"], "a history card on hover"),
  m(STEP.inner, "inner-card", C + "SourceNav.module.css", ".source[data-active]", CHOSEN, "a source rail's active entry"),
  // Menu and pop-over: what opens over something and closes
  ...([
    [C + "ExportMenu.module.css", ".menu", "a menu"],
    [C + "builder/LayerList.module.css", ".menu", "the layer menu"],
    [C + "builder/assistant/ModelPicker.module.css", ".menu", "the model picker"],
    [C + "builder/export/ExportControl.module.css", ".menu", "the export menu"],
    [C + "connections/ConnectionMenu.module.css", ".menu", "the connection menu"],
    [C + "projects/ProjectHome.module.css", ".menu", "the project menu"],
    [C + "scope/ScopeFilter.module.css", ".menu", "the scope filter"],
    [C + "sharing/ShareDialog.module.css", ".results", "the share dialog's results"],
    [C + "sharing/ShareDialog.module.css", ".menu", "the share dialog's menu"],
    [C + "sql/SqlConsole.module.css", ".menu", "the SQL page's menu"],
    [C + "sql/SqlConsole.module.css", ".peek", "the SQL peek"],
    [C + "sql/SqlConsole.module.css", ".mapTip", "the SQL map's tooltip"],
    [C + "map/BasemapPicker.module.css", ".panel", "the basemap picker"],
    [C + "builder/FilterSection.module.css", ".picker", "the filter pop-over"],
    [C + "builder/publish/PublishControl.module.css", ".pop", "the publish pop-over"],
    [C + "builder/search/SearchControl.module.css", ".panel", "the search results"],
    [C + "workflow-canvas/InputPicker.module.css", ".pop", "the input picker"],
    [C + "SaveResultAsDataset.module.css", ".panel", "the save result pop-over"],
    [C + "gallery.module.css", ".tip", "the gallery's tip"],
    [C + "ui/HintLayer.module.css", ".bubble", "the kit's hint"],
    [C + "map/search-marker.module.css", ".chip", "the search marker's name chip"],
    [C + "QueryDrawer.module.css", ".drawer", "the query drawer"],
    [C + "QueryDrawer.module.css", ".drawer[data-accent]", "the query drawer, accented"],
    [C + "map/MapCanvas.module.css", ".tooltip", "the map's tooltip"],
    [C + "map/MapCanvas.module.css", ".popup", "the map's popup"],
    [C + "map/MapCanvas.module.css", ".webglFailureCard", "the map's failure notice"],
    [C + "TablePreviewMap.module.css", ".refusal", "the preview map's refusal plate"],
    [C + "builder/export/ExportComposition.module.css", ".frame[data-presentation]", "the export card's preview frame"],
  ] as const).map(([file, selector, what]) => m(STEP.menu, "menu", file, selector, ["shadow"], what)),
  // Dialog
  m(STEP.dialog, "dialog", C + "ui/Dialog.module.css", ".dialog", ["shadow"], "every modal"),
  // The Appearance tab's pictures, each reading the role it pictures
  m(STEP.pictures, "page-card", C + "settings/LookPictures.module.css", ".art .bgCard", ["shadow"], "pictured: a card on the page"),
  m(STEP.pictures, "glass-chrome", C + "settings/LookPictures.module.css", ".art .coHead", GLASS, "pictured: the header card"),
  m(STEP.pictures, "glass-chrome", C + "settings/LookPictures.module.css", ".art .coRail", GLASS, "pictured: the side rail at rest"),
  m(STEP.pictures, "inner-card", C + "settings/LookPictures.module.css", ".coSwitch::after", ["shadow"], "pictured: a switch's knob"),
  m(STEP.pictures, "inner-card", C + "settings/LookPictures.module.css", ".ctSwitch::after", ["shadow"], "pictured: a switch's knob"),
  m(STEP.pictures, "page-card", C + "settings/LookPictures.module.css", ".art .fnCard", ["shadow"], "pictured: a card on the page"),
  m(STEP.pictures, "page-card", C + "settings/LookPictures.module.css", ".art .crCard", ["shadow"], "pictured: a card on the page"),
  m(STEP.pictures, "glass-chrome", C + "settings/LookPictures.module.css", ".art .smRail", GLASS, "pictured: the side rail at rest"),
  m(STEP.pictures, "menu", C + "settings/LookPictures.module.css", ".art .smHint", ["shadow"], "pictured: the kit's hint"),
];

/** The property each part is read by. */
const PROPERTY: Record<Part, RegExp> = {
  fill: /^background(-color)?$/,
  blur: /^(-webkit-)?backdrop-filter$/,
  edge: /^border$/,
  shadow: /^box-shadow$/,
  corner: /^border-radius$/,
  "shadow-hover": /^box-shadow$/,
  "shadow-lifted": /^box-shadow$/,
  "shadow-dragged": /^box-shadow$/,
};

/** The declarations of every rule written with exactly this selector list. */
function declarations(css: string, selector: string): [string, string][] | null {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.trim().replace(/\s+/g, " ") === selector);
  if (!found.length) return null;
  return found.flatMap(([, , body]) => [...body.matchAll(/([-\w]+)\s*:\s*([^;]+);?/g)]
    .map(([, property, value]) => [property, value.trim().replace(/\s+/g, " ")] as [string, string]));
}

/** A value of the three kinds typed by hand: a drop-shadow layer with an
 * offset, a blur, a translucent fill of the panel or raised tone. */
function typed(property: string, value: string): string[] {
  const out: string[] = [];
  if (property === "box-shadow") {
    let depth = 0, layer = "";
    const layers: string[] = [];
    for (const ch of value + ",") {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) { layers.push(layer.trim()); layer = ""; } else layer += ch;
    }
    for (const l of layers) {
      if (/^var\(--[\w-]+\)$/.test(l) || /\binset\b/.test(l) || l === "none") continue;
      const [x = "0", y = "0"] = l.replace(/color-mix\([^)]*\)|var\([^)]*\)/g, " ").match(/-?\d*\.?\d+/g) ?? [];
      if (parseFloat(x) !== 0 || parseFloat(y) !== 0) out.push(l);
    }
  }
  if (/backdrop-filter$/.test(property) && /blur\(/.test(value)) out.push(value);
  for (const mix of value.match(/color-mix\(in srgb, var\(--bg-(?:panel|raised)\) \d+%, transparent\)/g) ?? []) out.push(mix);
  return out;
}

/** What keeps a moved member from reading its role; empty when it does. */
export function memberProblems(member: Member, css: string): string[] {
  const decls = declarations(css, member.selector);
  if (!decls) return [`${member.file} has no rule ${member.selector}`];
  const problems: string[] = [];
  const own = `--surface-${member.role}-`;
  for (const part of member.parts) {
    const token = `var(${own}${part})`;
    if (!decls.some(([property, value]) => PROPERTY[part].test(property) && value.includes(token))) {
      problems.push(`${member.selector} does not read ${token}`);
    }
  }
  for (const [property, value] of decls) {
    for (const value_ of typed(property, value)) problems.push(`${member.selector} types ${property}: ${value_}`);
    for (const [read] of value.matchAll(/--surface-[\w-]+/g)) {
      if (!read.startsWith(own)) problems.push(`${member.selector} reads ${read}, another role's`);
    }
    if (EDGELESS.includes(member.role) && /^border(-(top|right|bottom|left))?$/.test(property)
      && !/^(none|0(px)?)$/.test(value) && value !== `var(${own}edge)`) {
      problems.push(`${member.selector} draws an edge its role has none of: ${property}: ${value}`);
    }
  }
  return problems;
}

/** What keeps a direct read from writing its value; empty when it does. */
export function directProblems(direct: Direct, css: string): string[] {
  const decls = declarations(css, direct.selector);
  if (!decls) return [`${direct.file} has no rule ${direct.selector}`];
  const values = decls.filter(([property]) => property === direct.property).map(([, value]) => value);
  return values.length === 1 && values[0] === direct.value
    ? []
    : [`${direct.selector} ${direct.property}: ${values.join(" | ") || "nothing"}, not ${direct.value}`];
}

const read = (file: string) => readFileSync(file, "utf8");

describe("the members of each role", () => {
  it("name rules that exist, each once in the table", () => {
    const missing = MEMBERS.filter(member => !declarations(read(member.file), member.selector)).map(member => `${member.file} ${member.selector}`);
    expect(missing).toEqual([]);
    const keys = MEMBERS.map(member => `${member.file} ${member.selector}`);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
    // Every role has members, and the frame runs in the roles' order.
    const roles: Role[] = ["glass-chrome", "glass-panel", "overlay-panel", "overlay-control", "stage", "page-card", "inner-card", "menu", "dialog"];
    for (const role of roles) expect(MEMBERS.some(member => member.role === role), role).toBe(true);
  });

  it("read their role once it has moved, typing none of its values", () => {
    const moved = MEMBERS.filter(member => member.step <= MOVED_THROUGH);
    expect(moved.flatMap(member => memberProblems(member, read(member.file)))).toEqual([]);
  });

  it("read a step where they are a button or a named exception, once their step has moved", () => {
    const moved = DIRECT.filter(direct => direct.step <= MOVED_THROUGH);
    expect(moved.flatMap(direct => directProblems(direct, read(direct.file)))).toEqual([]);
  });

  it("dress the Assistant pane by composing the Tools drawer, open and closed, with no surface value of its own", () => {
    if (STEP.panel > MOVED_THROUGH) return;
    const pane = read(C + "builder/assistant/AssistantPane.module.css");
    expect(declarations(pane, ".pane")).toContainEqual(["composes", 'drawer from "../drawer/RecipeDrawer.module.css"']);
    const own = pane.replace(/\/\*[\s\S]*?\*\//g, "").match(/([^{}]+)\{([^{}]*)\}/g) ?? [];
    expect(own.filter(rule => /^\s*\.pane\b/.test(rule) && /(background|backdrop-filter|border|box-shadow)\s*:/.test(rule))).toEqual([]);
    const drawer = MEMBERS.find(member => member.selector === ".drawer")!;
    expect(memberProblems(drawer, read(drawer.file))).toEqual([]);
  });

  it("draw the legend from its role at today's legend values to the digit, so an image of it stays as it was", () => {
    if (STEP.overlay > MOVED_THROUGH) return;
    // The block's own tokens, each reference inside it written out: the role
    // as an image's default scope computes it, against that scope's tones.
    const globals = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const body = [...globals.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) => selectors.includes("[data-look-default]"))![2];
    const tokens = new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
    const resolve = (value: string): string => value.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => (tokens.has(name) ? resolve(tokens.get(name)!) : whole));
    const legend = Object.fromEntries(declarations(read(C + "map/LegendPanel.module.css"), ".legend")!);
    expect({ background: legend.background, "backdrop-filter": legend["backdrop-filter"], "box-shadow": legend["box-shadow"] }).toEqual({
      background: "var(--surface-overlay-panel-fill)", "backdrop-filter": "var(--surface-overlay-panel-blur)", "box-shadow": "var(--surface-overlay-panel-shadow)",
    });
    // The legend as it was drawn before it read a role, written out here.
    expect(resolve(legend.background)).toBe("color-mix(in srgb, var(--bg-panel) 93%, transparent)");
    expect(resolve(legend["backdrop-filter"])).toBe("blur(8px)");
    expect(resolve(legend["box-shadow"])).toBe("0 8px 26px var(--shadow)");
    expect(legend["border-radius"]).toBe("var(--radius-legend)");
    expect(legend.border).toBeUndefined();
  });

  it("count the workflow canvas's full-view button among the stage buttons, so it reads the overlay control", () => {
    if (STEP.control > MOVED_THROUGH) return;
    // The full-view toggle stands in the canvas's stage stack: it is drawn
    // by the shared stage button, whose box is the stage stack's rule.
    const stage = read(C + "workflow-canvas/CanvasStage.tsx");
    const action = stage.indexOf('"Fill the screen"');
    expect(action, "the canvas offers its full view").toBeGreaterThan(-1);
    expect(/^<(\w+)/.exec(stage.slice(stage.lastIndexOf("<", action)))?.[1]).toBe("StageButton");
    const stack = read(C + "map/StageStack.tsx");
    expect(stack).toMatch(/className=\{className \? `\$\{styles\.stageBtn\} \$\{className\}` : styles\.stageBtn\}/);
    const button = MEMBERS.find(member => member.selector === ".stageBtn")!;
    expect(memberProblems(button, read(button.file))).toEqual([]);
  });

  it("let the map card's entrance go once it has played, so a blur inside the card reads the map", () => {
    if (STEP.stage > MOVED_THROUGH) return;
    const css = read(C + "builder/MapBuilder.module.css").replace(/\/\*[\s\S]*?\*\//g, "");
    // The entrance plays only where motion is welcome; its block, by its braces.
    const at = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(at, "the entrance's block").toBeGreaterThan(-1);
    const start = css.indexOf("{", at) + 1;
    let depth = 1, end = start;
    while (depth > 0 && end < css.length) {
      if (css[end] === "{") depth += 1;
      if (css[end] === "}") depth -= 1;
      end += 1;
    }
    const entrance = css.slice(start, end - 1);
    // The card and its map layer settle in as before, the from-state held
    // through the delay, and fill nothing forwards: a finished animation
    // that keeps filling holds the card on a compositing layer of its own,
    // and a background blur inside the card then reads that layer alone,
    // never the map under it.
    expect(declarations(entrance, ".canvasCol, .mapLayer")).toEqual([["animation", "settle-in 0.55s var(--ease-entrance) 0.14s backwards"]]);
    // The inspector stands outside the card; its entrance is left as it was.
    expect(declarations(entrance, ".rail")).toEqual([["animation", "settle-in 0.55s var(--ease-entrance) 0.07s both"]]);
    // Released, the card and the layer return to their own styles, which are
    // the keyframes' end: neither sets an opacity or a transform of its own.
    const keyframes = /@keyframes settle-in\s*\{([\s\S]*?\})\s*\}/.exec(css)?.[1] ?? "";
    expect(declarations(keyframes, "from")).toEqual([["opacity", "0"], ["transform", "translateY(14px)"]]);
    expect(declarations(keyframes, "to")).toEqual([["opacity", "1"], ["transform", "none"]]);
    for (const selector of [".canvasCol", ".mapLayer"]) {
      expect(declarations(css, selector)!.filter(([property]) => /^(opacity|transform|translate|scale)$/.test(property)), selector).toEqual([]);
    }
  });

  it("round every card on the page at the card radius, and keep its corner and shadow in the states that restate them", () => {
    if (STEP.page > MOVED_THROUGH) return;
    // The card radius, the role's corner, written on the radius token as
    // every member keeps it, so the person's Corners pick reaches it.
    const cards = MEMBERS.filter(member => member.step === STEP.page && member.parts.includes("shadow"));
    expect.soft(cards.flatMap(card => (declarations(read(card.file), card.selector) ?? [])
      .filter(([property, value]) => property === "border-radius" && value !== "var(--radius-card)")
      .map(([, value]) => `${card.selector} in ${card.file}: ${value}`))).toEqual([]);
    expect.soft(cards.filter(card => !(declarations(read(card.file), card.selector) ?? []).some(([property]) => property === "border-radius"))
      .map(card => card.selector)).toEqual([]);
    // A Settings card marked for a moment, and the SQL results card showing
    // a preview, restate the card's corner or shadow: each keeps the card's
    // and adds its own ring.
    const marked = Object.fromEntries(declarations(read(C + "settings/SettingsFrame.module.css"), '.content section[data-marked=""]') ?? []);
    expect.soft(marked).toEqual({ "border-radius": "var(--radius-card)", "box-shadow": "var(--surface-page-card-shadow), 0 0 0 6px var(--accent-wash)" });
    const preview = Object.fromEntries(declarations(read(C + "sql/SqlConsole.module.css"), '.resultsCard[data-mode="preview"]') ?? []);
    expect.soft(preview["box-shadow"]).toBe("var(--surface-page-card-shadow), inset 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent)");
  });

  it("keep a node tile's own corner, ground and edge, and its selection ring above the lifted shadow", () => {
    if (STEP.inner > MOVED_THROUGH) return;
    const canvas = read(C + "workflow-canvas/WorkflowCanvas.module.css");
    // The tile keeps the card radius and the edge and ground its group colours.
    const tile = Object.fromEntries(declarations(canvas, ".tBox")!);
    expect(tile["border-radius"]).toBe("var(--radius-card)");
    expect(tile.border).toMatch(/var\(--gc,/);
    expect(tile.background).toMatch(/var\(--gc,/);
    // Selected, the ring is drawn first, so it paints above the shadow as it did.
    expect(Object.fromEntries(declarations(canvas, ".member[data-sel] .tBox")!)["box-shadow"])
      .toBe("0 0 0 3px var(--accent-dim), var(--surface-inner-card-shadow-lifted)");
  });

  it("read no role at all until theirs moves, so a half-made move shows", () => {
    const waiting = MEMBERS.filter(member => member.step > MOVED_THROUGH);
    const early = waiting.flatMap(member => (declarations(read(member.file), member.selector) ?? [])
      .filter(([, value]) => /--surface-/.test(value)).map(([property, value]) => `${member.selector} ${property}: ${value}`));
    expect(early).toEqual([]);
  });

  it("fails a member that types its value, reads another role or misses a part", () => {
    const legend = MEMBERS.find(member => member.selector === ".legend" && member.role === "overlay-panel")!;
    const moved = `.legend {\n  background: var(--surface-overlay-panel-fill);\n  backdrop-filter: var(--surface-overlay-panel-blur);\n  box-shadow: var(--surface-overlay-panel-shadow);\n}`;
    expect(memberProblems(legend, moved)).toEqual([]);
    expect(memberProblems(legend, moved.replace("var(--surface-overlay-panel-shadow)", "0 8px 26px var(--shadow)")))
      .toEqual([".legend does not read var(--surface-overlay-panel-shadow)", ".legend types box-shadow: 0 8px 26px var(--shadow)"]);
    expect(memberProblems(legend, moved.replace("var(--surface-overlay-panel-blur)", "var(--surface-glass-panel-blur)")))
      .toContain(".legend reads --surface-glass-panel-blur, another role's");
    expect(memberProblems(legend, moved.replace("var(--surface-overlay-panel-fill)", "color-mix(in srgb, var(--bg-panel) 93%, transparent)")))
      .toContain(".legend types background: color-mix(in srgb, var(--bg-panel) 93%, transparent)");
    expect(memberProblems(legend, moved.replace("}", "  border: 1px solid var(--border);\n}")))
      .toEqual([".legend draws an edge its role has none of: border: 1px solid var(--border)"]);
    expect(memberProblems(legend, moved.replace("}", "  border: 0;\n}"))).toEqual([]);
  });

  it("fails a direct read that types its value or loses its side layer", () => {
    const rail = DIRECT.find(direct => direct.selector === ".rail[data-expanded]" && direct.property === "box-shadow")!;
    const opened = ".rail[data-expanded] {\n  background: var(--bg-panel);\n  box-shadow:\n    var(--shadow-lift),\n    16px 0 36px -18px var(--shadow);\n}";
    expect(directProblems(rail, opened)).toEqual([]);
    expect(directProblems(rail, opened.replace("var(--shadow-lift)", "0 10px 30px var(--shadow)"))).toHaveLength(1);
    expect(directProblems(rail, opened.replace(",\n    16px 0 36px -18px var(--shadow)", ""))).toHaveLength(1);
  });
});
