/*
 * The specimen feed:
 * the living specimen is mechanically fed from the component library, so
 * it cannot drift. This script derives the page's fed sections from the
 * shipped sources and writes them between explicit markers in
 * design/identity/dezfil-identity.html:
 *
 *   tokens-light   the light :root token block of src/app/globals.css
 *   tokens-dark    the dark block, rescoped to the page's theme switch
 *   tokens-os      the same dark values under the OS-preference media query
 *   kit-css        every src/components/ui/*.module.css, selectors
 *                  namespaced .kit-<module>-<class>, values untouched
 *   ramps          the palette arrays derived from src/lib/style/palettes.ts
 *                  (labels, colorblind flags and colors are fed; the short
 *                  attribution strings below are documentary)
 *
 * The only transform applied to token values: --sheet maps to the page's
 * embedded data-URI sheets (var(--sheet-light|dark)) — a standalone page
 * cannot reference app-served files. Everything else is verbatim.
 *
 * Usage: node scripts/build-specimen.mjs [rootDir]     regenerate in place
 *        node scripts/build-specimen.mjs --check       fail if a rerun would
 *                                                      change the page
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SPECIMEN = "design/identity/dezfil-identity.html";

/** Documentary attribution shown beside each ramp — editorial, not fed. */
const RAMP_NOTES = {
  global_warming: { src: "kepler.gl · DEFAULT", cont: true, def: true },
  viridis: { src: "matplotlib · 256 steps", cont: true },
  plasma: { src: "matplotlib · 256 steps", cont: true },
  inferno: { src: "matplotlib · 256 steps", cont: true },
  turbo: { src: "Google · 256 steps", cont: true },
  uber_viz_sequential: { src: "kepler.gl", cont: true },
  sunrise: { src: "kepler.gl", cont: true },
  greys: { src: "ColorBrewer · single-hue" },
  blues: { src: "ColorBrewer · single-hue" },
  greens: { src: "ColorBrewer · single-hue" },
  reds: { src: "ColorBrewer · single-hue" },
  ylorrd: { src: "ColorBrewer · multi-hue" },
  rdbu: { src: "ColorBrewer" },
  piyg: { src: "ColorBrewer" },
  spectral: { src: "ColorBrewer" },
  berlin: { src: "256 steps · diverging", cont: true },
  ice_and_fire: { src: "kepler.gl", cont: true },
  uber_viz_qualitative: { src: "kepler · DEFAULT", def: true },
};

/** The declarations of one top-level CSS block, verbatim lines. */
function blockOf(css, selectorStart) {
  const at = css.indexOf(selectorStart);
  if (at < 0) throw new Error("block not found: " + selectorStart);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css
    .slice(open + 1, close)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("--"));
}

const mapSheet = (lines) =>
  lines.map((l) => {
    if (!l.startsWith("--sheet:")) return l;
    if (l.includes("light")) return "--sheet: var(--sheet-light);";
    return "--sheet: var(--sheet-dark);";
  });

const indent = (lines, pad) => lines.map((l) => pad + l).join("\n");

/** Namespace one module's selectors: .x becomes .kit-<mod>-x.
 *
 * Text is flushed at every `;`, `}` and comment without renaming, so only
 * what sits in selector position — the run of text preceding a `{` —
 * is ever rewritten. That covers multi-line selector lists whose earlier
 * lines carry a pseudo-class (`.hint:hover::after,` on its own line),
 * which a line-oriented pass silently let escape into a global rule. */
export function namespaceModule(css, mod) {
  const prefix = "kit-" + mod.toLowerCase();
  const rename = (text) =>
    text.replace(/\.([a-zA-Z][\w-]*)/g, (m, c) => "." + prefix + "-" + c);
  let out = "";
  let buf = "";
  let i = 0;
  while (i < css.length) {
    if (css.startsWith("/*", i)) {
      const close = css.indexOf("*/", i + 2);
      const to = close < 0 ? css.length : close + 2;
      buf += css.slice(i, to);
      i = to;
      continue;
    }
    const ch = css[i];
    if (ch === "{") {
      // An at-rule prelude keeps its own vocabulary; a selector is renamed.
      out += (buf.trimStart().startsWith("@") ? buf : rename(buf)) + "{";
      buf = "";
    } else if (ch === "}" || ch === ";") {
      out += buf + ch;
      buf = "";
    } else {
      buf += ch;
    }
    i += 1;
  }
  return (out + buf).trimEnd();
}

/** The shipped palette rows, imported from the module the app itself
 * uses - not parsed. Node strips the types; the resolve hook supplies the
 * extension TypeScript source omits, so `colors` arrives already resolved
 * through its shared constants (the continuous stops, the ColorBrewer
 * levels, the kepler cycle) rather than re-derived here. */
export async function rampRows(root) {
  registerHooks({
    resolve(spec, ctx, next) {
      try {
        return next(spec, ctx);
      } catch {
        return next(spec + ".ts", ctx);
      }
    },
  });
  const url = pathToFileURL(path.join(root, "src/lib/style/palettes.ts")).href;
  const { PALETTES } = await import(url);
  if (!PALETTES?.length) throw new Error("no palettes exported by palettes.ts");
  return PALETTES.map((p) => ({
    name: p.name,
    label: p.label,
    group: p.group,
    cb: p.colorblindSafe,
    colors: p.colors,
  }));
}

/** The page's SEQ/DIV/CAT arrays, rendered from the fed rows. */
export function rampJs(rows) {
  const render = (row) => {
    const note = RAMP_NOTES[row.name] ?? {};
    const bits = [
      "nm:" + JSON.stringify(row.label),
      note.src ? "src:" + JSON.stringify(note.src) : null,
      "cont:" + Boolean(note.cont),
      "cb:" + row.cb,
      note.def ? "def:true" : null,
      row.group === "diverging" ? "mid:" + Math.floor(row.colors.length / 2) : null,
      "colors:" + JSON.stringify(row.colors),
    ].filter(Boolean);
    return "  {" + bits.join(", ") + "}";
  };
  const of = (group) => rows.filter((r) => r.group === group).map(render).join(",\n");
  return [
    "var SEQ = [",
    of("sequential"),
    "];",
    "var DIV = [",
    of("diverging"),
    "];",
    "var CAT = [",
    of("qualitative"),
    "];",
  ].join("\n");
}

export async function generate(root) {
  const read = (p) => readFileSync(path.join(root, p), "utf8");
  const globals = read("src/app/globals.css");

  const light = mapSheet(blockOf(globals, ":root {"));
  const dark = mapSheet(blockOf(globals, ':root[data-theme="dark"]'));

  const uiDir = path.join(root, "src/components/ui");
  const modules = readdirSync(uiDir)
    .filter((f) => f.endsWith(".module.css"))
    .sort();
  const kitCss = modules
    .map((f) => {
      const mod = f.replace(".module.css", "");
      return (
        "/* --- " + f + " (fed verbatim, namespaced) --- */\n" +
        namespaceModule(read("src/components/ui/" + f), mod)
      );
    })
    .join("\n\n");

  return {
    "tokens-light": ":root {\n" + indent(light, "  ") + "\n  color-scheme: light;\n}",
    "tokens-dark": ':root[data-theme="dark"] {\n' + indent(dark, "  ") + "\n  color-scheme: dark;\n}",
    "tokens-os":
      "@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) {\n" +
      indent(dark, "    ") +
      "\n    color-scheme: dark;\n  }\n}",
    "kit-css": kitCss,
    ramps: rampJs(await rampRows(root)),
  };
}

export function apply(page, sections) {
  let out = page;
  for (const [name, body] of Object.entries(sections)) {
    // Comment markers that are legal in both <style> and <script>.
    const start = "/* wheelhouse:feed " + name + " start */";
    const end = "/* wheelhouse:feed " + name + " end */";
    const a = out.indexOf(start);
    const b = out.indexOf(end);
    if (a < 0 || b < 0) throw new Error("marker pair missing for " + name);
    out = out.slice(0, a + start.length) + "\n" + body + "\n" + out.slice(b);
  }
  return out;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  const pagePath = path.join(root, SPECIMEN);
  const page = readFileSync(pagePath, "utf8");
  const fed = apply(page, await generate(root));
  if (check) {
    if (fed !== page) {
      console.error(
        "FAIL - the specimen's fed sections drifted from their sources; run `node scripts/build-specimen.mjs` and commit the result.",
      );
      process.exit(1);
    }
    console.log("PASS - the specimen matches its sources.");
  } else {
    writeFileSync(pagePath, fed);
    console.log("WROTE - fed sections regenerated into " + SPECIMEN);
  }
}
