import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/config";
import type { PictureImages } from "@/lib/pictures/card";
import { KEPT_SHAPE, PICTURE_SHAPE } from "@/lib/pictures/shapes";

/** A whole picture as the service publishes it: the default PNG and every
 * kept size, each file's bytes naming what it is, so a read shows which
 * one it picked. A test that publishes bare PNG bytes instead stands for a
 * picture made before sizes were kept. */
export function sizedPicture(tag: string, png: Uint8Array = Buffer.from(`${tag}:png`)): PictureImages {
  return {
    png,
    sized: PICTURE_SHAPE.widths.map((width) => ({
      shape: KEPT_SHAPE, width, height: 1, bytes: Buffer.from(`${tag}:${KEPT_SHAPE}-${width}`),
    })),
  };
}

/** The first sized recipe's widths: a card shape and a wide shape of its
 * own, both listed in the set. */
export const FIRST_RECIPE_WIDTHS = { card: [360, 720, 1080, 1440, 1980], wide: [1104, 1656, 2208, 3312] } as const;

/**
 * Rewrites a map's published set as the first sized recipe wrote it: both
 * shape names listed, the wide shape's own sizes beside the card's (each
 * file's bytes naming its appearance, shape and width), no recipe named.
 * A test stands it for a picture made before this recipe.
 */
export function asFirstRecipe(mapId: string): void {
  const dir = path.join(dataDir(), "thumbnails");
  const manifestFile = path.join(dir, `${mapId}.json`);
  const set = JSON.parse(readFileSync(manifestFile, "utf8")) as { light: string; dark: string; sizes?: Record<string, number[]> };
  for (const png of new Set([set.light, set.dark])) {
    const theme = png.endsWith(".dark.png") ? "dark" : "light";
    for (const name of readdirSync(dir).filter((file) => file.startsWith(png.replace(/\.png$/, ".")) && file.endsWith(".webp"))) rmSync(path.join(dir, name));
    for (const [shape, widths] of Object.entries(FIRST_RECIPE_WIDTHS)) {
      for (const width of widths) writeFileSync(path.join(dir, png.replace(/\.png$/, `.${shape}-${width}.webp`)), `first-${theme}:${shape}-${width}`);
    }
  }
  writeFileSync(manifestFile, JSON.stringify({ light: set.light, dark: set.dark, sizes: { card: [...FIRST_RECIPE_WIDTHS.card], wide: [...FIRST_RECIPE_WIDTHS.wide] } }));
}

/** The map's published manifest as written. */
export function publishedManifest(mapId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dataDir(), "thumbnails", `${mapId}.json`), "utf8"));
}
