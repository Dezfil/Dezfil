import type { Bbox } from "@/lib/bbox";
import type { Ring } from "@/lib/overture/query";
import { geometryParts, type PolygonalGeometry } from "@/lib/geo-shape";

/**
 * Pure OverpassQL shaping — shared by the pane's live drawer and the
 * server, so the query the user reads is the query that runs. One-way
 * generation: the form compiles to QL; nothing parses QL back. Areas are
 * a bbox, a drawn polygon, or a layer feature's real geometry (one
 * Overpass poly filter per outer ring; holes apply only in the
 * post-fetch within filter).
 */

/** The selected area a query applies to. */
export type OsmArea =
  | { bbox: Bbox }
  | { ring: Ring }
  | { geometry: PolygonalGeometry };

/** A tag selector: bare key ("building") or key=value ("amenity=restaurant"). */
export interface Selector {
  key: string;
  value?: string;
}

/** Quick presets (the everyday cases). */
export const OSM_PRESETS: { key: string; label: string }[] = [
  { key: "building", label: "Buildings" },
  { key: "highway", label: "Roads" },
  { key: "amenity", label: "Amenities" },
  { key: "landuse", label: "Landuse" },
];

const KEY_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/;
const VALUE_PATTERN = /^[^"\n\\]{1,128}$/;

export function parseSelector(raw: string): Selector | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) {
    return KEY_PATTERN.test(trimmed) ? { key: trimmed } : null;
  }
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (!KEY_PATTERN.test(key)) return null;
  if (!value || value === "*") return { key };
  return VALUE_PATTERN.test(value) ? { key, value } : null;
}

export function selectorLabel(s: Selector): string {
  return s.value ? `${s.key}=${s.value}` : s.key;
}

export interface EnvelopeSettings {
  timeoutS: number;
  maxsizeBytes: number;
}

function settingsLine(env: EnvelopeSettings): string {
  return `[out:json][timeout:${Math.round(env.timeoutS)}][maxsize:${Math.round(env.maxsizeBytes)}];`;
}

/** Overpass wants (south, west, north, east). */
export function overpassBbox([w, s, e, n]: Bbox): string {
  return `${s},${w},${n},${e}`;
}

/** Overpass polygon filter: lat lon pairs, space-separated. */
export function overpassPoly(ring: Ring): string {
  const pairs = ring
    .map(([lng, lat]) => `${lat.toFixed(6)} ${lng.toFixed(6)}`)
    .join(" ");
  return `poly:"${pairs}"`;
}

function openRing(ring: Ring): Ring {
  const [first] = ring;
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1]
    ? ring.slice(0, -1)
    : ring;
}

function areaFilters(area: OsmArea): string[] {
  if ("geometry" in area) {
    return geometryParts(area.geometry).map((part) =>
      overpassPoly(openRing(part.outer)),
    );
  }
  return ["ring" in area ? overpassPoly(area.ring) : overpassBbox(area.bbox)];
}

/** Compile selectors + area into the canonical query (spec: the form
 * teaches the query language by showing its work). A multi-part geometry
 * emits one statement per selector and part — the union block merges them. */
export function buildOverpassQl(
  selectors: Selector[],
  area: OsmArea,
  env: EnvelopeSettings,
): string {
  const filters = areaFilters(area);
  const lines = selectors.flatMap((s) =>
    filters.map((filter) =>
      s.value
        ? `  nwr["${s.key}"="${s.value}"](${filter});`
        : `  nwr["${s.key}"](${filter});`,
    ),
  );
  return `${settingsLine(env)}\n(\n${lines.join("\n")}\n);\nout geom;`;
}

/** Leading Overpass settings statement, e.g. [out:xml][timeout:900]; */
const SETTINGS_PREFIX = /^\s*(\[[^\]\n]*\]\s*)+;/;

/**
 * The server's safety envelope on a custom query (spec: whether generated
 * or custom, the outgoing query is always bounded): any declared settings
 * are replaced with ours, and overpass-turbo's {{bbox}} placeholder is
 * honoured when an area is present.
 */
export function applyEnvelope(
  rawQl: string,
  env: EnvelopeSettings,
  bbox?: Bbox | null,
): string {
  let body = rawQl.trim().replace(SETTINGS_PREFIX, "").trim();
  if (body.includes("{{bbox}}")) {
    if (!bbox) {
      throw new Error(
        "The query uses {{bbox}} but no area is selected. Pick an area or inline coordinates.",
      );
    }
    body = body.split("{{bbox}}").join(overpassBbox(bbox));
  }
  if (/\{\{[^}]*\}\}/.test(body)) {
    throw new Error(
      "The query still contains overpass-turbo placeholders; only {{bbox}} is supported.",
    );
  }
  return `${settingsLine(env)}\n${body}`;
}

/** Whitespace-collapsed form — the instance-global cache key input. */
export function normalizeQl(ql: string): string {
  return ql.replace(/\s+/g, " ").trim();
}

/** Keys promoted to plain columns for an import: name + the queried keys. */
export function promotedKeys(selectors: Selector[]): string[] {
  const keys = new Set<string>(["name"]);
  for (const s of selectors) keys.add(s.key);
  return [...keys];
}

/** A default table-name stem from the most specific selector. */
export function suggestStem(selectors: Selector[]): string {
  const valued = selectors.find((s) => s.value);
  const pick = valued?.value ?? selectors[0]?.key ?? "import";
  const cleaned = pick
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `osm_${cleaned || "import"}`;
}
