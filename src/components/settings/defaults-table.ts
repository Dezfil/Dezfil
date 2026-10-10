import type { ThumbStyle } from "@/components/map/BasemapThumb";
import { isBasemapKey, OFFERED_SETTING } from "@/lib/basemap";
import type { INSTANCE_DEFAULT_SETTINGS, InstanceDefaultKey, InstanceDefaultValue } from "@/lib/settings/instance-defaults";
import { PALETTES } from "@/lib/style/palettes";
import { imageryState } from "./libraries-table";
import type { ReadSetting } from "./server-set";

/**
 * What new maps, new layers, the workflow canvas, the SQL console and a
 * fresh image export card start with, as three tabs draw it: Maps,
 * Workflows & SQL and Publishing, each card's rows under the labels the
 * page shows, mapped by key onto the configuration read. The read
 * supplies what a choice offers, a number's range, the default and the
 * kept value; this table supplies the words, the order, the unit written
 * after a number and how far an arrow key steps it. A test holds it
 * against the read, so a new default with no row here fails.
 */

export type DefaultsTabId = "maps" | "workflows" | "publishing";

/** One setting a row draws. A row draws one, or a few side by side (the
 * starting view's three numbers, the three opacities), each then named
 * by its own label. */
export interface DefaultsField {
  readonly key: InstanceDefaultKey;
  /** Its own name, where its row draws several. */
  readonly label?: string;
  /** The unit written after a number; none where absent. A choice's unit
   * is in its words. */
  readonly unit?: string;
  /** How far an arrow key moves a number: a whole step, a finer one, or
   * any amount. */
  readonly step?: number | "any";
}

export interface DefaultsRow {
  /** The row's address inside its tab. */
  readonly id: string;
  readonly label: string;
  /** The quiet line under the label. */
  readonly meta?: string;
  /** Words the search also finds the row by. */
  readonly keys: string;
  /** The control takes the row's width, under its label. */
  readonly stack?: boolean;
  readonly fields: readonly DefaultsField[];
}

export interface DefaultsCard {
  readonly id: string;
  readonly title: string;
  /** Words the search matches the card by. */
  readonly keys: string;
  /** The quiet line under the title. */
  readonly lead?: string;
  readonly rows: readonly DefaultsRow[];
}

const one = (key: InstanceDefaultKey, words: Omit<DefaultsField, "key" | "label"> = {}): readonly DefaultsField[] => [{ key, ...words }];

export const DEFAULTS_TABS: { readonly [T in DefaultsTabId]: readonly DefaultsCard[] } = {
  maps: [
    { id: "card-new-maps", title: "New maps", keys: "defaults new map create", lead: "Maps you already have keep their settings.", rows: [
      { id: "set-basemap", label: "Basemap", keys: "background map style auto dark light streets satellite basemap", stack: true,
        fields: one("newMap.basemap") },
      { id: "set-starting-view", label: "Starting view", keys: "zoom centre center place camera latitude longitude extent start view", stack: true,
        fields: [
          { key: "newMap.latitude", label: "Latitude", step: "any" },
          { key: "newMap.longitude", label: "Longitude", step: "any" },
          { key: "newMap.zoom", label: "Zoom", step: "any" },
        ] },
    ] },
    { id: "card-legend", title: "Legend", keys: "legend overlays map furniture", rows: [
      { id: "set-legend-corner", label: "Legend corner", keys: "legend position place corner", fields: one("newMap.legendCorner") },
    ] },
    { id: "card-new-layers", title: "New layers", keys: "layer style defaults new layers", rows: [
      { id: "set-color-cycle", label: "Color cycle", keys: "colour colors palette first layer qualitative cycle", fields: one("newLayer.colorCycle") },
      { id: "set-opacity", label: "Opacity", keys: "transparency fill alpha points lines areas", fields: [
        { key: "newLayer.pointOpacity", label: "Points", unit: "%", step: 1 },
        { key: "newLayer.lineOpacity", label: "Lines", unit: "%", step: 1 },
        { key: "newLayer.areaOpacity", label: "Areas", unit: "%", step: 1 },
      ] },
      { id: "set-line-width", label: "Line width", keys: "stroke thickness", fields: one("newLayer.lineWidth", { unit: "px", step: 0.5 }) },
      { id: "set-point-radius", label: "Point radius", keys: "size dot marker circle", fields: one("newLayer.pointRadius", { unit: "px", step: 0.5 }) },
    ] },
  ],
  workflows: [
    { id: "card-workflow-canvas", title: "Workflow canvas", keys: "workflow canvas defaults", lead: "Someone’s own choice on the canvas still wins.", rows: [
      { id: "set-canvas-opens", label: "Canvas opens", keys: "full screen framed view fill the screen", fields: one("canvas.opens") },
      { id: "set-minimap", label: "Minimap", meta: "Automatic shows it at 6 nodes or more.", keys: "minimap overview map navigator",
        fields: one("canvas.minimap") },
      { id: "set-results-band", label: "Results band", meta: "A closed band opens at the first run.",
        keys: "results band table messages bottom panel open closed collapsed", fields: one("canvas.resultsBand") },
    ] },
    { id: "card-sql-console", title: "SQL console", keys: "sql console editor query", rows: [
      { id: "set-sql-text-size", label: "Text size", keys: "sql editor font size code", fields: one("sqlConsole.textSize") },
      { id: "set-sql-line-wrap", label: "Line wrap", keys: "sql editor wrap long lines soft wrap", fields: one("sqlConsole.lineWrap") },
    ] },
  ],
  publishing: [
    { id: "publishing-export", title: "Image export", keys: "export image png download picture", rows: [
      { id: "set-export-width", label: "Starting width", keys: "export image size pixels px wide default", fields: one("imageExport.width") },
      { id: "set-export-shape", label: "Starting shape", keys: "export image aspect ratio shape default", fields: one("imageExport.shape") },
    ] },
  ],
};

type DefaultDefinition = (typeof INSTANCE_DEFAULT_SETTINGS)[number];
/** The defaults picked from a list. */
export type ChoiceDefaultKey = Extract<DefaultDefinition, { readonly write: { readonly kind: "choice" } }>["key"];

/** The categorical palettes a new layer's colors may cycle through, by the
 * names the palette picker shows. */
const CYCLES = Object.fromEntries(PALETTES.filter(palette => palette.kind === "categorical").map(palette => [palette.name, palette.label])) as
  Readonly<Record<InstanceDefaultValue<"newLayer.colorCycle">, string>>;

/** The words each choice is shown with, in the order the read offers them. */
export const CHOICE_WORDS: { readonly [K in ChoiceDefaultKey]: Readonly<Record<Extract<InstanceDefaultValue<K>, string>, string>> } = {
  "newMap.basemap": { auto: "Auto", dark: "Dark", light: "Light", streets: "Streets", satellite: "Satellite" },
  "newMap.legendCorner": { "top-left": "Top left", "top-right": "Top right", "bottom-left": "Bottom left", "bottom-right": "Bottom right" },
  "newLayer.colorCycle": CYCLES,
  "canvas.opens": { full: "Full screen", framed: "Framed" },
  "canvas.minimap": { auto: "Automatic", always: "Always", never: "Never" },
  "canvas.resultsBand": { closed: "Closed", open: "Open" },
  "sqlConsole.textSize": { "11": "11 px", "12": "12 px", "13": "13 px", "14": "14 px", "16": "16 px" },
  "imageExport.width": { "1280": "1280 px", "1920": "1920 px", "2560": "2560 px" },
  "imageExport.shape": { "16:9": "16:9", "4:3": "4:3", "1:1": "1:1" },
};

/** A choice's words; a value it does not word (one the read no longer
 * offers) shows as itself. */
export function choiceWords(key: InstanceDefaultKey, value: unknown): string {
  const words: Readonly<Record<string, string>> | undefined = (CHOICE_WORDS as Readonly<Record<string, Readonly<Record<string, string>>>>)[key];
  return words?.[String(value)] ?? String(value ?? "");
}

/** Every row the tabs draw, or one tab's, top to bottom. */
export function defaultsRows(tab?: DefaultsTabId): DefaultsRow[] {
  const tabs = tab ? [DEFAULTS_TABS[tab]] : Object.values(DEFAULTS_TABS);
  return tabs.flatMap(cards => cards.flatMap(card => card.rows));
}

/** Every setting the tabs draw, or one tab's, in the order they show. */
export function defaultsFields(tab?: DefaultsTabId): DefaultsField[] {
  return defaultsRows(tab).flatMap(row => row.fields);
}

/** The label each default is shown under, by key: its own where its row
 * draws several, else its row's. */
export const DEFAULTS_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  defaultsRows().flatMap(row => row.fields.map(field => [field.key, field.label ?? row.label])));

type Settings = Readonly<Record<string, ReadSetting>>;

/** The values a choice offers, as the read gives them. */
export function choiceValues(setting: ReadSetting | undefined): readonly string[] {
  return setting?.write?.kind === "choice" ? setting.write.values : [];
}

/** The basemaps a new map may start on here: what the builder's picker
 * offers. Auto always; each style unless an admin hid it on Libraries,
 * Satellite only while imagery is set up and its address readable. */
export function offeredBasemaps(settings: Settings): ThumbStyle[] {
  const imagery = imageryState(settings) === "ready";
  return choiceValues(settings["newMap.basemap"])
    .filter((value): value is ThumbStyle => value === "auto" || isBasemapKey(value))
    .filter(value => value !== "satellite" || imagery)
    .filter(value => value === "auto" || settings[OFFERED_SETTING[value]]?.value !== false);
}

/** A basemap as a new map starts on it: one no longer offered is Auto. */
export const startsOn = (value: unknown, offered: readonly ThumbStyle[]): ThumbStyle =>
  offered.find(style => style === value) ?? "auto";

/** A row's value in the words its tab shows it with, as the search reads
 * it: a choice in its words (a basemap the instance no longer offers as
 * Auto), a switch On or Off, a number with its unit; a row of several
 * names each, "Latitude 40, longitude 0, zoom 1.3". */
export function rowValueWords(row: DefaultsRow, settings: Settings): string {
  const words = row.fields.map(field => {
    const value = settings[field.key]?.value;
    if (field.key === "newMap.basemap") return choiceWords(field.key, startsOn(value, offeredBasemaps(settings)));
    if (typeof value === "boolean") return value ? "On" : "Off";
    if (typeof value === "number") return field.unit ? `${value} ${field.unit}` : String(value);
    return value === null || value === undefined ? "" : choiceWords(field.key, value);
  });
  if (row.fields.length === 1) return words[0];
  return row.fields.map((field, index) => `${index ? (field.label ?? "").toLowerCase() : field.label} ${words[index]}`).join(", ");
}
