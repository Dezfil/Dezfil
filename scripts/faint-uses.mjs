/*
 * The faint ink's uses, read from the source collector's model.
 *
 * The faint ink is decoration only: placeholders, ornament glyphs and
 * separators, the bare no-value mark, line and row numbers. Interface text
 * at rest is not faded by transparency either, its own or a parent's,
 * outside disabled controls and short transient states. This module finds
 * every place the source can break that, in four layers:
 *
 *   - declarations: every colour of text that resolves to the faint ink,
 *     in a stylesheet or set in code (svg text's fill included): the token,
 *     its palette and Liquid spellings, the raw faint hexes, and any custom
 *     property defined from them, in a stylesheet or inline (the token
 *     blocks that define the ink are definitions, not uses). A value set in
 *     code is read through the constants it names;
 *   - elements: every element that wears one of those styles, a style
 *     object held in a constant included;
 *   - inheritance: text inside such an element that sets no colour of its
 *     own, so it takes the faint ink from it. A class, a rule or an inline
 *     colour that holds only some of the time sets one only when every
 *     branch does;
 *   - opacity: every opacity under one (or a see-through text colour) that
 *     applies at rest to an element with text in it, whatever that text's
 *     colour. A colour is see-through by its alpha, read through the colour
 *     functions it nests and the custom properties it names, in a
 *     stylesheet or set in code. Fully transparent is hiding, not fading,
 *     and is left out.
 *
 * Each use carries what the check needs to judge a listed use by its kind:
 * the selectors, the value, the elements with what they show.
 */
import { atRest, bearsText, cmp, collect, descend, elementIds, elementsMatching, selectorParts, shows, specificity, splitTop, statesOf } from "./source-collector.mjs";

/** The faint ink's spellings: the token, its palette capture and the Liquid
 * steps, and the raw hexes the token holds (light, dark, and by day). */
export const FAINT_TOKENS = ["--fg-faint", "--fg-faint-palette", "--liquid-fg-faint"];
export const FAINT_HEXES = ["#93a19c", "#5d6880", "#7f8d89"];

const TEXT_COLOUR = new Set(["color", "-webkit-text-fill-color"]);
const SVG_TEXT = /^(text|tspan|textpath)$/i;
const NO_COLOUR = /^(inherit|currentcolor|unset|initial|revert|revert-layer)$/i;
/** Fields keep the browser's own ink unless a rule says otherwise. */
const FIELD_TAGS = new Set(["input", "textarea", "select"]);

/** A selector with its :not() parts left out, so what remains is what it asks for. */
const positive = (selector) => selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "");
/** Whether a selector asks for an attribute, on its subject or on an
 * element around it: a state it holds only some of the time, so what it
 * says about the ink does not hold at rest. */
const needsAttr = (selector) => selectorParts(positive(selector)).some((c) => c.attrs.length > 0);

/** Every value a custom property is given: in a stylesheet, and in code
 * (an inline style that sets it). */
export function customValues(model) {
  const out = new Map();
  const add = (prop, value) => {
    if (!out.has(prop)) out.set(prop, []);
    out.get(prop).push(value);
  };
  for (const c of model.customs) add(c.prop, c.value);
  for (const c of model.codeCustoms ?? []) for (const v of c.values) add(c.prop, v);
  return out;
}

/** Every custom property that resolves to the faint ink. */
export function faintAliases(model) {
  const aliases = new Set(FAINT_TOKENS);
  const defined = [...customValues(model)].flatMap(([prop, values]) => values.map((value) => ({ prop, value })));
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of defined) {
      if (!aliases.has(c.prop) && isFaint(c.value, aliases)) {
        aliases.add(c.prop);
        grew = true;
      }
    }
  }
  return aliases;
}

/** Whether a colour value can resolve to the faint ink. */
export function isFaint(value, aliases) {
  const v = value.toLowerCase();
  if (FAINT_HEXES.some((h) => new RegExp(h + "(?![0-9a-f])").test(v))) return true;
  for (const m of v.matchAll(/var\(\s*(--[-\w]+)/g)) if (aliases.has(m[1])) return true;
  return false;
}

const num = (s) => (s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s));
const between = (x) => Number.isFinite(x) && x > 0 && x < 1;

/** A CSS function call written as the whole of a value: its name and what
 * stands between its brackets, or null. */
function callOf(value) {
  const m = /^([a-z][-a-z0-9]*)\(/i.exec(value);
  if (!m || !value.endsWith(")")) return null;
  let depth = 0;
  for (let i = m[1].length; i < value.length; i += 1) {
    if (value[i] === "(") depth += 1;
    else if (value[i] === ")") {
      depth -= 1;
      if (depth === 0) return i === value.length - 1 ? { name: m[1].toLowerCase(), inner: value.slice(m[1].length + 1, -1) } : null;
    }
  }
  return null;
}

/** The most values a custom property is followed into. */
const READ_CAP = 64;
const unique = (xs) => [...new Set(xs)].slice(0, READ_CAP);

/** A var(): its property and its fallback, or null. */
function varOf(value) {
  const call = callOf(value.trim());
  if (!call || call.name !== "var") return null;
  const [prop, ...rest] = splitTop(call.inner, /,/);
  const comma = call.inner.indexOf(",");
  return { prop: prop.trim(), fallback: rest.length ? call.inner.slice(comma + 1).trim() : null };
}

/**
 * Read colours and numbers through the custom properties they name.
 * `resolve(prop)` gives every value a property is given. A property given
 * nowhere is a token from outside the tree and reads as opaque; a var()
 * with a fallback can take the fallback as well.
 */
function reader(resolve = () => []) {
  /** Every number an alpha, share or opacity can be, as a fraction; NaN
   * where it is a calculation that cannot be read. */
  const numbers = (expr, env = {}, seen = new Set()) => {
    const v = expr.trim().toLowerCase();
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/.test(v)) return [num(v)];
    if (v === "none") return [0];
    if (/^(inherit|initial|unset|revert|revert-layer)$/.test(v)) return [1];
    if (v === "alpha" && env.alpha) return env.alpha;
    const ref = varOf(v);
    if (ref) {
      if (seen.has(ref.prop)) return [NaN];
      const given = resolve(ref.prop);
      const out = given.flatMap((g) => numbers(g, env, new Set([...seen, ref.prop])));
      if (ref.fallback !== null) out.push(...numbers(ref.fallback, env, seen));
      return unique(out);
    }
    const call = callOf(v);
    if (call && /^(calc|min|max|clamp)$/.test(call.name)) {
      const args = call.name === "calc" ? [call.inner] : splitTop(call.inner, /,/);
      const each = args.map((a) => calc(a, env, seen));
      if (call.name === "calc") return each[0];
      const combos = each.reduce((acc, xs) => acc.flatMap((a) => xs.map((x) => [...a, x])).slice(0, READ_CAP), [[]]);
      const pick = { min: (xs) => Math.min(...xs), max: (xs) => Math.max(...xs), clamp: ([lo, x, hi]) => Math.min(Math.max(x, lo), hi) }[call.name];
      return unique(combos.map(pick));
    }
    return [NaN];
  };
  /** A calculation over numbers, `alpha`, var() and nested calc(). */
  const calc = (text, env, seen) => {
    const tokens = [];
    const src = text.trim();
    for (let i = 0; i < src.length; ) {
      const ch = src[i];
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if ("+-*/()".includes(ch) && !(ch === "-" && /[a-z]/i.test(src[i + 1] ?? ""))) {
        tokens.push(ch);
        i += 1;
        continue;
      }
      const m = /^([a-z][-a-z0-9]*)\(/i.exec(src.slice(i));
      if (m) {
        let depth = 0;
        let j = i;
        for (; j < src.length; j += 1) {
          if (src[j] === "(") depth += 1;
          else if (src[j] === ")" && --depth === 0) break;
        }
        tokens.push(numbers(src.slice(i, j + 1), env, seen));
        i = j + 1;
        continue;
      }
      const word = /^[-\w.%]+/.exec(src.slice(i));
      if (!word) return [NaN];
      tokens.push(numbers(word[0], env, seen));
      i += word[0].length;
    }
    let at = 0;
    const expr = () => {
      let left = term();
      while (tokens[at] === "+" || tokens[at] === "-") {
        const op = tokens[at++];
        const right = term();
        left = left.flatMap((a) => right.map((b) => (op === "+" ? a + b : a - b)));
      }
      return left;
    };
    const term = () => {
      let left = factor();
      while (tokens[at] === "*" || tokens[at] === "/") {
        const op = tokens[at++];
        const right = factor();
        left = left.flatMap((a) => right.map((b) => (op === "*" ? a * b : a / b)));
      }
      return left;
    };
    const factor = () => {
      const t = tokens[at++];
      if (t === "(") {
        const inner = expr();
        at += 1;
        return inner;
      }
      if (t === "-") return factor().map((x) => -x);
      return Array.isArray(t) ? t : [NaN];
    };
    const out = expr();
    return at === tokens.length ? unique(out) : [NaN];
  };
  /**
   * Every opacity a colour can paint with, from nothing to all, read
   * through the colour functions it nests and the custom properties it
   * names: transparent; a hex with an alpha; rgb(), hsl() and their kin
   * with an alpha after a slash or as their last argument; a relative
   * colour, which keeps its origin's alpha unless it writes one (where
   * `alpha` stands for the origin's); color-mix(), from the share each
   * colour is given and its own opacity, the total under all fading it as
   * well; light-dark(), either side. An alpha it cannot work out is NaN.
   */
  const alphas = (value, seen = new Set()) => {
    const v = value.trim().toLowerCase();
    if (v === "transparent") return [0];
    const hex = /^#([0-9a-f]{3,8})$/.exec(v);
    if (hex) {
      const h = hex[1];
      if (h.length === 4) return [parseInt(h[3] + h[3], 16) / 255];
      if (h.length === 8) return [parseInt(h.slice(6), 16) / 255];
      return [1];
    }
    const ref = varOf(v);
    if (ref) {
      if (seen.has(ref.prop)) return [1];
      const given = resolve(ref.prop);
      const out = given.flatMap((g) => alphas(g, new Set([...seen, ref.prop])));
      if (ref.fallback !== null) out.push(...alphas(ref.fallback, seen));
      return out.length ? unique(out) : [1];
    }
    const call = callOf(v);
    if (!call) return [1];
    const clamp = (x) => (Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : NaN);
    if (call.name === "color-mix") {
      const [, ...colours] = splitTop(call.inner, /,/);
      if (colours.length !== 2) return [1];
      const sides = colours.map((part) => {
        const words = splitTop(part, /\s/);
        const share = words.find((w) => /%$/.test(w) || /^calc\(/.test(w));
        return { colour: words.filter((w) => w !== share).join(" "), shares: share === undefined ? [null] : numbers(share, {}, seen) };
      });
      const out = [];
      for (const a0 of sides[0].shares) for (const b0 of sides[1].shares) {
        let a = a0;
        let b = b0;
        if (a === null && b === null) a = b = 0.5;
        else if (a === null) a = 1 - b;
        else if (b === null) b = 1 - a;
        const total = a + b;
        if (!Number.isFinite(total)) {
          out.push(NaN);
          continue;
        }
        if (!(total > 0)) continue;
        for (const x of alphas(sides[0].colour, seen)) for (const y of alphas(sides[1].colour, seen)) out.push(((x * a + y * b) / total) * Math.min(total, 1));
      }
      return out.length ? unique(out) : [1];
    }
    if (call.name === "light-dark") {
      const sides = splitTop(call.inner, /,/);
      return sides.length === 2 ? unique(sides.flatMap((side) => alphas(side, seen))) : [1];
    }
    if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/.test(call.name)) {
      const slash = splitTop(call.inner, /\//);
      const words = splitTop(slash[0], /\s/);
      const origin = words[0] === "from" && words.length > 1 ? alphas(words[1], seen) : null;
      if (slash.length === 2) return unique(numbers(slash[1], { alpha: origin ?? [1] }, seen).map(clamp));
      if (origin) return origin;
      const commas = splitTop(call.inner, /,/);
      // The comma form: an alpha as the fourth argument, or after a var()
      // that stands for the three channels.
      if (/^(rgba?|hsla?)$/.test(call.name) && (commas.length === 4 || (commas.length === 2 && varOf(commas[0])))) return unique(numbers(commas.at(-1), {}, seen).map(clamp));
      return [1];
    }
    return [1];
  };
  return { alphas, numbers };
}

/** The opacity a colour paints with, from nothing to all: the faintest it
 * can be, read through what it nests, with custom properties as opaque. */
export function alphaOf(value) {
  return Math.min(...reader().alphas(value));
}

/**
 * How much a declaration fades what it draws, or null: an opacity, an
 * opacity() filter or a see-through colour that can be between none and
 * all, read through the custom properties it names (`resolve` gives a
 * property's values). The faintest wins; one it cannot work out is NaN, a
 * fade all the same. Fully transparent is hiding, not fading.
 */
export function fadeOf(prop, value, resolve) {
  const read = reader(resolve);
  let xs = null;
  if (prop === "opacity") xs = read.numbers(value);
  else if (prop === "filter") {
    const m = /opacity\(\s*([^)]*(?:\([^)]*\))?[^)]*)\s*\)/.exec(value);
    xs = m ? read.numbers(m[1]) : null;
  } else if (TEXT_COLOUR.has(prop) || prop === "fill") xs = read.alphas(value);
  if (!xs) return null;
  const fading = xs.filter(between);
  if (fading.length) return Math.min(...fading);
  return xs.some((x) => Number.isNaN(x)) ? NaN : null;
}

/** The lowest numeric literal under one in a value set in code, or null. */
function codeFade(value) {
  const xs = [...value.matchAll(/(?<![\w.])(0?\.\d+)(?![\w.])/g)].map((m) => parseFloat(m[1])).filter((x) => x > 0 && x < 1);
  return xs.length ? Math.min(...xs) : null;
}

/** A rule's identity: its file and its selector list, with the at-rules
 * around it when there are any. */
const ruleId = (sel) => `${sel.file} :: ${sel.context ? sel.context + " { " + sel.prelude + " }" : sel.prelude}`;

/**
 * Every use of the faint ink and every fade over text in a model.
 * Returns { uses, ids, aliases, context }: `uses` maps a use's key
 * ("ink :: id" or "opacity :: id") to the use, `ids` names every element,
 * `aliases` are the custom properties that resolve to the faint ink, and
 * `context` is what a kind may ask of the model.
 */
export function faintUses(model) {
  const aliases = faintAliases(model);
  const ids = elementIds(model);
  const uses = new Map();
  const record = (layer, id, base) => {
    const key = layer + " :: " + id;
    if (!uses.has(key)) uses.set(key, { layer, id, ...base, selectors: [], decls: [], elements: new Map(), inherits: new Map(), inside: new Map() });
    return uses.get(key);
  };
  const entry = (el) => ({ id: ids.get(el.index), el, text: bearsText(model, el), shows: shows(model, el) });

  const customs = customValues(model);
  const resolve = (prop) => customs.get(prop) ?? [];

  /* The ink an element sets for itself at rest. The rules that can say:
   * those that match it at rest and name a text colour, outside a
   * pseudo-element, a state, or an attribute the selector asks for. The
   * strongest of them decides; where two tie, every one must give a colour.
   * `inherit`, `currentColor` and their kin give none, whatever the tag, so
   * the element takes its parent's ink. With no rule, a field keeps the
   * browser's own ink.
   *
   * An element that wears its classes under a condition gets its own ink
   * only when every set of classes it can wear does: a rule stands for the
   * sets that hold every class its subject asks for (and none its :not()
   * names, and one of each :is() or :where() list). A rule that gives an
   * ink only some of the time is no ink at rest: under a media or container
   * query, a class on the page or one an element around it wears under a
   * condition, a sibling, a :has(), or a position (:nth-child and its kin).
   * A colour that names a custom property gives an ink only where the
   * property is always given: on the page itself, in the same rule, or
   * inline on the element in every branch. An inline colour outranks the
   * rules, in the branches of the style that set one; a branch that sets
   * none leaves the rules to decide, and one that says `inherit` takes the
   * parent's ink whatever the rules say. */
  const tokenOf = (sel, c) => (sel.module ? "m\t" + sel.file + "\t" + c : "g\t" + c);
  const tokensOf = (sel, compound) => [...compound.classes.map((c) => tokenOf(sel, c)), ...compound.globals.map((c) => "g\t" + c)];
  /** The class lists a pseudo-class names, when each is plain classes. */
  const classLists = (sel, arg) => {
    if (arg === null || arg === undefined) return null;
    const out = [];
    for (const part of splitTop(arg, /,/)) {
      if (!/^(\.[-_a-zA-Z0-9]+)+$/.test(part.trim())) return null;
      out.push(part.trim().split(".").filter(Boolean).map((c) => tokenOf(sel, c)));
    }
    return out;
  };
  /** Whether every element that can wear these classes always does. */
  const wornMemo = new Map();
  const alwaysWorn = (tokens) => {
    if (!tokens.length) return true;
    const key = tokens.join("\n");
    if (wornMemo.has(key)) return wornMemo.get(key);
    const has = (set) => tokens.every((t) => set.includes(t));
    const ok = (model.byToken.get(tokens[0]) ?? []).every((el) => {
      const groups = el.dom ? [el.wears] : el.landings.map((l) => l.wears ?? []);
      return groups.every((g) => !g.some(has) || g.every(has));
    });
    wornMemo.set(key, ok);
    return ok;
  };
  const SITUATIONAL = /^(nth-|first-|last-|only-|empty$|has$)/;
  /** Whether a rule holds only some of the time, beyond its subject's classes. */
  const someOfTheTime = (sel) => {
    if (/@(media|container)\b/i.test(sel.context ?? "")) return true;
    const parts = sel.parts;
    if (parts.some((c) => c.comb === "+" || c.comb === "~")) return true;
    return parts.some((c, i) => {
      const subject = i === parts.length - 1;
      if (c.document) return c.classes.length > 0 || c.globals.length > 0 || c.attrs.length > 0;
      if (c.pseudos.some((p) => SITUATIONAL.test(p.name) || (/^(not|is|where|matches)$/.test(p.name) && (!subject || classLists(sel, p.arg) === null)))) return true;
      return !subject && (c.opaque || !alwaysWorn(tokensOf(sel, c)));
    });
  };
  /** Where each custom property is given. */
  const givenAt = new Map();
  const giveAt = (prop, where) => {
    if (!givenAt.has(prop)) givenAt.set(prop, []);
    givenAt.get(prop).push(where);
  };
  for (const c of model.customs) giveAt(c.prop, { css: c });
  for (const c of model.codeCustoms ?? []) giveAt(c.prop, { code: c });
  const onThePage = (prelude) =>
    splitTop(prelude, /,/).some((s) => {
      const parts = selectorParts(s);
      return parts.length > 0 && parts.every((c) => c.document && !c.classes.length && !c.globals.length && !c.attrs.length && c.pseudos.every((p) => p.name === "root"));
    });
  /** Whether a custom property is given wherever this element can be. */
  const supplied = (prop, el, sel) => {
    const at = givenAt.get(prop) ?? [];
    // Given nowhere in the tree: a token from outside it.
    if (!at.length) return true;
    return at.some(({ css, code }) => {
      if (css) return (css.file === sel.file && css.prelude === sel.prelude && css.context === sel.context) || (!/@(media|container)\b/i.test(css.context ?? "") && onThePage(css.prelude));
      return code.when === null && code.owners.includes(el);
    });
  };
  const atRestRules = new Map();
  for (const sel of model.selectors) {
    const colours = sel.decls.filter((d) => TEXT_COLOUR.has(d.prop));
    if (!colours.length || sel.subject.pseudoElement) continue;
    if (statesOf(sel.selector).pseudos.length || needsAttr(sel.selector)) continue;
    const decisive = colours.filter((d) => d.prop === "color").at(-1) ?? colours.at(-1);
    const gives = !NO_COLOUR.test(decisive.value.trim());
    // An ink given only some of the time cannot be relied on; a rule that
    // takes the ink away still counts wherever it can match.
    if (gives && someOfTheTime(sel)) continue;
    const subject = sel.subject;
    const tokens = subject.opaque ? [] : tokensOf(sel, subject);
    const not = [];
    const anyOf = [];
    for (const p of subject.pseudos) {
      const lists = classLists(sel, p.arg);
      if (!lists) continue;
      if (p.name === "not") not.push(...lists);
      else if (/^(is|where|matches)$/.test(p.name)) anyOf.push(lists);
    }
    const needs = [...decisive.value.matchAll(/var\(\s*(--[-\w]+)\s*\)/g)].map((m) => m[1]);
    const rule = { sel, specificity: specificity(sel.selector), gives, tokens, not, anyOf, needs };
    for (const el of elementsMatching(model, sel)) {
      if (!atRestRules.has(el.index)) atRestRules.set(el.index, []);
      atRestRules.get(el.index).push(rule);
    }
  }
  const holds = (set, list) => list.every((t) => set.includes(t));
  const applies = (r, set) => holds(set, r.tokens) && !r.not.some((x) => holds(set, x)) && r.anyOf.every((lists) => lists.some((x) => holds(set, x)));
  const unquote = (v) => v.trim().replace(/^(["'`])([\s\S]*)\1$/, "$2").trim();
  /** A component call that puts classes on more than one element. */
  const spreadsOut = (el) => !el.dom && new Set((el.landings ?? []).map((l) => l.landing).filter((x) => x !== null)).size > 1;
  /** The class sets an element wears, and the rules that can match it.
   * Inside a call that puts classes on several elements, the classes the
   * call hands in are filled in, and the rules matched against the call
   * stand for the element they land on. */
  const setsOf = (el, stack) => {
    const call = stack.at(-1);
    let sets = el.wears?.length ? el.wears : [[]];
    if (!call || !spreadsOut(call)) return { sets, rules: atRestRules.get(el.index) ?? [] };
    sets = sets.flatMap((set) => {
      const given = set.filter((t) => t.startsWith("p\t") && call.props.has(t.slice(2)));
      if (!given.length) return [set];
      const own = set.filter((t) => !given.includes(t));
      return given.reduce((acc, t) => acc.flatMap((a) => call.props.get(t.slice(2)).map((b) => [...new Set([...a, ...b])])), [own]);
    });
    return { sets, rules: [...(atRestRules.get(el.index) ?? []), ...(atRestRules.get(call.index) ?? [])] };
  };
  const rulesGiveInk = (el, stack = []) => {
    const { sets, rules } = setsOf(el, stack);
    const field = model.tagsOf(el).some((t) => FIELD_TAGS.has(t));
    return sets.every((set) => {
      const here = rules.filter((r) => applies(r, set));
      if (!here.length) return field;
      const top = here.reduce((best, r) => (cmp(r.specificity, best) > 0 ? r.specificity : best), [0, 0, 0]);
      return here.filter((r) => cmp(r.specificity, top) === 0).every((r) => r.gives && r.needs.every((prop) => supplied(prop, el, r.sel)));
    });
  };
  const ownColour = (el, stack = []) => {
    const inks = el.style?.inks ?? [null];
    if (inks.some((ink) => typeof ink === "string" && NO_COLOUR.test(unquote(ink)))) return false;
    if (!inks.includes(null)) return true;
    return rulesGiveInk(el, stack);
  };
  const isBox = (el) => el.dom || el.landings.length > 0;
  const textual = (el) => (isBox(el) ? bearsText(model, el) : el.texts.length || el.exprs.length);

  /** Text-bearing elements inside one that set no colour of their own. A
   * call that puts classes on several elements is read at those elements,
   * the text it hands in where its component shows it. */
  const inherited = (root) => {
    const out = [];
    const queue = [];
    const queued = new Set();
    const visit = (el, _depth, stack) => {
      if (spreadsOut(el) && el.callee && !el.callee.external) {
        for (const r of model.rootsOf(el.callee.file, el.callee.name)) {
          const key = r.index + ":" + el.index;
          if (!queued.has(key) && queue.length < 64) {
            queued.add(key);
            queue.push({ el: r, stack: [...stack, el] });
          }
        }
        return false;
      }
      if (isBox(el) && ownColour(el, stack)) return false;
      if (textual(el)) out.push(el);
      return true;
    };
    descend(model, [root], visit);
    for (let i = 0; i < queue.length; i += 1) {
      const { el, stack } = queue[i];
      if (visit(el, 1, stack) !== false) descend(model, [{ el, stack }], visit);
    }
    return [...new Set(out)];
  };
  /** The text-bearing elements inside one, whatever their ink. */
  const textBelow = (root) => {
    const out = [];
    descend(model, [root], (el) => {
      if (textual(el)) out.push(el);
      return true;
    });
    return out;
  };
  /** Whether an element or anything drawn inside it shows text. */
  const textMemo = new Map();
  const textInside = (root) => {
    if (textMemo.has(root.index)) return textMemo.get(root.index);
    let found = bearsText(model, root);
    if (!found) {
      descend(model, [root], (el) => {
        if (found) return false;
        if (textual(el)) found = true;
        return !found;
      });
    }
    textMemo.set(root.index, found);
    return found;
  };
  /** Svg text: an element whose fill is the colour its text is drawn in,
   * and the svg text drawn inside one, which takes the fill it is given. */
  const isSvgText = (el) => model.tagsOf(el).some((t) => SVG_TEXT.test(t));
  const svgTextMemo = new Map();
  const svgTextBelow = (root) => {
    if (svgTextMemo.has(root.index)) return svgTextMemo.get(root.index);
    const out = [];
    descend(model, [root], (el) => {
      if (isSvgText(el) && bearsText(model, el)) out.push(el);
      return true;
    });
    svgTextMemo.set(root.index, out);
    return out;
  };
  const fillsText = (el) => (isSvgText(el) && bearsText(model, el)) || svgTextBelow(el).length > 0;

  /* Stylesheets. */
  for (const sel of model.selectors) {
    const pseudo = sel.subject.pseudoElement;
    for (const d of sel.decls) {
      const fill = d.prop === "fill";
      const filled = fill ? elementsMatching(model, sel).filter(fillsText) : [];
      const ink = TEXT_COLOUR.has(d.prop) || (fill && (SVG_TEXT.test(sel.subject.tag ?? "") || filled.length > 0));
      if (ink && isFaint(d.value, aliases)) {
        const u = record("ink", ruleId(sel), { file: sel.file, line: d.line, origin: "css", value: d.value, pseudo: new Set() });
        u.selectors.push(sel.selector);
        if (!u.decls.includes(d)) u.decls.push(d);
        if (pseudo) u.pseudo.add(pseudo);
        u.rule = sel;
        for (const el of fill ? filled : elementsMatching(model, sel)) {
          const e = entry(el);
          if (pseudo === "placeholder") e.shows = typeof el.attrs.get("placeholder") === "string" ? "placeholder " + JSON.stringify(el.attrs.get("placeholder")) : "a placeholder";
          else if (pseudo === "before" || pseudo === "after") e.shows = "content " + (sel.decls.find((x) => x.prop === "content")?.value ?? "(none)");
          u.elements.set(e.id, e);
          if (fill) for (const inner of svgTextBelow(el)) u.inherits.set(ids.get(inner.index), entry(inner));
          else if (!pseudo) for (const inner of inherited(el)) u.inherits.set(ids.get(inner.index), entry(inner));
        }
      }
      const fade = fadeOf(d.prop, d.value, resolve);
      if (fade !== null && atRest(sel.selector)) {
        const reached = fill
          ? filled
          : elementsMatching(model, sel).filter((el) => {
              if (pseudo === "placeholder") return typeof el.attrs.get("placeholder") === "string" || model.tagsOf(el).some((t) => t === "input" || t === "textarea");
              if (pseudo === "before" || pseudo === "after") return /["'][^"']*\p{L}/u.test(sel.decls.find((x) => x.prop === "content")?.value ?? "");
              if (pseudo) return false;
              return textInside(el);
            });
        if (!reached.length) continue;
        const u = record("opacity", ruleId(sel), { file: sel.file, line: d.line, origin: "css", value: `${d.prop}: ${d.value}`, pseudo: new Set() });
        u.selectors.push(sel.selector);
        if (!u.decls.includes(d)) u.decls.push(d);
        if (pseudo) u.pseudo.add(pseudo);
        u.rule = sel;
        for (const el of reached) {
          const e = entry(el);
          u.elements.set(e.id, e);
          for (const inner of fill ? svgTextBelow(el) : textBelow(el)) u.inside.set(ids.get(inner.index), entry(inner));
        }
      }
    }
  }

  /* Styles set in code: the value as written and every value it can take
   * through the constants it names. A style object held in a constant
   * reaches every element that wears it, unless the element's own style
   * sets the colour over it in every branch. */
  for (const cs of model.codeStyles) {
    const el = cs.element;
    const colour = cs.prop === "color" || cs.prop === "WebkitTextFillColor";
    const reaches = (owner) =>
      owner === el || !colour || !owner.style || owner.style.inks.some((b) => b !== null && (typeof b !== "string" || isFaint(unquote(b), aliases) || [cs.value, ...(cs.values ?? [])].includes(b)));
    const owners = (cs.owners?.length ? cs.owners : el ? [el] : []).filter(reaches);
    const where = el ? `${ids.get(el.index).replace(/^.*? :: /, "")} ${cs.keys.join(" > ")}` : cs.keys.join(" > ");
    const id = `${cs.file} :: ${where}`;
    const values = cs.values ?? [];
    const value = values.length && !(values.length === 1 && values[0] === cs.value) ? `${cs.value} = ${[...new Set(values)].join(" | ")}` : cs.value;
    const fill = cs.prop === "fill";
    const text = fill && owners.some(fillsText);
    const ink = colour || text;
    if (ink && [cs.value, ...values].some((v) => isFaint(v, aliases))) {
      const u = record("ink", id, { file: cs.file, line: cs.line, origin: "code", value, keys: cs.keys, when: cs.when, pseudo: new Set() });
      for (const owner of owners) {
        const e = entry(owner);
        u.elements.set(e.id, e);
        for (const inner of fill ? svgTextBelow(owner) : inherited(owner)) u.inherits.set(ids.get(inner.index), entry(inner));
      }
    }
    const quoted = (v) => /^["'`]/.test(v.trim());
    const fades =
      cs.prop === "opacity"
        ? [codeFade(cs.value), ...values.map((v) => (quoted(v) ? fadeOf("opacity", unquote(v), resolve) : codeFade(v)))]
        : ink
          ? values.map((v) => fadeOf(fill ? "fill" : "color", unquote(v), resolve))
          : [];
    const fade = fades.some((x) => x !== null) ? Math.min(...fades.filter((x) => x !== null)) : null;
    if (fade !== null && (!owners.length || owners.some(fill ? fillsText : textInside))) {
      const u = record("opacity", id, { file: cs.file, line: cs.line, origin: "code", value: `${cs.prop}: ${value}`, keys: cs.keys, when: cs.when, pseudo: new Set() });
      for (const owner of owners) {
        const e = entry(owner);
        u.elements.set(e.id, e);
        for (const inner of fill ? svgTextBelow(owner) : textBelow(owner)) u.inside.set(ids.get(inner.index), entry(inner));
      }
    }
  }

  for (const u of uses.values()) u.shows = [...u.elements.values(), ...u.inherits.values(), ...u.inside.values()].map((e) => e.shows).filter(Boolean);
  /** What the kinds may ask of the model: a rule by its identity, the
   * elements a rule stands for, and whether an element is a hidden overlay
   * beside a field (a placeholder the page draws itself). */
  const context = {
    aliases,
    rule: (id) => {
      const [file, selector] = id.split(" :: ");
      return model.selectors.find((sel) => sel.file === file && sel.selector === selector) ?? null;
    },
    matching: (sel) => elementsMatching(model, sel),
    overField: (el) => {
      const hidden = el.attrs.get("aria-hidden");
      if (hidden !== true && hidden !== "true") return false;
      return el.parents.some((p) => model.elements[p]?.children.some((c) => c !== el.index && model.tagsOf(model.elements[c]).some((t) => FIELD_TAGS.has(t))));
    },
  };
  return { uses, ids, aliases, context };
}

/* ---- kinds ---- */

/** The literal text of an expression written as a string, or null. */
const literal = (expr) => {
  const m = /^\s*(["'`])([^"'`$]*)\1\s*$/.exec(expr);
  return m ? m[2] : null;
};
/** What an element shows as written text: its text and its literal
 * expressions; null when it shows an expression that is not a literal. */
const written = (el) => {
  const out = [...el.texts];
  for (const x of el.exprs) {
    const l = literal(x);
    if (l === null) return null;
    out.push(l);
  }
  return out.map((t) => t.trim()).filter(Boolean);
};
/** Every element a use reaches that shows text: the ones that wear it,
 * those that inherit it, and for a fade, everything inside. */
const textEntries = (use) => [...use.elements.values(), ...use.inherits.values(), ...use.inside.values()].filter((e) => e.text);
const GLYPH = /^[^\p{L}\p{N}]{1,3}$/u;
const NO_VALUE = /^[—–∅-]$/u;
/** A sentence: three words or more, a clause closed by a full stop, a
 * question or an exclamation mark. A placeholder prompts; it does not explain. */
const isSentence = (t) => t.split(/\s+/).filter(Boolean).length >= 3 && /[\p{L}\p{N})][.!?](?=\s|$)/u.test(t);
/** What an element shows: its written text with its literal expressions,
 * and whether it also shows an expression that is not written out. */
const readText = (el) => {
  const words = [...el.texts, ...el.exprs.map(literal).filter((l) => l !== null)].map((t) => t.trim()).filter(Boolean);
  return { words, open: el.exprs.some((x) => literal(x) === null) };
};

/** The states a selector asks for that make a control disabled. */
function saysDisabled(selector) {
  const asked = positive(selector);
  if (/:disabled\b/.test(asked)) return true;
  return [...asked.matchAll(/\[\s*(disabled|inert|aria-disabled|data-disabled|data-inert|data-refused)\s*(?:[~|^$*]?=\s*(["']?)([^"'\]]*)\2)?\s*\]/g)].some((m) => m[3] !== "false");
}
/** The states a selector asks for that take a control out of use without
 * the word disabled: off, unavailable, or an aria state. */
function saysOff(selector) {
  return saysDisabled(selector) || statesOf(selector).attrs.some((a) => a.value !== "false" && (/^aria-/.test(a.name) || /^data-(off|unavailable)$/.test(a.name)));
}
/** Whether a selector asks for a missing value as a state: an attribute
 * whose name or value says null. */
const saysNull = (selector) => statesOf(selector).attrs.some((a) => /null/i.test(a.name) || /null/i.test(a.value ?? ""));
/** The states a selector asks for that last only a moment. */
function saysTransient(selector) {
  const { attrs } = statesOf(selector);
  const word = /^(stale|updating|refreshing|loading|dragging|pending|busy|saving)$/;
  return attrs.some((a) => a.value !== "false" && (/^(aria-busy|data-(stale|updating|refreshing|loading|dragging|pending|busy|saving))$/.test(a.name) || word.test(a.value ?? "")));
}

/**
 * The kinds an allowed use can have, each a test of the use as it stands:
 * a reason it fails, or null when it holds. A listed use whose source
 * changes so that its kind no longer describes it fails here, even though
 * its identity is still listed.
 *
 * @type {Record<string, (use: any, row?: any, ctx?: any) => string | null>}
 */
export const KINDS = {
  /** An input's placeholder: a placeholder selector, or a class or key
   * that names the placeholder an element draws. What a named one reaches
   * must read as a placeholder: no sentence, or a hidden overlay on a field. */
  placeholder(use, _row, ctx = null) {
    const pseudo = use.origin === "css" && use.pseudo.has("placeholder");
    const ok = use.origin === "css"
      ? use.selectors.every((s) => pseudo ? /::placeholder/.test(s) || /placeholder/i.test(s) : /placeholder/i.test(s.split(/[\s>+~]/).pop() ?? ""))
      : (use.keys ?? []).some((k) => /placeholder/i.test(k));
    if (!ok) return "the style is not a placeholder's";
    if (use.inherits.size) return "text inherits it: " + [...use.inherits.keys()][0];
    if (pseudo) return null;
    for (const e of textEntries(use)) {
      if (ctx?.overField(e.el)) continue;
      const { words, open } = readText(e.el);
      if (open || !words.length) return `${e.id} shows text the check cannot read, and is no hidden overlay on a field: ${e.shows}`;
      if (words.some(isSentence)) return `${e.id} shows a sentence: ${e.shows}`;
    }
    return null;
  },
  /** A glyph that decorates: every text it reaches is one to three
   * characters with no letter or digit. */
  ornament(use) {
    if (!textEntries(use).length) return "it reaches no glyph";
    for (const e of textEntries(use)) {
      const w = written(e.el);
      if (w === null) return `${e.id} shows an expression, not a glyph`;
      if (w.some((t) => !GLYPH.test(t))) return `${e.id} shows words: ${e.shows}`;
    }
    return null;
  },
  /** The bare mark of a missing value: every text it reaches is the mark
   * alone, or an expression under a selector that asks for a null state. */
  "no-value"(use) {
    const entries = textEntries(use);
    if (!entries.length) return "it reaches no no-value mark";
    const nullState = use.selectors.length > 0 && use.selectors.every(saysNull);
    for (const e of entries) {
      const { words, open } = readText(e.el);
      if (words.some((t) => !NO_VALUE.test(t))) return `${e.id} shows more than the no-value mark: ${e.shows}`;
      if (open && !nullState) return `${e.id} shows an expression, and no selector asks for a null state: ${e.shows}`;
      if (!open && !words.length) return `${e.id} shows text the check cannot read: ${e.shows}`;
    }
    return null;
  },
  /** Line and row numbers: a numbering selector or key, and no written
   * word where it lands. */
  numbering(use) {
    const NUMBERING = /gutter|line-?number|\.rn\b|row-?num/i;
    const named = use.origin === "css" ? use.selectors.every((s) => NUMBERING.test(s)) : (use.keys ?? []).some((k) => NUMBERING.test(k));
    if (!named) return "the style is not a numbering one";
    for (const e of textEntries(use)) {
      if (e.el.texts.some((t) => /\p{L}/u.test(t))) return `${e.id} shows words: ${e.shows}`;
    }
    return null;
  },
  /** A disabled control: every selector asks for a disabled or inert state,
   * or the rule takes the pointer away under an off, aria or disabled state. */
  disabled(use) {
    if (use.origin !== "css") return "only a stylesheet state can say disabled";
    if (use.selectors.every(saysDisabled)) return null;
    const inert = use.rule?.decls.some((d) => d.prop === "pointer-events" && d.value === "none");
    if (!inert) return "a selector does not ask for a disabled state";
    return use.selectors.every(saysOff) ? null : "it takes the pointer away, but a selector asks for no off, aria or disabled state";
  },
  /** A short transient state: dragged, loading, refreshing, updating. */
  transient(use) {
    if (use.origin === "css") return use.selectors.every(saysTransient) ? null : "a selector does not ask for a transient state";
    return /drag|pending|loading|busy|updat|refresh|stale|saving/i.test(use.when ?? "") ? null : "the code does not set it only in a transient state";
  },
  /** A colour that reaches no text: icons, rules with no element. A row
   * may name the rule that gives its text another ink in the state the text
   * shows (`textInk`); that rule must exist, set an ink that is not faint,
   * outrank this one and stand for each of those elements. */
  "non-text"(use, row = {}, ctx = null) {
    if (use.layer !== "ink") return "an opacity listed here would reach text";
    let t = textEntries(use);
    if (row.textInk) {
      const over = ctx?.rule(row.textInk);
      if (!over) return `textInk names no rule: ${row.textInk}`;
      if (!over.decls.some((d) => TEXT_COLOUR.has(d.prop) && !NO_COLOUR.test(d.value) && !isFaint(d.value, ctx.aliases))) return `${row.textInk} gives no ink of its own`;
      if (use.rule && use.rule.selector && cmp(specificity(over.selector), specificity(use.rule.selector)) <= 0) return `${row.textInk} does not outrank ${use.rule.selector}`;
      const covered = new Set(ctx.matching(over).map((el) => el.index));
      t = t.filter((e) => !covered.has(e.el.index));
    }
    return t.length ? `${t[0].id} shows text: ${t[0].shows}` : null;
  },
  /** A syntax colour of code: the code tokens' own palette. */
  syntax(use) {
    return /var\(\s*--code-/.test(use.value) && !/--fg-faint/.test(use.value) ? null : "the colour is not a code token's";
  },
};

/* ---- the lists ---- */

/** A list row's key, the same as its use's. */
export const keyOf = (row) => row.layer + " :: " + row.id;

/** One line on a use that no list names: where it is set and what it reaches. */
function unlisted(use) {
  const where = `${use.origin === "code" ? "set in code" : "a rule"} at ${use.file}:${use.line} (${use.value})`;
  const reached = [...use.elements.values(), ...use.inherits.values(), ...use.inside.values()];
  const shown = reached.find((e) => e.text) ?? reached[0];
  if (!shown) return `not listed: ${where}, reaching no element the collector can see`;
  return `not listed: ${where}, reaching ${reached.length} element(s), first ${described(shown)}`;
}

/** An element's identity, with what it shows when the identity does not
 * already say it (a placeholder, generated content). */
const described = (e) => (e.shows && !e.id.includes(e.shows) ? `${e.id} showing ${e.shows}` : e.id);

/**
 * Judge a model's uses against the allowed list. Each row carries a kind
 * the use must still have, and names the elements the use reaches, the text
 * that inherits it and, for a fade, the text inside it. Every one of those
 * is compared both ways: a new one is growth, a missing one a stale row.
 *
 * Returns findings `{ check, key, message }`, `check` being one of
 * declaration, opacity, element, inheritance, kind or list.
 *
 * @param {{ uses: Map<string, any>, context: any }} found
 * @param {{ allowed?: any[] }} [lists]
 * @returns {{ check: string, key: string, message: string }[]}
 */
export function judge({ uses, context }, { allowed = [] } = {}) {
  const out = [];
  const add = (check, key, message) => out.push({ check, key, message: `${key}: ${message}` });
  const listed = new Set();
  for (const row of allowed) {
    const key = keyOf(row);
    if (listed.has(key)) add("list", key, "listed twice");
    listed.add(key);
  }
  for (const [key, use] of uses) if (!listed.has(key)) add(use.layer === "ink" ? "declaration" : "opacity", key, unlisted(use));

  const twoWay = (check, key, rows, found, verb) => {
    const named = new Set(rows);
    for (const [id, e] of found) if (!named.has(id)) add(check, key, `${described(e)} ${verb} and is not listed`);
    for (const id of named) if (!found.has(id)) add(check, key, `listed ${id} no longer ${verb}`);
  };
  for (const row of allowed) {
    const key = keyOf(row);
    const use = uses.get(key);
    if (!use) {
      add("list", key, "the allowed row outlives its use");
      continue;
    }
    twoWay("element", key, row.elements ?? [], use.elements, "wears it");
    twoWay("inheritance", key, row.inherits ?? [], use.inherits, "inherits it");
    twoWay("opacity", key, row.inside ?? [], use.inside, "sits inside the fade");
    const test = Object.hasOwn(KINDS, row.kind) ? KINDS[row.kind] : null;
    if (!test) {
      add("kind", key, `no kind is called ${row.kind}`);
      continue;
    }
    const why = test(use, row, context);
    if (why) add("kind", key, `not ${row.kind}: ${why}`);
    if (!use.elements.size && !row.unseen) add("kind", key, "it reaches no element; the row must say why (unseen)");
    if (use.elements.size && row.unseen) add("kind", key, "it reaches elements now; drop its unseen note");
  }
  return out.sort((a, b) => a.message.localeCompare(b.message, "en"));
}

export { collect };
