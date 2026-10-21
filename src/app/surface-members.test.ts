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
  | "glass-chrome" | "glass-panel" | "overlay-panel" | "overlay-control" | "map-card" | "stage"
  | "page-card" | "inner-card" | "block" | "menu" | "dialog";
type Part = "fill" | "blur" | "edge" | "shadow" | "corner" | "shadow-hover" | "shadow-lifted" | "shadow-dragged"
  | "grow" | "edge-strong" | "edge-hover" | "edge-new" | "knob" | "mark" | "fill-raised" | "fill-panel";
/** A member's rule, or with `state` a rule restating some of its parts in
 * a state of the member (hovered, chosen, dragged). */
type Member = { step: number; role: Role; file: string; selector: string; parts: Part[]; what: string; state?: true };

/** The steps, in the order the roles move. */
const STEP = {
  chrome: 4, panel: 5, overlay: 6, control: 7, stage: 8, page: 9, inner: 10, menu: 11, dialog: 12, veil: 12, wash: 12, pictures: 12,
  block: 13, mapCard: 13,
} as const;

/** The last step whose members read their role. */
const MOVED_THROUGH = 13;

const C = "src/components/";
const LAYOUT = "src/app/(workspace)/layout.module.css";
const m = (step: number, role: Role, file: string, selector: string, parts: Part[], what: string): Member =>
  ({ step, role, file, selector, parts, what });
const st = (step: number, role: Role, file: string, selector: string, parts: Part[], what: string): Member =>
  ({ step, role, file, selector, parts, what, state: true });
const GLASS: Part[] = ["fill", "blur", "shadow"];
/** A card, menu or dialog draws its ground, its blur, its edge and its
 * shadow from its role, so a look that restates any of them reaches it. */
const FULL: Part[] = ["fill", "blur", "edge", "shadow"];
/** The same, on the menu's stronger edge. */
const STRONG: Part[] = ["fill", "blur", "edge-strong", "shadow"];
/** A chosen tab, entry or knob: the role's ground, blur and shadow, and no edge. */
const CHIP: Part[] = ["fill", "blur", "shadow"];
/** Drawn on the role's ground with its shadow: a pictured surface. */
const GROUND: Part[] = ["fill", "shadow"];
/** A pictured card on the page. */
const CARD: Part[] = ["fill", "edge", "shadow"];

/** The roles with no edge: what floats as glass or over a map draws its
 * shape with the fill and the shadow alone, in every look. */
const EDGELESS: Role[] = ["glass-chrome", "glass-panel", "overlay-panel", "overlay-control"];
/** The roles with no blur: a block lies inside a panel, which shows it
 * nothing but the panel's own fill to blur. */
const BLURLESS: Role[] = ["block"];
/** A block drawn on the raised tone, and one drawn on the panel tone. */
const BLOCK: Part[] = ["fill", "edge", "shadow"];
const BLOCK_PANEL: Part[] = ["fill-panel", "edge", "shadow"];

/** What a member draws of its own in place of one of its role's parts, and
 * why; the rest of the role it reads, so a look reaches it there. */
type Own = { file: string; selector: string; part: "fill" | "blur" | "edge" | "shadow"; why: string };
const CHOSEN_EDGE = "a chosen tab, entry or knob draws no edge";

/** What reads a step, a strength or a tone directly instead of a role, held
 * to the exact value it writes once its step has moved: a primary button's
 * shadow is a step, not a role, and a named exception keeps a value of its
 * own beside the step it reads. */
type Direct = { step: number; file: string; selector: string; property: string; value: string; what: string };
const OPENED_RAIL = [
  ':global(:root:not([data-look-rail="icons"]):not([data-look-rail="open"])) .rail:has(:focus-visible)',
  ".rail[data-expanded]",
];
/** The wash: one raised level under a small map while it loads or fails,
 * and the connection form's URL tray. */
const WASHES = [
  [C + "TablePreviewMap.module.css", ".notice", "the wash under the dataset page's preview map"],
  [C + "TablePreviewMap.module.css", ".errorWrap", "the wash under the dataset page's preview map, failed"],
  [C + "map/FeaturePreviewMap.module.css", ".notice", "the wash under a feature's preview map"],
  [C + "sql/SqlConsole.module.css", ".mapNotice", "the wash under the SQL page's map"],
  [C + "workflow-canvas/ResultsBand.module.css", ".mapNotice", "the wash under the canvas results' map"],
  [C + "connections/ConnectionForm.module.css", ".urlBox", "the connection form's URL tray"],
] as const;
export const DIRECT: Direct[] = [
  ...OPENED_RAIL.flatMap(selector => [
    { step: STEP.chrome, file: LAYOUT, selector, property: "background", value: "var(--bg-panel)", what: "the side rail opened over the page, solid" },
    {
      step: STEP.chrome, file: LAYOUT, selector, property: "backdrop-filter", value: "var(--blur-glass)",
      what: "the side rail opened over the page keeps the glass strength, whatever a look makes of the rail at rest",
    },
    {
      step: STEP.chrome, file: LAYOUT, selector, property: "box-shadow", value: "var(--shadow-lift), 16px 0 36px -18px var(--shadow)",
      what: "the side rail opened over the page: the lift and its one side layer",
    },
  ]),
  { step: STEP.chrome, file: C + "builder/publish/PublishControl.module.css", selector: ".trigger", property: "box-shadow", value: "var(--shadow-float)", what: "Publish before publishing" },
  { step: STEP.chrome, file: C + "workflow-canvas/WorkflowCanvas.module.css", selector: ".runChrome .runAction[data-run-action]", property: "box-shadow", value: "var(--shadow-float)", what: "Run all" },
  { step: STEP.chrome, file: C + "templates/TemplateView.module.css", selector: ".copyAction", property: "box-shadow", value: "var(--shadow-float)", what: "Make a copy, a template's one action" },
  { step: STEP.chrome, file: C + "gallery.module.css", selector: ".ghost .plus", property: "box-shadow", value: "var(--shadow-float)", what: "the create tile's disc, the face of the New button" },
  { step: STEP.chrome, file: C + "projects/EmptyHome.module.css", selector: ".plateGlyph", property: "box-shadow", value: "var(--shadow-float)", what: "the empty project's glyph, the same face" },
  {
    step: STEP.overlay, file: C + "viewer/PublishedView.module.css", selector: ".attribution", property: "background", value: "color-mix(in srgb, var(--bg) 55%, transparent)",
    what: "a published page's credit chip keeps its ground-tone fill",
  },
  { step: STEP.overlay, file: C + "viewer/PublishedView.module.css", selector: ".attribution", property: "backdrop-filter", value: "var(--blur-overlay)", what: "a published page's credit chip takes the overlay strength" },
  // The veil behind every dialog: its ink and its blur, a veil and not a panel.
  { step: STEP.veil, file: C + "ui/Dialog.module.css", selector: ".scrim", property: "background", value: "var(--fill-veil)", what: "the dialog's veil" },
  { step: STEP.veil, file: C + "ui/Dialog.module.css", selector: ".scrim", property: "backdrop-filter", value: "var(--blur-veil)", what: "the dialog's veil, its blur" },
  ...WASHES.map(([file, selector, what]) => ({ step: STEP.wash, file, selector, property: "background", value: "var(--fill-wash)", what })),
  // The Appearance tab's picture of the rail opened over the page: the rail's exception, drawn small.
  ...["background", "box-shadow"].map(property => ({
    step: STEP.pictures, file: C + "settings/LookPictures.module.css", selector: '[role="radio"]:hover .art[data-picture-rail="hover"] .smRail', property,
    value: property === "background" ? "var(--bg-panel)" : "var(--shadow-lift), 16px 0 36px -18px var(--shadow)",
    what: "pictured: the side rail opened over the page, solid on the lift with its side layer",
  })),
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
  st(STEP.panel, "glass-panel", C + "builder/drawer/RecipeDrawer.module.css", '.drawer[data-overlay="true"]', ["shadow"], "the drawer and the pane overlaying the stage"),
  m(STEP.panel, "glass-panel", C + "templates/TemplateView.module.css", ".panel", GLASS, "How it's made beside a template's map or canvas"),
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
  st(STEP.control, "overlay-control", C + "map/StageStack.module.css", ".stageBtn:hover", ["grow"], "the zoom and stage buttons growing on hover"),
  m(STEP.control, "overlay-control", C + "MiniMap.module.css", ".polyActions button", GLASS, "the mini-map's action buttons"),
  m(STEP.control, "overlay-control", C + "gallery.module.css", ".acts", GLASS, "a card's hover pill"),
  m(STEP.control, "overlay-control", C + "sharing/PeopleMarks.module.css", '.ownerPill[data-placement="corner"]', GLASS, "a card's owner mark"),
  m(STEP.control, "overlay-control", C + "projects/ProjectPicture.module.css", ".mark", GLASS, "a project picture's kind mark"),
  m(STEP.control, "overlay-control", C + "workflow-canvas/NoteNode.module.css", ".menu", GLASS, "the note's colour bar"),
  // The stage: the map card and the framed canvas, no fill of their own; a look restates only their shadow
  m(STEP.stage, "stage", C + "builder/MapBuilder.module.css", ".canvasCol", ["shadow"], "the map card"),
  m(STEP.stage, "stage", C + "workflow-canvas/WorkflowCanvas.module.css", '.host[data-view="framed"] .flowArea', ["shadow"], "the framed canvas"),
  // Page card: a card on a page
  m(STEP.page, "page-card", C + "gallery.module.css", ".card", FULL, "the gallery card"),
  st(STEP.page, "page-card", C + "gallery.module.css", ".card:hover", ["shadow-hover", "edge-hover"], "the gallery card lifting on hover"),
  m(STEP.page, "page-card", C + "gallery.module.css", ".listCard", FULL, "the gallery's list view card"),
  m(STEP.page, "page-card", C + "settings/SettingsCard.module.css", ".card", FULL, "a Settings card"),
  m(STEP.page, "page-card", C + "settings/SettingsFrame.module.css", ".column", FULL, "the Settings tab column"),
  m(STEP.page, "page-card", C + "sql/SqlConsole.module.css", ".editorCard", FULL, "the SQL editor card"),
  m(STEP.page, "page-card", C + "sql/SqlConsole.module.css", ".resultsCard", FULL, "the SQL results card"),
  m(STEP.page, "page-card", C + "connections/ConnectionDetail.module.css", ".card", FULL, "the connection detail card"),
  m(STEP.page, "page-card", C + "connections/NewConnectionScreen.module.css", ".card", FULL, "the new-connection card"),
  m(STEP.page, "page-card", C + "set-geometry/SetGeometryPanel.module.css", ".dock", FULL, "the set-geometry panel"),
  // Its ground is the map's raised tone under a map still loading, kept.
  m(STEP.page, "page-card", C + "TablePreviewMap.module.css", ".pane", ["blur", "edge", "shadow"], "the dataset page's preview card"),
  // Inner card: a card inside a panel or card, and a control that carries a small shadow.
  // Its ground and edge are read wherever the member draws the panel tone
  // or the hairline today; a ground or edge of the member's own (a node
  // tile's group colour, a slider thumb's accent ring, a handle's ring)
  // stays its own, and the accent of a drag grip or handle is the mark part.
  m(STEP.inner, "inner-card", C + "builder/LayerList.module.css", ".card", FULL, "a layer card"),
  st(STEP.inner, "inner-card", C + "builder/LayerList.module.css", ".floating", ["shadow-dragged"], "a layer card dragged"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".tBox", ["fill", "blur", "shadow"], "a node tile"),
  st(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".member[data-sel] .tBox", ["shadow-lifted"], "a node tile selected"),
  st(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".member[data-drag] .tBox", ["shadow-dragged"], "a node tile dragged"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/WorkflowCanvas.module.css", ".dragGhost", ["fill", "blur", "shadow-dragged"], "an operation dragged onto the canvas"),
  m(STEP.inner, "inner-card", C + "AddToMapDialog.module.css", ".card, .newCard", ["fill", "blur", "edge"], "a pickable card in a dialog"),
  st(STEP.inner, "inner-card", C + "AddToMapDialog.module.css", ".card:hover:not(:disabled), .newCard:hover:not(:disabled)", ["shadow-lifted"], "a pickable card in a dialog, on hover"),
  st(STEP.inner, "inner-card", C + "AddToMapDialog.module.css", ".newCard", ["edge-new"], "the card that makes a new map, its dashed line"),
  m(STEP.inner, "inner-card", C + "QueryAreaPicker.module.css", ".cats button[data-active], .subs button[data-active]", CHIP, "a pickable card in a dialog, picked"),
  m(STEP.inner, "inner-card", C + "AreaSemanticsToggle.module.css", ".seg button[data-active]", CHIP, "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "ui/Switch.module.css", ".switch::before", CHIP, "a switch's knob"),
  m(STEP.inner, "inner-card", C + "ui/Slider.module.css", ".slider::-webkit-slider-thumb", ["knob", "blur", "shadow"], "a slider's thumb"),
  m(STEP.inner, "inner-card", C + "ui/Slider.module.css", ".slider::-moz-range-thumb", ["knob", "blur", "shadow"], "a slider's thumb"),
  m(STEP.inner, "inner-card", C + "builder/drawer/ParameterForm.module.css", '.modeBtn[aria-pressed="true"]', CHIP, "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "builder/style-panel/BreakBrush.module.css", ".thumb::-webkit-slider-thumb", CHIP, "the break brush's thumb"),
  m(STEP.inner, "inner-card", C + "builder/style-panel/BreakBrush.module.css", ".thumb::-moz-range-thumb", CHIP, "the break brush's thumb"),
  m(STEP.inner, "inner-card", C + "builder/export/ExportImageCard.module.css", ".frameSashGrip", ["mark", "blur", "shadow"], "a drag grip"),
  m(STEP.inner, "inner-card", C + "MiniMap.module.css", ".handle", ["mark", "blur", "shadow"], "the mini-map's handles"),
  m(STEP.inner, "inner-card", C + "MiniMap.module.css", ".measure", ["blur", "shadow"], "the mini-map's labels"),
  m(STEP.inner, "inner-card", C + "connections/PostgisPane.module.css", '.segmented button[aria-pressed="true"]', CHIP, "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "workflow-canvas/ResultsBand.module.css", ".scopeBtn[data-on]", CHIP, "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "sql/SqlConsole.module.css", ".tabs button[data-on]", CHIP, "a segmented control's active tab"),
  m(STEP.inner, "inner-card", C + "sql/SqlConsole.module.css", ".card", ["fill", "blur", "edge"], "a history card in the SQL pane"),
  st(STEP.inner, "inner-card", C + "sql/SqlConsole.module.css", ".card:hover", ["shadow-lifted", "edge-hover"], "a history card on hover"),
  m(STEP.inner, "inner-card", C + "SourceNav.module.css", ".source[data-active]", CHIP, "a source rail's active entry"),
  // Block: a block inside a panel, on the raised tone or the panel tone,
  // with the hairline and no shadow of its own today. Fields, selects,
  // code, segmented tracks and the dashed actions that add something stay
  // their own: a field is where a person types.
  ...([
    [C + "builder/StylePanel.module.css", ".segment", BLOCK_PANEL, "a visualization's tile in the inspector"],
    [C + "builder/PaletteControl.module.css", ".head", BLOCK, "the palette's row"],
    [C + "builder/FilterSection.module.css", ".filter", BLOCK, "a filter's card"],
    [C + "builder/LegendTab.module.css", ".item", BLOCK, "a legend entry in the legend tab"],
    [C + "builder/WidgetsTab.module.css", ".row", BLOCK_PANEL, "a widget's row in the widgets tab"],
    [C + "builder/WidgetsTab.module.css", ".typeTile", BLOCK_PANEL, "a widget kind's tile"],
    [C + "builder/BasemapPanel.module.css", ".card", BLOCK, "a basemap's card"],
    [C + "builder/CustomBasemapSection.module.css", ".form", BLOCK, "the custom basemap's form"],
    [C + "builder/drawer/ParameterForm.module.css", ".picker", BLOCK, "a tool's dataset picker"],
    [C + "builder/drawer/ParameterForm.module.css", ".result", BLOCK, "a tool's result block"],
    [C + "builder/AssistantPanel.module.css", ".user", ["fill", "shadow"], "the person's own message to the Assistant"],
    [C + "builder/AssistantPanel.module.css", ".action", BLOCK, "an action the Assistant took"],
    [C + "builder/AssistantPanel.module.css", ".proposal", BLOCK, "a change the Assistant proposes"],
    [C + "builder/assistant/TalkingAbout.module.css", ".chip", BLOCK, "what the Assistant is talking about"],
    [C + "builder/assistant/ModelPicker.module.css", ".chip", BLOCK, "the Assistant's model chip"],
  ] as const).map(([file, selector, parts, what]) => m(STEP.block, "block", file, selector, [...parts], what)),
  // Map card: a card floating over a map on the panel tone, with the hairline and no shadow today.
  m(STEP.mapCard, "map-card", C + "widgets/Widgets.module.css", ".card", FULL, "a widget's card over the map"),
  m(STEP.mapCard, "map-card", C + "widgets/Widgets.module.css", ".menu", FULL, "a widget card's menu"),
  // Menu and pop-over: what opens over something and closes. Its ground and
  // edge are read wherever the member draws the panel tone or the hairline
  // today; the stronger edge and the map's raised tooltip, popup and
  // failure notice read their own two parts; the hint's hover tone and the
  // export frame, whose ground is the image's, stay their own.
  ...([
    [C + "ExportMenu.module.css", ".menu", FULL, "a menu"],
    [C + "builder/LayerList.module.css", ".menu", FULL, "the layer menu"],
    [C + "builder/assistant/ModelPicker.module.css", ".menu", STRONG, "the model picker"],
    [C + "builder/export/ExportControl.module.css", ".menu", FULL, "the export menu"],
    [C + "connections/ConnectionMenu.module.css", ".menu", FULL, "the connection menu"],
    [C + "projects/ProjectHome.module.css", ".menu", FULL, "the project menu"],
    [C + "scope/ScopeFilter.module.css", ".menu", FULL, "the scope filter"],
    [C + "sharing/ShareDialog.module.css", ".results", FULL, "the share dialog's results"],
    [C + "sharing/ShareDialog.module.css", ".menu", FULL, "the share dialog's menu"],
    [C + "sql/SqlConsole.module.css", ".menu", STRONG, "the SQL page's menu"],
    [C + "sql/SqlConsole.module.css", ".peek", STRONG, "the SQL peek"],
    [C + "sql/SqlConsole.module.css", ".mapTip", STRONG, "the SQL map's tooltip"],
    [C + "map/BasemapPicker.module.css", ".panel", STRONG, "the basemap picker"],
    [C + "builder/FilterSection.module.css", ".picker", STRONG, "the filter pop-over"],
    [C + "builder/publish/PublishControl.module.css", ".pop", FULL, "the publish pop-over"],
    [C + "builder/search/SearchControl.module.css", ".panel", FULL, "the search results"],
    [C + "workflow-canvas/InputPicker.module.css", ".pop", FULL, "the input picker"],
    [C + "SaveResultAsDataset.module.css", ".panel", FULL, "the save result pop-over"],
    [C + "gallery.module.css", ".tip", FULL, "the gallery's tip"],
    [C + "ui/HintLayer.module.css", ".bubble", ["blur", "edge-strong", "shadow"], "the kit's hint"],
    [C + "map/search-marker.module.css", ".chip", FULL, "the search marker's name chip"],
    [C + "QueryDrawer.module.css", ".drawer", FULL, "the query drawer"],
    [C + "map/MapCanvas.module.css", ".tooltip", ["fill-raised", "blur", "edge-strong", "shadow"], "the map's tooltip"],
    [C + "map/MapCanvas.module.css", ".popup", ["fill-raised", "blur", "edge-strong", "shadow"], "the map's popup"],
    [C + "map/MapCanvas.module.css", ".webglFailureCard", ["fill-raised", "blur", "edge-strong", "shadow"], "the map's failure notice"],
    [C + "TablePreviewMap.module.css", ".refusal", FULL, "the preview map's refusal plate"],
    [C + "builder/export/ExportComposition.module.css", ".frame[data-presentation]", ["blur", "shadow"], "the export card's preview frame"],
  ] as const).map(([file, selector, parts, what]) => m(STEP.menu, "menu", file, selector, [...parts], what)),
  st(STEP.menu, "menu", C + "QueryDrawer.module.css", ".drawer[data-accent]", ["shadow"], "the query drawer, accented"),
  // Dialog
  m(STEP.dialog, "dialog", C + "ui/Dialog.module.css", ".dialog", FULL, "every modal"),
  // The Appearance tab's pictures, each reading the role it pictures: its
  // ground and edge where the picture draws them as the app does, so a
  // picture shows what the app does.
  m(STEP.pictures, "page-card", C + "settings/LookPictures.module.css", ".art .bgCard", GROUND, "pictured: a card on the page"),
  m(STEP.pictures, "glass-chrome", C + "settings/LookPictures.module.css", ".art .coHead", GLASS, "pictured: the header card"),
  m(STEP.pictures, "glass-chrome", C + "settings/LookPictures.module.css", ".art .coRail", GLASS, "pictured: the side rail at rest"),
  m(STEP.pictures, "inner-card", C + "settings/LookPictures.module.css", ".coSwitch::after", GROUND, "pictured: a switch's knob"),
  m(STEP.pictures, "inner-card", C + "settings/LookPictures.module.css", ".ctSwitch::after", GROUND, "pictured: a switch's knob"),
  m(STEP.pictures, "page-card", C + "settings/LookPictures.module.css", ".art .fnCard", GROUND, "pictured: a card on the page"),
  m(STEP.pictures, "page-card", C + "settings/LookPictures.module.css", ".art .crCard", CARD, "pictured: a card on the page"),
  m(STEP.pictures, "glass-chrome", C + "settings/LookPictures.module.css", ".art .smRail", GLASS, "pictured: the side rail at rest"),
  m(STEP.pictures, "glass-chrome", C + "settings/LookPictures.module.css", ".art .pnHead", GLASS, "pictured: the header card over a map"),
  m(STEP.pictures, "glass-chrome", C + "settings/LookPictures.module.css", ".art .pnRail", GLASS, "pictured: the side menu over a map"),
  m(STEP.pictures, "overlay-panel", C + "settings/LookPictures.module.css", ".art .pnCard", GLASS, "pictured: a panel read over a map"),
  m(STEP.pictures, "menu", C + "settings/LookPictures.module.css", ".art .smHint", ["shadow"], "pictured: the kit's hint"),
];

/** The members that keep one of their role's parts as their own, named. */
export const OWN: Own[] = [
  { file: C + "set-geometry/WorldInset.module.css", selector: ".inset", part: "fill", why: "the inset is a picture of the world: its pixels are its ground" },
  { file: C + "set-geometry/WorldInset.module.css", selector: ".inset", part: "blur", why: "nothing shows through a picture to blur" },
  { file: C + "TablePreviewMap.module.css", selector: ".pane", part: "fill", why: "its ground is the map's raised tone, seen only while the map loads" },
  { file: C + "workflow-canvas/WorkflowCanvas.module.css", selector: ".tBox", part: "edge", why: "a node tile's edge is its group's colour, what tells one group from another" },
  { file: C + "workflow-canvas/WorkflowCanvas.module.css", selector: ".dragGhost", part: "edge", why: "the accent ring marks what is being dragged" },
  { file: C + "AddToMapDialog.module.css", selector: ".card, .newCard", part: "shadow", why: "a pickable card rests flat and lifts on hover" },
  { file: C + "sql/SqlConsole.module.css", selector: ".card", part: "shadow", why: "a history card rests flat and lifts on hover" },
  { file: C + "builder/AssistantPanel.module.css", selector: ".user", part: "edge", why: "the person's own message draws no line around it" },
  ...([
    [C + "QueryAreaPicker.module.css", ".cats button[data-active], .subs button[data-active]"],
    [C + "AreaSemanticsToggle.module.css", ".seg button[data-active]"],
    [C + "ui/Switch.module.css", ".switch::before"],
    [C + "builder/drawer/ParameterForm.module.css", '.modeBtn[aria-pressed="true"]'],
    [C + "connections/PostgisPane.module.css", '.segmented button[aria-pressed="true"]'],
    [C + "workflow-canvas/ResultsBand.module.css", ".scopeBtn[data-on]"],
    [C + "sql/SqlConsole.module.css", ".tabs button[data-on]"],
    [C + "SourceNav.module.css", ".source[data-active]"],
  ] as const).map(([file, selector]) => ({ file, selector, part: "edge" as const, why: CHOSEN_EDGE })),
  { file: C + "builder/export/ExportImageCard.module.css", selector: ".frameSashGrip", part: "edge", why: "a drag grip draws no edge" },
  ...[".slider::-webkit-slider-thumb", ".slider::-moz-range-thumb"].map(selector =>
    ({ file: C + "ui/Slider.module.css", selector, part: "edge" as const, why: "the accent ring marks a slider's thumb" })),
  ...[".thumb::-webkit-slider-thumb", ".thumb::-moz-range-thumb"].map(selector =>
    ({ file: C + "builder/style-panel/BreakBrush.module.css", selector, part: "edge" as const, why: "the ink ring marks a break's handle" })),
  { file: C + "MiniMap.module.css", selector: ".handle", part: "edge", why: "a handle's ring in the panel tone sets it off the map" },
  { file: C + "MiniMap.module.css", selector: ".measure", part: "fill", why: "a measure carries its words in the accent's ink, which reads only on the accent" },
  { file: C + "MiniMap.module.css", selector: ".measure", part: "edge", why: "a label pill draws no edge" },
  { file: C + "ui/HintLayer.module.css", selector: ".bubble", part: "fill", why: "the hover tone tells a hint from a menu" },
  { file: C + "builder/export/ExportComposition.module.css", selector: ".frame[data-presentation]", part: "fill", why: "the image's ground is the composition's, inside the default look" },
  { file: C + "builder/export/ExportComposition.module.css", selector: ".frame[data-presentation]", part: "edge", why: "a frame around an image draws no edge" },
];

/** A part a member reads in place of another: the ground through a knob, a
 * mark or the raised fill, the edge through the stronger one, the shadow
 * through one of its states. */
const STANDS_FOR: Record<"fill" | "blur" | "edge" | "shadow", Part[]> = {
  fill: ["fill", "knob", "mark", "fill-raised", "fill-panel"],
  blur: ["blur"],
  edge: ["edge", "edge-strong", "edge-hover", "edge-new"],
  shadow: ["shadow", "shadow-lifted", "shadow-dragged", "shadow-hover"],
};

/** The parts a member of a role a look reaches reads, or names as its own:
 * the ground, blur and shadow, and the edge where the role has one. */
const owed = (role: Role): ("fill" | "blur" | "edge" | "shadow")[] =>
  (EDGELESS.includes(role) ? ["fill", "blur", "shadow"] as const : ["fill", "blur", "edge", "shadow"] as const)
    .filter(part => part !== "blur" || !BLURLESS.includes(role));

/** What a member's rule misses of its role's parts; empty when it reads them
 * all or names the rest as its own. The stage, a state and a picture are
 * held to the parts they list. */
export function fullSetProblems(members: readonly Member[], own: readonly Own[]): string[] {
  const problems: string[] = [];
  const named = (member: Member, part: string) => own.some(entry => entry.file === member.file && entry.selector === member.selector && entry.part === part);
  for (const member of members) {
    if (member.state || member.role === "stage" || member.step === STEP.pictures) continue;
    for (const part of owed(member.role)) {
      const reads = STANDS_FOR[part].some(read => member.parts.includes(read));
      if (!reads && !named(member, part)) problems.push(`${member.file} ${member.selector} reads no ${part} of its role and names none of its own`);
      if (reads && named(member, part)) problems.push(`${member.file} ${member.selector} reads its role's ${part} and also names one of its own`);
    }
  }
  for (const entry of own) {
    if (!members.some(member => member.file === entry.file && member.selector === entry.selector)) problems.push(`${entry.file} ${entry.selector} is not a member`);
  }
  return problems;
}

/** The property each part is read by: the ground through the background
 * shorthand alone, so a look's fill (one colour, or a colour over a mix)
 * replaces any image a member's state lays under it. */
const PROPERTY: Record<Part, RegExp> = {
  fill: /^background$/,
  blur: /^(-webkit-)?backdrop-filter$/,
  edge: /^border$/,
  shadow: /^box-shadow$/,
  corner: /^border-radius$/,
  "shadow-hover": /^box-shadow$/,
  "shadow-lifted": /^box-shadow$/,
  "shadow-dragged": /^box-shadow$/,
  grow: /^transform$/,
  "edge-strong": /^border$/,
  "edge-hover": /^border$/,
  "edge-new": /^border$/,
  knob: /^background$/,
  mark: /^background$/,
  "fill-raised": /^background$/,
  "fill-panel": /^background$/,
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

/** A value with every reference to the block's own tokens written out: the
 * role as an image's default scope computes it, against that scope's tones. */
function resolveThroughBlock(value: string): string {
  const globals = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const body = [...globals.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) => selectors.includes("[data-look-default]"))![2];
  const tokens = new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, v]) => [name, v.trim()]));
  const resolve = (v: string): string => v.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => (tokens.has(name) ? resolve(tokens.get(name)!) : whole));
  return resolve(value);
}

describe("the members of each role", () => {
  it("name rules that exist, each once in the table", () => {
    const missing = MEMBERS.filter(member => !declarations(read(member.file), member.selector)).map(member => `${member.file} ${member.selector}`);
    expect(missing).toEqual([]);
    const keys = MEMBERS.map(member => `${member.file} ${member.selector}`);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
    // Every role has members, and the frame runs in the roles' order.
    const roles: Role[] = ["glass-chrome", "glass-panel", "overlay-panel", "overlay-control", "map-card", "stage", "page-card", "inner-card", "block",
      "menu", "dialog"];
    for (const role of roles) expect(MEMBERS.some(member => member.role === role), role).toBe(true);
  });

  it("read their role once it has moved, typing none of its values", () => {
    const moved = MEMBERS.filter(member => member.step <= MOVED_THROUGH);
    expect(moved.flatMap(member => memberProblems(member, read(member.file)))).toEqual([]);
  });

  it("read every part of their role a look can restate, or name the part they keep as their own", () => {
    expect(fullSetProblems(MEMBERS, OWN)).toEqual([]);
    // Every named part is one the member really draws itself: it reads no role there.
    const stale = OWN.flatMap(entry => {
      const member = MEMBERS.find(candidate => candidate.file === entry.file && candidate.selector === entry.selector)!;
      const property = { fill: /^background$/, blur: /backdrop-filter$/, edge: /^border$/, shadow: /^box-shadow$/ }[entry.part];
      return (declarations(read(member.file), member.selector) ?? [])
        .filter(([name, value]) => property.test(name) && value.includes(`--surface-${member.role}-`))
        .map(([name, value]) => `${entry.selector} names its ${entry.part} its own but reads ${name}: ${value}`);
    });
    expect(stale).toEqual([]);
  });

  it("fails a member whose table drops a part it owes, and a named part it also reads", () => {
    const card = MEMBERS.find(member => member.selector === ".card" && member.file.endsWith("gallery.module.css"))!;
    const dropped = MEMBERS.map(member => member === card ? { ...member, parts: member.parts.filter(part => part !== "blur") } : member);
    expect(fullSetProblems(dropped, OWN)).toEqual([`${card.file} .card reads no blur of its role and names none of its own`]);
    const doubled = [...OWN, { file: card.file, selector: ".card", part: "fill" as const, why: "seeded" }];
    expect(fullSetProblems(MEMBERS, doubled)).toEqual([`${card.file} .card reads its role's fill and also names one of its own`]);
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
    const resolve = resolveThroughBlock;
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

  it("grow a stage button on hover, line a gallery card and a history card under the pointer, dash the card that makes a new map, edge the map's tooltip, popup and failure notice and light a slider's thumb from their roles, at today's values", () => {
    const value = (file: string, selector: string, property: string) =>
      resolveThroughBlock(Object.fromEntries(declarations(read(C + file), selector)!)[property]);
    // Each as it was drawn before it read a role, written out here.
    expect(value("map/StageStack.module.css", ".stageBtn:hover", "transform")).toBe("scale(1.06)");
    // A gallery card under the pointer shows the stronger line it showed.
    expect(value("gallery.module.css", ".card:hover", "border")).toBe("1px solid var(--border-strong)");
    // So does a history card in the SQL pane, and the card that makes a new map keeps its dashed line.
    expect(value("sql/SqlConsole.module.css", ".card:hover", "border")).toBe("1px solid var(--border-strong)");
    expect(value("AddToMapDialog.module.css", ".newCard", "border")).toBe("1px dashed var(--border-strong)");
    for (const selector of [".tooltip", ".popup", ".webglFailureCard"]) {
      expect(value("map/MapCanvas.module.css", selector, "border"), selector).toBe("1px solid var(--border-strong)");
    }
    for (const selector of [".slider::-webkit-slider-thumb", ".slider::-moz-range-thumb"]) {
      expect(value("ui/Slider.module.css", selector, "background"), selector).toBe("#fff");
      // The accent ring marks the thumb: its own edge, never a role's.
      expect(Object.fromEntries(declarations(read(C + "ui/Slider.module.css"), selector)!).border, selector).toBe("1.5px solid var(--accent)");
    }
  });

  it("draw the blocks inside panels and the widget cards over the map from their roles at the values they had", () => {
    if (STEP.block > MOVED_THROUGH) return;
    // Each as it was drawn before it read a role, written out here: the raised or the panel tone, the hairline, no shadow, no blur.
    for (const member of MEMBERS.filter(candidate => candidate.role === "block" || candidate.role === "map-card")) {
      const drawn = Object.fromEntries(declarations(read(member.file), member.selector)!);
      const tone = member.parts.includes("fill") && member.role === "block" ? "var(--bg-raised)" : "var(--bg-panel)";
      expect(resolveThroughBlock(drawn.background), member.selector).toBe(tone);
      expect(resolveThroughBlock(drawn["box-shadow"]), member.selector).toBe("none");
      if (member.parts.includes("edge")) expect(resolveThroughBlock(drawn.border), member.selector).toBe("1px solid var(--border)");
      if (member.role === "map-card") expect(resolveThroughBlock(drawn["backdrop-filter"]), member.selector).toBe("none");
      else expect(drawn["backdrop-filter"], member.selector).toBeUndefined();
    }
  });

  it("dress every dialog and its veil from the role and the veil's tokens at the values they had", () => {
    if (STEP.dialog > MOVED_THROUGH) return;
    const css = read(C + "ui/Dialog.module.css");
    const dialog = Object.fromEntries(declarations(css, ".dialog")!);
    const scrim = Object.fromEntries(declarations(css, ".scrim")!);
    // The dialog and its veil as they were drawn before they read a role, written out here.
    expect(resolveThroughBlock(dialog.background)).toBe("var(--bg-panel)");
    expect(resolveThroughBlock(dialog.border)).toBe("1px solid var(--border)");
    expect(resolveThroughBlock(dialog["border-radius"])).toBe("var(--radius-card)");
    expect(resolveThroughBlock(dialog["box-shadow"])).toBe("0 30px 80px var(--shadow)");
    expect(resolveThroughBlock(scrim.background)).toBe("color-mix(in srgb, var(--fg) 32%, transparent)");
    expect(resolveThroughBlock(scrim["backdrop-filter"])).toBe("blur(4px)");
  });

  it("draw the wash at its one level wherever a small map loads or fails, and on the connection form's URL tray", () => {
    if (STEP.wash > MOVED_THROUGH) return;
    expect(WASHES.map(([file, selector]) => resolveThroughBlock(Object.fromEntries(declarations(read(file), selector)!).background)))
      .toEqual(WASHES.map(() => "color-mix(in srgb, var(--bg-raised) 70%, transparent)"));
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
    // Its ground is the inner card's fill under its group tint: today's colour to the digit.
    expect(tile.background).toContain("var(--surface-inner-card-fill)");
    expect(resolveThroughBlock(tile.background)).toBe("color-mix(in srgb, var(--gc, var(--fg-muted-palette)) 12%, var(--bg-panel))");
    // Selected, the ring is drawn first, so it paints above the shadow as it did.
    expect(Object.fromEntries(declarations(canvas, ".member[data-sel] .tBox")!)["box-shadow"])
      .toBe("0 0 0 3px var(--accent-dim), var(--surface-inner-card-shadow-lifted)");
  });

  it("open every menu and pop-over solid, the map's tooltip and popup on their own raised tone, the accented drawer keeping its ring", () => {
    if (STEP.menu > MOVED_THROUGH) return;
    // Solid: no member fills itself with a see-through mix or blurs what is behind it.
    const menus = MEMBERS.filter(member => member.role === "menu");
    expect(menus.flatMap(menu => (declarations(read(menu.file), menu.selector) ?? [])
      .filter(([property, value]) => (/^background(-color)?$/.test(property) && /transparent/.test(value))
        || (/backdrop-filter$/.test(property) && value !== "var(--surface-menu-blur)"))
      .map(([property, value]) => `${menu.selector} in ${menu.file}: ${property}: ${value}`))).toEqual([]);
    const canvas = read(C + "map/MapCanvas.module.css");
    for (const selector of [".tooltip", ".popup", ".webglFailureCard"]) {
      expect(Object.fromEntries(declarations(canvas, selector)!).background, selector).toBe("var(--surface-menu-fill-raised)");
      expect(resolveThroughBlock(Object.fromEntries(declarations(canvas, selector)!).background), selector).toBe("var(--bg-raised)");
    }
    // The accent ring is drawn first, so it paints above the shadow as it did.
    expect(Object.fromEntries(declarations(read(C + "QueryDrawer.module.css"), ".drawer[data-accent]")!)["box-shadow"])
      .toBe("0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent), var(--surface-menu-shadow)");
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
    // A read dropped from the stylesheet, and a ground read through background-color.
    expect(memberProblems(legend, moved.replace("  backdrop-filter: var(--surface-overlay-panel-blur);\n", "")))
      .toEqual([".legend does not read var(--surface-overlay-panel-blur)"]);
    expect(memberProblems(legend, moved.replace("background: var(", "background-color: var(")))
      .toEqual([".legend does not read var(--surface-overlay-panel-fill)"]);
  });

  it("keep the side rail opened over the page at today's blur: the glass strength the rail at rest reads by default", () => {
    if (STEP.chrome > MOVED_THROUGH) return;
    const rest = Object.fromEntries(declarations(read(LAYOUT), ".rail")!);
    expect(resolveThroughBlock(rest["backdrop-filter"])).toBe("blur(18px)");
    for (const selector of OPENED_RAIL) {
      expect(resolveThroughBlock(Object.fromEntries(declarations(read(LAYOUT), selector)!)["backdrop-filter"]), selector).toBe("blur(18px)");
    }
  });

  it("fails a direct read that types its value or loses its side layer", () => {
    const rail = DIRECT.find(direct => direct.selector === ".rail[data-expanded]" && direct.property === "box-shadow")!;
    const opened = ".rail[data-expanded] {\n  background: var(--bg-panel);\n  box-shadow:\n    var(--shadow-lift),\n    16px 0 36px -18px var(--shadow);\n}";
    expect(directProblems(rail, opened)).toEqual([]);
    expect(directProblems(rail, opened.replace("var(--shadow-lift)", "0 10px 30px var(--shadow)"))).toHaveLength(1);
    expect(directProblems(rail, opened.replace(",\n    16px 0 36px -18px var(--shadow)", ""))).toHaveLength(1);
  });
});
