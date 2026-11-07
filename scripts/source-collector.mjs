/*
 * The source collector: what the app's source says about the elements it
 * draws and the styles that reach them, read without running anything.
 *
 * It reads every stylesheet under src/ into rules by selector (a rule
 * nested in another with its selectors composed) and the custom properties
 * it gives (an @property rule's initial value included), and every
 * component file into the elements it draws:
 *
 *   - the classes each element can wear, from its own stylesheets (module
 *     classes), from plain class strings (global classes), from the
 *     objects a JSX spread can be, and from a class handed to a component
 *     that puts it on an element, followed through components that pass it
 *     on, by name or in the props they spread;
 *   - the attributes it is drawn with, its inline style, the text written
 *     in it and the expressions it shows;
 *   - where it sits: its JSX parent, and for a component's outermost
 *     element, every place the component is drawn; markup held in a const
 *     or drawn by a function of the same file joins the element that shows
 *     it, and the children a component is handed join the element that
 *     shows them;
 *   - the styles set in code: every colour, opacity, filter and custom
 *     property a TypeScript object or a JSX attribute gives (inline styles,
 *     editor themes) or a later write puts into a style object, with the
 *     values each can take, read through the names it uses where it uses
 *     them (the constants of the scopes around it, through the keys a
 *     destructuring takes, or one another file exports), and for an
 *     inline style, whether written, spread in or handed to a component,
 *     the colour each of its branches leaves the element with;
 *   - the styles set on an element by hand (`el.style.color = x`,
 *     `setProperty`, `cssText`, a style attribute, an object assigned into
 *     an element's style), which reach an element the source does not name;
 *   - stylesheet text a component writes in a <style> element, read as
 *     global rules of its file.
 *
 * A class expression, a style or a style's value, stylesheet text,
 * markup that may carry styles of its own, or a JSX spread that may carry
 * a class or a style, that it cannot read is recorded in `unresolved` with
 * its place, never dropped in silence.
 *
 * On top of that it answers: which elements a selector can stand for,
 * an element's parents and children in the drawn tree, whether it shows
 * text (the text a ::before, ::after or ::marker rule's `content` or a
 * list style written as a string writes in it included), and what it
 * shows.
 *
 * Not seen: elements a library draws for itself (an editor's gutter, a
 * map's controls), a class a component receives under a name it never
 * puts on an element, props passed through more than six components, a
 * style an element is given from another file's object (named as unread
 * instead), and which branch of a condition holds at run time: every
 * branch is taken to be possible.
 *
 * The parsing of stylesheets and of component imports is shared with the
 * class-pair sweep (scripts/check-class-pairs.mjs).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/* ---- stylesheets ---- */

/** Comments blanked, line breaks kept so lines stay countable. */
export const blank = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

/** Split at a separator that stands outside brackets and quotes. */
export function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (!quote && depth === 0 && sep.test(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function declarationsOf(body) {
  const out = [];
  for (const part of splitTop(body, /;/)) {
    const colon = part.indexOf(":");
    if (colon < 1) continue;
    const prop = part.slice(0, colon).trim();
    if (!/^(--)?[a-zA-Z-]+$/.test(prop)) continue;
    let value = part.slice(colon + 1).replace(/\s+/g, " ").trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    out.push({ prop: prop.startsWith("--") ? prop : prop.toLowerCase(), value, important });
  }
  return out;
}

const GROUPING = /^@(media|container|supports|layer|scope)\b/i;
/** The most selectors one nested rule is composed into. */
const NEST_CAP = 256;

/**
 * A nested rule's selectors, composed with the selectors of the rule it is
 * nested in, as CSS nesting reads them: `&` stands for the parent, a
 * selector without one sits under it (`.hint` is `& .hint`, `> .hint` is
 * `& > .hint`). Each `&` takes each parent selector. Where `&` continues a
 * compound (`.on&`) and the parent has combinators, the parent is written
 * as `:is()`, which the matching reads loosely. Past NEST_CAP selectors the
 * rest are left out and `complete` is false, so the rule can be named as
 * unread.
 */
export function composeNested(parents, prelude) {
  const out = [];
  let complete = true;
  for (const raw of splitTop(prelude, /,/)) {
    const sel = raw.replace(/\s+/g, " ").trim();
    const rel = sel.includes("&") ? sel : "& " + sel;
    let alts = [""];
    let cur = "";
    let quote = "";
    let bracket = 0;
    for (let i = 0; i < rel.length; i += 1) {
      const ch = rel[i];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[") bracket += 1;
      else if (ch === "]") bracket -= 1;
      if (ch !== "&" || quote || bracket) {
        cur += ch;
        continue;
      }
      const before = (alts[0] + cur).slice(-1);
      const starts = !before || /[\s>+~(,]/.test(before);
      const each = parents.map((p) => (starts || !/[\s>+~]/.test(p) ? p : `:is(${p})`));
      const next = alts.flatMap((a) => each.map((p) => a + cur + p));
      if (next.length > NEST_CAP) complete = false;
      alts = next.slice(0, NEST_CAP);
      cur = "";
    }
    out.push(...alts.map((a) => (a + cur).replace(/\s+/g, " ").trim()));
  }
  const selectors = [...new Set(out)];
  if (selectors.length > NEST_CAP) complete = false;
  return { selectors: selectors.slice(0, NEST_CAP), complete };
}

/** Every style rule of a stylesheet: its selectors, the at-rules around it,
 * its declarations and its line. Grouping at-rules are read through;
 * keyframes, font faces and the like hold no element rules. A rule nested
 * in another is a rule of its own, its selectors composed with its
 * parent's, and a grouping at-rule nested in a rule gives the parent's
 * selectors the declarations it holds; the parent keeps the declarations
 * written around them. A nested rule composed into more selectors than
 * are read names its own selector text in `unread`. With `{ lines: true }`
 * each declaration carries the line it starts on. */
export function parseRules(css, options = {}) {
  const src = blank(css);
  const rules = [];
  const lineAt = (i) => src.slice(0, i).split("\n").length;
  /** The index just past the brace that closes the one at `i`. */
  const closeOf = (i, end) => {
    let depth = 1;
    let quote = "";
    let j = i + 1;
    for (; j < end && depth > 0; j += 1) {
      const ch = src[j];
      if (quote) {
        if (ch === quote && src[j - 1] !== "\\") quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    return j;
  };
  const declsOf = (ranges) => ranges.flatMap(([a, b]) => (options.lines ? declarationsAt(src, a, b, lineAt) : declarationsOf(src.slice(a, b))));
  /** The blocks written in [start, end): each with its prelude, where the
   * prelude starts, its body, and the text between blocks. */
  const blocksIn = (start, end) => {
    const blocks = [];
    const between = [];
    let head = start;
    let from = start;
    let quote = "";
    for (let i = start; i < end; i += 1) {
      const ch = src[i];
      if (quote) {
        if (ch === quote && src[i - 1] !== "\\") quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ";") {
        head = i + 1;
        continue;
      }
      if (ch !== "{") continue;
      const j = closeOf(i, end);
      const text = src.slice(head, i);
      between.push([from, head]);
      blocks.push({ prelude: text.trim(), at: head + (text.length - text.trimStart().length), body: [i + 1, j - 1] });
      i = j - 1;
      head = j;
      from = j;
    }
    between.push([from, end]);
    return { blocks, between };
  };
  /** A style rule's body: its own declarations, then what is nested in it.
   * A nested rule composed into more selectors than are read carries its
   * selector text as `unread`. */
  const rule = (selectors, context, at, [start, end], unread = null) => {
    const { blocks, between } = blocksIn(start, end);
    const own = { selectors, context: context.join(" "), decls: declsOf(between), line: lineAt(at) };
    if (unread) own.unread = unread.replace(/\s+/g, " ").slice(0, 100);
    rules.push(own);
    nested(blocks, selectors, context);
  };
  const nested = (blocks, selectors, context) => {
    for (const b of blocks) {
      if (b.prelude.startsWith("@")) {
        if (!GROUPING.test(b.prelude)) continue;
        const inner = [...context, b.prelude.replace(/\s+/g, " ")];
        const { blocks: deeper, between } = blocksIn(...b.body);
        const decls = declsOf(between);
        if (decls.length) rules.push({ selectors, context: inner.join(" "), decls, line: lineAt(b.at) });
        nested(deeper, selectors, inner);
      } else if (b.prelude) {
        const composed = composeNested(selectors, b.prelude);
        rule(composed.selectors, context, b.at, b.body, composed.complete ? null : b.prelude);
      }
    }
  };
  const walk = (start, end, context) => {
    for (const b of blocksIn(start, end).blocks) {
      if (b.prelude.startsWith("@")) {
        if (GROUPING.test(b.prelude)) walk(...b.body, [...context, b.prelude.replace(/\s+/g, " ")]);
      } else if (b.prelude) rule(splitTop(b.prelude, /,/).map((s) => s.replace(/\s+/g, " ")), context, b.at, b.body);
    }
  };
  walk(0, src.length, []);
  return rules;
}

/** The initial values a stylesheet's @property rules register: a custom
 * property given one holds it wherever nothing else sets it. */
export function registeredValues(css) {
  const src = blank(css);
  const out = [];
  for (const m of src.matchAll(/@property\s+(--[-\w]+)\s*\{([^{}]*)\}/g)) {
    const initial = declarationsOf(m[2]).filter((d) => d.prop === "initial-value").at(-1);
    if (initial) out.push({ prop: m[1], value: initial.value, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** A selector's compounds, split at its top-level combinators. */
export function compoundsOf(selector) {
  const out = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = "";
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const ELEMENT_PSEUDOS = new Set(["before", "after", "first-line", "first-letter"]);

/** The simple selectors of one compound: [kind, text, argument]. */
export function simplesOf(compound) {
  const out = [];
  let i = 0;
  const ident = () => {
    const m = /^-?[_a-zA-Z -￿\\][-_a-zA-Z0-9 -￿\\]*/.exec(compound.slice(i));
    const name = m ? m[0] : "";
    i += name.length;
    return name;
  };
  const balanced = () => {
    let depth = 0;
    const start = i;
    for (; i < compound.length; i += 1) {
      if (compound[i] === "(") depth += 1;
      else if (compound[i] === ")" && --depth === 0) {
        i += 1;
        break;
      }
    }
    return compound.slice(start + 1, i - 1);
  };
  while (i < compound.length) {
    const ch = compound[i];
    if (ch === ".") {
      i += 1;
      out.push(["class", ident()]);
    } else if (ch === "#") {
      i += 1;
      out.push(["id", ident()]);
    } else if (ch === "[") {
      const end = compound.indexOf("]", i);
      out.push(["attr", compound.slice(i, end + 1)]);
      i = end + 1;
    } else if (ch === ":") {
      const element = compound[i + 1] === ":";
      i += element ? 2 : 1;
      const name = ident().toLowerCase();
      const arg = compound[i] === "(" ? balanced() : null;
      out.push([element || ELEMENT_PSEUDOS.has(name) ? "pseudo-element" : "pseudo", name, arg]);
    } else if (ch === "*" || ch === "&") {
      i += 1;
    } else {
      const name = ident();
      if (!name) i += 1;
      else out.push(["type", name]);
    }
  }
  return out;
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const max = (list) => list.reduce((best, s) => (cmp(s, best) > 0 ? s : best), [0, 0, 0]);
export const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** A selector's specificity, as Selectors Level 4 counts it; :global()
 * and :local() are transparent. */
export function specificity(selector) {
  let total = [0, 0, 0];
  for (const compound of compoundsOf(selector)) {
    for (const [kind, name, arg] of simplesOf(compound)) {
      if (kind === "id") total = add(total, [1, 0, 0]);
      else if (kind === "class" || kind === "attr") total = add(total, [0, 1, 0]);
      else if (kind === "type" || kind === "pseudo-element") total = add(total, [0, 0, 1]);
      else if (kind === "pseudo") {
        if (name === "where") continue;
        if (["global", "local"].includes(name) && arg !== null) total = add(total, specificity(arg));
        else if (["is", "not", "has", "matches"].includes(name) && arg !== null) {
          total = add(total, max(splitTop(arg, /,/).map(specificity)));
        } else if (/^nth-(last-)?child$/.test(name) && arg && / of /.test(arg)) {
          total = add(total, add([0, 1, 0], max(splitTop(arg.split(/ of /)[1], /,/).map(specificity))));
        } else total = add(total, [0, 1, 0]);
      }
    }
  }
  return total;
}

/** For one selector, the module classes its subject must carry, and what
 * else the subject and its ancestors ask, so two subjects can be compared. */
export function subjectOf(selector) {
  const compounds = compoundsOf(selector);
  const subject = compounds[compounds.length - 1] ?? "";
  const classes = simplesOf(subject).filter(([kind]) => kind === "class").map(([, name]) => name);
  return { classes, subject, ancestors: compounds.slice(0, -1).join(" "), specificity: specificity(selector) };
}

/* ---- component imports ---- */

export function resolveImport(root, fromFile, spec, exists = (file) => existsSync(path.join(root, file))) {
  let base;
  if (spec.startsWith("@/")) base = path.posix.join("src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(fromFile), spec);
  else return null;
  if (base.endsWith(".css")) return base;
  for (const candidate of [base, base + ".tsx", base + ".ts", base + "/index.tsx", base + "/index.ts"]) {
    if (/\.(tsx?|jsx?)$/.test(candidate) && exists(candidate)) return candidate;
  }
  return null;
}

export const isComponentName = (name) => /^[A-Z]/.test(name);

/** The function a component is: itself, or the one wrapped by forwardRef or memo. */
export function functionOf(node) {
  if (!node) return null;
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (ts.isCallExpression(node)) return node.arguments.map(functionOf).find(Boolean) ?? null;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return functionOf(node.expression);
  return null;
}

/** A component's props as its body reads them: each destructured prop's
 * local name, the rest binding, and a props identifier. */
export function bindingsOf(fn) {
  const param = fn.parameters[0];
  const props = new Map();
  let rest = null;
  let whole = null;
  if (param && ts.isObjectBindingPattern(param.name)) {
    for (const element of param.name.elements) {
      if (element.dotDotDotToken && ts.isIdentifier(element.name)) rest = element.name.text;
      else if (ts.isIdentifier(element.name)) {
        const prop = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
        props.set(element.name.text, prop);
      }
    }
  } else if (param && ts.isIdentifier(param.name)) whole = param.name.text;
  return { props, rest, whole, bound: new Set(props.values()) };
}

export function walk(dir, keep, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

/* ---- class sets ---- */

const CAP = 256;
export const EMPTY = [[]];
export const union = (...lists) => {
  const seen = new Map();
  for (const list of lists) for (const alt of list) seen.set([...alt].sort().join("\n"), alt);
  return [...seen.values()];
};
export function product(lists) {
  let out = EMPTY;
  for (const list of lists) {
    const next = [];
    for (const a of out) for (const b of list) next.push([...new Set([...a, ...b])]);
    out = union(next);
    // Past the cap the branches are merged: an over-reading, never a miss.
    if (out.length > CAP) out = [[...new Set(out.flat())]];
  }
  return out;
}

/* ---- declarations with their lines ---- */

/** A rule body's declarations as declarationsOf reads them, each with the
 * line it starts on. */
function declarationsAt(src, start, end, lineAt) {
  const out = [];
  let depth = 0;
  let quote = "";
  let from = start;
  const take = (to) => {
    const part = src.slice(from, to);
    const colon = part.indexOf(":");
    const lead = part.length - part.trimStart().length;
    if (colon >= 1) {
      const prop = part.slice(0, colon).trim();
      if (/^(--)?[a-zA-Z-]+$/.test(prop)) {
        let value = part.slice(colon + 1).replace(/\s+/g, " ").trim();
        const important = /!\s*important$/i.test(value);
        if (important) value = value.replace(/!\s*important$/i, "").trim();
        out.push({ prop: prop.startsWith("--") ? prop : prop.toLowerCase(), value, important, line: lineAt(from + lead) });
      }
    }
  };
  for (let i = start; i < end; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === ";" && depth === 0) {
      take(i);
      from = i + 1;
    }
  }
  if (src.slice(from, end).trim()) take(end);
  return out;
}

/* ---- selectors, for matching against elements ---- */

/** A selector's compounds left to right, each with the combinator that
 * joins it to the one before (" ", ">", "+" or "~"; "" for the first). */
export function selectorParts(selector) {
  const out = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  let comb = "";
  const flush = () => {
    if (cur) out.push({ text: cur, comb: out.length ? comb || " " : "" });
    cur = "";
    comb = "";
  };
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = "";
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      if (cur) {
        out.push({ text: cur, comb: out.length ? comb || " " : "" });
        cur = "";
        comb = "";
      }
      if (/[>+~]/.test(ch)) comb = ch;
      continue;
    }
    cur += ch;
  }
  flush();
  return out.map(({ text, comb: c }) => ({ ...readCompound(text), comb: c }));
}

/** Pseudo-classes that only name where an element sits, never a state it
 * passes through: a rule under one of them applies at rest. */
const STRUCTURAL = new Set([
  "not", "is", "where", "has", "global", "local", "root", "first-child", "last-child", "only-child",
  "nth-child", "nth-last-child", "first-of-type", "last-of-type", "only-of-type", "nth-of-type",
  "nth-last-of-type", "empty", "scope", "defined",
]);
/** Pseudo-classes a person passes through by pointing, pressing or focusing. */
const INTERACTION = new Set(["hover", "active", "focus", "focus-visible", "focus-within"]);

/** One compound: its type, module classes, global classes, attributes,
 * pseudo-classes and pseudo-element. `document` marks a compound that
 * stands for the page itself (html, body, :root, or a :global() of them),
 * which every element sits under. */
function readCompound(text) {
  const out = { text, tag: null, classes: [], globals: [], attrs: [], pseudos: [], pseudoElement: null, document: false, opaque: false };
  for (const [kind, name, arg] of simplesOf(text)) {
    if (kind === "type") out.tag = name.toLowerCase();
    else if (kind === "class") out.classes.push(name);
    else if (kind === "attr") out.attrs.push(readAttr(name));
    else if (kind === "pseudo-element") out.pseudoElement = name;
    else if (kind === "pseudo" && (name === "global" || name === "local") && arg !== null) {
      const inner = selectorParts(arg);
      if (inner.length !== 1) {
        out.opaque = true;
        continue;
      }
      const [c] = inner;
      if (c.tag) out.tag = c.tag;
      out.globals.push(...(name === "global" ? [...c.classes, ...c.globals] : []));
      out.classes.push(...(name === "local" ? c.classes : []));
      out.attrs.push(...c.attrs);
      out.pseudos.push(...c.pseudos);
      if (c.document) out.document = true;
    } else if (kind === "pseudo") out.pseudos.push({ name, arg });
  }
  if (out.tag === "html" || out.tag === "body" || out.pseudos.some((p) => p.name === "root")) out.document = true;
  return out;
}

function readAttr(text) {
  const m = /^\[\s*([-\w]+)\s*(?:([~|^$*]?=)\s*(["']?)(.*?)\3\s*[is]?)?\s*\]$/.exec(text);
  return m ? { name: m[1], op: m[2] ?? null, value: m[4] ?? null } : { name: text, op: null, value: null };
}

/** Whether a selector applies at rest: no compound asks for a pointer,
 * press or focus state outside a :not(). */
export function atRest(selector) {
  return !selectorParts(selector).some((c) => c.pseudos.some((p) => INTERACTION.has(p.name)));
}

/** The state pseudo-classes and attributes a selector asks for, read
 * positively (a :not() says the opposite and is left out). */
export function statesOf(selector) {
  const positive = selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "");
  const parts = selectorParts(positive);
  return {
    pseudos: parts.flatMap((c) => c.pseudos.map((p) => p.name)).filter((n) => !STRUCTURAL.has(n)),
    attrs: parts.flatMap((c) => c.attrs),
  };
}

/* ---- components ---- */

const CLASS_PROP = /^(className|class)$|ClassName$/;
/** A TypeScript file without markup is read only when it can set a style:
 * it names a faint spelling, a colour, an opacity, a fill, a filter or a
 * custom property, whatever the value (a constant from another file
 * included), or it styles an element by hand. */
const CODE_STYLE_HINT = /fg-faint|#93a19c|#5d6880|#7f8d89|code-comment|\b(color|opacity|fill|WebkitTextFillColor)\b|\b(?:webkit-?)?filter["']?\s*[:=]|["'`]--[-\w]+["'`]|\.style\b|cssText|setProperty|setAttribute/i;
/** Names an expression shows that hold a drawing, not text. */
const ICONISH = /icon|glyph|svg|chevron|caret|arrow$|tile$/i;
const SVG_TEXT = new Set(["text", "tspan", "textpath"]);
const SVG_ART = new Set([
  "svg", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g", "defs", "clippath", "mask",
  "lineargradient", "radialgradient", "stop", "pattern", "use", "symbol", "title", "desc", "marker", "image", "foreignobject",
]);
const FIELDS = new Set(["input", "textarea", "select"]);
/** External components whose element is known: what they render a class onto. */
const EXTERNAL_TAGS = { Link: "a", NextLink: "a", Image: "img" };

/** The text an expression shows: "text" when it can be words or numbers,
 * "slot" for the children a caller hands in, null for elements, icons and
 * nothing. Calls to a function of the same file that returns markup are
 * named, so the markup is joined where it is drawn. */
function textOf(node, ctx) {
  if (!node) return { kind: null };
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return textOf(node.expression, ctx);
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return { kind: null };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: node.text.trim() ? "text" : null };
  if (ts.isTemplateExpression(node) || ts.isNumericLiteral(node)) return { kind: "text" };
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { kind: null };
  if (ts.isIdentifier(node) && node.text === "undefined") return { kind: null };
  if (ts.isConditionalExpression(node)) return merge(textOf(node.whenTrue, ctx), textOf(node.whenFalse, ctx));
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return textOf(node.right, ctx);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return merge(textOf(node.left, ctx), textOf(node.right, ctx));
    return { kind: "text" };
  }
  if (ts.isIdentifier(node)) {
    if (node.text === "children") return { kind: "slot" };
    const prop = ctx.bindings?.props.get(node.text);
    if (prop) return { kind: ICONISH.test(node.text) ? null : "text", slotProp: prop };
    if (ICONISH.test(node.text)) return { kind: null };
    const init = ctx.constOf(node.text);
    if (init && [init].flat().some(containsJsx)) {
      if ([init].flat().some((i) => functionOf(i))) return { kind: "text" };
      return { kind: null, ref: node.text };
    }
    return { kind: "text" };
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === "children") return { kind: "slot" };
    if (ts.isIdentifier(node.expression) && ctx.bindings && node.expression.text === ctx.bindings.whole) {
      return { kind: ICONISH.test(node.name.text) ? null : "text", slotProp: node.name.text };
    }
    if (ICONISH.test(node.name.text)) return { kind: null };
    return { kind: "text" };
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && /^(map|flatMap)$/.test(callee.name.text)) {
      const fn = node.arguments[0];
      if (fn && ts.isIdentifier(fn) && ctx.helperNamed(fn.text)) return { kind: null, helper: fn.text };
      return { kind: fn && containsJsx(fn) ? null : "text" };
    }
    if (ts.isIdentifier(callee) && ctx.helperNamed(callee.text)) return { kind: null, helper: callee.text };
    if (ts.isIdentifier(callee) && ICONISH.test(callee.text)) return { kind: null };
    return { kind: "text" };
  }
  return { kind: "text" };
}
const merge = (a, b) => ({
  kind: a.kind === "text" || b.kind === "text" ? "text" : a.kind ?? b.kind,
  helper: a.helper ?? b.helper,
  ref: a.ref ?? b.ref,
  slotProp: a.slotProp ?? b.slotProp,
});
function containsJsx(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The literal a JSX attribute holds: its string, true for a bare name,
 * or null when it is computed. */
function attributeValue(attr) {
  if (!attr.initializer) return true;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  const e = ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : null;
  if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text;
  return null;
}

/* ---- values set in code ---- */

/** An expression with its brackets, type assertions and JSX braces taken off. */
function unwrap(node) {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isNonNullExpression(n) || ts.isJsxExpression(n) || ts.isTypeAssertionExpression?.(n))) n = n.expression;
  return n;
}

/** The expressions a function returns, outside the functions nested in
 * it; null for a return with no value. */
function returnsOf(fn) {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out = [];
  const visit = (n) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) out.push(n.expression ?? null);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

/** The member names the objects an expression can be may hold, read from
 * object literals through conditions and fallbacks; null when a branch is
 * anything else or holds a spread or a name that cannot be read. */
function keysOf(node, depth = 0) {
  const n = unwrap(node);
  if (!n || n.kind === ts.SyntaxKind.NullKeyword || n.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(n) && n.text === "undefined")) return new Set();
  if (depth > 8) return null;
  if (ts.isConditionalExpression(n)) {
    const [a, b] = [keysOf(n.whenTrue, depth + 1), keysOf(n.whenFalse, depth + 1)];
    return a && b ? new Set([...a, ...b]) : null;
  }
  if (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) {
    const right = keysOf(n.right, depth + 1);
    if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return right;
    const left = keysOf(n.left, depth + 1);
    return left && right ? new Set([...left, ...right]) : null;
  }
  if (!ts.isObjectLiteralExpression(n)) return null;
  const out = new Set();
  for (const p of n.properties) {
    const key = ts.isSpreadAssignment(p) ? null : memberKey(p.name);
    if (key === null) return null;
    out.add(key);
  }
  return out;
}

/** Whether an initializer belongs to a `const`, so the value it gives is the
 * only one the name ever holds. */
const isConstInit = (init) => !!init?.parent && ts.isVariableDeclaration(init.parent) && init.parent.initializer === init && (ts.getCombinedNodeFlags(init.parent) & ts.NodeFlags.Const) !== 0;

/** The most values one expression is followed into, and the depth. */
const VALUE_CAP = 32;
const VALUE_DEPTH = 12;

/** A literal's text with its quotes taken off. */
const unquoted = (v) => String(v).trim().replace(/^(["'`])([\s\S]*)\1$/, "$2").trim();

/** A branch of an inline style that leaves the colour as it was. */
const ABSENT = Object.freeze({ absent: true });

const NAMED_COLOURS = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
  "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
  "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise " +
  "darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod " +
  "gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral " +
  "lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey " +
  "lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
  "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
  "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
  "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow " +
  "springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor " +
  "inherit initial unset revert revert-layer canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext " +
  "highlight highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext").split(" "));

/** Whether a value can stand as a colour: a hex, a colour function or a
 * var(), a named colour or a keyword. Anything else (empty, `none`, a
 * number) is dropped by the browser, and the colour is left unset. */
export function isColourValue(value) {
  const v = String(value).trim().toLowerCase();
  if (!v) return false;
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return true;
  if (/^[a-z][-a-z0-9]*\(.*\)$/s.test(v)) return true;
  return NAMED_COLOURS.has(v);
}

/** The name a member of an object literal is written under, or null when
 * it is computed from something other than a literal. */
function memberKey(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isPrivateIdentifier?.(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = unwrap(name.expression);
    if (e && (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text;
  }
  return null;
}

/** The expression a member of an object literal holds when it is read:
 * its value, the constant a shorthand names, a getter's one returned
 * expression; null for a method, a setter, or a getter that does more. */
function memberValue(p) {
  if (ts.isPropertyAssignment(p)) return p.initializer;
  if (ts.isShorthandPropertyAssignment(p)) return p.name;
  if (ts.isGetAccessorDeclaration(p) && p.body) {
    const returns = p.body.statements.filter(ts.isReturnStatement);
    return returns.length === 1 && p.body.statements.length === 1 ? returns[0].expression ?? null : null;
  }
  return null;
}

/** Every name a declaration's name or binding pattern introduces, with the
 * keys that lead to it from the value it takes apart and the default it
 * falls back to. */
function boundNames(name, path = [], fallback = null, out = []) {
  if (ts.isIdentifier(name)) out.push({ name: name.text, path, fallback });
  else if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      const key = el.dotDotDotToken ? "*" : el.propertyName ? memberKey(el.propertyName) ?? "*" : ts.isIdentifier(el.name) ? el.name.text : "*";
      boundNames(el.name, [...path, key], el.initializer ?? null, out);
    }
  } else if (ts.isArrayBindingPattern(name)) {
    name.elements.forEach((el, i) => {
      if (!ts.isOmittedExpression(el)) boundNames(el.name, [...path, el.dotDotDotToken ? "*" : String(i)], el.initializer ?? null, out);
    });
  }
  return out;
}

/** The lists of class sets one array of lists can produce together. Past
 * the cap the branches are merged into the set that holds every class and
 * the set that holds only the classes every branch shares, so a reading
 * that asks what an element may lack still sees the bare branch. */
function productKeep(lists) {
  let out = EMPTY;
  for (const list of lists) {
    const next = [];
    for (const a of out) for (const b of list) next.push([...new Set([...a, ...b])]);
    out = union(next);
    if (out.length > CAP) {
      const all = [...new Set(out.flat())];
      out = union([all, all.filter((t) => out.every((alt) => alt.includes(t)))]);
    }
  }
  return out;
}

/**
 * The values an expression set in code can take, read through the
 * constants it names, the properties and items of constant objects and
 * arrays, and both sides of a condition or a fallback (every branch is
 * taken to be possible):
 *
 *   - `values`: each literal it can be, as written (a string with its
 *     quotes, a number);
 *   - `none`: whether a branch gives no value at all (null, undefined,
 *     false, a key the object does not hold);
 *   - `open`: what it cannot read: a call, a prop or a parameter, a
 *     constant that is not one (a `let`), a name another file does not
 *     export as a constant.
 *
 * `scope.lookup(name)` answers what a name is: a list of { init, scope }
 * for a constant, or null for anything else.
 */
function valuesOf(node, scope, from = 0) {
  const out = { values: [], none: false, open: [] };
  const text = (n) => n.getText().replace(/\s+/g, " ");
  /** The keys an element access can read: its literal, or each literal its
   * key can be; "*" for every member when the key cannot be read, which
   * may also name a member the object does not hold. */
  const keysOf = (arg, sc, depth) => {
    const a = unwrap(arg);
    if (a && (ts.isStringLiteral(a) || ts.isNumericLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) return { keys: [a.text], sure: true };
    const read = valuesOf(a, sc, depth + 1);
    if (read.open.length || !read.values.length) return { keys: ["*"], sure: false };
    return { keys: [...new Set(read.values.map(unquoted))], sure: !read.none };
  };
  /** An array literal's items with its spreads laid out, or null when a
   * spread is not a constant array. */
  const itemsOf = (arr, sc, depth) => {
    const items = [];
    for (const el of arr.elements) {
      if (!ts.isSpreadElement(el)) {
        items.push(el);
        continue;
      }
      let inner = unwrap(el.expression);
      if (inner && ts.isIdentifier(inner)) {
        const found = sc.lookup(inner.text, inner);
        inner = found?.length === 1 && !(found[0].keys ?? []).length ? unwrap(found[0].init) : null;
      }
      const nested = inner && ts.isArrayLiteralExpression(inner) && depth < VALUE_DEPTH ? itemsOf(inner, sc, depth + 1) : null;
      if (!nested) return null;
      items.push(...nested);
    }
    return items;
  };
  const visit = (raw, sc, keys, depth) => {
    const n = unwrap(raw);
    if (!n || depth > VALUE_DEPTH || out.values.length > VALUE_CAP) {
      out.open.push(raw ? text(raw) : "(nothing)");
      return;
    }
    if (ts.isConditionalExpression(n)) {
      visit(n.whenTrue, sc, keys, depth + 1);
      visit(n.whenFalse, sc, keys, depth + 1);
      return;
    }
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        out.none = true;
        visit(n.right, sc, keys, depth + 1);
        return;
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        // A left side that gives nothing falls through to the right.
        const none = out.none;
        visit(n.left, sc, keys, depth + 1);
        out.none = none;
        visit(n.right, sc, keys, depth + 1);
        return;
      }
    }
    if (n.kind === ts.SyntaxKind.NullKeyword || n.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(n) && n.text === "undefined")) {
      out.none = true;
      return;
    }
    if (ts.isIdentifier(n)) {
      const found = sc.lookup(n.text, n);
      if (!found?.length) out.open.push(text(n));
      else for (const f of found) visit(f.init, f.scope, [...(f.keys ?? []), ...keys], depth + 1);
      return;
    }
    if (ts.isPropertyAccessExpression(n)) {
      visit(n.expression, sc, [n.name.text, ...keys], depth + 1);
      return;
    }
    if (ts.isElementAccessExpression(n)) {
      const { keys: read, sure } = keysOf(n.argumentExpression, sc, depth);
      // A key that cannot be read may name a member the object lacks.
      if (!sure) out.none = true;
      for (const key of read) visit(n.expression, sc, [key, ...keys], depth + 1);
      return;
    }
    if (keys.length) {
      const [key, ...rest] = keys;
      if (ts.isObjectLiteralExpression(n)) {
        let hit = false;
        for (const p of n.properties) {
          if (ts.isSpreadAssignment(p)) {
            hit = true;
            visit(p.expression, sc, keys, depth + 1);
            continue;
          }
          const name = memberKey(p.name);
          // A name computed from a constant is read as the constant's value.
          const names = name !== null ? { keys: [name], sure: true } : p.name && ts.isComputedPropertyName(p.name) ? keysOf(p.name.expression, sc, depth) : null;
          if (!names || !(key === "*" || names.keys.includes(key) || names.keys.includes("*"))) continue;
          const value = memberValue(p);
          if (value === null) {
            if (ts.isGetAccessorDeclaration(p)) out.open.push(text(p));
            continue;
          }
          hit = true;
          if (!names.sure || (key !== "*" && !names.keys.includes(key))) out.none = true;
          visit(value, sc, rest, depth + 1);
        }
        if (!hit) out.none = true;
        return;
      }
      if (ts.isArrayLiteralExpression(n) && (key === "*" || /^\d+$/.test(key))) {
        const laid = itemsOf(n, sc, depth);
        if (laid === null) {
          // A spread it cannot lay out: every item may stand at the index.
          if (key !== "*") out.none = true;
          for (const el of n.elements) visit(ts.isSpreadElement(el) ? el.expression : el, sc, ts.isSpreadElement(el) ? ["*", ...rest] : rest, depth + 1);
          return;
        }
        const items = key === "*" ? laid : [laid[Number(key)]].filter(Boolean);
        if (!items.length) out.none = true;
        for (const item of items) visit(item, sc, rest, depth + 1);
        return;
      }
      out.open.push(text(n));
      return;
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) {
      out.values.push(text(n));
      return;
    }
    if (ts.isPrefixUnaryExpression(n) && ts.isNumericLiteral(n.operand)) {
      out.values.push(text(n));
      return;
    }
    if (ts.isTemplateExpression(n)) {
      // Each part read through; a part it cannot read leaves the whole unread.
      let combos = [n.head.text];
      for (const span of n.templateSpans) {
        const part = valuesOf(span.expression, sc, depth + 1);
        if (part.open.length || part.none || !part.values.length || combos.length * part.values.length > VALUE_CAP) {
          out.open.push(text(n));
          return;
        }
        combos = combos.flatMap((c) => part.values.map((v) => c + v.replace(/^(["'`])([\s\S]*)\1$/, "$2") + span.literal.text));
      }
      for (const c of combos) out.values.push("`" + c + "`");
      return;
    }
    out.open.push(text(n));
  };
  visit(node, scope, [], from);
  return out;
}

/** Read one source file: its stylesheet imports, its other imports, its
 * exports, its components, every element it draws, and every style it
 * sets in code. */
function readSource(file, text, env) {
  const base = env.base;
  const local = (i) => elements[i - base];
  const isTsx = file.endsWith(".tsx");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const sheets = new Map();
  const imports = new Map();
  const reexports = new Map();
  const components = new Map();
  const exportsAs = new Map();
  const moduleConsts = new Map();
  const helpers = new Map();

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text;
      const target = resolveImport(env.root, file, spec, env.exists);
      const clause = statement.importClause;
      if (!clause) continue;
      if (target?.endsWith(".module.css")) {
        if (clause.name) sheets.set(clause.name.text, target);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) sheets.set(clause.namedBindings.name.text, target);
        continue;
      }
      const from = target ?? "external:" + spec;
      if (clause.name) imports.set(clause.name.text, { file: from, name: "default" });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) imports.set(el.name.text, { file: from, name: (el.propertyName ?? el.name).text });
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = resolveImport(env.root, file, statement.moduleSpecifier.text, env.exists);
      if (target && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) reexports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
      } else if (target && !statement.exportClause) reexports.set("*" + target, { file: target, name: "*" });
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const el of statement.exportClause.elements) exportsAs.set(el.name.text, (el.propertyName ?? el.name).text);
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) exportsAs.set("default", statement.expression.text);
  }

  for (const statement of source.statements) {
    const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (isComponentName(statement.name.text)) {
        components.set(statement.name.text, { fn: statement });
        if (exported) exportsAs.set(isDefault ? "default" : statement.name.text, statement.name.text);
      } else helpers.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const name = decl.name.text;
        const fn = functionOf(decl.initializer);
        if (fn && isComponentName(name)) {
          components.set(name, { fn, bindings: bindingsOf(fn) });
          if (exported) exportsAs.set(name, name);
        } else if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) helpers.set(name, fn);
        else moduleConsts.set(name, decl.initializer);
      }
    } else if (ts.isExportAssignment(statement)) {
      const fn = functionOf(statement.expression);
      if (fn) {
        components.set("default", { fn, bindings: bindingsOf(fn) });
        exportsAs.set("default", "default");
      }
    }
  }

  const elements = [];
  const codeStyles = [];
  const codeCustoms = [];
  const unresolved = [];
  const owner = new Map();
  /** Each style object literal, with the elements whose style it is. */
  const styleOwners = new Map();
  for (const [name, { fn }] of components) owner.set(fn, { component: name });
  for (const [name, fn] of helpers) owner.set(fn, { component: null, helper: name });

  /** The constants a function declares, by name. */
  const constsCache = new Map();
  const constantsOf = (fn) => {
    if (!fn) return new Map();
    if (constsCache.has(fn)) return constsCache.get(fn);
    const consts = new Map();
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const name = node.name.text;
        consts.set(name, consts.has(name) ? [...[consts.get(name)].flat(), node.initializer] : node.initializer);
      }
      if (ts.isFunctionDeclaration(node) && node.name) consts.set(node.name.text, node);
      ts.forEachChild(node, visit);
    };
    if (fn.body) ts.forEachChild(fn.body, visit);
    constsCache.set(fn, consts);
    return consts;
  };

  /** A component's props as its body reads them, including those taken
   * out of the props object inside the body (`const { a, ...rest } = props`). */
  const bindingsCache = new Map();
  const bindingsFor = (fnNode) => {
    if (bindingsCache.has(fnNode)) return bindingsCache.get(fnNode);
    const own = bindingsOf(fnNode);
    const b = { props: new Map(own.props), rest: own.rest, whole: own.whole };
    if (b.whole && fnNode.body) {
      const visit = (n) => {
        if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && ts.isIdentifier(n.initializer) && n.initializer.text === b.whole) {
          for (const el of n.name.elements) {
            if (el.dotDotDotToken && ts.isIdentifier(el.name)) b.rest ??= el.name.text;
            else if (ts.isIdentifier(el.name)) b.props.set(el.name.text, el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text);
          }
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(fnNode.body, visit);
    }
    b.bound = new Set(b.props.values());
    bindingsCache.set(fnNode, b);
    return b;
  };
  for (const c of components.values()) c.bindings = bindingsFor(c.fn);

  const ownerOf = (node) => {
    for (let n = node; n; n = n.parent) if (owner.has(n)) return { node: n, ...owner.get(n) };
    return null;
  };
  /** What an expression at this node can refer to: the component or
   * function it sits in, its props, and the constants in scope. */
  const ctxFor = (node) => {
    const own = ownerOf(node);
    const consts = own ? constantsOf(own.node) : new Map();
    return {
      component: own?.component ?? null,
      helper: own?.helper ?? null,
      bindings: own?.component ? bindingsFor(own.node) : null,
      ownerNode: own?.node ?? null,
      constOf: (name) => (consts.has(name) ? consts.get(name) : moduleConsts.get(name)),
      helperNamed: (name) => {
        const f = consts.has(name) ? consts.get(name) : helpers.get(name);
        return !!f && !Array.isArray(f) && !!functionOf(f) && containsJsx(f);
      },
    };
  };

  /** The function that declares a name as a parameter, seen from a use of
   * the name, and the parameter's position (and key, when destructured). */
  const paramOf = (node, name) => {
    for (let n = node.parent; n; n = n.parent) {
      if (!ts.isFunctionLike(n) || !n.parameters) continue;
      for (const [index, p] of n.parameters.entries()) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return { fn: n, index, key: null };
        if (ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) {
            if (ts.isIdentifier(el.name) && el.name.text === name) return { fn: n, index, key: el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : name };
          }
        }
      }
    }
    return null;
  };
  /* ---- names, read where they are used ---- */

  /** The names one scope declares, each with how: a `const`, `let` or
   * `var` with its declaration and the keys a destructuring takes, a
   * parameter, a loop or catch variable, a function, a class, an import. */
  const scopeNames = new Map();
  const declaredIn = (scope) => {
    if (scopeNames.has(scope)) return scopeNames.get(scope);
    const names = new Map();
    const put = (decl, kind) => {
      for (const b of boundNames(decl.name, [], kind === "param" ? decl.initializer ?? null : null)) if (!names.has(b.name)) names.set(b.name, { ...b, kind, decl });
    };
    const list = (declarations, kind) => {
      const how = kind ?? (declarations.flags & ts.NodeFlags.Const ? "const" : declarations.flags & (ts.NodeFlags.Let | (ts.NodeFlags.Using ?? 0)) ? "let" : "var");
      for (const d of declarations.declarations) put(d, how);
    };
    const statements = (stmts) => {
      for (const st of stmts) {
        if (ts.isVariableStatement(st)) list(st.declarationList);
        else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name && !names.has(st.name.text)) names.set(st.name.text, { name: st.name.text, path: [], fallback: null, kind: "other", decl: st });
        else if (ts.isImportDeclaration(st) && st.importClause) {
          const clause = st.importClause;
          const add = (id) => names.set(id.text, { name: id.text, path: [], fallback: null, kind: "import", decl: st });
          if (clause.name) add(clause.name);
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) add(clause.namedBindings.name);
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) add(el.name);
        }
      }
    };
    if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) statements(scope.statements);
    else if (ts.isCaseBlock(scope)) for (const c of scope.clauses) statements(c.statements);
    else if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
      if (scope.initializer && ts.isVariableDeclarationList(scope.initializer)) list(scope.initializer, "loop");
    } else if (ts.isCatchClause(scope)) {
      if (scope.variableDeclaration) put(scope.variableDeclaration, "loop");
    } else if (ts.isFunctionLike(scope)) {
      for (const p of scope.parameters ?? []) put(p, "param");
      // A `var` anywhere in the body belongs to the function.
      const hoist = (n) => {
        if (n !== scope.body && ts.isFunctionLike(n)) return;
        if (ts.isVariableDeclarationList(n) && !(n.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) list(n, "var");
        ts.forEachChild(n, hoist);
      };
      if (scope.body) hoist(scope.body);
    }
    scopeNames.set(scope, names);
    return names;
  };
  const isScope = (n) => ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseBlock(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isCatchClause(n) || ts.isFunctionLike(n);
  /** What a name is where it is read: the nearest declaration of it in the
   * scopes around the place, or null for a name this file never declares. */
  const bindingOf = (name, at) => {
    for (let n = at; n; n = n.parent) {
      if (!isScope(n)) continue;
      const found = declaredIn(n).get(name);
      if (found) return found;
    }
    return null;
  };

  /** Every write in the file, by the name it writes to: a new value for a
   * variable, a value for one of its members, an object assigned into it,
   * an array method that changes it in place. */
  let writeIndex = null;
  const writesOf = (name) => {
    if (!writeIndex) {
      writeIndex = new Map();
      const note = (id, w) => {
        if (!writeIndex.has(id)) writeIndex.set(id, []);
        writeIndex.get(id).push(w);
      };
      const base = (e) => {
        const keys = [];
        let n = unwrap(e);
        while (n && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) {
          const arg = ts.isElementAccessExpression(n) ? unwrap(n.argumentExpression) : null;
          keys.unshift(ts.isPropertyAccessExpression(n) ? n.name.text : arg && (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg)) ? arg.text : "*");
          n = unwrap(n.expression);
        }
        return n && ts.isIdentifier(n) ? { id: n, keys } : null;
      };
      const ASSIGN = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]);
      const visit = (n) => {
        if (ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind)) {
          const left = unwrap(n.left);
          if (left && ts.isIdentifier(left)) note(left.text, { kind: "assign", node: left, value: n.right });
          else {
            const b = base(left);
            if (b) note(b.id.text, { kind: "member", node: b.id, keys: b.keys, value: n.right });
          }
        }
        if (ts.isDeleteExpression(n)) {
          const b = base(n.expression);
          if (b) note(b.id.text, { kind: "member", node: b.id, keys: b.keys, value: null });
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const callee = n.expression;
          if (ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && callee.name.text === "assign" && n.arguments.length > 1) {
            const target = unwrap(n.arguments[0]);
            if (target && ts.isIdentifier(target)) note(target.text, { kind: "merge", node: target, args: n.arguments.slice(1) });
          }
          const target = unwrap(callee.expression);
          if (target && ts.isIdentifier(target) && /^(pop|shift|splice|push|unshift|fill|copyWithin)$/.test(callee.name.text)) {
            note(target.text, { kind: "mutate", node: target, method: callee.name.text, args: [...n.arguments] });
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(source);
    }
    return writeIndex.get(name) ?? [];
  };
  /** What a name holds where it is read: the expressions it can be (its
   * value, through the keys a destructuring takes, its default, and for a
   * `let` every value assigned to it later), the objects assigned into it,
   * its member writes and in-place changes. `param` marks a parameter,
   * `other` a function, class or import, and null a name the file never
   * declares. */
  const heldBy = (name, at) => {
    const b = bindingOf(name, at);
    if (!b) return null;
    const writes = writesOf(name).filter((w) => bindingOf(name, w.node) === b);
    const exprs = [];
    if (b.kind === "const" || b.kind === "let" || b.kind === "var") {
      if (b.decl.initializer) exprs.push({ expr: b.decl.initializer, keys: b.path });
      else exprs.push({ expr: null, keys: [] });
    }
    if (b.fallback) exprs.push({ expr: b.fallback, keys: [] });
    if (b.kind === "let" || b.kind === "var") for (const w of writes) if (w.kind === "assign") exprs.push({ expr: w.value, keys: [] });
    return {
      binding: b,
      exprs,
      merges: writes.filter((w) => w.kind === "merge"),
      members: writes.filter((w) => w.kind === "member"),
      mutates: writes.filter((w) => w.kind === "mutate"),
      param: b.kind === "param" || b.kind === "loop",
      other: b.kind === "other" || b.kind === "import",
    };
  };
  /** Whether a parameter is one of the component's own props. */
  const isProp = (held, ctx) => held.binding.kind === "param" && !!ctx.component && held.binding.decl.parent === ctx.ownerNode;

  /** What a name in a value set in code is, seen from where it is used: a
   * constant of the scope it sits in or around it, read through the keys
   * a destructuring takes, or a constant another file exports. A
   * parameter, a prop, a loop variable or a `let` is none of these. */
  const valueScope = {
    lookup: (name, at) => {
      const b = bindingOf(name, at);
      if (!b) return null;
      if (b.kind === "import") {
        const imported = imports.get(name);
        return imported && !imported.file.startsWith("external:") && env.exported ? env.exported(imported.file, imported.name) : null;
      }
      if (b.kind !== "const" || !b.decl.initializer) return null;
      const found = [{ init: b.decl.initializer, scope: valueScope, keys: b.path }];
      if (b.fallback) found.push({ init: b.fallback, scope: valueScope, keys: [] });
      return found;
    },
  };

  /** The name a function is called by in this file, if it has one. */
  const nameOfFunction = (fn) => {
    if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
    return null;
  };
  /** Every call of a same-file function by name. */
  let allCalls = null;
  const callsNamed = (name) => {
    if (!allCalls) {
      allCalls = new Map();
      const visit = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          if (!allCalls.has(n.expression.text)) allCalls.set(n.expression.text, []);
          allCalls.get(n.expression.text).push(n);
        }
        ts.forEachChild(n, visit);
      };
      visit(source);
    }
    return allCalls.get(name) ?? [];
  };
  /** The array a callback walks over, when it is a constant table:
   * `TABLE.map((row) => ...)`. */
  const tableOf = (fn, ctx) => {
    const call = fn.parent;
    if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
    if (!/^(map|flatMap|forEach|filter)$/.test(call.expression.name.text)) return null;
    let target = call.expression.expression;
    while (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && /^(filter|slice)$/.test(target.expression.name.text)) target = target.expression.expression;
    if (!ts.isIdentifier(target)) return null;
    const init = ctx.constOf(target.text);
    const arr = init && !Array.isArray(init) ? (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init) ? init.expression : init) : null;
    return arr && ts.isArrayLiteralExpression(arr) ? arr.elements : null;
  };
  /** The class sets a parameter of a function can hold: what the function's
   * callers in this file hand it, or the rows of the table it walks. */
  const paramMemo = new Map();
  const paramAlts = (param, prop, ctx, seen) => {
    const key = param.fn.pos + ":" + param.index + ":" + (param.key ?? "") + ":" + (prop ?? "");
    if (paramMemo.has(key)) return paramMemo.get(key);
    paramMemo.set(key, null);
    let out = null;
    const field = prop ?? param.key;
    const pick = (obj, c) => {
      if (field === null) return alts(obj, c, seen);
      if (!ts.isObjectLiteralExpression(obj)) return null;
      const p = obj.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText(source).replace(/^["']|["']$/g, "") === field);
      return p ? alts(p.initializer, c, seen) : EMPTY;
    };
    const rows = tableOf(param.fn, ctx);
    if (rows && param.index === 0) {
      const found = rows.map((r) => pick(r, ctx));
      if (found.every(Boolean)) out = union(...found);
    } else if (!owner.get(param.fn)?.component) {
      const name = nameOfFunction(param.fn);
      const calls = name ? callsNamed(name) : [];
      if (calls.length) {
        const found = calls.map((call) => {
          const arg = call.arguments[param.index];
          return arg ? pick(arg, { ...ctxFor(call), globals: ctx.globals, miss: ctx.miss }) : EMPTY;
        });
        if (found.every(Boolean)) out = union(...found);
      }
    }
    paramMemo.set(key, out);
    return out;
  };

  /** The one expression a function returns, when it has one. */
  const returnedOf = (fn) => {
    if (!fn.body) return null;
    if (!ts.isBlock(fn.body)) return fn.body;
    const returns = fn.body.statements.filter(ts.isReturnStatement);
    return returns.length === 1 && fn.body.statements.length <= 3 ? returns[0].expression ?? null : null;
  };
  /** Whether a name is a parameter of a function nested in the component
   * (which then shadows the component's prop of the same name). */
  const paramOfInner = (node, name, ctx) => {
    const p = paramOf(node, name);
    return !!p && p.fn !== ctx.ownerNode;
  };

  /** The class sets an expression can produce, with the parts it could not
   * read recorded. Tokens: m<TAB>sheet<TAB>class for a module class,
   * g<TAB>class for a global class, p<TAB>prop for a class handed in,
   * i<TAB>file<TAB>name for a constant imported from another file (read
   * once every file is). */
  const alts = (node, ctx, seen = new Set()) => {
    if (!node) return EMPTY;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression?.(node)) {
      return alts(node.expression, ctx, seen);
    }
    if (ts.isJsxExpression(node)) return alts(node.expression, ctx, seen);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return ctx.globals ? [node.text.split(/\s+/).filter(Boolean).map((c) => "g\t" + c)] : EMPTY;
    }
    if (ts.isTemplateExpression(node)) {
      const lits = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
      const own = ctx.globals ? lits.split(/\s+/).filter(Boolean).map((c) => "g\t" + c) : [];
      return productKeep([[own], ...node.templateSpans.map((span) => alts(span.expression, ctx, seen))]);
    }
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.TrueKeyword) return EMPTY;
    if (ts.isIdentifier(node) && node.text === "undefined") return EMPTY;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) return productKeep([alts(node.left, ctx, seen), alts(node.right, ctx, seen)]);
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return union(EMPTY, alts(node.right, ctx, seen));
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return union(alts(node.left, ctx, seen), alts(node.right, ctx, seen));
      return EMPTY;
    }
    if (ts.isConditionalExpression(node)) return union(alts(node.whenTrue, ctx, seen), alts(node.whenFalse, ctx, seen));
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const owner = node.expression.text;
      if (sheets.has(owner)) return [["m\t" + sheets.get(owner) + "\t" + node.name.text]];
      if (ctx.bindings && (owner === ctx.bindings.whole || owner === ctx.bindings.rest)) return [["p\t" + node.name.text]];
      const map = ctx.constOf(owner);
      if (map && !Array.isArray(map) && ts.isObjectLiteralExpression(map)) {
        const prop = map.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source).replace(/^["']|["']$/g, "") === node.name.text);
        if (prop) return alts(prop.initializer, ctx, seen);
      }
      const param = map === undefined ? paramOf(node, owner) : null;
      if (param && !seen.has("param:" + owner)) {
        const found = paramAlts(param, node.name.text, ctx, new Set([...seen, "param:" + owner]));
        if (found) return found;
      }
      ctx.miss(node);
      return EMPTY;
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const owner = node.expression.text;
      const arg = node.argumentExpression;
      if (sheets.has(owner)) {
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return [["m\t" + sheets.get(owner) + "\t" + arg.text]];
        ctx.miss(node);
        return EMPTY;
      }
      // A lookup table of classes: the entries its key can name, and none
      // where the key can name an entry the table lacks.
      const map = ctx.constOf(owner);
      if (map && !Array.isArray(map) && ts.isObjectLiteralExpression(map)) {
        const entries = map.properties.filter(ts.isPropertyAssignment);
        const a = unwrap(arg);
        const read = a && (ts.isStringLiteral(a) || ts.isNumericLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? { values: [a.text], open: [], none: false } : valuesOf(a, valueScope);
        if (read.open.length || !read.values.length) return union(EMPTY, ...entries.map((p) => alts(p.initializer, ctx, seen)));
        const keys = new Set(read.values.map(unquoted));
        const hits = entries.filter((p) => keys.has(memberKey(p.name)));
        const missed = [...keys].some((k) => !entries.some((p) => memberKey(p.name) === k));
        return union(...(missed || read.none ? [EMPTY] : []), ...hits.map((p) => alts(p.initializer, ctx, seen)));
      }
      ctx.miss(node);
      return EMPTY;
    }
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (ctx.params?.has(name)) return ctx.params.get(name);
      if (ctx.bindings?.props.has(name) && !paramOfInner(node, name, ctx)) return [["p\t" + ctx.bindings.props.get(name)]];
      const init = ctx.constOf(name);
      if (init !== undefined && !seen.has(name)) {
        const next = new Set([...seen, name]);
        let found = union(...[init].flat().map((i) => (functionOf(i) ? EMPTY : alts(i, ctx, next))));
        // A `let` can hold every value assigned to it later; an array of
        // classes changed in place can lose its classes or gain more.
        const held = heldBy(name, node);
        if (held && (held.binding.kind === "let" || held.binding.kind === "var")) {
          found = union(found, ...held.exprs.map((e) => (e.expr === null ? EMPTY : alts(e.expr, ctx, next))));
        }
        for (const m of held?.mutates ?? []) {
          found = /^(push|unshift)$/.test(m.method) ? productKeep([found, union(EMPTY, ...m.args.map((a) => alts(a, ctx, next)))]) : union(found, EMPTY);
        }
        return found;
      }
      const param = paramOf(node, name);
      if (param && !owner.get(param.fn)?.component && !seen.has("param:" + name)) {
        const found = paramAlts(param, null, ctx, new Set([...seen, "param:" + name]));
        if (found) return found;
      }
      const imported = imports.get(name);
      if (ctx.globals && imported && !imported.file.startsWith("external:") && !isComponentName(name)) return [["i\t" + imported.file + "\t" + imported.name]];
      ctx.miss(node);
      return EMPTY;
    }
    if (ts.isArrayLiteralExpression(node)) {
      return productKeep(node.elements.map((el) => (ts.isSpreadElement(el) ? alts(el.expression, ctx, seen) : alts(el, ctx, seen))));
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "join") {
        let target = callee.expression;
        while (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === "filter") {
          target = target.expression.expression;
        }
        return alts(target, ctx, seen);
      }
      if (ts.isIdentifier(callee) && /^(clsx|classNames|cx|cn)$/.test(callee.text)) {
        return productKeep(node.arguments.map((arg) => {
          if (!ts.isObjectLiteralExpression(arg)) return alts(arg, ctx, seen);
          return productKeep(arg.properties.map((p) => (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name) ? union(EMPTY, alts(p.name.expression, ctx, seen)) : EMPTY)));
        }));
      }
      // A function of this file that builds a class from its arguments.
      if (ts.isIdentifier(callee) && !seen.has("call:" + callee.text)) {
        const f = ctx.constOf(callee.text) ?? helpers.get(callee.text);
        const fn = f && !Array.isArray(f) ? functionOf(f) : null;
        const ret = fn ? returnedOf(fn) : null;
        if (ret) {
          const params = new Map();
          fn.parameters.forEach((p, i) => {
            if (ts.isIdentifier(p.name)) params.set(p.name.text, node.arguments[i] ? alts(node.arguments[i], ctx, seen) : EMPTY);
          });
          return alts(ret, { ...ctxFor(ret), globals: ctx.globals, miss: ctx.miss, params }, new Set([...seen, "call:" + callee.text]));
        }
      }
      ctx.miss(node);
      return EMPTY;
    }
    ctx.miss(node);
    return EMPTY;
  };

  /**
   * The object literals a style expression can be: through conditions and
   * fallbacks, the constants and variables it names (a `let` with every
   * value assigned to it, an object assigned into with `Object.assign`),
   * the members of constant objects, a default a prop falls back to, and
   * `useMemo`. `none` marks a branch that gives no object; `opaque` one it
   * cannot read. A style a component is handed as a prop is read where the
   * callers write it, so it is neither; `prop` marks a branch that is one.
   */
  const objectsOf = (raw, ctx, keys = [], depth = 0, out = { objects: [], none: false, opaque: false, prop: false }) => {
    const n = unwrap(raw);
    if (!n) {
      out.none = true;
      return out;
    }
    if (depth > VALUE_DEPTH) {
      out.opaque = true;
      return out;
    }
    if (ts.isConditionalExpression(n)) {
      objectsOf(n.whenTrue, ctx, keys, depth + 1, out);
      return objectsOf(n.whenFalse, ctx, keys, depth + 1, out);
    }
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        out.none = true;
        return objectsOf(n.right, ctx, keys, depth + 1, out);
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        objectsOf(n.left, ctx, keys, depth + 1, out);
        return objectsOf(n.right, ctx, keys, depth + 1, out);
      }
    }
    if (n.kind === ts.SyntaxKind.NullKeyword || n.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(n) && n.text === "undefined")) {
      out.none = true;
      return out;
    }
    if (ts.isObjectLiteralExpression(n)) {
      if (!keys.length) {
        out.objects.push(n);
        return out;
      }
      const [key, ...rest] = keys;
      let hit = false;
      for (const p of n.properties) {
        if (ts.isSpreadAssignment(p)) {
          objectsOf(p.expression, ctx, keys, depth + 1, out);
          continue;
        }
        const name = memberKey(p.name);
        if (name !== null && key !== "*" && name !== key) continue;
        const value = memberValue(p);
        if (!value) continue;
        hit ||= name !== null;
        objectsOf(value, ctx, rest, depth + 1, out);
      }
      if (!hit) out.none = true;
      return out;
    }
    if (ts.isArrayLiteralExpression(n) && keys.length) {
      const [key, ...rest] = keys;
      const items = key === "*" || n.elements.some(ts.isSpreadElement) ? [...n.elements] : [n.elements[Number(key)]].filter(Boolean);
      if (!items.length) out.none = true;
      for (const item of items) objectsOf(ts.isSpreadElement(item) ? item.expression : item, ctx, ts.isSpreadElement(item) ? ["*", ...rest] : rest, depth + 1, out);
      return out;
    }
    if (ts.isIdentifier(n)) {
      const held = heldBy(n.text, n);
      if (!held || held.other) {
        out.opaque = true;
        return out;
      }
      if (held.param) {
        if (held.binding.fallback) objectsOf(held.binding.fallback, ctx, keys, depth + 1, out);
        if (!isProp(held, ctx)) out.opaque = true;
        else out.prop = true;
        return out;
      }
      for (const e of held.exprs) {
        if (e.expr === null) out.none = true;
        else objectsOf(e.expr, ctx, [...e.keys, ...keys], depth + 1, out);
      }
      if (!keys.length) for (const m of held.merges) for (const a of m.args) objectsOf(a, ctx, [], depth + 1, out);
      return out;
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const arg = ts.isElementAccessExpression(n) ? unwrap(n.argumentExpression) : null;
      const key = ts.isPropertyAccessExpression(n) ? n.name.text : arg && (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg)) ? arg.text : "*";
      return objectsOf(n.expression, ctx, [key, ...keys], depth + 1, out);
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "useMemo") {
      const fn = functionOf(n.arguments[0]);
      const ret = fn ? returnedOf(fn) : null;
      if (ret) return objectsOf(ret, ctx, keys, depth + 1, out);
    }
    out.opaque = true;
    return out;
  };

  /** A colour as an inline style sets it: the value, or null where the
   * browser drops it (empty, or no colour at all), so the element's rules
   * decide as if it set none. */
  const inkOf = (literal) => {
    const v = unquoted(literal);
    return isColourValue(v) ? literal : null;
  };
  /** Distinct branches, past the cap keeping first those that set no
   * colour of their own, so the cap never hides a branch that inherits. */
  const distinct = (list) => {
    const seen = new Map();
    for (const x of list) seen.set(x === ABSENT ? "\0absent" : JSON.stringify(x), x);
    const all = [...seen.values()];
    if (all.length <= VALUE_CAP) return all;
    const bare = (x) => x === ABSENT || x === null || (typeof x === "string" && /^(inherit|currentcolor|unset|initial|revert|revert-layer)$/i.test(unquoted(x)));
    return [...all.filter(bare), ...all.filter((x) => !bare(x))].slice(0, VALUE_CAP);
  };
  /** The colours one member of a style object can set. */
  const memberInks = (p) => {
    const value = memberValue(p);
    if (!value) return [{ open: p.getText(source).slice(0, 60) }];
    const v = valuesOf(value, valueScope);
    return [...v.values.map(inkOf), ...(v.none ? [null] : []), ...v.open.map((t) => ({ open: t }))];
  };
  /** The possible names of a member of a style object; null when it is
   * computed from something that cannot be read. */
  const memberNames = (p) => {
    if (!p.name) return null;
    const name = memberKey(p.name);
    if (name !== null) return [name];
    if (!ts.isComputedPropertyName(p.name)) return null;
    const read = valuesOf(p.name.expression, valueScope);
    return read.open.length || !read.values.length ? null : [...new Set(read.values.map(unquoted))];
  };

  /**
   * The text colour each branch of an inline style leaves an element with:
   * null where the branch sets none (the element's rules decide), else the
   * colour as written, or { open } where the value cannot be read. A later
   * key or spread that sets a colour replaces an earlier one, and one that
   * sets it to nothing clears it. A style it cannot read, or one handed in
   * as a prop, may set anything, and reads as none here: the rules decide.
   */
  const inksOf = (raw, ctx) => inkBranches(raw, ctx, [], 0).map((b) => (b === ABSENT ? null : b));
  const inkBranches = (raw, ctx, keys, depth) => {
    const n = unwrap(raw);
    if (!n || depth > VALUE_DEPTH) return [null];
    if (ts.isConditionalExpression(n)) return distinct([...inkBranches(n.whenTrue, ctx, keys, depth + 1), ...inkBranches(n.whenFalse, ctx, keys, depth + 1)]);
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return distinct([ABSENT, ...inkBranches(n.right, ctx, keys, depth + 1)]);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return distinct([...inkBranches(n.left, ctx, keys, depth + 1), ...inkBranches(n.right, ctx, keys, depth + 1)]);
    }
    if (n.kind === ts.SyntaxKind.NullKeyword || n.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(n) && n.text === "undefined")) return [ABSENT];
    if (ts.isObjectLiteralExpression(n) && keys.length) {
      const [key, ...rest] = keys;
      const found = [];
      let hit = false;
      for (const p of n.properties) {
        if (ts.isSpreadAssignment(p)) {
          found.push(...inkBranches(p.expression, ctx, keys, depth + 1));
          continue;
        }
        const name = memberKey(p.name);
        if (name !== null && key !== "*" && name !== key) continue;
        const value = memberValue(p);
        if (!value) continue;
        hit ||= name !== null;
        found.push(...inkBranches(value, ctx, rest, depth + 1));
      }
      return distinct(hit ? found : [...found, ABSENT]);
    }
    if (ts.isObjectLiteralExpression(n)) {
      let branches = [ABSENT];
      for (const p of n.properties) {
        if (ts.isSpreadAssignment(p)) {
          const spread = inkBranches(p.expression, ctx, [], depth + 1);
          branches = distinct(branches.flatMap((b) => spread.map((s) => (s === ABSENT ? b : s))));
          continue;
        }
        const names = memberNames(p);
        if (names !== null && !names.some((x) => x === "color" || x === "WebkitTextFillColor")) continue;
        const set = memberInks(p);
        // A name it cannot read may or may not be the colour.
        branches = distinct(names === null || names.length > 1 ? [...branches, ...set] : set.length ? set : [null]);
      }
      return branches;
    }
    if (ts.isIdentifier(n)) {
      const held = heldBy(n.text, n);
      if (!held || held.other) return [null];
      if (held.param) return distinct([null, ...(held.binding.fallback ? inkBranches(held.binding.fallback, ctx, keys, depth + 1) : [])]);
      let branches = distinct(held.exprs.flatMap((e) => (e.expr === null ? [ABSENT] : inkBranches(e.expr, ctx, [...e.keys, ...keys], depth + 1))));
      if (!keys.length) {
        // Objects assigned into it, and colours written into it, in some branch.
        for (const m of held.merges) {
          let merged = branches;
          for (const a of m.args) {
            const over = inkBranches(a, ctx, [], depth + 1);
            merged = distinct(merged.flatMap((b) => over.map((s) => (s === ABSENT ? b : s))));
          }
          branches = distinct([...branches, ...merged]);
        }
        for (const w of held.members) {
          if (w.keys.length !== 1 || !(w.keys[0] === "color" || w.keys[0] === "WebkitTextFillColor" || w.keys[0] === "*")) continue;
          const v = w.value ? valuesOf(w.value, valueScope) : { values: [], none: true, open: [] };
          branches = distinct([...branches, ...v.values.map(inkOf), ...(v.none ? [null] : []), ...v.open.map((t) => ({ open: t }))]);
        }
      }
      return branches;
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const arg = ts.isElementAccessExpression(n) ? unwrap(n.argumentExpression) : null;
      const key = ts.isPropertyAccessExpression(n) ? n.name.text : arg && (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg)) ? arg.text : "*";
      return inkBranches(n.expression, ctx, [key, ...keys], depth + 1);
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "useMemo") {
      const fn = functionOf(n.arguments[0]);
      const ret = fn ? returnedOf(fn) : null;
      if (ret) return inkBranches(ret, ctx, keys, depth + 1);
    }
    return [null];
  };

  /** An inline style: the object literals it can be are tied to the
   * element (with those its spreads bring in), `inks` holds the colour
   * each branch leaves the element with, and a style it cannot read is
   * recorded. */
  const readStyle = (node, ctx, element, { quiet = false } = {}) => {
    const found = objectsOf(node, ctx);
    let opaque = found.opaque;
    const all = new Set();
    const walkObj = (o) => {
      if (all.has(o)) return;
      all.add(o);
      for (const p of o.properties) {
        if (!ts.isSpreadAssignment(p)) continue;
        const inner = objectsOf(p.expression, ctx);
        opaque ||= inner.opaque;
        inner.objects.forEach(walkObj);
      }
    };
    found.objects.forEach(walkObj);
    for (const o of all) {
      if (!styleOwners.has(o)) styleOwners.set(o, []);
      if (!styleOwners.get(o).includes(element)) styleOwners.get(o).push(element);
    }
    if (opaque && !quiet) {
      unresolved.push({ file, line: lineOf(node), kind: "style", component: ctx.component, text: node.getText(source).replace(/\s+/g, " ").slice(0, 100), element });
    }
    return { inks: inksOf(node, ctx), opaque };
  };

  /** The objects a JSX spread can be: through what objectsOf reads, and
   * what a function of this file returns when the spread calls one. */
  const spreadObjects = (expr, ctx) => {
    const n = unwrap(expr);
    if (n && ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      const f = ctx.constOf(name) ?? helpers.get(name);
      const fn = f && !Array.isArray(f) ? functionOf(f) : null;
      if (fn) {
        const out = { objects: [], none: false, opaque: false, prop: false };
        for (const r of returnsOf(fn)) objectsOf(r, r ? ctxFor(r) : ctx, [], 0, out);
        return out;
      }
      // A function another file exports: what it returns is read for its
      // member names, and gives nothing here when it holds no class or style.
      const local = bindingOf(name, n);
      const imported = !local || local.kind === "import" ? imports.get(name) : null;
      const keys = imported && !imported.file.startsWith("external:") ? env.returnedKeys?.(imported.file, imported.name) : null;
      if (keys && ![...keys].some((k) => k === "style" || CLASS_PROP.test(k))) return { objects: [], none: true, opaque: false, prop: false };
    }
    return objectsOf(expr, ctx);
  };

  /** Whether a JSX spread hands on the props the component is given: all
   * of them, or the rest of them. */
  const forwardedProps = (expr, ctx) => {
    const n = unwrap(expr);
    if (!n || !ts.isIdentifier(n) || !ctx.bindings || paramOfInner(n, n.text, ctx)) return null;
    if (n.text === ctx.bindings.whole) return "whole";
    if (n.text === ctx.bindings.rest) return "rest";
    return null;
  };

  /** Whether an expression reads the style the component is handed: the
   * `style` prop by the name it is bound to, or as a member of its props. */
  const readsStyleProp = (node, ctx) => {
    const b = ctx.bindings;
    if (!b) return false;
    let found = false;
    const visit = (n) => {
      if (found) return;
      if (ts.isIdentifier(n) && b.props.get(n.text) === "style" && !paramOfInner(n, n.text, ctx)) {
        const up = n.parent;
        const named = up && ((ts.isPropertyAccessExpression(up) && up.name === n) || (ts.isPropertyAssignment(up) && up.name === n));
        if (!named) found = true;
      } else if (ts.isPropertyAccessExpression(n) && n.name.text === "style" && ts.isIdentifier(n.expression) && (n.expression.text === b.whole || n.expression.text === b.rest) && !paramOfInner(n.expression, n.expression.text, ctx)) {
        found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  /** Whether a computed member name that cannot be read can still name a
   * class. On an element only `className` does, so a template whose fixed
   * start does not begin it cannot; a component's class props end in any
   * name. */
  const mayBeClassKey = (name, onElement) => {
    const e = name && ts.isComputedPropertyName(name) ? unwrap(name.expression) : null;
    if (!onElement || !e || !ts.isTemplateExpression(e) || !e.head.text) return true;
    return "className".startsWith(e.head.text);
  };

  /** The class sets the class members hold once a spread's objects are
   * written over `before` (a map of member to class sets), branch by
   * branch: a branch that gives no object or leaves a member out keeps
   * what it held. On an element the member is `className`; on a component
   * call, every class prop. A member, a name or a nested spread it cannot
   * read is handed to `miss`. */
  const spreadClassMembers = (found, onElement, before, miss, depth = 0) => {
    const isClass = onElement ? (n) => n === "className" : (n) => CLASS_PROP.test(n);
    const branches = found.none ? [new Map(before)] : [];
    for (const o of found.objects) {
      let cur = new Map(before);
      for (const p of o.properties) {
        if (ts.isSpreadAssignment(p)) {
          const inner = objectsOf(p.expression, ctxFor(p));
          if (inner.opaque || inner.prop || depth > 4) miss(p.expression);
          else cur = spreadClassMembers(inner, onElement, cur, miss, depth + 1);
          continue;
        }
        const names = memberNames(p);
        if (names === null) {
          if (mayBeClassKey(p.name, onElement)) miss(p);
          continue;
        }
        for (const name of names.filter(isClass)) {
          const v = memberValue(p);
          if (!v) miss(p);
          cur.set(name, v ? alts(v, { ...ctxFor(v), globals: true, miss }) : EMPTY);
        }
      }
      branches.push(cur);
    }
    const out = new Map();
    for (const name of new Set(branches.flatMap((b) => [...b.keys()]))) out.set(name, union(...branches.map((b) => b.get(name) ?? EMPTY)));
    return out;
  };

  /** The style a JSX spread puts on an element, branch by branch: the
   * style member of each object it can be, or null where a branch has
   * none. Props the component is handed may bring a style or none, so a
   * spread of them gives both. Null when the spread cannot be read. */
  const spreadStyles = (found) => {
    if (found.opaque) return null;
    const out = found.none || found.prop || !found.objects.length ? [null] : [];
    for (const o of found.objects) {
      let style = null;
      for (const p of o.properties) {
        if (ts.isSpreadAssignment(p)) continue;
        if (memberKey(p.name) === "style") style = memberValue(p);
      }
      out.push(style);
    }
    return out;
  };

  /**
   * Stylesheet text written in markup: a <style> element's text, read
   * through the constants it names, or the markup it is handed, kept as
   * rules of this file for the classes the page puts on elements. Markup
   * any other element is handed (a script's aside) may carry inline styles
   * or a stylesheet of its own; it is not parsed, so where it does, or
   * where it cannot be read, it is named as unread. So is stylesheet text
   * that cannot be read.
   */
  const sheetTexts = [];
  const readMarkup = (node, opening, element, ctx) => {
    const tag = element.tag.toLowerCase();
    if (tag === "script") return;
    const parts = [];
    for (const a of opening.attributes.properties) {
      if (!ts.isJsxAttribute(a) || a.name.getText(source) !== "dangerouslySetInnerHTML" || !a.initializer) continue;
      const found = objectsOf(a.initializer, ctx);
      const members = found.objects.map((o) => o.properties.find((p) => !ts.isSpreadAssignment(p) && memberKey(p.name) === "__html")).map((p) => (p ? memberValue(p) : null));
      if (found.opaque || !members.length || members.some((m) => !m)) {
        parts.push({ node: a.initializer, read: { values: [], open: [a.initializer.getText(source)], none: false } });
        continue;
      }
      for (const m of members) parts.push({ node: m, read: valuesOf(m, valueScope) });
    }
    if (tag === "style" && ts.isJsxElement(node)) {
      for (const child of node.children) {
        if (ts.isJsxText(child) && child.text.trim()) parts.push({ node: child, read: { values: ['"' + child.text + '"'], open: [], none: false } });
        else if (ts.isJsxExpression(child) && child.expression) parts.push({ node: child.expression, read: valuesOf(child.expression, valueScope) });
      }
    }
    const unread = (n, kind) => unresolved.push({ file, line: lineOf(n), kind, component: ctx.component, text: n.getText(source).replace(/\s+/g, " ").slice(0, 100), element });
    for (const { node: n, read } of parts) {
      if (tag !== "style") {
        if (read.open.length || read.values.some((v) => /<style\b|\sstyle\s*=/i.test(v))) unread(n, "markup");
        continue;
      }
      if (read.open.length) {
        unread(n, "stylesheet");
        continue;
      }
      for (const css of new Set(read.values.map(unquoted))) sheetTexts.push({ file, line: lineOf(n), css });
    }
  };

  /** Walk one top-level statement for elements, carrying the element they
   * sit in. */
  const scan = (statement) => {
    const add = (node, opening, parent) => {
      const ctx = ctxFor(opening);
      const tag = opening.tagName.getText(source);
      const dom = /^[a-z]/.test(tag) && !tag.includes(".");
      const element = {
        file, line: lineOf(opening), component: ctx.component, helper: ctx.helper, tag, dom,
        alts: null, attrs: new Map(), spread: false, style: null, props: new Map(), parents: parent === null ? [] : [parent],
        children: [], texts: [], exprs: [], slot: false, slotProps: [], propJsx: new Map(), propHelpers: new Map(), propForward: new Map(),
        helperCalls: [], refs: [], constName: null, fnName: null, html: false, unreadSpreads: [], forwardsStyle: false,
        index: base + elements.length,
      };
      const missed = [];
      // The colour each branch of the element's style leaves it with, in
      // the order its attributes write it: a spread that brings a style
      // replaces the one before it.
      let inks = null;
      for (const [at, a] of opening.attributes.properties.entries()) {
        if (ts.isJsxSpreadAttribute(a)) {
          element.spread = true;
          const found = spreadObjects(a.expression, ctx);
          const forwards = forwardedProps(a.expression, ctx);
          if (forwards === "whole" || (forwards === "rest" && !ctx.bindings.bound.has("style"))) element.forwardsStyle = true;
          if (forwards) {
            // The class a caller hands in: worn here, or handed on.
            if (!dom) element.forwardsRest = true;
            else if (forwards === "whole" || !ctx.bindings.bound.has("className")) element.alts = union(element.alts ?? EMPTY, [["p\tclassName"]]);
          } else if (found.opaque || found.prop) {
            // It may carry a class or a style: named as unread, unless the
            // attributes after it set both again; on a call, once its
            // component is known to put a class it is handed on an element.
            const later = new Set(opening.attributes.properties.slice(at + 1).filter(ts.isJsxAttribute).map((x) => x.name.getText(source)));
            const site = { line: lineOf(a), text: a.expression.getText(source).replace(/\s+/g, " ").slice(0, 100), later };
            if (dom && !(later.has("className") && later.has("style"))) unresolved.push({ file, line: site.line, text: site.text, kind: "spread", component: ctx.component, element });
            else if (!dom) element.unreadSpreads.push(site);
          } else if (dom) {
            const after = spreadClassMembers(found, true, new Map(element.alts ? [["className", element.alts]] : []), (n) => missed.push(n));
            if (after.has("className")) element.alts = after.get("className");
          } else {
            const before = new Map([...element.props].filter(([n]) => CLASS_PROP.test(n)));
            for (const [name, list] of spreadClassMembers(found, false, before, (n) => missed.push(n))) {
              if (list.some((alt) => alt.length)) element.props.set(name, list);
            }
            // A style handed to a component: its objects are tied to the call.
            for (const o of found.objects) {
              for (const p of o.properties) if (!ts.isSpreadAssignment(p) && memberKey(p.name) === "style" && memberValue(p)) readStyle(memberValue(p), ctx, element, { quiet: true });
            }
          }
          const branches = dom ? spreadStyles(found) : null;
          if (branches) {
            const before = inks ?? [null];
            const next = branches.flatMap((style) => (style === null ? before : readStyle(style, ctx, element).inks));
            // Props the component is handed may bring a style without a colour.
            if (found.prop) next.push(null);
            inks = [...new Map(next.map((x) => [JSON.stringify(x), x])).values()];
          }
          continue;
        }
        const name = a.name.getText(source);
        if (name === "style" && a.initializer && readsStyleProp(a.initializer, ctx)) element.forwardsStyle = true;
        if (dom && name === "style" && a.initializer) {
          element.style = readStyle(a.initializer, ctx, element);
          inks = element.style.inks;
          continue;
        }
        // A style handed to a component: its objects are tied to the call.
        // A component's `style` prop need not be a style, so what cannot be
        // read there is left to the component that puts it on an element.
        if (!dom && name === "style" && a.initializer) readStyle(a.initializer, ctx, element, { quiet: true });
        if (name === "dangerouslySetInnerHTML") element.html = true;
        const classy = CLASS_PROP.test(name);
        if (dom && name === "className") {
          element.alts = a.initializer ? alts(a.initializer, { ...ctx, globals: true, miss: (n) => missed.push(n) }) : EMPTY;
          continue;
        }
        if (!dom && a.initializer) {
          const found = alts(a.initializer, { ...ctx, globals: classy, miss: (n) => (classy ? missed.push(n) : null) });
          if (found.some((alt) => alt.length)) element.props.set(name, found);
          if (classy) continue;
        }
        if (/^(key|ref|children)$/.test(name) || /^on[A-Z]/.test(name)) continue;
        element.attrs.set(name, attributeValue(a));
      }
      if (inks) element.style = { ...(element.style ?? { opaque: false }), inks };
      if (dom && (tag.toLowerCase() === "style" || element.html)) readMarkup(node, opening, element, ctx);
      for (const n of missed) {
        unresolved.push({ file, line: lineOf(n), kind: "class", component: ctx.component, text: n.getText(source).replace(/\s+/g, " ").slice(0, 100), element });
      }
      elements.push(element);
      if (parent !== null) local(parent).children.push(element.index);
      // The function that draws it, and for outermost markup held in a
      // const, the const's name: the element is drawn where those are used.
      for (let n = node.parent; n; n = n.parent) {
        if (ts.isFunctionDeclaration(n) && n.name) {
          element.fnName = n.name.text;
          break;
        }
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
          // `const draw = () => ...`, or wrapped: `const draw = useCallback(() => ...)`.
          const holder = ts.isCallExpression(n.parent) ? n.parent.parent : n.parent;
          if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
            element.fnName = holder.name.text;
            break;
          }
        }
      }
      if (parent === null) {
        for (let n = node.parent; n; n = n.parent) {
          if (ts.isJsxElement(n) || ts.isJsxFragment(n) || ts.isBlock(n) || ts.isSourceFile(n) || ts.isReturnStatement(n)) break;
          // Markup a function returns is the function's, not a const's;
          // a callback walking a list (`rows.map(...)`) hands it on.
          if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
            const call = n.parent;
            const mapped = call && ts.isCallExpression(call) && call.expression !== n && ts.isPropertyAccessExpression(call.expression) && /^(map|flatMap|filter)$/.test(call.expression.name.text);
            if (!mapped) break;
          }
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
            element.constName = n.name.text;
            break;
          }
        }
      }
      return element;
    };
    const childText = (child, parentIndex, ctx) => {
      const parent = local(parentIndex);
      if (ts.isJsxText(child)) {
        const t = child.text.replace(/\s+/g, " ").trim();
        if (t) parent.texts.push(t);
        return;
      }
      if (ts.isJsxExpression(child) && child.expression) {
        const what = textOf(child.expression, ctx);
        if (what.kind === "text") parent.exprs.push(child.expression.getText(source).replace(/\s+/g, " ").slice(0, 60));
        if (what.kind === "slot") parent.slot = true;
        if (what.slotProp && !parent.slotProps.includes(what.slotProp)) parent.slotProps.push(what.slotProp);
        if (what.helper) parent.helperCalls.push(what.helper);
        if (what.ref) parent.refs.push(what.ref);
      }
    };
    const visit = (node, parent) => {
      if (ts.isJsxElement(node)) {
        const el = add(node, node.openingElement, parent);
        visitAttributes(node.openingElement, el.index);
        const ctx = ctxFor(node);
        for (const child of node.children) {
          childText(child, el.index, ctx);
          visit(child, el.index);
        }
        return;
      }
      if (ts.isJsxSelfClosingElement(node)) {
        const el = add(node, node, parent);
        visitAttributes(node, el.index);
        return;
      }
      if (ts.isJsxFragment(node)) {
        const ctx = ctxFor(node);
        for (const child of node.children) {
          if (parent !== null) childText(child, parent, ctx);
          visit(child, parent);
        }
        return;
      }
      ts.forEachChild(node, (c) => visit(c, parent));
    };
    // Markup handed to a component through a prop: drawn where the
    // component shows that prop.
    const visitAttributes = (opening, index) => {
      const host = local(index);
      for (const a of opening.attributes.properties) {
        if (!ts.isJsxAttribute(a) || !a.initializer || !ts.isJsxExpression(a.initializer)) continue;
        const name = a.name.getText(source);
        const before = elements.length;
        visit(a.initializer, index);
        const made = elements.slice(before).filter((e) => e.parents.includes(index)).map((e) => e.index);
        if (made.length) host.propJsx.set(name, made);
        let e = a.initializer.expression;
        while (e && (ts.isParenthesizedExpression(e) || ts.isConditionalExpression(e) || ts.isBinaryExpression(e))) {
          e = ts.isParenthesizedExpression(e) ? e.expression : ts.isConditionalExpression(e) ? e.whenTrue : e.right;
        }
        if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && ctxFor(e).helperNamed(e.expression.text)) host.propHelpers.set(name, e.expression.text);
        // A prop handed on as it came: `<Row acts={acts} />`.
        const passed = e && ts.isIdentifier(e) ? ctxFor(e).bindings?.props.get(e.text) : null;
        if (passed) host.propForward.set(name, passed);
      }
    };
    visit(statement, null);
  };
  if (isTsx) for (const statement of source.statements) scan(statement);

  /* Styles set in code: every colour or opacity a TypeScript object or a
   * JSX attribute gives, with the chain of keys that leads to it. */
  const keyPath = (node) => {
    const keys = [];
    let jsx = null;
    for (let n = node; n; n = n.parent) {
      if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) keys.unshift(n.name.getText(source));
      if (ts.isJsxAttribute(n)) {
        keys.unshift(n.name.getText(source));
        jsx = n.parent.parent;
        break;
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        keys.unshift(n.name.text);
        break;
      }
      if (ts.isFunctionDeclaration(n) && n.name) {
        keys.unshift(n.name.text + "()");
        break;
      }
    }
    return { keys, jsx };
  };
  const WATCHED = /^(color|WebkitTextFillColor|opacity|fill|filter|WebkitFilter|webkitFilter|-webkit-filter)$/;
  const watched = (name) => WATCHED.test(name) || name.startsWith("--");
  const ASSIGNS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]);
  /** A site whose style cannot be read, named by its source text. */
  const unreadAt = (node, element = null) =>
    unresolved.push({ file, line: lineOf(node), kind: "style", component: ctxFor(node).component, text: node.getText(source).replace(/\s+/g, " ").slice(0, 100), element });
  /** One colour, opacity, filter or custom property set in code: recorded
   * with the elements whose style holds it, and when it styles an element
   * and its value cannot be read, named as unread. `dom` marks a style set
   * on an element by hand, which reaches an element the source does not
   * name. */
  const record = (node, name, given, keys, element, owners, styled, when, jsxAttr, dom = false) => {
    put(node, name, given.getText(source), valuesOf(given, valueScope), keys, element, owners, styled, when, jsxAttr, dom);
  };
  const put = (node, name, value, read, keys, element, owners, styled, when, jsxAttr, dom) => {
    if (name.startsWith("--")) {
      codeCustoms.push({ file, line: lineOf(node), prop: name, values: read.values.map(unquoted), open: read.open, element, owners: [...owners], when });
      return;
    }
    codeStyles.push({ file, line: lineOf(node), prop: name, value, values: read.values, none: read.none, keys, element, owners: [...owners], when, jsxAttr, dom });
    // A text colour or an opacity that styles an element (an inline
    // style, a style object an element wears, the attribute itself, a
    // style set by hand) and whose value cannot be read is recorded, never
    // passed in silence.
    const inks = dom || name !== "fill" || [...owners].some((el) => SVG_TEXT.has(el.tag.toLowerCase()));
    const styles = dom || styled.size > 0 || (element !== null && (jsxAttr ? element.dom : keys[0] === "style"));
    if (read.open.length && inks && styles) {
      unresolved.push({ file, line: lineOf(node), kind: "style", component: ctxFor(node).component, text: `${name}: ${value}`.replace(/\s+/g, " ").slice(0, 100), element });
    }
  };

  /* ---- styles set on an element by hand ---- */

  /** The name a style property set by hand is recorded under, as an
   * element's style object or `setProperty` spells it: null for one that
   * holds no colour, opacity, filter or custom property. */
  const BY_HAND = new Map([
    ["color", "color"], ["opacity", "opacity"], ["fill", "fill"], ["filter", "filter"],
    ["webkitFilter", "WebkitFilter"], ["WebkitFilter", "WebkitFilter"], ["-webkit-filter", "WebkitFilter"],
    ["webkitTextFillColor", "WebkitTextFillColor"], ["WebkitTextFillColor", "WebkitTextFillColor"], ["-webkit-text-fill-color", "WebkitTextFillColor"],
  ]);
  const byHandName = (name) => (name.startsWith("--") ? name : BY_HAND.get(name) ?? null);
  /** Whether an expression is an element's own style (`el.style`, or a
   * constant that holds one) rather than a style object this file makes. */
  const isElementStyle = (expr, depth = 0) => {
    const n = unwrap(expr);
    if (!n || depth > 4) return false;
    if (ts.isPropertyAccessExpression(n) && n.name.text === "style") return objectsOf(n, ctxFor(n)).objects.length === 0;
    if (!ts.isIdentifier(n)) return false;
    const held = heldBy(n.text, n);
    if (!held || held.binding.kind !== "const" || held.exprs.length !== 1) return false;
    const [only] = held.exprs;
    return only.expr !== null && !only.keys.length && isElementStyle(only.expr, depth + 1);
  };
  /** Where a style is set by hand: the function it is set in. */
  const placeOf = (node) => {
    for (let n = node.parent; n; n = n.parent) {
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText(source) + "()";
      if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text + "()";
    }
    return null;
  };
  /** The condition a statement is set under, up to its function. */
  const conditionOf = (node) => {
    for (let n = node.parent; n && !ts.isFunctionLike(n) && !ts.isSourceFile(n); n = n.parent) {
      if (ts.isIfStatement(n)) return n.expression.getText(source);
      if (ts.isConditionalExpression(n)) return n.condition.getText(source);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return n.left.getText(source);
    }
    return null;
  };
  /** A style set by hand under a name it can read. */
  const byHand = (node, name, given, receiver) => {
    const prop = byHandName(name);
    if (!prop) return;
    const keys = [placeOf(node), receiver.getText(source).replace(/\s+/g, " "), prop].filter(Boolean);
    record(node, prop, given, keys, null, new Set(), new Set(), conditionOf(node), false, true);
  };
  /** Declarations written as text (`cssText`, a style attribute), read
   * through the constants they name, each colour, opacity, filter or
   * custom property recorded as set by hand; text it cannot read is named
   * as unread. */
  const byHandText = (node, given, receiver) => {
    const read = valuesOf(given, valueScope);
    if (read.open.length) {
      unreadAt(node);
      return;
    }
    const byProp = new Map();
    for (const v of read.values) {
      for (const d of declarationsOf(unquoted(v))) {
        const prop = byHandName(d.prop);
        if (!prop) continue;
        if (!byProp.has(prop)) byProp.set(prop, []);
        byProp.get(prop).push('"' + d.value + '"');
      }
    }
    for (const [prop, values] of byProp) {
      const keys = [placeOf(node), receiver.getText(source).replace(/\s+/g, " "), prop].filter(Boolean);
      put(node, prop, values.join(" | "), { values, none: false, open: [] }, keys, null, new Set(), new Set(), conditionOf(node), false, true);
    }
  };
  /** Whether an expression is text in every branch. */
  const isStyleText = (expr) => {
    const read = valuesOf(expr, valueScope);
    return !read.open.length && read.values.length > 0 && read.values.every((v) => /^["'`]/.test(v));
  };
  /** The names a key can be, or null when it cannot be read. */
  const namesOf = (keyExpr) => {
    const read = valuesOf(keyExpr, valueScope);
    return read.open.length || !read.values.length ? null : [...new Set(read.values.map(unquoted))];
  };
  /** Objects assigned into an element's own style: their members are set
   * by hand. */
  const handObjects = new Set();
  if (/Object\s*\.\s*assign/.test(text)) {
    const mark = (n) => {
      const callee = ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) ? n.expression : null;
      if (callee && ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && callee.name.text === "assign" && n.arguments.length > 1 && isElementStyle(n.arguments[0])) {
        for (const a of n.arguments.slice(1)) {
          const found = objectsOf(a, ctxFor(a));
          if (found.opaque) unreadAt(a);
          for (const o of found.objects) handObjects.add(o);
        }
      }
      ts.forEachChild(n, mark);
    };
    mark(source);
  }

  const codeVisit = (node) => {
    const shorthand = ts.isShorthandPropertyAssignment(node);
    if (((ts.isPropertyAssignment(node) || ts.isJsxAttribute(node)) && node.initializer) || shorthand) {
      // A name computed from a constant is read as the constant's value.
      const names = ts.isJsxAttribute(node) ? [node.name.getText(source)] : memberNames(node);
      if (names === null || names.some(watched)) {
        // `{ color }` holds the constant of that name.
        const given = shorthand ? node.name : node.initializer;
        const { keys, jsx } = keyPath(node);
        const element = jsx ? elements.find((e) => e.line === lineOf(jsx) && e.tag === jsx.tagName.getText(source)) ?? null : null;
        // The elements whose style holds it, and the condition it is set under.
        const owners = new Set(element ? [element] : []);
        const styled = new Set();
        let when = null;
        let dom = false;
        for (let n = node.parent; n && !ts.isStatement(n) && !ts.isJsxElement(n) && !ts.isJsxSelfClosingElement(n); n = n.parent) {
          for (const el of styleOwners.get(n) ?? []) {
            owners.add(el);
            styled.add(el);
          }
          dom ||= handObjects.has(n);
          if (when === null && ts.isConditionalExpression(n)) when = n.condition.getText(source);
          if (when === null && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) when = n.left.getText(source);
        }
        const jsxAttr = ts.isJsxAttribute(node);
        if (names === null) {
          // A style member whose name cannot be read may be a colour.
          if (dom || styled.size > 0 || (element !== null && keys[0] === "style")) {
            unresolved.push({ file, line: lineOf(node), kind: "style", component: ctxFor(node).component, text: `${node.name.getText(source)}: ${given.getText(source)}`.replace(/\s+/g, " ").slice(0, 100), element });
          }
        } else {
          for (const name of new Set(names)) if (watched(name)) record(node, name, given, keys, element, owners, styled, when ?? (dom ? conditionOf(node) : null), jsxAttr, dom);
        }
      }
    }
    // A value written into a style after it is made: into an object this
    // file makes (`s.color = x`), or into an element's own style by hand
    // (`el.style.color = x`, `el.style.cssText = "..."`, `el.style = "..."`).
    if (ts.isBinaryExpression(node) && ASSIGNS.has(node.operatorToken.kind)) {
      const left = unwrap(node.left);
      if (left && (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))) {
        const names = ts.isPropertyAccessExpression(left) ? [left.name.text] : namesOf(left.argumentExpression);
        const target = names === null || names.some(watched) ? objectsOf(left.expression, ctxFor(node)) : null;
        if (target?.objects.length) {
          const owners = new Set(target.objects.flatMap((o) => styleOwners.get(o) ?? []));
          const keys = [left.expression.getText(source).replace(/\s+/g, " ")];
          if (names === null) {
            // A member it cannot name, written into a style an element wears.
            if (owners.size) unreadAt(node);
          } else {
            let when = null;
            for (let n = node.parent; n && !ts.isFunctionLike(n) && !ts.isSourceFile(n); n = n.parent) {
              if (ts.isIfStatement(n)) {
                when = n.expression.getText(source);
                break;
              }
            }
            for (const name of new Set(names)) if (watched(name)) record(node, name, node.right, [...keys, name], null, owners, owners, when, false);
          }
        } else if (names !== null && names.includes("style") && ts.isPropertyAccessExpression(left) && isStyleText(node.right) && isElementStyle(left)) {
          // A style given whole as text; an object given to a `style` member
          // is data, not an element's style.
          byHandText(node, node.right, left);
        } else if (isElementStyle(left.expression)) {
          if (names === null) unreadAt(node);
          else {
            for (const name of names) {
              if (name === "cssText") byHandText(node, node.right, left.expression);
              else byHand(node, name, node.right, left.expression);
            }
          }
        }
      }
    }
    // A style set by hand through a call: `el.style.setProperty(name, value)`,
    // `el.setAttribute("style", text)` and the presentation attributes.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length >= 2) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const [prop, value] = node.arguments;
      if (method === "setProperty" && isElementStyle(receiver)) {
        const names = namesOf(prop);
        if (names === null) unreadAt(node);
        else for (const name of names) byHand(node, name, value, receiver);
      } else if (method === "setAttribute") {
        // An attribute it cannot name is left: attributes are not styles.
        for (const name of namesOf(prop) ?? []) {
          if (name === "style") byHandText(node, value, receiver);
          else if (/^(color|opacity|fill|filter)$/.test(name)) byHand(node, name, value, receiver);
        }
      }
    }
    ts.forEachChild(node, codeVisit);
  };
  codeVisit(source);

  /** The class sets a constant this file exports can hold. */
  const exportAlts = (name) => {
    const init = moduleConsts.get(exportsAs.get(name) ?? name);
    if (!init) return null;
    return alts(init, { ...ctxFor(init), globals: true, miss: () => {} });
  };

  return { file, sheets, imports, reexports, components, exportsAs, helpers, elements, codeStyles, codeCustoms, unresolved, exportAlts, sheetTexts };
}

/* ---- the model ---- */

/** Every non-test source file under src/, by its path from the root. */
export function loadSources(root) {
  const sources = new Map();
  const src = path.join(root, "src");
  for (const full of walk(src, (f) => /\.(css|tsx?)$/.test(f) && !/\.test\.tsx?$/.test(f) && !/\.d\.ts$/.test(f))) {
    sources.set(path.relative(root, full).split(path.sep).join("/"), readFileSync(full, "utf8"));
  }
  return sources;
}

/**
 * Read a source tree into one model: every stylesheet rule by selector,
 * every element the components draw (with the classes it can wear, its
 * attributes, its text and where it sits), the styles set in code, and
 * what could not be read.
 *
 * `sources` maps a path from the root (src/...) to its text; without it the
 * tree under `root` is read from disk. A TypeScript file without markup is
 * read only when it names a colour or an opacity, which keeps the walk
 * over the server code short.
 */
export function collect({ root = process.cwd(), sources = loadSources(root) } = {}) {
  const exists = (file) => sources.has(file);
  const elements = [];
  const files = new Map();
  const selectors = [];
  const customs = [];
  const composes = new Map();
  const codeStyles = [];
  const codeCustoms = [];
  const unresolved = [];

  /* The constants a file declares at its top, for a value set in code
   * that names one it imports: read when first asked for, whether or not
   * the file is read for elements. */
  const moduleScopes = new Map();
  const moduleScope = (file) => {
    if (moduleScopes.has(file)) return moduleScopes.get(file);
    moduleScopes.set(file, null);
    const text = sources.get(file);
    if (text === undefined) return null;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const consts = new Map();
    const fns = new Map();
    const imported = new Map();
    // What the file exports under each name: its own constant, or one it
    // passes on from another file.
    const local = new Map();
    const passed = new Map();
    const stars = [];
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        fns.set(statement.name.text, statement);
        if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) local.set(statement.name.text, statement.name.text);
      }
      if (ts.isVariableStatement(statement)) {
        const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        for (const d of statement.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          if (d.initializer && isConstInit(d.initializer)) consts.set(d.name.text, d.initializer);
          if (exported) local.set(d.name.text, d.name.text);
        }
      }
      const clause = ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? statement.importClause : null;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const target = resolveImport(root, file, statement.moduleSpecifier.text, exists);
        if (target) for (const el of clause.namedBindings.elements) imported.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
      }
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? resolveImport(root, file, statement.moduleSpecifier.text, exists) : null;
        for (const el of statement.exportClause.elements) {
          const from = (el.propertyName ?? el.name).text;
          if (target) passed.set(el.name.text, { file: target, name: from });
          else if (!statement.moduleSpecifier) local.set(el.name.text, from);
        }
      } else if (ts.isExportDeclaration(statement) && !statement.exportClause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveImport(root, file, statement.moduleSpecifier.text, exists);
        if (target) stars.push(target);
      }
    }
    const scope = {
      lookup: (name, _at, depth = 0) => {
        if (consts.has(name)) return [{ init: consts.get(name), scope }];
        const from = imported.get(name);
        return from && depth < 8 ? exportedAs(from.file, from.name, depth + 1) : null;
      },
      /** A name another file imports from this one, read through the
       * name it is exported under. */
      exported: (name, depth = 0) => {
        if (local.has(name)) return scope.lookup(local.get(name), null, depth);
        const via = passed.get(name);
        if (via) return depth < 8 ? exportedAs(via.file, via.name, depth + 1) : null;
        for (const star of stars) {
          const found = depth < 8 ? exportedAs(star, name, depth + 1) : null;
          if (found) return found;
        }
        return scope.lookup(name, null, depth);
      },
      /** The function another file imports from this one under a name. */
      fn: (name, depth = 0) => {
        const own = (n) => fns.get(n) ?? (consts.has(n) ? functionOf(consts.get(n)) : null);
        if (local.has(name)) {
          const found = own(local.get(name));
          if (found) return found;
          const from = imported.get(local.get(name));
          return from && depth < 8 ? moduleScope(from.file)?.fn(from.name, depth + 1) ?? null : null;
        }
        const via = passed.get(name);
        if (via) return depth < 8 ? moduleScope(via.file)?.fn(via.name, depth + 1) ?? null : null;
        for (const star of stars) {
          const found = depth < 8 ? moduleScope(star)?.fn(name, depth + 1) : null;
          if (found) return found;
        }
        return own(name);
      },
    };
    moduleScopes.set(file, scope);
    return scope;
  };
  const exportedAs = (file, name, depth = 0) => moduleScope(file)?.exported(name, depth) ?? null;
  const exported = (file, name) => exportedAs(file, name);
  /** The member names the objects a function another file exports returns
   * may hold, or null when that cannot be read. */
  const returnedKeys = (file, name) => {
    const fn = moduleScope(file)?.fn(name);
    if (!fn) return null;
    const keys = new Set();
    for (const r of returnsOf(fn)) {
      const k = keysOf(r);
      if (!k) return null;
      for (const x of k) keys.add(x);
    }
    return keys;
  };

  /** One stylesheet's rules, custom properties and composed classes.
   * Stylesheet text a component writes in markup is read as a global
   * stylesheet of the component's file, its lines counted from `first`. */
  const readSheet = (file, text, isModule, first = 1) => {
    // A registered initial value is given on the page itself.
    for (const r of registeredValues(text)) customs.push({ file, prelude: ":root", context: "", prop: r.prop, value: r.value, important: false, line: r.line + first - 1, registered: true });
    for (const rule of parseRules(text, { lines: true })) {
      if (first > 1) {
        rule.line += first - 1;
        for (const d of rule.decls) d.line += first - 1;
      }
      const prelude = rule.selectors.join(", ");
      if (rule.unread) unresolved.push({ file, line: rule.line, kind: "stylesheet", component: null, text: rule.unread, element: null });
      for (const d of rule.decls) if (d.prop.startsWith("--")) customs.push({ file, prelude, context: rule.context, ...d });
      for (const selector of rule.selectors) {
        const parts = selectorParts(selector);
        selectors.push({ file, module: isModule, prelude, selector, context: rule.context, line: rule.line, decls: rule.decls, parts, subject: parts[parts.length - 1] });
        const single = /^\.([-_a-zA-Z0-9]+)$/.exec(selector);
        if (!single || !isModule) continue;
        for (const d of rule.decls.filter((x) => x.prop === "composes")) {
          const m = /^(.*?)(?:\s+from\s+(["'])(.+)\2)?$/.exec(d.value);
          if (!m || m[3] === "global") continue;
          const from = m[3] ? path.posix.join(path.posix.dirname(file), m[3]) : file;
          const key = "m\t" + file + "\t" + single[1];
          if (!composes.has(key)) composes.set(key, []);
          for (const cls of m[1].trim().split(/\s+/)) composes.get(key).push("m\t" + from + "\t" + cls);
        }
      }
    }
  };

  for (const [file, text] of [...sources].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (file.endsWith(".css")) {
      readSheet(file, text, file.endsWith(".module.css"));
      continue;
    }
    if (!file.endsWith(".tsx") && !CODE_STYLE_HINT.test(text)) continue;
    const info = readSource(file, text, { root, exists, base: elements.length, exported, returnedKeys });
    elements.push(...info.elements);
    files.set(file, info);
    codeStyles.push(...info.codeStyles);
    codeCustoms.push(...info.codeCustoms);
    unresolved.push(...info.unresolved);
    for (const sheet of info.sheetTexts) readSheet(file, sheet.css, false, sheet.line);
  }

  /* Constants imported from another file: read now that every file is. */
  const importedAlts = (token, depth) => {
    const [, from, name] = token.split("\t");
    const found = depth < 4 ? files.get(from)?.exportAlts(name) : null;
    return found ? resolveImported(found, depth + 1) : null;
  };
  function resolveImported(list, depth = 0) {
    if (!list.some((alt) => alt.some((t) => t.startsWith("i\t")))) return list;
    return union(...list.map((alt) => {
      const own = alt.filter((t) => !t.startsWith("i\t"));
      const parts = alt.filter((t) => t.startsWith("i\t")).map((t) => importedAlts(t, depth) ?? [[t]]);
      return product([[own], ...parts]);
    }));
  }
  for (const el of elements) {
    if (el.alts) el.alts = resolveImported(el.alts);
    for (const [name, list] of el.props) el.props.set(name, resolveImported(list));
    for (const t of new Set([...(el.alts ?? []), ...el.props.values()].flat(2).filter((x) => typeof x === "string" && x.startsWith("i\t")))) {
      unresolved.push({ file: el.file, line: el.line, kind: "class", component: el.component, text: "imported " + t.split("\t").slice(1).join(" "), element: el });
    }
  }

  /** The component a name exported from a file is, following re-exports. */
  const definition = (file, name, depth = 0) => {
    const info = files.get(file);
    if (!info || depth > 8) return null;
    const local = info.exportsAs.get(name);
    if (local && info.components.has(local)) return { file, name: local };
    if (info.reexports.has(name)) {
      const r = info.reexports.get(name);
      return definition(r.file, r.name, depth + 1);
    }
    for (const [key, r] of info.reexports) {
      if (key.startsWith("*")) {
        const found = definition(r.file, name, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  const calleeOf = (el) => {
    const info = files.get(el.file);
    if (el.dom || !info) return null;
    if (info.components.has(el.tag)) return { file: el.file, name: el.tag };
    const imported = info.imports.get(el.tag);
    if (!imported) return null;
    if (imported.file.startsWith("external:")) return { external: true, name: imported.name };
    return definition(imported.file, imported.name);
  };

  /* Component calls, their callers, and the elements a class handed to a
   * component lands on. */
  const callers = new Map();
  for (const el of elements) {
    if (el.dom) continue;
    el.callee = calleeOf(el);
    if (el.callee && !el.callee.external) {
      const key = el.callee.file + "\t" + el.callee.name;
      if (!callers.has(key)) callers.set(key, []);
      callers.get(key).push(el.index);
    }
  }
  const byFile = new Map();
  for (const el of elements) {
    if (!byFile.has(el.file)) byFile.set(el.file, []);
    byFile.get(el.file).push(el);
  }
  // Markup held in a const, or drawn by a function of the same file, is
  // joined to the element that shows it (every one, when it is shown in
  // several places). Done before the outermost elements are counted, so
  // joined markup is no component's outermost.
  const loose = new Set(elements.filter((e) => e.parents.length === 0).map((e) => e.index));
  for (const el of elements) {
    const mine = byFile.get(el.file).filter((e) => loose.has(e.index));
    for (const ref of el.refs) {
      for (const held of mine.filter((e) => e.constName === ref && e.component === el.component)) {
        held.parents.push(el.index);
        el.children.push(held.index);
      }
    }
    for (const name of el.helperCalls) {
      for (const drawn of mine.filter((e) => e.fnName === name && e.constName === null && e.index !== el.index)) {
        drawn.parents.push(el.index);
        el.children.push(drawn.index);
      }
    }
    for (const [prop, name] of el.propHelpers) {
      const drawn = mine.filter((e) => e.fnName === name && e.constName === null && e.index !== el.index);
      for (const d of drawn) {
        d.parents.push(el.index);
        el.children.push(d.index);
      }
      el.propJsx.set(prop, [...(el.propJsx.get(prop) ?? []), ...drawn.map((d) => d.index)]);
    }
  }
  const byComponent = new Map();
  const roots = new Map();
  for (const el of elements) {
    const key = el.file + "\t" + el.component;
    if (!byComponent.has(key)) byComponent.set(key, []);
    byComponent.get(key).push(el);
    if (el.parents.length === 0 && el.component) {
      if (!roots.has(key)) roots.set(key, []);
      roots.get(key).push(el);
    }
  }
  const rootsOf = (file, name) => roots.get(file + "\t" + name) ?? [];

  const fill = (alt, supplied) => {
    const given = alt.filter((t) => t.startsWith("p\t") && supplied.has(t.slice(2)));
    const own = alt.filter((t) => !given.includes(t));
    return product([[own], ...given.map((t) => supplied.get(t.slice(2)))]);
  };
  const memo = new Map();
  /** Where a prop handed to a component lands: the element and the class
   * sets it wears there, with the props still unbound. */
  const landingsOf = (target, prop, depth = 0) => {
    const key = target.file + "\t" + target.name + "\t" + prop;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, []);
    const info = files.get(target.file);
    const out = [];
    if (info && depth <= 6) {
      const bound = info.components.get(target.name)?.bindings?.bound ?? new Set();
      for (const el of byComponent.get(target.file + "\t" + target.name) ?? []) {
        if (el.dom) {
          for (const alt of el.alts ?? []) if (alt.includes("p\t" + prop)) out.push({ alt, landing: el.index });
          continue;
        }
        if (!el.callee) continue;
        if (el.callee.external) {
          for (const [, list] of el.props) for (const alt of list) if (alt.includes("p\t" + prop)) out.push({ alt, landing: el.index });
          continue;
        }
        const via = [...el.props].filter(([, list]) => list.some((alt) => alt.includes("p\t" + prop))).map(([name]) => name);
        if (el.forwardsRest && !bound.has(prop) && !el.props.has(prop)) via.push(prop);
        for (const name of via) {
          for (const inner of landingsOf(el.callee, name, depth + 1)) {
            for (const alt of fill(inner.alt, el.props)) out.push({ alt, landing: inner.landing });
          }
        }
      }
    }
    memo.set(key, out);
    return out;
  };
  for (const el of elements) {
    if (el.dom) continue;
    el.landings = [];
    if (!el.callee || !el.props.size) continue;
    if (el.callee.external) {
      // A component from a package: taken to put its class on one element.
      const alts = union(...[...el.props].filter(([name]) => CLASS_PROP.test(name)).map(([, list]) => list));
      if (alts.some((a) => a.length)) el.landings.push({ alts, landing: null, tag: EXTERNAL_TAGS[el.callee.name] ?? null });
      continue;
    }
    const byLanding = new Map();
    for (const prop of el.props.keys()) {
      for (const inner of landingsOf(el.callee, prop)) {
        for (const alt of fill(inner.alt, el.props)) {
          if (!byLanding.has(inner.landing)) byLanding.set(inner.landing, []);
          byLanding.get(inner.landing).push(alt);
        }
      }
    }
    for (const [landing, list] of byLanding) {
      const target = elements[landing];
      el.landings.push({ alts: union(list), landing, tag: target?.dom ? target.tag : null });
    }
  }

  /* A spread on a component call that cannot be read may hand it a class
   * or a style: named as unread where the component puts a class it is
   * handed on an element under a name no attribute after the spread sets
   * again, or puts the style it is handed on one (spreading its props, all
   * of them or a rest that keeps the style, or reading the style prop)
   * and no style is set after the spread. A component from a package, or
   * one not known, is taken to do both. */
  const takesClass = new Map();
  const handedClasses = (callee) => {
    if (!callee || callee.external) return null;
    const key = callee.file + "\t" + callee.name;
    if (takesClass.has(key)) return takesClass.get(key);
    const names = new Set(["className"]);
    for (const el of byComponent.get(key) ?? []) {
      for (const alt of [...(el.alts ?? []), ...[...el.props.values()].flat()]) for (const t of alt) if (t.startsWith("p\t") && CLASS_PROP.test(t.slice(2))) names.add(t.slice(2));
    }
    const found = [...names].filter((name) => landingsOf(callee, name).length > 0);
    takesClass.set(key, found);
    return found;
  };
  const takesStyle = new Map();
  const handedStyle = (callee, depth = 0) => {
    if (!callee || callee.external) return true;
    const key = callee.file + "\t" + callee.name;
    if (takesStyle.has(key)) return takesStyle.get(key);
    takesStyle.set(key, false);
    const found = (byComponent.get(key) ?? []).some((el) => el.forwardsStyle && (el.dom || depth > 6 || handedStyle(el.callee, depth + 1)));
    takesStyle.set(key, found);
    return found;
  };
  for (const el of elements) {
    if (el.dom || !el.unreadSpreads.length) continue;
    const handed = handedClasses(el.callee);
    for (const site of el.unreadSpreads) {
      if (handed && handed.every((name) => site.later.has(name)) && (site.later.has("style") || !handedStyle(el.callee))) continue;
      unresolved.push({ file: el.file, line: site.line, text: site.text, kind: "spread", component: el.component, element: el });
    }
  }

  /* Composed classes stand on the element with the class that composes them. */
  const expand = (alt) => {
    const out = new Set(alt);
    const stack = [...alt];
    while (stack.length) {
      const t = stack.pop();
      for (const c of composes.get(t) ?? []) if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
    }
    return [...out];
  };
  for (const el of elements) {
    if (!el.dom) for (const l of el.landings) l.wears = l.alts.map(expand);
    el.wears = el.dom ? (el.alts ?? []).map(expand) : el.landings.flatMap((l) => l.wears);
  }

  /* Indexes: elements by the classes they wear and by tag. */
  const byToken = new Map();
  const byTag = new Map();
  for (const el of elements) {
    for (const t of new Set(el.wears.flat())) {
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t).push(el);
    }
    for (const tag of tagsOf(el)) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(el);
    }
  }
  function tagsOf(el) {
    if (el.dom) return [el.tag.toLowerCase()];
    return [...new Set(el.landings.map((l) => l.tag).filter(Boolean))];
  }

  return {
    root, sources, files, elements, selectors, customs, codeStyles, codeCustoms, unresolved, callers, byToken, byTag, tagsOf,
    rootsOf,
    stats: {
      stylesheets: [...sources.keys()].filter((f) => f.endsWith(".css")).length,
      components: [...files.keys()].filter((f) => f.endsWith(".tsx")).length,
      sourcesRead: files.size,
      elements: elements.length,
      selectors: selectors.length,
    },
  };
}

/* ---- questions about the model ---- */

/** Whether an element can wear every one of these class tokens at once. */
function wears(el, tokens) {
  return el.wears.some((alt) => tokens.every((t) => alt.includes(t)));
}

/** The attributes an element is drawn with: its own, and for a class handed
 * to a component, the landing element's too. */
function attributesOf(model, el) {
  if (el.dom) return { attrs: el.attrs, spread: el.spread };
  const attrs = new Map(el.attrs);
  let spread = el.spread || el.landings.some((l) => l.landing === null);
  for (const l of el.landings) {
    const target = l.landing === null ? null : model.elements[l.landing];
    if (!target) continue;
    for (const [k, v] of target.attrs) if (!attrs.has(k)) attrs.set(k, v);
    spread ||= target.spread;
  }
  return { attrs, spread };
}

/** Whether one compound of a selector from `sheet` can stand for an element. */
export function compoundMatches(model, compound, el, sheet) {
  if (compound.document || compound.opaque) return true;
  const tags = model.tagsOf(el);
  if (compound.tag && compound.tag !== "*" && !tags.includes(compound.tag)) return false;
  const tokens = [
    ...compound.classes.map((c) => (sheet.module ? "m\t" + sheet.file + "\t" + c : "g\t" + c)),
    ...compound.globals.map((c) => "g\t" + c),
  ];
  if (!tokens.length && !compound.tag && !compound.attrs.length) return !el.dom ? el.landings.length > 0 : true;
  if (tokens.length && !wears(el, tokens)) return false;
  if (!el.dom && !el.landings.length) return false;
  const { attrs, spread } = attributesOf(model, el);
  for (const a of compound.attrs) {
    if (!attrs.has(a.name)) {
      if (spread) continue;
      return false;
    }
    const v = attrs.get(a.name);
    if (a.op === "=" && a.value !== null && typeof v === "string" && v !== a.value) return false;
    if (a.op === "=" && a.value === "false" && v === true) return false;
  }
  return true;
}

function rootCallers(model, el) {
  if (!el.component) return [];
  return (model.callers.get(el.file + "\t" + el.component) ?? []).map((i) => model.elements[i]);
}

/** Whether an element stands in the page as a box of its own: a DOM
 * element, or a component call that puts a class handed to it on one. */
const isBox = (el) => el.dom || el.landings?.length > 0;

/**
 * Walk down from some elements through everything drawn inside them:
 * JSX children, what a component they call draws, and at an element that
 * shows the children its component is handed, the children of the call
 * the walk came in through (or of every call, when the walk started
 * inside the component). `visit(el, depth, stack)` returns false to stop
 * below an element; a root can be given with the calls it was reached
 * through, as { el, stack }. Each element is visited once per call it was reached
 * through, to a fixed depth, so the walk is the same however the tree
 * around it grows. A root is walked from, not visited; reached again
 * inside another root (a selector whose first compound can be any
 * element starts from every element), it is visited there.
 */
export function descend(model, roots, visit, maxDepth = 24) {
  const queue = roots.map((r) => (r.el ? { el: r.el, stack: r.stack, depth: 0 } : { el: r, stack: [], depth: 0 }));
  const visited = new Set();
  const walked = new Set();
  for (let head = 0; head < queue.length; head += 1) {
    const { el, stack, depth } = queue[head];
    const key = el.index + ":" + (stack.length ? stack[stack.length - 1].index : "");
    if (depth > 0) {
      if (visited.has(key)) continue;
      visited.add(key);
      if (visit(el, depth, stack) === false) continue;
    }
    if (walked.has(key) || depth >= maxDepth) continue;
    walked.add(key);
    for (const [child, next] of stepDown(model, el, stack)) queue.push({ el: child, stack: next, depth: depth + 1 });
  }
}

/** What is drawn directly inside one element, each with the calls the walk
 * is inside of once it gets there. */
function stepDown(model, el, stack) {
  const out = [];
  const add = (i, s) => {
    const c = typeof i === "number" ? model.elements[i] : i;
    if (c) out.push([c, s]);
  };
  for (const i of el.children) add(i, stack);
  if (!el.dom) {
    if (el.callee && !el.callee.external) {
      const inner = [...stack, el];
      const landed = el.landings.map((l) => l.landing).filter((x) => x !== null);
      if (landed.length) for (const i of new Set(landed)) for (const c of model.elements[i]?.children ?? []) add(c, inner);
      else for (const r of model.rootsOf(el.callee.file, el.callee.name)) add(r, inner);
    }
  }
  if ((el.slot || el.slotProps.length) && el.component) {
    // What a call hands in through a prop, followed back through calls that
    // hand on a prop of their own component under it.
    const handed = (call, prop, rest, depth) => {
      const own = prop === "children" ? call.children : call.propJsx.get(prop) ?? [];
      for (const i of own) add(i, rest);
      const from = call.propForward.get(prop);
      if (!from || depth > 6) return;
      const up = rest[rest.length - 1];
      if (up && up.callee?.name === call.component && up.callee?.file === call.file) handed(up, from, rest.slice(0, -1), depth + 1);
      else if (!rest.length) for (const c of rootCallers(model, call)) handed(c, from, [], depth + 1);
    };
    const props = [...(el.slot ? ["children"] : []), ...el.slotProps];
    const top = stack[stack.length - 1];
    if (top && top.callee?.name === el.component && top.callee?.file === el.file) {
      for (const p of props) handed(top, p, stack.slice(0, -1), 0);
    } else if (!stack.length) {
      for (const call of rootCallers(model, el)) for (const p of props) handed(call, p, [], 0);
    }
  }
  return out;
}

/** The elements directly inside one as the page has them: through
 * component calls that are no box of their own, to the first box. */
function boxesInside(model, root) {
  const out = [];
  descend(model, [root], (c, depth, stack) => {
    if (isBox(c)) {
      out.push({ el: c, stack });
      return false;
    }
    return true;
  }, 8);
  return out;
}

/** The boxes an element sits directly in. */
function boxesAround(model, el) {
  const out = [];
  const seen = new Set();
  const up = (e, depth) => {
    if (depth > 8) return;
    const ups = e.parents.length ? e.parents.map((i) => model.elements[i]) : rootCallers(model, e);
    for (const p of ups) {
      if (!p || seen.has(p.index)) continue;
      seen.add(p.index);
      if (isBox(p)) out.push(p);
      else up(p, depth + 1);
    }
  };
  up(el, 0);
  return out;
}

/** The elements that can match one compound, before its attributes and
 * ancestors are read. */
function candidatesFor(model, compound, sheet) {
  const tokens = [
    ...compound.classes.map((c) => (sheet.module ? "m\t" + sheet.file + "\t" + c : "g\t" + c)),
    ...compound.globals.map((c) => "g\t" + c),
  ];
  if (tokens.length) return model.byToken.get(tokens[0]) ?? [];
  if (compound.tag && compound.tag !== "*") return model.byTag.get(compound.tag) ?? [];
  return model.elements;
}

/**
 * The elements a selector can stand for, read top-down: the elements that
 * match its first compound, then those under them that match the next,
 * and so on to its subject. A compound that stands for the page itself
 * (html, body, :root, a :global() of them) holds everywhere.
 */
export function elementsMatching(model, sel) {
  model.matchCache ??= new Map();
  if (model.matchCache.has(sel)) return model.matchCache.get(sel);
  // Each match keeps the calls it was reached through, so a component's
  // children slot under it shows only that call's children.
  let found = null;
  const parts = sel.parts;
  for (let i = 0; i < parts.length; i += 1) {
    const c = parts[i];
    if (c.document || c.opaque) {
      if (i === parts.length - 1) found = [];
      continue;
    }
    const here = new Set(candidatesFor(model, c, sel).filter((el) => compoundMatches(model, c, el, sel)));
    let next = [];
    if (found === null) next = [...here].map((el) => ({ el, stack: [] }));
    else if (c.comb === ">") {
      for (const r of found) for (const b of boxesInside(model, r)) if (here.has(b.el)) next.push(b);
    } else if (c.comb === "+" || c.comb === "~") {
      for (const r of found) for (const p of boxesAround(model, r.el)) for (const b of boxesInside(model, { el: p, stack: [] })) if (b.el !== r.el && here.has(b.el)) next.push(b);
    } else {
      descend(model, found, (d, depth, stack) => {
        if (here.has(d)) next.push({ el: d, stack });
        return true;
      });
    }
    const seen = new Set();
    found = next.filter((r) => {
      const key = r.el.index + ":" + (r.stack.length ? r.stack[r.stack.length - 1].index : "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!found.length) break;
  }
  const out = [...new Set((found ?? []).map((r) => r.el))];
  model.matchCache.set(sel, out);
  return out;
}

/** Whether a selector can stand for an element. */
export function selectorMatches(model, sel, el) {
  return elementsMatching(model, sel).includes(el);
}

/** A CSS string's text with its escapes read. */
const cssString = (s) => s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (_m, hex, ch) => (hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : ch === "\n" ? "" : ch));

/** The text a `content` value writes before its alternative text: its
 * strings with their escapes read; an attribute's, a counter's or a custom
 * property's value stands as "{attr}", "{counter}" or "{var}". "" when it
 * writes none. */
export function contentText(value) {
  const shown = splitTop(value, /\//)[0] ?? "";
  let out = "";
  for (const token of splitTop(shown, /\s/)) {
    const quoted = /^(["'])([\s\S]*)\1$/.exec(token);
    if (quoted) out += cssString(quoted[2]);
    else if (/^attr\(/i.test(token)) out += "{attr}";
    else if (/^counters?\(/i.test(token)) out += "{counter}";
    else if (/^var\(/i.test(token)) out += "{var}";
  }
  return out;
}

/** Whether generated text is decoration: one to three characters with no
 * letter or digit (an ornament glyph or a separator), or an icon font's
 * glyph from the private use area. */
export const isDecoration = (text) => {
  const t = text.trim();
  return /^[^\p{L}\p{N}]{1,3}$/u.test(t) || /^[\p{Co}\s]+$/u.test(t);
};

/** The marker text a list style writes: the string a `list-style-type`
 * or a `list-style` shorthand holds, or "" for a counter style or none. */
function markerString(decls) {
  const d = decls.filter((x) => x.prop === "list-style-type" || x.prop === "list-style").at(-1);
  const quoted = d ? splitTop(d.value, /\s/).map((t) => /^(["'])([\s\S]*)\1$/.exec(t)).find(Boolean) : null;
  return quoted ? cssString(quoted[2]) : "";
}

/** The text the ::before, ::after and ::marker rules that can stand for an
 * element write in it: `{ pseudo, text, decoration }` for each that writes
 * some, whatever state the rule asks for (svg draws none). A list style
 * written as a string is a marker's text in the list items it reaches: the
 * element it is set on when that is one, and those inside it, which
 * inherit it. */
export function generatedText(model, el) {
  if (!model.generated) {
    model.generated = new Map();
    const put = (m, pseudo, text, sel) => {
      if (m.dom && (SVG_ART.has(m.tag.toLowerCase()) || SVG_TEXT.has(m.tag.toLowerCase()))) return;
      if (!model.generated.has(m.index)) model.generated.set(m.index, []);
      model.generated.get(m.index).push({ pseudo, text: text.trim(), decoration: isDecoration(text), sel });
    };
    const listItem = (m, sel) => model.tagsOf(m).includes("li") || sel.decls.some((d) => d.prop === "display" && /\blist-item\b/.test(d.value));
    for (const sel of model.selectors) {
      const pseudo = sel.subject?.pseudoElement;
      if (!pseudo) {
        const marker = markerString(sel.decls);
        if (!marker.trim()) continue;
        for (const m of elementsMatching(model, sel)) {
          if (listItem(m, sel)) put(m, "marker", marker, sel);
          descend(model, [m], (d) => {
            if (model.tagsOf(d).includes("li")) put(d, "marker", marker, sel);
            return true;
          });
        }
        continue;
      }
      if (pseudo !== "before" && pseudo !== "after" && pseudo !== "marker") continue;
      const content = sel.decls.filter((d) => d.prop === "content").at(-1);
      const text = content ? contentText(content.value) : "";
      if (!text.trim()) continue;
      for (const m of elementsMatching(model, sel)) put(m, pseudo, text, sel);
    }
  }
  return model.generated.get(el.index) ?? [];
}

/** Whether an element shows text of its own: words or numbers written in
 * it, an expression that can be them, a field's value, the text its
 * callers hand in through its children, or text a ::before, ::after or
 * ::marker rule or a list style writes in it that is no decoration. */
export function bearsText(model, el) {
  if (el.dom) {
    const tag = el.tag.toLowerCase();
    if (SVG_ART.has(tag)) return false;
    if (SVG_TEXT.has(tag)) return el.texts.length > 0 || el.exprs.length > 0;
    if (FIELDS.has(tag) || el.html) return true;
  }
  if (el.texts.length || el.exprs.length) return true;
  if (generatedText(model, el).some((g) => !g.decoration)) return true;
  if (el.slot && el.component) {
    return rootCallers(model, el).some((call) => call.texts.length > 0 || call.exprs.length > 0);
  }
  if (!el.dom) {
    for (const l of el.landings) {
      const target = l.landing === null ? null : model.elements[l.landing];
      if (target && target !== el && target.dom && (target.texts.length || target.exprs.length || FIELDS.has(target.tag))) return true;
    }
  }
  return false;
}

/** What an element shows, in a few words: its written text, else the
 * expressions it shows, else its placeholder. */
export function shows(model, el) {
  const own = [...el.texts.map((t) => JSON.stringify(t)), ...el.exprs.map((e) => "{" + e + "}")];
  if (!own.length && !el.dom) {
    for (const l of el.landings) {
      const t = l.landing === null ? null : model.elements[l.landing];
      if (t && t !== el) own.push(...t.texts.map((x) => JSON.stringify(x)), ...t.exprs.map((e) => "{" + e + "}"));
    }
  }
  if (!own.length && typeof el.attrs.get("placeholder") === "string") own.push("placeholder " + JSON.stringify(el.attrs.get("placeholder")));
  if (!own.length && el.slot) own.push("{children}");
  const text = own.join(" ");
  return text.length > 80 ? text.slice(0, 79) + "…" : text;
}

/** An element's identity: its file, the component it is drawn in, its tag
 * with the module classes it can wear, and the start of what it shows.
 * Two elements that would read the same in one file are numbered in
 * source order. Lines are not part of it, so it holds while a file moves. */
export function elementIds(model) {
  const ids = new Map();
  const seen = new Map();
  for (const el of model.elements) {
    const classes = [...new Set(el.wears.flat().filter((t) => !t.startsWith("p\t")).map((t) => "." + t.split("\t").pop()))].sort().join("");
    const text = shows(model, el).slice(0, 40);
    let id = `${el.file} :: ${el.component ?? el.helper ?? "(module)"} <${el.tag}${classes}>${text ? " " + text : ""}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id += ` #${n}`;
    ids.set(el.index, id);
  }
  return ids;
}
