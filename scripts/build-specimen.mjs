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
 *   tokens-surface the surface roles' block of src/app/globals.css verbatim,
 *                  so the page's samples read the tokens the app reads
 *   surface-plate  the plate's rows parsed from that block: the shadow
 *                  steps, blur strengths, fills and edge, and each role's
 *                  fill, blur, edge, corner, shadow and states as the block
 *                  states them (the role's name and words are documentary)
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

/** What each surface role is to a person, shown beside its values on the
 * plate: documentary, as the ramp notes are. The values are fed. A role the
 * block declares without words here, or words for a role the block does not
 * declare, stops the feed rather than drawing a row nobody described. */
const ROLE_NOTES = {
  "glass-chrome": {
    nm: "Floating glass, chrome",
    what: "What floats over the page and carries an icon or one strong line: the header card and its buttons, the theme button, the side rail at rest, the search field, the save chip, the draw dock and its pill.",
  },
  "glass-panel": {
    nm: "Floating glass, panel",
    what: "What floats over the page and is read: the builder's inspector, the Tools drawer and the Assistant pane, the SQL page's left pane, the workflow canvas's pane and inspector, How it's made beside a template. Docked or overlaying, no edge.",
  },
  "overlay-panel": {
    nm: "Overlay panel",
    what: "What is read over a map or the canvas: the legend, the status pill, the timeline bar, a published page's title bar, the readouts, the mini-map's legend, the workflow minimap.",
  },
  "overlay-control": {
    nm: "Overlay control",
    what: "A control floating over a map, canvas or picture: the zoom and stage buttons, the mini-map's actions, a card's hover pill and owner mark, a note's colour bar.",
  },
  "map-card": {
    nm: "Map card",
    what: "A card floating over a map on the panel tone, with the hairline: a widget's card and its menu. Glass, with the overlay panel's blur.",
  },
  "page-card": {
    nm: "Page card",
    what: "A card on a page: the gallery cards, the Settings cards and column, the SQL editor and results, the connection cards, the set-geometry panel. Glass, with the side panels' blur; a gallery card lifts on hover.",
  },
  "inner-card": {
    nm: "Inner card",
    what: "A card inside a panel or card, and a control that carries a small shadow: the layer cards, the node tiles, the pickable cards in dialogs, a switch's knob, a slider's thumb. On the glass tone with no blur of its own, since only its panel lies behind it; corners as each has them.",
  },
  block: {
    nm: "Block",
    what: "A block inside a panel on the raised or the panel tone, with the hairline: a visualization's tile, a filter's card, a legend entry, a widget's row, a basemap's card, a tool's result, the person's own message to the Assistant. The glass of either tone with no blur of its own, lying on its panel.",
    onPanel: true,
  },
  menu: {
    nm: "Menu and pop-over",
    what: "What opens over something and closes: every menu, picker and pop-over, the map's tooltip and popup, the hint, the SQL peek, the map's failure notice. Glass, with the overlay panel's blur, the tooltip and popup on the raised tone's; corners as each has them.",
  },
  dialog: {
    nm: "Dialog",
    what: "Every modal, over its veil. Glass, with the side panels' blur.",
  },
  stage: {
    nm: "The stage",
    what: "The map card and the framed canvas: no fill of its own, the deep shadow; the framed canvas keeps its edge.",
  },
};

/** A role's part, or one of the shadows a state of the role takes. */
const SURFACE_PART = /^--surface-(.+?)-(fill|blur|edge|corner|shadow(?:-[a-z]+)?)$/;
/** A step, a strength, a fill or an edge the roles read. */
const SURFACE_STEP = /^--(shadow|blur|fill|edge)-([\w-]+)$/;

/** The one rule after the block that may restate roles: an image's default
 * scope and a published page, kept on the solid grounds the workspace draws
 * as glass. */
const SOLID_SCOPES = "[data-look-default], [data-published-view]";

/** The one rule of a stylesheet that declares the surface roles: its text
 * verbatim from the selector list to the closing brace, its selectors, and
 * its custom properties in order. Comments are blanked (not removed) while
 * searching, so a role named in a comment is not mistaken for the rule and
 * the slice taken from the sheet keeps its comments. Past it, only the
 * solid scopes' rule may name a role. */
export function surfaceBlock(css) {
  const blank = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const first = blank.indexOf("--surface-");
  if (first < 0) throw new Error("no rule declares the surface roles");
  const open = blank.lastIndexOf("{", first);
  const close = blank.indexOf("}", first);
  for (let next = blank.indexOf("--surface-", close); next >= 0; ) {
    const at = blank.lastIndexOf("{", next), end = blank.indexOf("}", next);
    const head = blank.slice(blank.lastIndexOf("}", at) + 1, at).split(",").map((s) => s.trim()).filter(Boolean).join(", ");
    if (head !== SOLID_SCOPES) throw new Error("more than one rule declares the surface roles");
    next = blank.indexOf("--surface-", end);
  }
  const from = blank.lastIndexOf("}", open) + 1;
  const tokens = new Map(
    [...blank.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.trim().replace(/\s+/g, " "),
    ]),
  );
  return {
    text: css.slice(from, close + 1).replace(/^\s*(\/\*[\s\S]*?\*\/\s*)*/, ""),
    selectors: blank.slice(from, open).split(",").map((s) => s.trim()).filter(Boolean),
    tokens,
  };
}

/** The plate's content from the parsed block: the steps, strengths, fills
 * and edges in the block's order, and each role with its name and words,
 * its five parts as the block states them (a role without a corner of its
 * own keeps each surface's) and the shadows its states take.
 * @param {{ tokens: Map<string, string> }} block
 * @param {Record<string, { nm: string, what: string, onPanel?: boolean }>} [notes]
 */
export function surfacePlate(block, notes = ROLE_NOTES) {
  const steps = { shadow: [], blur: [], fill: [], edge: [] };
  const roles = new Map();
  for (const [token, value] of block.tokens) {
    const part = SURFACE_PART.exec(token);
    if (part) {
      const [, key, name] = part;
      if (!roles.has(key)) roles.set(key, { parts: {}, states: [] });
      const role = roles.get(key);
      if (name.startsWith("shadow-")) role.states.push({ nm: name.slice("shadow-".length), v: value });
      else role.parts[name] = value;
      continue;
    }
    const step = SURFACE_STEP.exec(token);
    if (step) steps[step[1]].push({ nm: step[2], v: value });
  }
  const unworded = [...roles.keys()].filter((key) => !notes[key]);
  const unknown = Object.keys(notes).filter((key) => !roles.has(key));
  if (unworded.length) throw new Error("no words for the role " + unworded.join(", ") + ": add them to ROLE_NOTES");
  if (unknown.length) throw new Error("words for a role the block does not declare: " + unknown.join(", "));
  return {
    steps,
    roles: [...roles].map(([key, { parts, states }]) => {
      // A role its words say lies on a panel has no blur of its own and shows
      // none; every other role states all four parts.
      for (const name of notes[key].onPanel ? ["fill", "edge", "shadow"] : ["fill", "blur", "edge", "shadow"]) {
        if (!(name in parts)) throw new Error("the role " + key + " states no " + name);
      }
      return {
        key,
        nm: notes[key].nm,
        what: notes[key].what,
        fill: parts.fill,
        blur: parts.blur ?? "none",
        edge: parts.edge,
        corner: parts.corner ?? null,
        shadow: parts.shadow,
        states,
      };
    }),
  };
}

/** The page's SURFACE_STEPS and SURFACE_ROLES, one entry per line. */
export function surfacePlateJs(plate) {
  const groups = Object.entries(plate.steps).map(
    ([group, rows]) => "  " + group + ": [" + rows.map((r) => JSON.stringify(r)).join(", ") + "],",
  );
  return [
    "var SURFACE_STEPS = {",
    ...groups,
    "};",
    "var SURFACE_ROLES = [",
    plate.roles.map((r) => "  " + JSON.stringify(r)).join(",\n"),
    "];",
  ].join("\n");
}

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
  const surface = surfaceBlock(globals);

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
    "tokens-surface": surface.text,
    "surface-plate": surfacePlateJs(surfacePlate(surface)),
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
