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
const MOVED_THROUGH = 3;

const C = "src/components/";
const m = (step: number, role: Role, file: string, selector: string, parts: Part[], what: string): Member =>
  ({ step, role, file, selector, parts, what });
const GLASS: Part[] = ["fill", "blur", "shadow"];

export const MEMBERS: Member[] = [
  // Floating glass, chrome: what floats over the page and carries an icon or one strong line
  m(STEP.chrome, "glass-chrome", "src/app/(workspace)/layout.module.css", ".headCard", GLASS, "the header card"),
  m(STEP.chrome, "glass-chrome", "src/app/(workspace)/layout.module.css", ".rail", GLASS, "the side rail at rest"),
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
  m(STEP.page, "page-card", C + "gallery.module.css", ".card", ["shadow"], "the gallery card"),
  m(STEP.page, "page-card", C + "gallery.module.css", ".card:hover", ["shadow-hover"], "the gallery card lifting on hover"),
  m(STEP.page, "page-card", C + "gallery.module.css", ".listCard", ["shadow"], "the gallery's list view card"),
  m(STEP.page, "page-card", C + "settings/SettingsCard.module.css", ".card", ["shadow"], "a Settings card"),
  m(STEP.page, "page-card", C + "settings/SettingsFrame.module.css", ".column", ["shadow"], "the Settings tab column"),
  m(STEP.page, "page-card", C + "sql/SqlConsole.module.css", ".editorCard", ["shadow"], "the SQL editor card"),
  m(STEP.page, "page-card", C + "sql/SqlConsole.module.css", ".resultsCard", ["shadow"], "the SQL results card"),
  m(STEP.page, "page-card", C + "connections/ConnectionDetail.module.css", ".card", ["shadow"], "the connection detail card"),
  m(STEP.page, "page-card", C + "connections/NewConnectionScreen.module.css", ".card", ["shadow"], "the new-connection card"),
  m(STEP.page, "page-card", C + "set-geometry/SetGeometryPanel.module.css", ".dock", ["shadow"], "the set-geometry panel"),
  m(STEP.page, "page-card", C + "TablePreviewMap.module.css", ".pane", ["shadow"], "the dataset page's preview card"),
  // Inner card: a card inside a panel or card, and a control that carries a small shadow
  m(STEP.inner, "inner-card", C + "builder/LayerList.module.css", ".card", ["shadow"], "a layer card"),
  m(STEP.inner, "inner-card", C + "builder/LayerList.module.css", ".floating", ["shadow-dragged"], "a layer card dragged"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".tBox", ["shadow"], "a node tile"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".member[data-sel] .tBox", ["shadow-lifted"], "a node tile selected"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".member[data-drag] .tBox", ["shadow-dragged"], "a node tile dragged"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".dragGhost", ["shadow-dragged"], "an operation dragged onto the canvas"),
  m(STEP.inner, "inner-card", C + "AddToMapDialog.module.css", ".card:hover:not(:disabled), .newCard:hover:not(:disabled)", ["shadow-lifted"], "a pickable card in a dialog, on hover"),
  m(STEP.inner, "inner-card", C + "QueryAreaPicker.module.css", ".cats button[data-active], .subs button[data-active]", ["shadow"], "a pickable card in a dialog, picked"),
  m(STEP.inner, "inner-card", C + "AreaSemanticsToggle.module.css", ".seg button[data-active]", ["shadow"], "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "ui/Switch.module.css", ".switch::before", ["shadow"], "a switch's knob"),
  m(STEP.inner, "inner-card", C + "ui/Slider.module.css", ".slider::-webkit-slider-thumb", ["shadow"], "a slider's thumb"),
  m(STEP.inner, "inner-card", C + "ui/Slider.module.css", ".slider::-moz-range-thumb", ["shadow"], "a slider's thumb"),
  m(STEP.inner, "inner-card", C + "builder/drawer/ParameterForm.module.css", '.modeBtn[aria-pressed="true"]', ["shadow"], "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "builder/style-panel/BreakBrush.module.css", ".thumb::-webkit-slider-thumb", ["shadow"], "the break brush's thumb"),
  m(STEP.inner, "inner-card", C + "builder/style-panel/BreakBrush.module.css", ".thumb::-moz-range-thumb", ["shadow"], "the break brush's thumb"),
  m(STEP.inner, "inner-card", C + "builder/export/ExportImageCard.module.css", ".frameSashGrip", ["shadow"], "a drag grip"),
  m(STEP.inner, "inner-card", C + "MiniMap.module.css", ".handle", ["shadow"], "the mini-map's handles"),
  m(STEP.inner, "inner-card", C + "MiniMap.module.css", ".measure", ["shadow"], "the mini-map's labels"),
  m(STEP.inner, "inner-card", C + "connections/PostgisPane.module.css", '.segmented button[aria-pressed="true"]', ["shadow"], "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/ResultsBand.module.css", ".scopeBtn[data-on]", ["shadow"], "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "sql/SqlConsole.module.css", ".tabs button[data-on]", ["shadow"], "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "sql/SqlConsole.module.css", ".card:hover", ["shadow-lifted"], "a history card on hover"),
  m(STEP.inner, "inner-card", C + "SourceNav.module.css", ".source[data-active]", ["shadow"], "a source rail's active entry"),
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
  }
  return problems;
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
  });
});
