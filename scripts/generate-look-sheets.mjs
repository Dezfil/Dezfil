/*
 * The look's backgrounds, generated.
 *
 * The workspace paints one sheet behind everything: the Atlantic chart by
 * default, or a Graticule or Hex lattice tile, in the person's Color and
 * the theme's ink. A sheet's inks are baked into the file and both paint
 * sites (the body and the header bar) draw it with a fixed attachment, so
 * each pattern exists once per Color and theme. Every file here is derived:
 *
 *   atlantic   the two shipped sheets (public/shell-sheet-light.svg and
 *              -dark.svg, Kelp's, never rewritten) with their two inks, the
 *              base and the accent tint, swapped for another Color's; one
 *              file per other Color and theme
 *   graticule  an 88 px tile, a hairline grid with corner ticks, in the
 *              base ink; one per Color and theme
 *   hex        a hexagon lattice tile in the base ink; one per Color and
 *              theme
 *
 * The inks are the approved table below; the alphas stay the shipped
 * ones, so a sheet is as faint in every Color as it is today. The output
 * folder holds only what this script writes.
 *
 * Usage: node scripts/generate-look-sheets.mjs [rootDir]   write the files
 *        node scripts/generate-look-sheets.mjs --check     fail if a rerun
 *                                                         would change one
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Each Color's two inks per theme, as `r,g,b`: the base draws the lines,
 * the accent tints the chart's one highlighted course. */
export const INKS = {
  kelp: { light: { base: "36,50,48", accent: "20,80,64" }, dark: { base: "151,170,205", accent: "140,180,165" } },
  harbor: { light: { base: "41,47,56", accent: "44,70,104" }, dark: { base: "143,172,208", accent: "153,171,198" } },
  heather: { light: { base: "48,45,56", accent: "71,61,100" }, dark: { base: "170,164,202", accent: "171,165,195" } },
  slate: { light: { base: "43,47,53", accent: "62,70,77" }, dark: { base: "161,170,184", accent: "167,170,174" } },
};
export const COLORS = Object.keys(INKS);
export const THEMES = ["light", "dark"];
export const PATTERNS = ["atlantic", "graticule", "hex"];

/** Where the derived files live, served at /look/. */
export const OUT_DIR = "public/look";
/** Kelp's Atlantic chart: the shipped sheets, the source of every other. */
export const SHIPPED = { light: "public/shell-sheet-light.svg", dark: "public/shell-sheet-dark.svg" };

/** The served path of one variant; Kelp's chart is the shipped file. */
export function variantPath(pattern, color, theme) {
  if (pattern === "atlantic" && color === "kelp") return `/${path.basename(SHIPPED[theme])}`;
  return `/look/${pattern}-${color}-${theme}.svg`;
}

/** Swap one ink everywhere it is drawn, alpha kept. */
function reink(svg, from, to) {
  return svg.split(`rgba(${from},`).join(`rgba(${to},`);
}

function graticule(base) {
  return "<svg xmlns='http://www.w3.org/2000/svg' width='88' height='88'>" +
    `<rect width='1' height='88' fill='rgba(${base},0.05)'/>` +
    `<rect width='88' height='1' fill='rgba(${base},0.05)'/>` +
    "<path d='M0 0h5M0 0v5M88 0h-5M88 0v5M0 88h5M0 88v-5M88 88h-5M88 88v-5' " +
    `stroke='rgba(${base},0.09)' stroke-width='1'/></svg>`;
}

function hex(base) {
  return "<svg xmlns='http://www.w3.org/2000/svg' width='31.177' height='54'>" +
    "<path d='M15.588 0L31.177 9v18l-15.589 9L0 27V9M15.588 36v18' fill='none' " +
    `stroke='rgba(${base},0.05)' stroke-width='1'/></svg>`;
}

/** Every derived file, by its path under the root, with its bytes. */
export function derivedFiles(root) {
  const files = new Map();
  for (const theme of THEMES) {
    const shipped = readFileSync(path.join(root, SHIPPED[theme]), "utf8");
    const kelp = INKS.kelp[theme];
    for (const color of COLORS) {
      const inks = INKS[color][theme];
      if (color !== "kelp") {
        files.set(`${OUT_DIR}/atlantic-${color}-${theme}.svg`, reink(reink(shipped, kelp.base, inks.base), kelp.accent, inks.accent));
      }
      files.set(`${OUT_DIR}/graticule-${color}-${theme}.svg`, `${graticule(inks.base)}\n`);
      files.set(`${OUT_DIR}/hex-${color}-${theme}.svg`, `${hex(inks.base)}\n`);
    }
  }
  return files;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const root = path.resolve(args.find(arg => !arg.startsWith("--")) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const files = derivedFiles(root);
  const outDir = path.join(root, OUT_DIR);
  const present = existsSync(outDir) ? readdirSync(outDir).map(name => `${OUT_DIR}/${name}`) : [];
  if (check) {
    const problems = [];
    for (const [file, bytes] of files) {
      const full = path.join(root, file);
      if (!existsSync(full)) problems.push(`missing ${file}`);
      else if (readFileSync(full, "utf8") !== bytes) problems.push(`stale ${file}`);
    }
    for (const file of present) if (!files.has(file)) problems.push(`unexpected ${file}`);
    if (problems.length) {
      console.error(`FAIL - the look's sheets drifted from their sources; run \`node scripts/generate-look-sheets.mjs\`.\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`PASS - ${files.size} look sheets match their sources.`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  for (const file of present) if (!files.has(file)) rmSync(path.join(root, file));
  for (const [file, bytes] of files) writeFileSync(path.join(root, file), bytes);
  console.log(`WROTE - ${files.size} look sheets under ${OUT_DIR}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
