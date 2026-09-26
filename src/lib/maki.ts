/**
 * The curated icon set: a subset of Maki (CC0, Mapbox) bundled under
 * `public/maki` — one-container, air-gap friendly, noted in NOTICE. This
 * manifest is the single source of truth: the picker renders exactly these
 * categories, validation accepts exactly these glyph names, and the canvas
 * loads `/maki/<glyph>.svg`.
 */

export interface MakiCategory {
  label: string;
  glyphs: readonly string[];
}

export const MAKI_CATEGORIES: readonly MakiCategory[] = [
  {
    label: "Markers",
    glyphs: ["marker", "circle", "star", "heart", "home", "lodging", "attraction", "monument"],
  },
  {
    label: "Transit",
    glyphs: ["airport", "bus", "rail", "rail-metro", "ferry", "bicycle", "car", "fuel", "charging-station", "parking"],
  },
  {
    label: "Food & drink",
    glyphs: ["cafe", "restaurant", "fast-food", "bar", "beer", "bakery", "ice-cream"],
  },
  {
    label: "Shops & services",
    glyphs: ["shop", "grocery", "pharmacy", "bank", "post", "laundry"],
  },
  {
    label: "Civic",
    glyphs: ["town-hall", "police", "fire-station", "hospital", "school", "college", "library", "museum", "place-of-worship", "embassy"],
  },
  {
    label: "Outdoors",
    glyphs: ["park", "garden", "playground", "swimming", "campsite", "picnic-site", "viewpoint", "mountain", "beach", "dog-park"],
  },
  {
    label: "Industry",
    glyphs: ["industry", "warehouse"],
  },
];

export const MAKI_GLYPHS: readonly string[] = MAKI_CATEGORIES.flatMap(
  (c) => c.glyphs,
);

export const DEFAULT_GLYPH = "marker";

export function isMakiGlyph(value: unknown): value is string {
  return typeof value === "string" && MAKI_GLYPHS.includes(value);
}

export function makiUrl(glyph: string): string {
  return `/maki/${glyph}.svg`;
}
