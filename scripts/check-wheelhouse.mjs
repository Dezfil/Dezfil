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
};

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
  "src/components/builder/export/ExportControl.module.css\tcursor\t.menu .door[data-static]":
    "census: dead - nothing in src sets data-static ; heal by removing the rule and this row together",
  "src/components/UploadZone.module.css\tcursor\t.zone[data-busy=\"true\"]":
    "census: recorded - the busy zone still opens the file picker",
  "src/components/sql/SqlConsole.module.css\tcursor\t.grid td":
    "census: recorded - the cells are focusable and clickable",
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
      ? (a.rule + a.value).localeCompare(b.rule + b.value)
      : a.file.localeCompare(b.file),
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

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const writeMode = args.includes("--write-inventory");
  const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  const inventoryPath = path.join(root, "scripts", "wheelhouse-inventory.json");
  const rows = toRows(sweepTree(root));
  if (writeMode) {
    const annotated = rows.map((r) => {
      const note = NAMED_EXCEPTIONS[keyOf(r)] ?? CURSOR_NOTES[keyOf(r)];
      return note ? { ...r, exception: note } : r;
    });
    writeFileSync(inventoryPath, JSON.stringify(annotated, null, 2) + "\n");
    console.log("WROTE - " + rows.length + " inventory row(s) to " + inventoryPath);
    process.exit(0);
  }
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const problems = judge(rows, inventory);
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error(
      "FAIL - " + problems.length + " wheelhouse violation(s); the vocabulary is src/app/globals.css, the rules design/identity/dezfil-identity.html",
    );
    process.exit(1);
  }
  console.log("PASS - wheelhouse holds (" + rows.length + " inventoried leftover(s) unchanged).");
}
