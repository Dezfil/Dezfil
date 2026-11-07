import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookAttributes, lookChoices } from "@/lib/look";

/**
 * The text that left the faint ink, under every look. Each declaration
 * below once set readable text in the faint ink, or faded it, and now sets
 * it in the ink its role gives it: muted for what explains or adds a
 * secondary fact, the kicker ink for the small uppercase group labels,
 * full ink for what you act on, accent for a link (the note action also
 * takes the link hover).
 *
 * Each one is resolved through the stylesheets as the cascade orders them
 * (the root's tokens, the body's quiet inks, then the rule's own custom
 * properties) under every Color, theme, Contrast and Panels look, Liquid at
 * each of its steps, Dezfil's default look among them. It must come to the
 * same colour as its role's ink there, and never to the faint ink. Tokens
 * only: nothing is rendered.
 *
 * Every declaration is read in the workspace's scope. Published pages and
 * server images restate their own inks and never take the person's look.
 */

type RGBA = [number, number, number, number];
type Role = "muted" | "kicker" | "full" | "accent" | "link";
type CssRule = { selectors: string[]; context: string; decls: [string, string][] };
type Scope = { label: string; attrs: Map<string, string> };
type Finding = { id: string; scope: string; problem: string };

/** Each role's ink, as the rule spells it on an element. */
const ROLE_INK: Record<Role, string> = {
  muted: "var(--fg-muted)",
  kicker: "color-mix(in srgb, var(--fg) 10%, var(--fg-muted))",
  full: "var(--fg)",
  accent: "var(--accent)",
  link: "var(--accent)",
};
const LINK_HOVER = "var(--accent-bright)";
const FAINT = "var(--fg-faint)";

/** The moved declarations, by role: a stylesheet's rule as `file :: selector`,
 * or a style set in code as the faint boundary names it. */
const MOVED: Record<Role, string[]> = {
  muted: [
    "src/components/AddDataDialog.module.css :: .scopeNote",
    "src/components/ExportMenu.module.css :: .menu a small",
    "src/components/MiniMap.module.css :: .legendRow[data-off]",
    "src/components/OsmPane.module.css :: .field small",
    "src/components/OsmPane.module.css :: .hint",
    "src/components/OverturePane.module.css :: .cityEmpty",
    "src/components/OverturePane.module.css :: .cityList small",
    "src/components/OverturePane.module.css :: .hint",
    "src/components/OverturePane.module.css :: .level small",
    "src/components/OverturePane.module.css :: .levelLoading",
    "src/components/PictureCredit.module.css :: .page",
    "src/components/ProjectsScreen.module.css :: .nothing",
    "src/components/ResultGrid.module.css :: .empty",
    "src/components/SourceNav.module.css :: .sourceText small",
    "src/components/TableDetailScreen.module.css :: .previewNote",
    "src/components/TablePreviewGrid.module.css :: .grid tr[data-bad] td",
    "src/components/UrlImportPane.module.css :: .hint",
    "src/components/builder/AssistantPanel.module.css :: .checkWords [data-provisional]",
    "src/components/builder/AssistantPanel.module.css :: .elapsed",
    "src/components/builder/AssistantPanel.module.css :: .hint",
    "src/components/builder/AssistantPanel.module.css :: .inspectionInput dt",
    "src/components/builder/AssistantPanel.module.css :: .toolId",
    "src/components/builder/BasemapPanel.module.css :: .groupAbsent",
    "src/components/builder/BasemapPanel.module.css :: .groupRow[data-absent] .groupLabel",
    "src/components/builder/BasemapPanel.module.css :: .groupRow[data-off=\"true\"] .groupLabel",
    "src/components/builder/BasemapPanel.module.css :: .note",
    "src/components/builder/BasemapPanel.module.css :: .thumbCredit",
    "src/components/builder/FilterSection.module.css :: .truncated, .loading, .noMatch",
    "src/components/builder/LayerList.module.css :: .empty",
    "src/components/builder/LayerList.module.css :: .menu a small, .menu button small",
    "src/components/builder/LegendTab.module.css :: .attrLabel",
    "src/components/builder/LegendTab.module.css :: .empty",
    "src/components/builder/MapBuilder.module.css :: .mapCredit",
    "src/components/builder/PaletteControl.module.css :: .emptyHint",
    "src/components/builder/PaletteControl.module.css :: .stopPct",
    "src/components/builder/StatusBar.module.css :: .key",
    "src/components/builder/StylePanel.module.css :: .editHint",
    "src/components/builder/UnsavedFields.module.css :: .mark",
    "src/components/builder/WidgetsTab.module.css :: .empty",
    "src/components/builder/WidgetsTab.module.css :: .row[data-hidden] .name",
    "src/components/builder/add-layer/AddLayerCatalog.module.css :: .scopeNote",
    "src/components/builder/assistant/ModelPicker.module.css :: .identity",
    "src/components/builder/assistant/TalkingAbout.module.css :: .label",
    "src/components/builder/draw/draw.module.css :: .pillFaint",
    "src/components/builder/export/ExportControl.module.css :: .menu .doorText small",
    "src/components/builder/export/ExportControl.module.css :: .menu .layerMeta",
    "src/components/builder/export/ExportControl.module.css :: .menu a small, .menu button small",
    "src/components/builder/export/ExportImageCard.module.css :: .chipSub",
    "src/components/builder/export/ExportImageCard.module.css :: .hint",
    "src/components/builder/export/ExportImageCard.module.css :: .metaHint",
    "src/components/builder/search/SearchControl.module.css :: .attribution",
    "src/components/builder/style-panel/IconPicker.module.css :: .note",
    "src/components/builder/style-panel/LabelSection.module.css :: .note",
    "src/components/column-matching/ColumnMatchingStep.module.css :: .keep",
    "src/components/connections/ConnectionDetail.module.css :: .cardHead > span",
    "src/components/connections/ConnectionDetail.module.css :: .facts dt",
    "src/components/connections/ConnectionDetail.module.css :: .snapshotMain small span",
    "src/components/connections/ConnectionDetail.module.css :: .title small",
    "src/components/connections/ConnectionForm.module.css :: .field em",
    "src/components/connections/ConnectionForm.module.css :: .note, .sslNote",
    "src/components/connections/PostgisPane.module.css :: .columnPending",
    "src/components/connections/PostgisPane.module.css :: .estimateFact[data-unknown]",
    "src/components/connections/PostgisPane.module.css :: .field em",
    "src/components/connections/PostgisPane.module.css :: .importActions span",
    "src/components/connections/PostgisPane.module.css :: .kindMark, .systemMark",
    "src/components/connections/PostgisPane.module.css :: .loading, .empty",
    "src/components/connections/PostgisPane.module.css :: .noMatches",
    "src/components/connections/PostgisPane.module.css :: .pickEmpty",
    "src/components/connections/PostgisPane.module.css :: .previewEmpty",
    "src/components/connections/PostgisPane.module.css :: .previewHead",
    "src/components/connections/PostgisPane.module.css :: .previewTable th small",
    "src/components/connections/PostgisPane.module.css :: .refusal",
    "src/components/connections/PostgisPane.module.css :: .relationRows[data-unknown]",
    "src/components/connections/PostgisPane.module.css :: .server",
    "src/components/gallery.module.css :: .cardWhen",
    "src/components/gallery.module.css :: .ghost small",
    "src/components/gallery.module.css :: .projCell[data-none]",
    "src/components/home/Home.module.css :: .cnt",
    "src/components/map/BasemapPicker.module.css :: .thumbCredit",
    "src/components/map/LegendPanel.module.css :: .rampCenter",
    "src/components/map/MapCanvas.module.css :: .tipKey",
    "src/components/map/TimelineBar.module.css :: .extent",
    "src/components/projects/AddItemsDialog.module.css :: .stateRow",
    "src/components/projects/AddItemsDialog.module.css :: .tabCount",
    "src/components/projects/AddToProjectDialog.module.css :: .dsMeta",
    "src/components/projects/AddToProjectDialog.module.css :: .pMeta",
    "src/components/projects/AddToProjectDialog.module.css :: .pickEmpty",
    "src/components/projects/ExportProjectDialog.module.css :: .emptyGroup",
    "src/components/projects/ExportProjectDialog.module.css :: .ext",
    "src/components/projects/ExportProjectDialog.module.css :: .meta",
    "src/components/projects/ExportProjectDialog.module.css :: .selHead small",
    "src/components/projects/ExportProjectDialog.module.css :: .sub",
    "src/components/projects/ExportProjectDialog.module.css :: .treeNote",
    "src/components/projects/HomeSections.module.css :: .cnt",
    "src/components/projects/RecentList.module.css :: .recentHead i",
    "src/components/projects/RecentList.module.css :: .stateRow",
    "src/components/scope/ScopeFilter.module.css :: .faceCount",
    "src/components/scope/ScopeFilter.module.css :: .rowCount",
    "src/components/set-geometry/SetGeometryPanel.module.css :: .formatExample",
    "src/components/set-geometry/SetGeometryPanel.module.css :: .keep",
    "src/components/settings/AppearancePreview.module.css :: .faint",
    "src/components/sharing/MembersLine.module.css :: .face[data-off]",
    "src/components/sharing/MembersLine.module.css :: .members[data-none] em",
    "src/components/sharing/ShareDialog.module.css :: .row[data-off] .avatar",
    "src/components/sharing/ShareDialog.module.css :: .row[data-off] .identity b, .row[data-off] .identity small, .row[data-off] .sqlName",
    "src/components/sql-editor-extensions.ts :: completionLook > \".cm-completionDetail\" > color",
    "src/components/sql/SqlConsole.module.css :: .browserEmpty, .historyEmpty",
    "src/components/sql/SqlConsole.module.css :: .cardWhen",
    "src/components/sql/SqlConsole.module.css :: .grid td[data-kind=\"geometry\"]",
    "src/components/sql/SqlConsole.module.css :: .mapTipKey",
    "src/components/sql/SqlConsole.module.css :: .menuItem span",
    "src/components/sql/SqlConsole.module.css :: .resEmpty",
    "src/components/sql/SqlConsole.module.css :: .rowMeta",
    "src/components/sql/SqlConsole.module.css :: .tabCount",
    "src/components/sql/SqlConsole.module.css :: .thType",
    "src/components/templates/TemplateView.module.css :: .count",
    "src/components/templates/TemplateView.module.css :: .steps code",
    "src/components/templates/Templates.module.css :: .credit",
    "src/components/users/UsersScreen.module.css :: .row[data-off] .avatar",
    "src/components/users/UsersScreen.module.css :: .row[data-off] .person b, .row[data-off] .email",
    "src/components/viewer/CursorReadout.module.css :: .readout",
    "src/components/viewer/PublishedView.module.css :: .attribution",
    "src/components/viewer/PublishedView.module.css :: .attribution a",
    "src/components/widgets/Widgets.module.css :: .crow",
    "src/components/workflow-canvas/InputPicker.module.css :: .fact",
    "src/components/workflow-canvas/InputPicker.module.css :: .name[data-unset]",
    "src/components/workflow-canvas/InputPicker.module.css :: .none",
    "src/components/workflow-canvas/InputPicker.module.css :: .unset .name",
    "src/components/workflow-canvas/InputPicker.module.css :: .why",
    "src/components/workflow-canvas/ResultsBand.module.css :: .count",
    "src/components/workflow-canvas/ResultsBand.module.css :: .empty",
    "src/components/workflow-canvas/ResultsBand.module.css :: .entry[data-lv=\"info\"] .lv",
    "src/components/workflow-canvas/ResultsBand.module.css :: .ts",
    "src/components/workflow-canvas/WorkflowCanvas.module.css :: .changeRow .was",
    "src/components/workflow-canvas/WorkflowCanvas.module.css :: .cnt",
    "src/components/workflow-canvas/WorkflowCanvas.module.css :: .colType",
    "src/components/workflow-canvas/WorkflowCanvas.module.css :: .edgeWord[data-time=\"lineage\"]",
    "src/components/workflow-canvas/WorkflowCanvas.module.css :: .emptyNote",
    "src/components/workflow-canvas/WorkflowCanvas.module.css :: .paneEmpty",
    "src/components/workflow-canvas/WorkflowCanvas.module.css :: .paneLock",
    "src/components/workflow-canvas/WorkflowCanvas.module.css :: .planList li[data-current] b::after",
    "src/components/workflow-canvas/WorkflowCanvas.module.css :: .rowMeta",
    "src/components/workflow-canvas/WorkflowCanvas.module.css :: .tabCount",
  ],
  kicker: [
    "src/components/MiniMap.module.css :: .legend > b",
    "src/components/OsmPane.module.css :: .sectT",
    "src/components/OverturePane.module.css :: .sectT",
    "src/components/builder/LegendTab.module.css :: .orderNote",
    "src/components/builder/PaletteControl.module.css :: .groupHeading",
    "src/components/builder/add-layer/AddLayerCatalog.module.css :: .groupEyebrow",
    "src/components/builder/assistant/ModelPicker.module.css :: .head",
    "src/components/builder/search/SearchControl.module.css :: .groupHead",
    "src/components/builder/style-panel/IconPicker.module.css :: .glyphGroupLabel",
    "src/components/connections/PostgisPane.module.css :: .schemaHead",
    "src/components/connections/PostgisPane.module.css :: .sectionTitle",
    "src/components/map/LegendPanel.module.css :: .channelHead",
    "src/components/templates/TemplateView.module.css :: .facts dt",
    "src/components/workflow-canvas/InputPicker.module.css :: .eyebrow",
  ],
  full: [
    "src/components/builder/CustomBasemapSection.module.css :: .door",
    "src/components/builder/draw/DrawPill.tsx :: DrawPill <button.pillDelete> \"Done\" style > color",
    "src/components/builder/style-panel/IconPicker.module.css :: .door",
  ],
  accent: [
    "src/components/PictureRendererNotice.module.css :: .notice a",
    "src/components/ResultGrid.module.css :: .colType",
    "src/components/TablePreviewGrid.module.css :: .colType",
    "src/components/builder/LegendTab.module.css :: .reset",
  ],
  link: [
    "src/components/projects/ProjectHome.module.css :: .noteEdit",
  ],
};

/** The styles set in code: where each colour is written in its file. */
const CODE: Record<string, RegExp> = {
  "src/components/builder/draw/DrawPill.tsx :: DrawPill <button.pillDelete> \"Done\" style > color":
    /className=\{styles\.pillDelete\}\s*style=\{\{\s*color:\s*"([^"]+)"/,
  "src/components/sql-editor-extensions.ts :: completionLook > \".cm-completionDetail\" > color":
    /"\.cm-completionDetail":\s*\{[^}]*?\bcolor:\s*"([^"]+)"/,
};

/** Hover rules written under a stronger selector than the rule at rest, so
 * they outrank another sheet's hover over the same element. A rule named
 * here must exist and set the link hover. */
const HOVER: Record<string, string> = {
  "src/components/PictureRendererNotice.module.css :: .notice a": ".notice a[href]:hover",
};

/* ---- the stylesheets ---- */

/** Split at a separator that stands outside brackets, parentheses and quotes. */
function splitTop(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", current = "";
  for (const char of text) {
    if (quote) { if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    if (!quote && depth === 0 && char === separator) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Every style rule of a stylesheet, comments removed, with the grouping at-rules around it. */
function cssRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const walk = (start: number, end: number, context: string[]) => {
    let head = start;
    for (let at = start; at < end; at += 1) {
      if (text[at] === ";") { head = at + 1; continue; }
      if (text[at] !== "{") continue;
      let depth = 1, close = at + 1;
      for (; close < end && depth > 0; close += 1) depth += text[close] === "{" ? 1 : text[close] === "}" ? -1 : 0;
      const prelude = text.slice(head, at).trim().replace(/\s+/g, " ");
      if (prelude.startsWith("@")) {
        if (/^@(media|supports|container|layer|scope)\b/.test(prelude)) walk(at + 1, close - 1, [...context, prelude]);
      } else if (prelude) {
        out.push({
          selectors: splitTop(prelude, ",").map(selector => selector.replace(/\s+/g, " ")),
          context: context.join(" "),
          decls: splitTop(text.slice(at + 1, close - 1), ";").flatMap(part => {
            const colon = part.indexOf(":");
            if (colon < 1) return [];
            const property = part.slice(0, colon).trim();
            return [[property.startsWith("--") ? property : property.toLowerCase(),
              part.slice(colon + 1).replace(/\s+/g, " ").replace(/!\s*important$/i, "").trim()] as [string, string]];
          }),
        });
      }
      at = close - 1;
      head = close;
    }
  };
  walk(0, text.length, []);
  return out;
}

const keyOf = (rule: CssRule) => (rule.context ? `${rule.context} { ${rule.selectors.join(", ")} }` : rule.selectors.join(", "));
const customs = (rule: CssRule) => new Map(rule.decls.filter(([property]) => property.startsWith("--")));
const readSource = (file: string) => readFileSync(file, "utf8");

/** The shipped sheets in the order the document loads them. */
const SHEET_FILES = ["src/app/globals.css", "src/app/look.css", "src/app/look-liquid.css", "src/app/look-paper.css"];
const SHEETS = SHEET_FILES.map(readSource);

/* ---- the root and the body under a look ---- */

type Part = { name: string; value: string | null; not: boolean };
type OnChain = { level: 0 | 1; parts: Part[]; specificity: number };
const PART = /^(?::not\(\[([\w-]+)(?:="([^"]*)")?\]\)|\[([\w-]+)(?:="([^"]*)")?\])/;

/** A selector on the workspace's root (level 0) or its body (level 1), with
 * the root's conditions and its specificity; null for any other element. */
function onChain(selector: string): OnChain | null {
  if (selector === "body") return { level: 1, parts: [], specificity: 1 };
  const match = /^:root(\S*?)( body)?$/.exec(selector);
  if (!match) return null;
  const parts: Part[] = [];
  for (let rest = match[1]; rest; ) {
    const part = PART.exec(rest);
    if (!part) return null;
    parts.push(part[1] ? { name: part[1], value: part[2] ?? null, not: true } : { name: part[3], value: part[4] ?? null, not: false });
    rest = rest.slice(part[0].length);
  }
  // :root and each attribute or :not() count as classes; body as a type.
  return { level: match[2] ? 1 : 0, parts, specificity: (1 + parts.length) * 100 + (match[2] ? 1 : 0) };
}

const holds = (part: Part, attrs: Map<string, string>) => {
  const has = part.value === null ? attrs.has(part.name) : attrs.get(part.name) === part.value;
  return part.not ? !has : has;
};

/** The custom properties the root and the body declare under a look, each
 * level's rules ordered by specificity and then by where they stand. Rules
 * inside an at-rule (a reduced-transparency request, a missing blur) are
 * not part of the look and are left out. */
function chainOf(sheets: string[], attrs: Map<string, string>): [Map<string, string>, Map<string, string>] {
  const found: { level: number; specificity: number; order: number; rule: CssRule }[] = [];
  let order = 0;
  for (const sheet of sheets) for (const rule of cssRules(sheet)) {
    order += 1;
    if (rule.context) continue;
    const hits = rule.selectors.map(onChain).filter((hit): hit is OnChain => hit !== null && hit.parts.every(part => holds(part, attrs)));
    for (const level of [0, 1]) {
      const best = Math.max(...hits.filter(hit => hit.level === level).map(hit => hit.specificity));
      if (Number.isFinite(best)) found.push({ level, specificity: best, order, rule });
    }
  }
  const level = (which: number) => new Map(found.filter(entry => entry.level === which)
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order).flatMap(entry => [...customs(entry.rule)]));
  return [level(0), level(1)];
}

const THEMES = ["light", "dark"] as const;
/** Every look a person can pick, as far as the inks go: each Color, theme,
 * Contrast and Panels look, Liquid at each step. Dezfil's default look is the
 * first. */
const SCOPES: Scope[] = lookChoices("color").flatMap(color => THEMES.flatMap(theme => lookChoices("contrast").flatMap(contrast =>
  lookChoices("panels").flatMap(panels => (panels === "liquid" ? lookChoices("transparency") : [lookChoices("transparency")[0]])
    .map(transparency => {
      const attrs = new Map(Object.entries(lookAttributes({ color, contrast, panels, transparency })) as [string, string][]);
      if (theme === "dark") attrs.set("data-theme", "dark");
      return { label: `${color} ${theme} ${contrast} ${panels}${panels === "liquid" ? ` ${transparency}` : ""}`, attrs };
    })))));

/* ---- colour arithmetic, as CSS Color 4 and 5 define it ---- */

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const toOklab = ([r, g, b]: RGBA) => {
  const [lr, lg, lb] = [r, g, b].map(linear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const fromOklab = ([L, A, B]: number[]): [number, number, number] => {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return rgb.map(c => Math.min(1, Math.max(0, gamma(c)))) as [number, number, number];
};

/** A colour value as computed on the element at `at` in a chain of
 * elements, each declaring custom properties: a reference takes the
 * nearest declaration at or above it, computed where it is declared. */
function colourAt(value: string, levels: Map<string, string>[], at: number, depth = 0): RGBA {
  if (depth > 12) throw new Error(`${value} refers too deep`);
  const text = value.trim();
  const reference = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.*))?\)$/.exec(text);
  if (reference) {
    for (let level = at; level >= 0; level -= 1) {
      const next = levels[level].get(reference[1]);
      if (next !== undefined) return colourAt(next, levels, level, depth + 1);
    }
    if (reference[2] !== undefined) return colourAt(reference[2], levels, at, depth + 1);
    throw new Error(`${reference[1]} is not declared`);
  }
  if (text === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(d => d + d).join("") : hex[1];
    const alpha = digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1;
    return [...[0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16) / 255), alpha] as RGBA;
  }
  const rgba = /^rgba?\(([^)]*)\)$/.exec(text);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1].split(",").map(part => part.trim());
    return [Number(r) / 255, Number(g) / 255, Number(b) / 255, Number(a)];
  }
  const mix = /^color-mix\(in (srgb|oklab), (.*)\)$/.exec(text);
  if (mix) {
    const [first, second] = splitTop(mix[2], ",").map(part => {
      const share = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(part);
      return share ? { colour: colourAt(share[1], levels, at, depth + 1), share: Number(share[2]) }
        : { colour: colourAt(part, levels, at, depth + 1), share: null };
    });
    // The shares: one missing is the rest of 100; a sum under 100 thins the result.
    const p = first.share ?? (second.share === null ? 50 : 100 - second.share), q = second.share ?? 100 - p;
    const sum = p + q, wp = p / sum, wq = q / sum;
    const alpha = first.colour[3] * wp + second.colour[3] * wq;
    if (alpha === 0) return [0, 0, 0, 0];
    const thinned = alpha * Math.min(1, sum / 100);
    if (mix[1] === "srgb") {
      const c = [0, 1, 2].map(i => (first.colour[i] * first.colour[3] * wp + second.colour[i] * second.colour[3] * wq) / alpha);
      return [c[0], c[1], c[2], thinned];
    }
    const a = toOklab(first.colour), b = toOklab(second.colour);
    return [...fromOklab(a.map((v, i) => (v * first.colour[3] * wp + b[i] * second.colour[3] * wq) / alpha)), thinned];
  }
  throw new Error(`${text}: not a colour this reading knows`);
}

/** Two colours an 8-bit screen cannot tell apart. */
const same = (a: RGBA, b: RGBA) => a.every((v, i) => Math.abs(v - b[i]) < 0.5 / 255);
const hexOf = (c: RGBA) => `#${c.slice(0, 3).map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}${c[3] < 1 ? ` at ${c[3].toFixed(2)}` : ""}`;

/* ---- the moved declarations ---- */

type Declared = { value: string; own: Map<string, string> };
type Located = { rest: Declared; hover: Declared | null } | { stale: string };

/** Where a listed declaration stands today: its text colour, the rule's own
 * custom properties, and its hover rule's colour when it sets one. */
function locate(id: string, role: Role, read: (file: string) => string): Located {
  const [file, key] = id.split(" :: ");
  const code = CODE[id];
  if (code) {
    const found = code.exec(read(file));
    return found ? { rest: { value: found[1], own: new Map() }, hover: null } : { stale: "the style set in code is gone" };
  }
  const all = cssRules(read(file));
  const hits = all.filter(rule => keyOf(rule) === key);
  if (hits.length !== 1) return { stale: hits.length ? `${hits.length} rules carry this selector` : "the rule is gone" };
  const colour = hits[0].decls.filter(([property]) => property === "color").at(-1);
  if (!colour) return { stale: "the rule sets no text colour" };
  const rest = { value: colour[1], own: customs(hits[0]) };
  const named = HOVER[id];
  const hovered = key.includes(",") && !named ? [] : all.filter(rule => keyOf(rule) === (named ?? `${key}:hover`));
  const hoverColour = hovered.flatMap(rule => rule.decls.filter(([property]) => property === "color")).at(-1);
  if ((role === "link" || named) && !hoverColour) return { stale: named ? `the hover rule ${named} sets no colour` : "the link has no hover colour" };
  const hover = role === "link" || role === "accent"
    ? (hoverColour ? { value: hoverColour[1], own: new Map([...rest.own, ...hovered.flatMap(rule => [...customs(rule)])]) } : null)
    : null;
  return { rest, hover };
}

/** Every listed declaration that misses its role's ink, or takes the faint
 * one, under each look. The sources and the sheets can be seeded. */
function inkFindings(moved: Partial<Record<Role, string[]>>, read = readSource, sheets = SHEETS): Finding[] {
  const chains = SCOPES.map(scope => ({ scope, chain: chainOf(sheets, scope.attrs) }));
  const out: Finding[] = [];
  for (const [role, ids] of Object.entries(moved) as [Role, string[]][]) for (const id of ids) {
    const found = locate(id, role, read);
    if ("stale" in found) { out.push({ id, scope: "", problem: found.stale }); continue; }
    for (const { scope, chain } of chains) {
      const judge = (declared: Declared, want: string, what: string) => {
        const levels = [chain[0], chain[1], declared.own];
        try {
          const [got, ink, faint] = [declared.value, want, FAINT].map(value => colourAt(value, levels, 2));
          if (same(got, faint)) out.push({ id, scope: scope.label, problem: `${what}: the faint ink` });
          else if (!same(got, ink)) out.push({ id, scope: scope.label, problem: `${what}: ${hexOf(got)}, not ${hexOf(ink)}` });
        } catch (error) {
          out.push({ id, scope: scope.label, problem: `${what}: ${(error as Error).message}` });
        }
      };
      judge(found.rest, ROLE_INK[role], `at rest, the ${role} ink`);
      if (found.hover) judge(found.hover, LINK_HOVER, "on hover, the link hover");
    }
  }
  return out;
}

/** One line per declaration and problem: how many looks it shows under,
 * and the first; a declaration that could not be read, on its own. */
function summary(findings: Finding[]): string[] {
  const groups = new Map<string, string[]>();
  for (const { id, scope, problem } of findings) {
    const problemKey = `${id} | ${problem.replace(/#[0-9a-f]{6}( at [\d.]+)?/g, "…")}`;
    groups.set(problemKey, [...(groups.get(problemKey) ?? []), scope]);
  }
  return [...groups].map(([problemKey, scopes]) =>
    (scopes[0] ? `${problemKey} | under ${scopes.length} look(s), first ${scopes[0]}` : problemKey));
}

const scopesOf = (findings: Finding[]) => new Set(findings.map(finding => finding.scope));
const at = (label: string, value: string) => {
  const scope = SCOPES.find(candidate => candidate.label === label);
  if (!scope) throw new Error(`no look ${label}`);
  const [root, body] = chainOf(SHEETS, scope.attrs);
  return colourAt(value, [root, body, new Map()], 2);
};
const literal = (value: string) => colourAt(value, [new Map()], 0);

describe("the text that left the faint ink, under every look", () => {
  it("resolves every moved declaration to its role's ink, and never to the faint ink, under every look", () => {
    expect(SCOPES).toHaveLength(lookChoices("color").length * THEMES.length * lookChoices("contrast").length
      * (lookChoices("panels").length - 1 + lookChoices("transparency").length));
    expect(SCOPES[0].label).toBe("kelp light standard glass");
    expect(SCOPES[0].attrs.size).toBe(0);
    expect(new Set(Object.values(MOVED).flat()).size).toBe(Object.values(MOVED).flat().length);
    expect(summary(inkFindings(MOVED))).toEqual([]);
  });

  it("reads each look's own version of the inks, as the stylesheets name them", () => {
    // The body's darker quiet ink by day, the palette's under More contrast and by night, Liquid's stepped one.
    const expected: [string, string, string][] = [
      ["kelp light standard glass", ROLE_INK.muted, "color-mix(in srgb, #243230 30%, #5f6f6b)"],
      ["kelp light more glass", ROLE_INK.muted, "#3e4c49"],
      ["kelp dark standard glass", ROLE_INK.muted, "#98a3b8"],
      ["harbor light standard paper", ROLE_INK.muted, "color-mix(in srgb, #292f38 30%, #616a75)"],
      ["slate dark more glass", ROLE_INK.muted, "#c8ccd2"],
      ["kelp light standard liquid clear", ROLE_INK.muted, "color-mix(in srgb, #243230 85%, #5f6f6b)"],
      ["kelp dark standard liquid firm", ROLE_INK.muted, "#98a3b8"],
      ["kelp light standard glass", ROLE_INK.kicker, "color-mix(in srgb, #243230 10%, color-mix(in srgb, #243230 30%, #5f6f6b))"],
      ["heather dark more glass", ROLE_INK.full, "#ecebf2"],
      ["harbor dark standard glass", ROLE_INK.accent, "#6ea2ee"],
      ["harbor dark standard glass", LINK_HOVER, "#93bbf6"],
      ["kelp light standard glass", FAINT, "color-mix(in srgb, #243230 18%, #93a19c)"],
      ["kelp dark standard glass", FAINT, "#5d6880"],
    ];
    for (const [label, value, want] of expected) {
      expect(hexOf(at(label, value)), `${value} under ${label}`).toBe(hexOf(literal(want)));
    }
    // The looks differ, so a reading that ignored them could not pass the first case by accident.
    expect(new Set(SCOPES.map(scope => hexOf(at(scope.label, ROLE_INK.muted)))).size).toBeGreaterThan(30);
  });

  it("fails on a hint in the palette's quiet ink, which misses the body's darker ink by day", () => {
    const seeded = { "x.module.css": ".hint { color: var(--fg-muted-palette); }" };
    const found = inkFindings({ muted: ["x.module.css :: .hint"] }, file => seeded[file as keyof typeof seeded] ?? readSource(file));
    const scopes = scopesOf(found);
    expect(scopes.has("kelp light standard glass")).toBe(true);
    expect(scopes.has("slate light standard paper")).toBe(true);
    expect(scopes.has("kelp dark standard glass")).toBe(false);
    expect(scopes.has("kelp light more glass")).toBe(false);
    expect(found[0].problem).toMatch(/^at rest, the muted ink: #[0-9a-f]{6}, not #[0-9a-f]{6}$/);
  });

  it("fails on the faint ink, written in the declaration or through a custom property of the rule's own", () => {
    const seeded: Record<string, string> = {
      "x.module.css": ".hint { color: var(--fg-faint); }\n.kicker { --ink: var(--fg-faint); color: var(--ink); }",
    };
    const found = inkFindings({ muted: ["x.module.css :: .hint"], kicker: ["x.module.css :: .kicker"] }, file => seeded[file] ?? readSource(file));
    for (const id of ["x.module.css :: .hint", "x.module.css :: .kicker"]) {
      const mine = found.filter(finding => finding.id === id);
      expect(mine, id).toHaveLength(SCOPES.length);
      expect(mine.every(finding => finding.problem.endsWith(": the faint ink")), id).toBe(true);
    }
  });

  it("fails on one look's colour written out, and on a kicker mixed from the palette's ink", () => {
    const seeded: Record<string, string> = {
      "x.module.css": ".hint { color: #98a3b8; }\n.kicker { color: color-mix(in srgb, var(--fg) 10%, var(--fg-muted-palette)); }",
    };
    const found = inkFindings({ muted: ["x.module.css :: .hint"], kicker: ["x.module.css :: .kicker"] }, file => seeded[file] ?? readSource(file));
    const hint = scopesOf(found.filter(finding => finding.id === "x.module.css :: .hint"));
    // Kelp's night ink is right by night under Glass and nowhere else.
    expect(hint.has("kelp dark standard glass")).toBe(false);
    expect(hint.has("harbor dark standard glass")).toBe(true);
    expect(hint.has("kelp light standard glass")).toBe(true);
    const kicker = scopesOf(found.filter(finding => finding.id === "x.module.css :: .kicker"));
    expect(kicker.has("heather light standard glass")).toBe(true);
    expect(kicker.has("heather dark standard glass")).toBe(false);
  });

  it("fails when a look's stylesheet hands the body the faint ink as its quiet one", () => {
    const liquid = SHEETS[2].replace("--fg-muted: var(--liquid-fg-muted);", "--fg-muted: var(--liquid-fg-faint);");
    expect(liquid).not.toBe(SHEETS[2]);
    const found = inkFindings({ muted: [MOVED.muted[0]] }, readSource, [SHEETS[0], SHEETS[1], liquid, SHEETS[3]]);
    expect(found.length).toBe(SCOPES.filter(scope => scope.label.includes(" liquid ")).length);
    expect(found.every(finding => finding.scope.includes(" liquid ") && finding.problem.endsWith(": the faint ink"))).toBe(true);
  });

  it("fails on a listed rule that is gone or sets no text colour, and on a link without its hover", () => {
    const seeded: Record<string, string> = {
      "x.module.css": ".quiet { font-size: 11px; }\n.link { color: var(--accent); }\n.lift { color: var(--accent); }\n.lift:hover { color: var(--fg-muted); }",
    };
    const read = (file: string) => seeded[file] ?? readSource(file);
    expect(summary(inkFindings({ muted: ["x.module.css :: .gone", "x.module.css :: .quiet"], link: ["x.module.css :: .link"] }, read))).toEqual([
      "x.module.css :: .gone | the rule is gone",
      "x.module.css :: .quiet | the rule sets no text colour",
      "x.module.css :: .link | the link has no hover colour",
    ]);
    const lift = inkFindings({ link: ["x.module.css :: .lift"] }, read);
    expect(lift).toHaveLength(SCOPES.length);
    expect(lift.every(finding => finding.problem.startsWith("on hover, the link hover: "))).toBe(true);
  });
});
