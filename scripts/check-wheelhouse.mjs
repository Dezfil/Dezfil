/*
 * The Wheelhouse enforcement gate: the rulebook's
 * ratified vocabulary becomes a check, so no later change quietly
 * regresses what the design system paid for.
 *
 * Rules swept, each against the token set in src/app/globals.css:
 *   font-size   px literals must sit on the type ramp (27/22/15/13/12/11)
 *               or reference a token; anything else is off-ramp.
 *   radius      a module stylesheet reads the closed family (4/9/12/14/20)
 *               through its tokens, so the person's Corners reaches every
 *               rounded edge; only pills (999px), rounds (50%) and 0 stay
 *               literal. The specimen's authored page may still write the
 *               family's values: its samples draw them.
 *   motion      duration literals must be a role beat (0.13/0.22/0.3/0.35s),
 *               easing literals a token curve or the default keywords.
 *   color       raw hex/rgb/hsl in component styles is off-token.
 *   glyphs      the banned Unicode chrome classes in JSX text.
 *   outline     focus-outline suppression outside the one recorded
 *               Dialog exception.
 *   cursor      the arrow cursor (`default`, or `auto`, the arrow by
 *               another name on a button) on a selector that does not
 *               itself say disabled. The convention makes the arrow
 *               mean disabled and src/app/globals.css says so once for
 *               every button, so that stylesheet is the convention and
 *               outside this rule; a component rule putting the arrow on
 *               anything else is held against the inventory by selector -
 *               an accepted use is annotated there, a recorded defect
 *               carries its registry row, and a clickable that lost its
 *               pointer (the workflow results tabs) is neither.
 *   names       a compile-time floor for accessible names: explicit
 *               role containers and nav need a name in the same tag; an
 *               icon-only raw button needs a label. Name correctness and
 *               composed content stay with the runtime census
 *               (e2e/a11y-census.spec.ts) and the kit's structurally
 *               enforced IconButton - this check is the floor, not the
 *               gate.
 *   shadow      a box-shadow layer with a non-zero x or y offset reads a
 *               surface role's shadow or one of the six steps; judged per
 *               layer, so an inset or an offset-free ring composed beside a
 *               read stays outside, and the colour-only `var(--shadow)`,
 *               which draws nothing, is not a shadow.
 *   blur        a backdrop-filter blur reads a role's blur or one of the
 *               three strengths (glass, overlay, the veil's).
 *   fill        a color-mix of --bg-panel or --bg-raised with transparent
 *               reads a role's fill or one of the fills; mixes of the page
 *               tone (--bg) and the ink are outside the rule.
 *               These three read the vocabulary at the end of
 *               src/app/globals.css, so a restated role reaches every
 *               surface that plays it. A local custom property typed with
 *               a shadow, a blur or a panel fill is the same typed value
 *               one hop away and is judged where it is declared. The rows
 *               they leave in the inventory are the named exceptions
 *               below and nothing else: a surface row without a name fails
 *               as UNNAMED, so the list only ever shrinks.
 *
 * Violations present at adoption are enumerated in
 * scripts/wheelhouse-inventory.json - the close sitting's leftover list,
 * not license. The check is a two-way ratchet: a violation missing from
 * the inventory fails as NEW, an inventory row matching nothing fails as
 * STALE (heal the code, shrink the list, same diff).
 *
 * Usage: node scripts/check-wheelhouse.mjs [rootDir]
 *   --write-inventory   regenerate the inventory from the current tree
 *                       (the seeding move; afterwards the ratchet holds)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAMP_PX = new Set(["27px", "22px", "15px", "13px", "12px", "11px"]);
/** The literals a module stylesheet may write: pills and rounds. */
const RADIUS_OK = new Set(["999px", "0", "50%"]);
/** The family the specimen's samples draw by value. */
const RADIUS_FAMILY = new Set(["4px", "9px", "12px", "14px", "20px", ...RADIUS_OK]);
const DUR_OK = new Set(["0.13s", "0.22s", "0.3s", "0.35s", "130ms", "220ms", "300ms", "350ms", "0s", "0ms"]);
const EASE_OK = new Set([
  "ease",
  "linear",
  "cubic-bezier(0.33, 1, 0.4, 1)",
  "cubic-bezier(0.2, 0.8, 0.2, 1)",
]);
// The banned chrome classes: geometric shapes, misc symbols, dingbats,
// plus the fullwidth plus that opened this hunt.
const GLYPH_RE = /[■-◿☀-⛿✀-➿＋]/g;
// Roles whose container owes an accessible name at the tag (a floor -
// see the header note).
const NAMED_ROLE_RE = /role="(group|radiogroup|region|toolbar|tablist)"/;

/* The three motion identities are NAMED EXCEPTIONS rather
 * than a fifth role. They stay in the
 * inventory — they are off-vocabulary literals and the ratchet must still
 * see them — but they are annotated, so a maintainer reading the list can
 * tell a sanctioned identity from an ordinary leftover.
 * The rule text itself lives in the specimen's Motion plate. */
const NAMED_EXCEPTIONS = {
  "src/components/map/StageStack.module.css\tduration\t0.12s":
    "Motion exception 1 of 3 — the compass needle's continuous linear tracking of the view bearing (.compassBtn svg); the other occurrences in this file are ordinary chrome transitions",
  "src/components/ui/Status.module.css\tduration\t1.1s":
    "Motion exception 2 of 3 — the indefinite tile-preparation pulse (status-sweep), which has no end to settle on",
  "src/components/ui/Status.module.css\teasing\tease-in-out":
    "Motion exception 2 of 3 — the same indefinite pulse's curve",
  "src/components/widgets/SortableCards.module.css\tduration\t250ms":
    "Motion exception 3 of 3 — the drag settle-and-reveal on its bespoke beat",
  "src/components/widgets/SortableCards.module.css\teasing\tcubic-bezier(0.25, 1, 0.5, 1)":
    "Motion exception 3 of 3 — the drag settle-and-reveal's bespoke curve",
  /* The surface exceptions: what sets a shadow or a translucent panel
   * fill and plays no surface role, kept typed by name. The veil, the wash
   * and the published credit chip's blur read the vocabulary and need no
   * row; the credit drawn into an image, the widget cards and the search
   * marker's pin declare nothing these rules read. */
  "src/app/(workspace)/layout.module.css\tshadow\t16px 0 36px -18px var(--shadow)":
    "Surface exception: the side rail opened over the page, solid on the lift step with this one side layer of its own (opened by keyboard focus and by the pointer's dwell)",
  "src/components/settings/LookPictures.module.css\tshadow\t16px 0 36px -18px var(--shadow)":
    "Surface exception: the side rail opened over the page, drawn in miniature in the Side menu picture of the Appearance tab",
  "src/components/builder/export/ExportComposition.module.css\tfill\tcolor-mix(in srgb, var(--bg-panel) 93%, transparent)":
    "Surface exception: the composition's own title line and failure note, drawn into an exported image with their own fill, so the image stays as it is",
  "src/components/builder/export/ExportComposition.module.css\tshadow\t0 8px 26px var(--shadow)":
    "Surface exception: the composition's own title line, its shadow drawn into an exported image",
  "src/components/WorkflowFolder.module.css\tfill\tcolor-mix(in srgb, var(--bg-panel) 72%, transparent)":
    "Surface exception: a tint, the Data page's folder pane, a fold in the list",
  "src/components/WorkflowFolder.module.css\tfill\tcolor-mix(in srgb, var(--bg-raised) 60%, transparent)":
    "Surface exception: a tint, the nested row tint",
  "src/components/UploadZone.module.css\tfill\tcolor-mix(in srgb, var(--bg-panel) 60%, transparent)":
    "Surface exception: a tint, the upload zone's chip",
  "src/components/gallery.module.css\tfill\tcolor-mix(in srgb, var(--bg-panel) 88%, transparent)":
    "Surface exception: a fade, the thumbnail fade on a gallery card",
};

/** The three surface rules; their inventory rows must be named above. */
const SURFACE_RULES = new Set(["shadow", "blur", "fill"]);

/* The arrow-cursor rules the census accepted, so a maintainer reading
 * the inventory can tell an accepted use from a recorded defect. Keyed
 * like NAMED_EXCEPTIONS; written out by --write-inventory. */
const CURSOR_NOTES = {
  "src/components/builder/BasemapPanel.module.css\tcursor\t.groupSection[data-inert=\"true\"] .groupEye":
    "census: correct - the IconButton is disabled whenever the section is inert",
  "src/components/projects/AddToProjectDialog.module.css\tcursor\t.pRow[data-current]":
    "census: correct - a label around a radio that is disabled when current",
  "src/components/widgets/Widgets.module.css\tcursor\t.otherRow":
    "census: correct - a div, not a control",
  "src/components/workflow-canvas/WorkflowCanvas.module.css\tcursor\tspan.chip":
    "census: correct - the span form of the chip carries no handler",
  "src/components/sql/SqlConsole.module.css\tcursor\t.grid td.rn":
    "census: correct - the row number carries no handler, beside the cells a click opens",
};

/** Every declaration in a CSS text as {prop, value, line}. */
function declarations(css) {
  const out = [];
  // The final declaration before `}` may omit its semicolon — a regex
  // requiring one silently exempts `.x { font-size: 10px }` from every
  // rule below.
  const re = /([a-zA-Z-]+)\s*:\s*([^;{}]+)(?=[;}])/g;
  let m;
  while ((m = re.exec(css))) {
    const line = css.slice(0, m.index).split("\n").length;
    out.push({ prop: m[1].toLowerCase(), value: m[2].trim(), line });
  }
  return out;
}

const usesVar = (v) => /var\(--/.test(v);

/** Off-ramp font sizes, off-family radii, off-beat motion, raw colors. */
export function sweepStyles(css, file) {
  const found = [];
  for (const { prop, value, line } of declarations(css)) {
    if (prop === "font-size") {
      if (usesVar(value) || RAMP_PX.has(value)) continue;
      if (/^(inherit|unset|initial)$/.test(value)) continue;
      found.push({ file, rule: "font-size", value, line });
    } else if (/^border(-\w+){0,2}-radius$/.test(prop)) {
      if (usesVar(value)) continue;
      const parts = value.split(/\s+/);
      if (parts.every((p) => RADIUS_OK.has(p))) continue;
      found.push({ file, rule: "radius", value, line });
    } else if (
      prop === "transition" ||
      prop === "animation" ||
      prop.endsWith("-duration") ||
      prop.endsWith("-timing-function")
    ) {
      if ((prop === "transition" || prop === "animation") && value === "none") continue;
      // Each literal is judged on its own: `opacity 0.5s var(--ease-panel)`
      // is still an off-beat duration.
      for (const t of value.match(/\b\d+(?:\.\d+)?m?s\b/g) ?? []) {
        if (!DUR_OK.has(t)) found.push({ file, rule: "duration", value: t, line });
      }
      const eases = [
        ...(value.match(/cubic-bezier\([^)]*\)|steps\([^)]*\)/g) ?? []),
        ...(value.match(/\b(ease-in-out|ease-in|ease-out)\b/g) ?? []),
      ];
      for (const e of eases) {
        if (!EASE_OK.has(e)) found.push({ file, rule: "easing", value: e, line });
      }
    } else {
      // A local custom property is not an exemption: `--brand: #f00`
      // then `color: var(--brand)` is the same raw color, one hop away.
      if (/#[0-9a-fA-F]{3,8}\b|(?:^|[^-\w])(rgba?|hsla?)\(/.test(value)) {
        found.push({
          file,
          rule: "color",
          value: value.length > 48 ? value.slice(0, 45) + "..." : value,
          line,
        });
      }
    }
  }
  return found;
}

/* The surface vocabulary's reads, by rule. A misspelled read is
 * lint:tokens' business: an undefined token fails there. */
const SHADOW_READ = /^var\(--(surface-[\w-]+-shadow(-[\w-]+)?|shadow-(hairline|float|overlay|lift|deep|dialog))\)$/;
const BLUR_READ = /^var\(--(surface-[\w-]+-blur|blur-(glass|overlay|veil))\)$/;
const PANEL_TONE = /^var\(--bg-(panel|raised)\)( [\d.]+%)?$/;
const TRANSPARENT = /^transparent( [\d.]+%)?$/;
const squash = (s) => s.replace(/\s+/g, " ").trim();

/** Split at the separators outside parentheses: the commas between
 * shadow layers or color-mix arguments, the spaces between a layer's
 * parts. */
function splitTop(value, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (depth === 0 && sep.test(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A drop shadow: a layer that is not a read, not inset, and moves off
 * its box by a non-zero x or y. A layer with fewer than two plain lengths
 * is a token read or a colour alone; a token is judged where it is
 * declared. */
function isDropLayer(layer) {
  if (layer === "none" || SHADOW_READ.test(layer)) return false;
  const parts = splitTop(layer, /\s/);
  if (parts.includes("inset")) return false;
  const lengths = parts.filter((p) => /^-?(\d+\.?\d*|\.\d+)(px|r?em)?$/.test(p));
  if (lengths.length < 2) return false;
  return parseFloat(lengths[0]) !== 0 || parseFloat(lengths[1]) !== 0;
}

/** Every color-mix of the panel or raised tone with transparent in a
 * value, nested ones included (a fade inside a gradient), each squashed
 * to one line. */
function panelMixes(value) {
  const out = [];
  const open = "color-mix(";
  for (let at = value.indexOf(open); at >= 0; at = value.indexOf(open, at + 1)) {
    let depth = 0;
    let end = -1;
    for (let i = at + open.length - 1; i < value.length; i++) {
      if (value[i] === "(") depth += 1;
      else if (value[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    const call = value.slice(at, end + 1);
    const args = splitTop(call.slice(open.length, -1), /,/).map(squash);
    if (args.length !== 3) continue;
    const [, a, b] = args;
    if ((PANEL_TONE.test(a) && TRANSPARENT.test(b)) || (TRANSPARENT.test(a) && PANEL_TONE.test(b))) {
      out.push(squash(call));
    }
  }
  return out;
}

/** Typed drop-shadow layers, background blurs and translucent panel or
 * raised fills: each must be read from the surface vocabulary. Comments
 * are blanked first (a retired value quoted in one is not a declaration);
 * a value written over several lines is judged and reported on one. */
export function sweepSurfaces(css, file) {
  const found = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const re = /(--[\w-]+|[a-zA-Z-]+)\s*:\s*([^;{}]+)(?=[;}])/g;
  let m;
  while ((m = re.exec(source))) {
    const prop = m[1].toLowerCase();
    const value = squash(m[2]);
    const line = source.slice(0, m.index).split("\n").length;
    const local = prop.startsWith("--");
    if (prop === "box-shadow" || (local && /var\(--shadow\)/.test(value))) {
      for (const layer of splitTop(value, /,/)) {
        if (isDropLayer(layer)) found.push({ file, rule: "shadow", value: layer, line });
      }
    }
    if ((/(^|-)backdrop-filter$/.test(prop) || local) && !BLUR_READ.test(value)) {
      for (const blur of value.match(/blur\([^()]*\)/g) ?? []) {
        found.push({ file, rule: "blur", value: blur, line });
      }
    }
    for (const term of panelMixes(value)) found.push({ file, rule: "fill", value: term, line });
  }
  return found;
}

/** Source with comment bodies blanked, newlines preserved so line
 * numbers survive. A glyph named in a comment is documentation, not
 * chrome (two of four frozen glyph rows were that). */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, " "));
}

/** Banned chrome glyphs in what a JSX file actually RENDERS.
 *
 * Only text nodes are scanned — the run between `>` and `<` — so a glyph
 * in a comment, an import path or a regex is not frozen as a violation,
 * and a glyph the user reads is not missed because it sat beside code.
 * The ASCII forms are caught only as a standalone leading token of a
 * label (`>+ Add filter<`), which is the recorded leftover shape;
 * arithmetic and JSX syntax are untouched. */
export function sweepGlyphs(tsx, file) {
  const found = [];
  const source = withoutComments(tsx);
  const textRe = />([^<>{}]*)</g;
  let m;
  while ((m = textRe.exec(source))) {
    const text = m[1];
    if (!text.trim()) continue;
    const line = source.slice(0, m.index).split("\n").length;
    for (const g of text.match(GLYPH_RE) ?? []) {
      found.push({ file, rule: "glyph", value: g, line });
    }
    const ascii = text.trim().match(/^([+x×✕])\s+\S/);
    if (ascii) found.push({ file, rule: "glyph", value: ascii[1], line });
  }
  return found;
}

/** Focus-outline suppressions (left exactly one, in Dialog). */
export function sweepOutline(css, file) {
  const found = [];
  if (file.endsWith("src/components/ui/Dialog.module.css")) return found;
  for (const { prop, value, line } of declarations(css)) {
    if (prop === "outline" && /^(none|0)$/.test(value)) {
      found.push({ file, rule: "outline", value, line });
    }
  }
  return found;
}

/* A selector that says disabled itself: the convention, not a finding.
 * Only a POSITIVE condition counts: a `:disabled`
 * inside `:not(...)` and an `aria-disabled` or `data-disabled` whose
 * value is explicitly false say the opposite, and do not exempt. */
function saysDisabled(selector) {
  const positive = selector.replace(/:not\([^)]*\)/g, "");
  if (/:disabled\b/.test(positive)) return true;
  const attrs = positive.matchAll(/\[(?:data|aria)-disabled(?:\s*[~|^$*]?=\s*(["']?)(.*?)\1\s*[is]?)?\]/g);
  for (const a of attrs) {
    if (a[2] === undefined || a[2].toLowerCase() !== "false") return true;
  }
  return false;
}

/** The arrow cursor outside the convention: every `cursor: default`
 * or `cursor: auto` declaration, judged per selector-list part so a bare
 * part cannot hide behind a disabled one, with the declaration's line.
 * Comments are blanked first (a retired rule quoted in one is not a rule);
 * blocks are read at any nesting, so an at-rule wrapper is transparent. */
export function sweepCursor(css, file) {
  const found = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = blockRe.exec(source))) {
    const body = m[2];
    // The optional priority suffix is recognised: `cursor: default
    // !important` is the declaration most able to override the app's
    // global pointer rule, and was invisible without it.
    const arrow = /(?:^|[;\s])cursor\s*:\s*(?:default|auto)(?:\s*!\s*important)?\s*(?:;|$)/i.exec(body);
    if (!arrow) continue;
    const at = m.index + m[1].length + 1 + arrow.index;
    const line = source.slice(0, at).split("\n").length;
    for (const part of m[1].split(",")) {
      const selector = part.replace(/\s+/g, " ").trim();
      if (!selector || saysDisabled(selector)) continue;
      found.push({ file, rule: "cursor", value: selector, line });
    }
  }
  return found;
}

/** The accessible-name floor: named-role containers and nav carry a name
 * in the tag; icon-only raw buttons carry a label. */
export function sweepNames(tsx, file) {
  const found = [];
  const tagRe = /<(nav|button|div|section|ul|span|header|aside|form)\b[^>]*>/gs;
  let m;
  while ((m = tagRe.exec(tsx))) {
    const tag = m[0];
    const line = tsx.slice(0, m.index).split("\n").length;
    const hasName = /aria-label(ledby)?[=\s]/.test(tag);
    if ((m[1] === "nav" || NAMED_ROLE_RE.test(tag)) && !hasName) {
      found.push({ file, rule: "name", value: "unnamed-" + (m[1] === "nav" ? "nav" : "role-container"), line });
    }
    if (m[1] === "button" && !hasName && !/aria-hidden/.test(tag)) {
      const close = tsx.indexOf("</button>", tagRe.lastIndex);
      if (close < 0) continue;
      const inner = tsx.slice(tagRe.lastIndex, close);
      // An icon is a drawn component OR an inline <svg>: an
      // `<svg aria-hidden />` button would otherwise escape entirely.
      const drawsIcon = /<[A-Z]\w*Icon\b/.test(inner) || /<svg\b/.test(inner);
      // Composed content — `{label}`, `{children}` — may well render the
      // name. The spec assigns that uncertainty to the runtime census, so
      // it is a residual here, never a frozen finding.
      const composed = /\{/.test(inner);
      const literalText = /[A-Za-z]/.test(
        inner.replace(/<[^>]*>/g, "").replace(/\{[^}]*\}/g, ""),
      );
      if (drawsIcon && !composed && !literalText) {
        found.push({ file, rule: "name", value: "unlabeled-icon-button", line });
      }
    }
  }
  return found;
}

function walk(dir, keep) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

/** The specimen's AUTHORED regions — everything outside the generator's
 * feed markers, whose content is the shipped sources' business and is
 * gated by lint:specimen instead.
 *
 * The page prints the rules; it must obey them, and until
 * this sweep existed that rule rested on a manual pass — the exact
 * "checked by hand" gap a review named. A line carrying
 * `wheelhouse:allow` is exempt, for the two places the page must show a
 * rule rather than follow it: the glyph rule's own text names the banned
 * glyphs, and
 * two rules are copied verbatim from the shipped token file so the page
 * renders the real focus ring and scrollbar. */
export function sweepSpecimen(page, file) {
  // Blank each fed region from its start marker to its MATCHING end
  // marker — not to the first `*/`, which lands inside the fed CSS's own
  // comments and would hand fed rules to the sweep as authored ones.
  const authored = page.replace(
    /\/\* wheelhouse:feed ([\w-]+) start \*\/[\s\S]*?\/\* wheelhouse:feed \1 end \*\//g,
    // Newline count is preserved so reported lines stay meaningful.
    (block) => block.replace(/[^\n]/g, " "),
  );
  const lines = authored.split("\n");
  const allowed = (line) => (lines[line - 1] ?? "").includes("wheelhouse:allow");
  const found = [];
  // The type ramp is a FLOOR on this page, not the app's six-rung ramp: a design
  // specimen legitimately shows display sizes the product never uses.
  for (const { prop, value, line } of declarations(authored)) {
    if (prop === "font-size") {
      const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
      if (px && Number(px[1]) < 11) found.push({ file, rule: "specimen-floor", value, line });
    } else if (/^border(-\w+){0,2}-radius$/.test(prop) && !usesVar(value)) {
      if (!value.split(/\s+/).every((p) => RADIUS_FAMILY.has(p)))
        found.push({ file, rule: "specimen-radius", value, line });
    }
  }
  for (const g of sweepGlyphs(authored, file)) {
    found.push({ ...g, rule: "specimen-glyph" });
  }
  return found.filter((f) => !allowed(f.line));
}

export function sweepTree(root) {
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  const src = path.join(root, "src");
  const found = [];
  for (const p of walk(src, (f) => f.endsWith(".module.css"))) {
    const css = readFileSync(p, "utf8");
    found.push(
      ...sweepStyles(css, rel(p)),
      ...sweepOutline(css, rel(p)),
      ...sweepCursor(css, rel(p)),
      ...sweepSurfaces(css, rel(p)),
    );
  }
  for (const p of walk(src, (f) => f.endsWith(".tsx") && !f.includes(".test."))) {
    const tsx = readFileSync(p, "utf8");
    found.push(...sweepGlyphs(tsx, rel(p)), ...sweepNames(tsx, rel(p)));
  }
  const specimen = "design/identity/dezfil-identity.html";
  found.push(...sweepSpecimen(readFileSync(path.join(root, specimen), "utf8"), specimen));
  return found;
}

/* Rows carry (file, rule, value, count) - line numbers drift, identities
 * do not. The lookup key joins on a tab, which none of the parts can
 * contain. */
const keyOf = (r) => [r.file, r.rule, r.value].join("\t");

/* Code-point order, not the machine's locale: the inventory is rewritten
 * on more than one machine, and a locale's collation would reshuffle every
 * row and bury the one that changed. */
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function toRows(found) {
  const map = new Map();
  for (const f of found) {
    const key = keyOf(f);
    const row = map.get(key);
    if (row) row.count += 1;
    else map.set(key, { file: f.file, rule: f.rule, value: f.value, count: 1 });
  }
  return [...map.values()].sort((a, b) =>
    a.file === b.file
      ? byCodePoint(a.rule + a.value, b.rule + b.value)
      : byCodePoint(a.file, b.file),
  );
}

/** The two-way ratchet: new violations and stale inventory rows both fail. */
export function judge(rows, inventory) {
  const have = new Map(rows.map((r) => [keyOf(r), r.count]));
  const listed = new Map(inventory.map((r) => [keyOf(r), r.count]));
  const problems = [];
  for (const r of rows) {
    const allowed = listed.get(keyOf(r)) ?? 0;
    if (r.count > allowed) {
      problems.push("NEW: " + r.file + " - " + r.rule + " " + JSON.stringify(r.value) + " x" + (r.count - allowed));
    }
  }
  for (const r of inventory) {
    const present = have.get(keyOf(r)) ?? 0;
    if (present < r.count) {
      problems.push(
        "STALE: " + r.file + " - " + r.rule + " " + JSON.stringify(r.value) +
          " listed x" + r.count + ", found x" + present +
          " (heal the inventory in the same change)",
      );
    }
  }
  return problems;
}

/** The inventory as written: the rows annotated from the two maps above,
 * two-space JSON, and every character outside ASCII escaped (a glyph
 * value, a dash in a note), the form the file is kept in, so a rewrite
 * changes only the rows that changed. */
export function inventoryText(rows) {
  const annotated = rows.map((r) => {
    const note = NAMED_EXCEPTIONS[keyOf(r)] ?? CURSOR_NOTES[keyOf(r)];
    return note ? { ...r, exception: note } : r;
  });
  const ascii = JSON.stringify(annotated, null, 2).replace(
    /[\u0080-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  return ascii + "\n";
}

/** The surface rows are the named exceptions: a row the map does not
 * name fails, so regenerating the inventory cannot absorb a typed shadow,
 * blur or panel fill on its own. */
export function judgeSurfaceNames(inventory) {
  return inventory
    .filter((r) => SURFACE_RULES.has(r.rule) && !NAMED_EXCEPTIONS[keyOf(r)])
    .map(
      (r) =>
        "UNNAMED: " + r.file + " - " + r.rule + " " + JSON.stringify(r.value) + " is not a named surface exception",
    );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const writeMode = args.includes("--write-inventory");
  const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  const inventoryPath = path.join(root, "scripts", "wheelhouse-inventory.json");
  const rows = toRows(sweepTree(root));
  if (writeMode) {
    writeFileSync(inventoryPath, inventoryText(rows));
    console.log("WROTE - " + rows.length + " inventory row(s) to " + inventoryPath);
    process.exit(0);
  }
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const problems = [...judge(rows, inventory), ...judgeSurfaceNames(inventory)];
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error(
      "FAIL - " + problems.length + " wheelhouse violation(s); the vocabulary is src/app/globals.css, the rules design/identity/dezfil-identity.html",
    );
    process.exit(1);
  }
  console.log("PASS - wheelhouse holds (" + rows.length + " inventoried leftover(s) unchanged).");
}
