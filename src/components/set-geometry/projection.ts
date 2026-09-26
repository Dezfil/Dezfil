import { GEOMETRY_PROJECTION_NAMES, type GeometryFormat, type GeometryRecord } from "@/lib/geometry-evidence";
import { acceptedColumns, type ColumnEntry } from "./columns";
import type { GeometryChoice, PanelChoice, PanelProjection, ProjectionEntry } from "./types";

/** The seven drawn entries in the drawn order (03 C). */
export const CURATED_PROJECTIONS: readonly ProjectionEntry[] = [4326, 3857, 25832, 25833, 3035, 27700, 4269].map(
  (epsg) => ({ epsg, name: GEOMETRY_PROJECTION_NAMES[epsg], unit: epsg === 4326 || epsg === 4269 ? "degrees" : "metres" }),
);

const isCurated = (code: number) => CURATED_PROJECTIONS.some((p) => p.epsg === code);

/** H3 and GeoJSON carry their own place; the API forbids a projection for both. */
export const takesProjection = (format: GeometryFormat) => format !== "h3" && format !== "geojson";

export const IMPLICIT: PanelProjection = { kind: "implicit", code: null, text: "" };
export const UNSET: PanelProjection = { kind: "unset", code: null, text: "" };

/** The projection a choice carries on open: the explicit code it already
 * had (a corrected UTM pair reopens under UTM), else implicit. */
export function carriedProjection(epsg: number | undefined): PanelProjection {
  if (epsg === undefined) return IMPLICIT;
  return isCurated(epsg) ? { kind: "explicit", code: epsg, text: "" } : { kind: "other", code: epsg, text: String(epsg) };
}

/** Parse the Other field as the API does: decimal digits with an optional EPSG: prefix. */
export function parseEpsgText(text: string): number | null {
  const m = /^(?:EPSG:)?([0-9]+)$/i.exec(text.trim());
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isSafeInteger(code) && code > 0 ? code : null;
}

/** The person picked an entry of the projection field: a curated code, or Other. */
export function chooseProjection(choice: PanelChoice, value: string): PanelChoice {
  if (value === "other") return { ...choice, projection: { kind: "other", code: null, text: "" } };
  const code = Number(value);
  return { ...choice, projection: { kind: "explicit", code, text: "" } };
}

export function typeOtherCode(choice: PanelChoice, text: string): PanelChoice {
  return { ...choice, projection: { kind: "other", code: parseEpsgText(text), text } };
}

/** The swap exchanges the two columns' roles, never their values. */
export function swapPair(choice: PanelChoice): PanelChoice {
  if (choice.format !== "pair" || choice.columns.length !== 2) return choice;
  return { ...choice, columns: [choice.columns[1], choice.columns[0]] };
}

/** A format change keeps the projection state and takes the first columns
 * the new format accepts, keeping a still-accepted column where it can. */
export function setFormat(
  choice: PanelChoice,
  format: GeometryFormat,
  columns: readonly ColumnEntry[],
  geometryColumn: string | null,
): PanelChoice {
  if (format === choice.format) return choice;
  const accepted = acceptedColumns(format, columns, geometryColumn).map((c) => c.name);
  const kept = choice.columns.filter((c) => accepted.includes(c));
  const next = format === "pair"
    ? [...kept, ...accepted.filter((c) => !kept.includes(c))].slice(0, 2)
    : [kept[0] ?? accepted[0]].filter((c): c is string => c !== undefined);
  return { ...choice, format, columns: next };
}

export function setColumn(choice: PanelChoice, index: 0 | 1, name: string): PanelChoice {
  const columns = [...choice.columns];
  columns[index] = name;
  // A pair names two distinct columns: picking the other field's column
  // exchanges them rather than doubling one.
  if (choice.format === "pair" && columns[0] === columns[1]) columns[1 - index] = choice.columns[index];
  return { ...choice, columns };
}

/** Whether the choice can be sent for a preview: its columns are complete
 * and, where the API requires an explicit code (the native path) or the
 * person opened the Other field, a code is present. */
export function previewable(choice: PanelChoice): boolean {
  const complete = choice.columns.length === (choice.format === "pair" ? 2 : 1) && choice.columns.every(Boolean);
  if (!complete) return false;
  if (!takesProjection(choice.format)) return true;
  const { kind, code } = choice.projection;
  return kind === "implicit" || kind === "explicit" || (kind === "other" && code !== null);
}

/** The choice as the API takes it: the code goes only when the
 * choice carries one, and never for H3 or GeoJSON. */
export function requestChoice(choice: PanelChoice): GeometryChoice {
  const { code } = choice.projection;
  return {
    format: choice.format,
    columns: [...choice.columns],
    ...(takesProjection(choice.format) && code !== null ? { epsg: code } : {}),
  };
}

/** What the projection field shows: the choice's code, else a declared
 * record's CRS, else WGS 84 as drawn; an unlisted code opens Other with
 * the code in its field. A marked field over a choice that carries no
 * code holds none: the native path, and the chip's
 * door on a retained source, where choosing WGS 84 from the empty field
 * is the explicit act needed, which a native select cannot report over
 * an option it already shows. */
export function projectionFieldValue(choice: PanelChoice, record: GeometryRecord | null, marked = false): { value: string; text: string } {
  const { kind, code, text } = choice.projection;
  if (kind === "unset" || (marked && kind === "implicit")) return { value: "", text: "" };
  if (kind === "other") return { value: "other", text };
  if (kind === "explicit" && code !== null) return isCurated(code) ? { value: String(code), text: "" } : { value: "other", text: String(code) };
  const declared = record?.crs.stance === "declared" && record.crs.srid !== null ? record.crs.srid : 4326;
  return isCurated(declared) ? { value: String(declared), text: "" } : { value: "other", text: String(declared) };
}

/** The projection in effect for a request, for the readout: the code the
 * request carried, else a declared record's CRS, else WGS 84. It takes the
 * request shape so an answer names what it was read under, not the draft. */
export function effectiveProjectionName(choice: Pick<GeometryChoice, "format" | "epsg">, record: GeometryRecord | null): string {
  if (!takesProjection(choice.format)) return "WGS 84";
  const code = choice.epsg ?? (record?.crs.stance === "declared" ? record.crs.srid : null) ?? 4326;
  return GEOMETRY_PROJECTION_NAMES[code] ?? `EPSG:${code}`;
}
