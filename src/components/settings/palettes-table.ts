import type { CustomPalette, CustomPaletteStop } from "@/lib/metadata/palettes";

/**
 * Libraries' Palettes card: the palettes people saved, which every map's
 * palette picker offers beside the built-in ones. A saved palette is a
 * gradient for numbers, its colors at their places along it; the card
 * shows its name, its ramp and how many colors it has, and adds one with
 * its colors evenly spaced. The bounds are the palette operation's own,
 * held against it by a test.
 */

export const PALETTES_CARD = { id: "card-palettes", title: "Palettes", keys: "palettes saved custom colors ramps gradient library" } as const;

/** Where the Add a palette form's name is, for the search. */
export const NEW_PALETTE_ROW = { id: "set-palette-name", label: "Add a palette", keys: "new palette create save colors ramp" } as const;

/** A saved palette's row, by its name. */
export const paletteRowId = (name: string) => `palette-${name}`;

/** The palette operation's bounds: a name of 1 to 60 characters, 2 to 16 colors. */
export const PALETTE_LIMITS = { name: 60, colors: { min: 2, max: 16 } } as const;

/** The colors a new palette starts with. */
export const STARTING_COLORS: readonly string[] = ["#f1eef6", "#bdc9e1", "#74a9cf", "#2b8cbe", "#045a8d"];

/** Colors evenly spaced from one end of the ramp to the other. */
export function evenStops(colors: readonly string[]): CustomPaletteStop[] {
  const last = colors.length - 1;
  return colors.map((color, index) => ({ color, position: last > 0 ? index / last : 0 }));
}

/** The ramp as a gradient through each color at its place. */
export function rampGradient(stops: readonly CustomPaletteStop[]): string {
  const ordered = [...stops].sort((a, b) => a.position - b.position);
  return `linear-gradient(90deg, ${ordered.map(stop => `${stop.color} ${Number((stop.position * 100).toFixed(2))}%`).join(", ")})`;
}

/** How many colors a palette has, in words. */
export function colorsWords(count: number): string {
  return `${count} ${count === 1 ? "color" : "colors"}`;
}

/** A saved palette as its row says it: its name, then how many colors. */
export function paletteWords(palette: Pick<CustomPalette, "label" | "stops">): string {
  return `${palette.label} · ${colorsWords(palette.stops.length)}`;
}
