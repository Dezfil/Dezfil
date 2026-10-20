import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * Card pictures are made on the server alone: no browser code writes one.
 * Everything the browser runs (the components and the pages, not the API
 * routes) names a map's picture address in one place only, the card
 * image's address, which reads it; and that place asks for nothing but a
 * read. A capture that photographed a canvas and sent it would name the
 * address again, as the builder's did.
 */

const BROWSER_ROOTS = ["src/components", "src/app"];
const PICTURE_ADDRESS = /\/api\/maps\/[^"'`\s]*\/thumbnail|\/thumbnail[?`"']/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return file === path.join("src", "app", "api") ? [] : sources(file);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [file] : [];
  });
}

it("names a map's picture address in the browser only where the card reads it", () => {
  const naming = BROWSER_ROOTS.flatMap(sources).filter((file) => PICTURE_ADDRESS.test(readFileSync(file, "utf8")));
  expect(naming).toEqual([path.join("src", "components", "map-card-image.ts")]);
  const reader = readFileSync(naming[0], "utf8");
  expect(reader).not.toMatch(/\bfetch\s*\(|method\s*:/);
});
