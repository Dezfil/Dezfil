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
 *     in a stylesheet or set in code: the token, its palette and Liquid
 *     spellings, the raw faint hexes, and any custom property defined from
 *     them (the token blocks that define the ink are definitions, not uses);
 *   - elements: every element that wears one of those styles;
 *   - inheritance: text inside such an element that sets no colour of its
 *     own, so it takes the faint ink from it;
 *   - opacity: every opacity under one (or a see-through text colour) that
 *     applies at rest to an element with text in it, whatever that text's
 *     colour. Fully transparent is hiding, not fading, and is left out.
 *
 * Each use carries what the check needs to judge a listed use by its kind:
 * the selectors, the value, the elements with what they show.
 */
import { atRest, bearsText, cmp, collect, descend, elementIds, elementsMatching, selectorParts, shows, specificity, statesOf } from "./source-collector.mjs";

/** The faint ink's spellings: the token, its palette capture and the Liquid
 * steps, and the raw hexes the token holds (light, dark, and by day). */
export const FAINT_TOKENS = ["--fg-faint", "--fg-faint-palette", "--liquid-fg-faint"];
export const FAINT_HEXES = ["#93a19c", "#5d6880", "#7f8d89"];

const TEXT_COLOUR = new Set(["color", "-webkit-text-fill-color"]);
const NO_COLOUR = /^(inherit|currentcolor|unset|initial|revert|revert-layer)$/i;
/** Fields keep the browser's own ink unless a rule says otherwise. */
const FIELD_TAGS = new Set(["input", "textarea", "select"]);

/** A selector with its :not() parts left out, so what remains is what it asks for. */
const positive = (selector) => selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "");
/** Whether a selector asks for an attribute, on its subject or on an
 * element around it: a state it holds only some of the time, so what it
 * says about the ink does not hold at rest. */
const needsAttr = (selector) => selectorParts(positive(selector)).some((c) => c.attrs.length > 0);

/** Every custom property that resolves to the faint ink. */
export function faintAliases(model) {
  const aliases = new Set(FAINT_TOKENS);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of model.customs) {
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

/** The opacity a declaration fades by, or null: a number or percentage
 * between none and all, an opacity() filter, or a see-through colour. */
export function fadeOf(prop, value) {
  const num = (s) => (s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s));
  const between = (x) => Number.isFinite(x) && x > 0 && x < 1;
  if (prop === "opacity") {
    const x = num(value.trim());
    return between(x) ? x : null;
  }
  if (prop === "filter") {
    const m = /opacity\(\s*([\d.]+%?)\s*\)/.exec(value);
    return m && between(num(m[1])) ? num(m[1]) : null;
  }
  if (TEXT_COLOUR.has(prop)) {
    const mix = /color-mix\([^)]*?([\d.]+)%[^)]*transparent/i.exec(value) ?? /transparent[^)]*?([\d.]+)%/i.exec(value);
    if (mix && /color-mix/i.test(value)) {
      const x = parseFloat(mix[1]) / 100;
      return between(x) ? x : null;
    }
    const rgba = /(?:rgba|hsla)\([^)]*,\s*([\d.]+%?)\s*\)/i.exec(value) ?? /(?:rgb|hsl)\([^)]*\/\s*([\d.]+%?)\s*\)/i.exec(value);
    if (rgba && between(num(rgba[1]))) return num(rgba[1]);
    const hex8 = /#[0-9a-f]{6}([0-9a-f]{2})\b/i.exec(value);
    if (hex8 && between(parseInt(hex8[1], 16) / 255)) return parseInt(hex8[1], 16) / 255;
  }
  return null;
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

  /* The ink an element sets for itself at rest. The rules that can say:
   * those that match it at rest and name a text colour, outside a
   * pseudo-element, a state, or an attribute the selector asks for. The
   * strongest of them decides; where two tie, every one must give a colour.
   * `inherit`, `currentColor` and their kin give none, whatever the tag, so
   * the element takes its parent's ink. An inline colour outranks them all.
   * With no rule, a field keeps the browser's own ink. */
  const atRestRules = new Map();
  for (const sel of model.selectors) {
    const colours = sel.decls.filter((d) => TEXT_COLOUR.has(d.prop));
    if (!colours.length || sel.subject.pseudoElement) continue;
    if (statesOf(sel.selector).pseudos.length || needsAttr(sel.selector)) continue;
    const decisive = colours.filter((d) => d.prop === "color").at(-1) ?? colours.at(-1);
    const rule = { specificity: specificity(sel.selector), gives: !NO_COLOUR.test(decisive.value.trim()) };
    for (const el of elementsMatching(model, sel)) {
      if (!atRestRules.has(el.index)) atRestRules.set(el.index, []);
      atRestRules.get(el.index).push(rule);
    }
  }
  const ownColour = (el) => {
    if (el.style?.color) return !NO_COLOUR.test((el.style.colorText ?? "").replace(/^["'`]|["'`]$/g, "").trim());
    const rules = atRestRules.get(el.index);
    if (!rules) return model.tagsOf(el).some((t) => FIELD_TAGS.has(t));
    const top = rules.reduce((best, r) => (cmp(r.specificity, best) > 0 ? r.specificity : best), [0, 0, 0]);
    return rules.filter((r) => cmp(r.specificity, top) === 0).every((r) => r.gives);
  };
  const isBox = (el) => el.dom || el.landings.length > 0;

  /** Text-bearing elements inside one that set no colour of their own. */
  const inherited = (root) => {
    const out = [];
    descend(model, [root], (el) => {
      if (isBox(el) && ownColour(el)) return false;
      if (isBox(el) ? bearsText(model, el) : el.texts.length || el.exprs.length) out.push(el);
      return true;
    });
    return out;
  };
  /** The text-bearing elements inside one, whatever their ink. */
  const textBelow = (root) => {
    const out = [];
    descend(model, [root], (el) => {
      if (isBox(el) ? bearsText(model, el) : el.texts.length || el.exprs.length) out.push(el);
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
        if (isBox(el) ? bearsText(model, el) : el.texts.length || el.exprs.length) found = true;
        return !found;
      });
    }
    textMemo.set(root.index, found);
    return found;
  };

  /* Stylesheets. */
  for (const sel of model.selectors) {
    const pseudo = sel.subject.pseudoElement;
    for (const d of sel.decls) {
      const ink = TEXT_COLOUR.has(d.prop) || (d.prop === "fill" && /^(text|tspan|textpath)$/.test(sel.subject.tag ?? ""));
      if (ink && isFaint(d.value, aliases)) {
        const u = record("ink", ruleId(sel), { file: sel.file, line: d.line, origin: "css", value: d.value, pseudo: new Set() });
        u.selectors.push(sel.selector);
        if (!u.decls.includes(d)) u.decls.push(d);
        if (pseudo) u.pseudo.add(pseudo);
        u.rule = sel;
        for (const el of elementsMatching(model, sel)) {
          const e = entry(el);
          if (pseudo === "placeholder") e.shows = typeof el.attrs.get("placeholder") === "string" ? "placeholder " + JSON.stringify(el.attrs.get("placeholder")) : "a placeholder";
          else if (pseudo === "before" || pseudo === "after") e.shows = "content " + (sel.decls.find((x) => x.prop === "content")?.value ?? "(none)");
          u.elements.set(e.id, e);
          if (!pseudo) for (const inner of inherited(el)) u.inherits.set(ids.get(inner.index), entry(inner));
        }
      }
      const fade = fadeOf(d.prop, d.value);
      if (fade !== null && atRest(sel.selector)) {
        const reached = elementsMatching(model, sel).filter((el) => {
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
          for (const inner of textBelow(el)) u.inside.set(ids.get(inner.index), entry(inner));
        }
      }
    }
  }

  /* Styles set in code. */
  for (const cs of model.codeStyles) {
    const el = cs.element;
    const where = el ? `${ids.get(el.index).replace(/^.*? :: /, "")} ${cs.keys.join(" > ")}` : cs.keys.join(" > ");
    const id = `${cs.file} :: ${where}`;
    const text = /^(text|tspan|textpath)$/i.test(el?.tag ?? "");
    const ink = cs.prop === "color" || cs.prop === "WebkitTextFillColor" || (cs.prop === "fill" && text);
    if (ink && isFaint(cs.value, aliases)) {
      const u = record("ink", id, { file: cs.file, line: cs.line, origin: "code", value: cs.value, keys: cs.keys, when: cs.when, pseudo: new Set() });
      if (el) {
        const e = entry(el);
        u.elements.set(e.id, e);
        for (const inner of inherited(el)) u.inherits.set(ids.get(inner.index), entry(inner));
      }
    }
    const fade = cs.prop === "opacity" ? codeFade(cs.value) : null;
    if (fade !== null && (!el || textInside(el))) {
      const u = record("opacity", id, { file: cs.file, line: cs.line, origin: "code", value: `opacity: ${cs.value}`, keys: cs.keys, when: cs.when, pseudo: new Set() });
      for (const owner of cs.owners ?? (el ? [el] : [])) {
        const e = entry(owner);
        u.elements.set(e.id, e);
        for (const inner of textBelow(owner)) u.inside.set(ids.get(inner.index), entry(inner));
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
