import type { SettingDefinition, SettingValue, WriteConstraint } from "./types";

/**
 * What new maps, new layers, the workflow canvas, the SQL console and the
 * image export card start with: stored instance settings an admin changes
 * and every signed-in account reads, applied to new things only. No
 * variable sets one, so none is ever locked. Each default value is the
 * product's own, the one a new thing started with before these settings
 * existed.
 *
 * Data only, like the rest of the catalogue: the lists a choice offers
 * restate the product's own (its basemaps, corners, categorical palettes,
 * image widths and shapes), held equal to them by the defaults' tests.
 * Number-like choices are text, so one validator and one schema shape
 * serve every choice; their readers parse them.
 */
const KIND_OF: Readonly<Record<WriteConstraint["kind"], SettingDefinition["kind"]>> = {
  integer: "number", decimal: "number", switch: "boolean", text: "text", choice: "choice",
};
function startsWith<const K extends string, const W extends WriteConstraint>(
  key: K, label: string, purpose: string, defaultValue: SettingValue, write: W, unit?: string,
): SettingDefinition & { readonly key: K; readonly write: W } {
  return {
    key, label, purpose, defaultValue,
    documentedDefault: typeof defaultValue === "boolean" ? (defaultValue ? "on" : "off") : String(defaultValue),
    scope: "instance", readBy: "signed-in", changedBy: "admin", kind: KIND_OF[write.kind],
    timing: "live", secret: false, editable: true, write, ...(unit ? { unit } : {}),
  };
}
const choice = <const V extends readonly string[]>(...values: V) => ({ kind: "choice", values }) as const;
const decimal = (min: number, max: number) => ({ kind: "decimal", min, max }) as const;
const integer = (min: number, max: number) => ({ kind: "integer", min, max }) as const;

export const INSTANCE_DEFAULT_SETTINGS = [
  startsWith("newMap.basemap", "Basemap", "The basemap a new map starts on. Auto follows the theme; a basemap the instance no longer offers starts on Auto.",
    "auto", choice("auto", "dark", "light", "streets", "satellite")),
  startsWith("newMap.latitude", "Starting latitude", "The latitude a new map opens at.", 40, decimal(-85, 85)),
  startsWith("newMap.longitude", "Starting longitude", "The longitude a new map opens at.", 0, decimal(-180, 180)),
  startsWith("newMap.zoom", "Starting zoom", "The zoom a new map opens at.", 1.3, decimal(0, 22)),
  startsWith("newMap.legendCorner", "Legend corner", "Where a new map's legend sits.",
    "bottom-left", choice("top-left", "top-right", "bottom-left", "bottom-right")),
  startsWith("newLayer.colorCycle", "Color cycle", "The palette whose colors new layers take in turn, drawn sketches included.",
    "uber_viz_qualitative", choice("uber_viz_qualitative", "bold", "tab10", "paired", "dark2", "set3")),
  startsWith("newLayer.pointOpacity", "Point opacity", "How opaque a new points layer is drawn, unless it is created with a style.", 72, integer(10, 100), "%"),
  startsWith("newLayer.lineOpacity", "Line opacity", "How opaque a new lines layer is drawn, unless it is created with a style.", 95, integer(10, 100), "%"),
  startsWith("newLayer.areaOpacity", "Area opacity", "How opaque a new areas layer is drawn, unless it is created with a style.", 50, integer(10, 100), "%"),
  startsWith("newLayer.lineWidth", "Line width", "How wide a new lines layer is drawn, unless it is created with a style.", 2, decimal(0.5, 50), "px"),
  startsWith("newLayer.pointRadius", "Point radius", "How large a new layer's points are drawn, unless it is created with a style.", 3, decimal(0.5, 100), "px"),
  startsWith("canvas.opens", "Canvas opens", "Whether a workflow canvas opens full screen or framed.", "full", choice("full", "framed")),
  startsWith("canvas.minimap", "Canvas minimap", "When a workflow canvas shows its minimap until the person chooses: auto shows it from six nodes.",
    "auto", choice("auto", "always", "never")),
  startsWith("canvas.resultsBand", "Canvas results band", "Whether a workflow canvas opens with its results band closed or open until the person chooses.",
    "closed", choice("closed", "open")),
  startsWith("sqlConsole.textSize", "SQL text size", "The text size the SQL console's editor opens at.", "12", choice("11", "12", "13", "14", "16"), "px"),
  startsWith("sqlConsole.lineWrap", "SQL line wrap", "Whether the SQL console's editor wraps long lines.", false, { kind: "switch" }),
  startsWith("imageExport.width", "Image starting width", "The width a fresh image export card opens at.", "1920", choice("1280", "1920", "2560"), "px"),
  startsWith("imageExport.shape", "Image starting shape", "The shape a fresh image export card opens at.", "4:3", choice("16:9", "4:3", "1:1")),
] as const;

export type InstanceDefaultKey = (typeof INSTANCE_DEFAULT_SETTINGS)[number]["key"];
type Definition<K extends InstanceDefaultKey> = Extract<(typeof INSTANCE_DEFAULT_SETTINGS)[number], { readonly key: K }>;

/** A default's stored value: one of its choices, true or false, or a number. */
export type InstanceDefaultValue<K extends InstanceDefaultKey> =
  Definition<K>["write"] extends { readonly kind: "choice"; readonly values: readonly (infer V)[] } ? V
    : Definition<K>["write"] extends { readonly kind: "switch" } ? boolean : number;
