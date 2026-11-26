/*
 * The mono face's uses, and the numbers set in digits of one width, read
 * from the source collector's model.
 *
 * Mono is for code and data written as code: SQL, a dataset written the
 * way SQL writes it, a table's structure and raw data, engine errors word
 * for word, code to copy, identifiers, addresses and paths, and the fields
 * that create a dataset's SQL name. Names, people, counts, sizes, times,
 * kinds and states read in the reading face. This module finds every
 * place the source puts mono, and every number set in digits of one width:
 *
 *   - declarations: every font family, `font` shorthand or custom property
 *     that resolves to a mono face, in a stylesheet or set in code (an
 *     inline style, an editor theme), read through the custom properties
 *     defined from the faces; and any other line of TypeScript that names
 *     a mono face (the font loaders), by its text;
 *   - elements: every element that wears such a style, unless a stronger
 *     rule that always holds for it sets another family; and the text
 *     inside one that sets no family of its own, which inherits it. A rule
 *     that says `font: inherit` sets none: fields and buttons take their
 *     parent's face that way;
 *   - code marks: every code, pre, kbd and samp element the components
 *     draw that no rule and no inline style gives a family. The browser
 *     sets its own monospace on these elements themselves, at its own
 *     size, so a mono parent does not reach them;
 *   - digits: every rule or style set in code that sets digits of one
 *     width (tabular-nums, or the tnum feature), the elements that wear it
 *     and keep it, and the text inside one that inherits it. A stronger
 *     rule, a `font` shorthand (which sets the numeric variants and the
 *     feature settings back to normal) or a style set in code that sets
 *     them back takes them away.
 *
 * Each use carries what a kind needs to judge it: its selectors and
 * declarations, and the elements it reaches with what they show.
 */
import { bearsText, cmp, collect as collectSources, compoundMatches, descend, elementIds, elementsMatching, shows, specificity, statesOf } from "./source-collector.mjs";

/** The mono faces' tokens: the app's, and the two loaded faces. */
export const MONO_TOKENS = ["--font-mono", "--font-dm-mono", "--font-plex-mono"];
/** A mono face written out: a loaded face by name, a stack, the generic. */
const MONO_WRITTEN = /"SF Mono"|DM.?Mono|Plex.?Mono|ui-monospace|Cascadia|\bmonospace\b|var\(\s*--mono\b/;

/** The model this boundary reads: the collector's, with the font
 * properties set in code recorded as well. */
export function collect(options = {}) {
  return collectSources({ ...options, fonts: true });
}

const FAMILY = new Set(["font-family", "font"]);
const NUMERIC = new Set(["font-variant-numeric", "font-variant"]);
const FEATURES = new Set(["font-feature-settings"]);
const CODE_FAMILY = new Set(["fontFamily", "font"]);
const CODE_NUMERIC = new Set(["fontVariantNumeric", "fontVariant"]);
const CODE_FEATURES = new Set(["fontFeatureSettings"]);
/** The properties that decide digits in the cascade: the numeric variants
 * or the feature settings, and the `font` shorthand, which sets both back
 * to normal while it sets a family. */
const NUMERIC_CASCADE = new Set([...NUMERIC, "font"]);
const FEATURES_CASCADE = new Set([...FEATURES, "font"]);
const CODE_NUMERIC_CASCADE = new Set([...CODE_NUMERIC, "font"]);
const CODE_FEATURES_CASCADE = new Set([...CODE_FEATURES, "font"]);
/** The elements the browser sets its own monospace on. */
const MARK_TAGS = /^(code|pre|kbd|samp)$/i;
const FIELD_TAGS = new Set(["input", "textarea", "select"]);
/** Values that set nothing of their own: the parent's holds. */
const KEYWORD = /^(inherit|initial|unset|revert|revert-layer)$/i;
const unquote = (v) => String(v).trim().replace(/^(["'`])([\s\S]*)\1$/, "$2").trim();
const push = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

/** Every value a custom property is given: in a stylesheet, and in code. */
function customValues(model) {
  const out = new Map();
  for (const c of model.customs) push(out, c.prop, c.value);
  for (const c of model.codeCustoms ?? []) for (const v of c.values) push(out, c.prop, v);
  return out;
}

/** Every custom property that resolves to a mono face. */
export function monoAliases(model) {
  const aliases = new Set(MONO_TOKENS);
  const defined = [...customValues(model)].flatMap(([prop, values]) => values.map((value) => ({ prop, value })));
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of defined) {
      if (!aliases.has(c.prop) && isMono(c.value, aliases)) {
        aliases.add(c.prop);
        grew = true;
      }
    }
  }
  return aliases;
}

/** Whether a value can resolve to a mono face. */
export function isMono(value, aliases) {
  if (MONO_WRITTEN.test(value)) return true;
  for (const m of value.matchAll(/var\(\s*(--[-\w]+)/g)) if (aliases.has(m[1])) return true;
  return false;
}

/** Whether a declaration names a mono face at all: a face written out, a
 * mono token or one defined from it, as a value or as the property it
 * defines. */
const namesMono = (prop, value, aliases) => isMono(value, aliases) || (prop.startsWith("--") && aliases.has(prop));

/** Whether a numeric declaration sets digits of one width. */
export function isTabular(prop, value) {
  const v = unquote(value);
  if (NUMERIC.has(prop) || CODE_NUMERIC.has(prop)) return /\btabular-nums\b/i.test(v);
  if (FEATURES.has(prop) || CODE_FEATURES.has(prop)) return /["']tnum["'](?!\s*(?:0|off)\b)/i.test(value) || /^tnum$/i.test(v);
  return false;
}

/** A rule's identity: its file and its selector list, with the at-rules
 * around it when there are any. */
const ruleId = (sel) => `${sel.file} :: ${sel.context ? sel.context + " { " + sel.prelude + " }" : sel.prelude}`;

/**
 * Every mono use, every code mark that falls back to the browser's own
 * monospace, and every use of digits of one width in a model. Returns
 * { uses, marks, unread, ids, aliases, context }: `uses` maps a use's key
 * ("mono :: id" or "digits :: id") to the use, `marks` maps a code mark's
 * element identity to it, `unread` maps a site whose classes cannot be
 * read where they can carry mono or digits ("element :: expression") to
 * it, `ids` names every element, and `context` is what a kind may ask of
 * the model.
 */
export function monoUses(model) {
  const aliases = monoAliases(model);
  const ids = elementIds(model);
  const byId = new Map([...ids].map(([index, id]) => [id, model.elements[index]]));
  const uses = new Map();
  const record = (layer, id, base) => {
    const key = layer + " :: " + id;
    if (!uses.has(key)) uses.set(key, { layer, id, ...base, selectors: [], decls: [], elements: new Map(), inherits: new Map() });
    return uses.get(key);
  };
  const isBox = (el) => el.dom || el.landings.length > 0;
  const textual = (el) => (isBox(el) ? bearsText(model, el) : el.texts.length > 0 || el.exprs.length > 0);
  /** What an element shows as written: its own text and expressions, and
   * for a component call, those of the element its class lands on. */
  const said = (el) => {
    const texts = [...el.texts];
    const exprs = [...el.exprs];
    if (!el.dom) {
      for (const l of el.landings) {
        const t = l.landing === null ? null : model.elements[l.landing];
        if (t && t !== el) {
          texts.push(...t.texts);
          exprs.push(...t.exprs);
        }
      }
    }
    return { texts, exprs };
  };
  const entry = (el) => ({ id: ids.get(el.index), el, text: textual(el), shows: shows(model, el), field: model.tagsOf(el).some((t) => FIELD_TAGS.has(t)), ...said(el) });

  /* The rules that set a property on an element, outside a pseudo-element
   * and a state it passes through, each with what decides between them:
   * the classes and attributes its subject asks for, its specificity, and
   * whether it holds wherever it matches (no media, container, supports or
   * scope around it). A rule in a cascade layer loses to one outside it. */
  const tokenOf = (sel, c) => (sel.module ? "m\t" + sel.file + "\t" + c : "g\t" + c);
  /** One rule's say on a property group, or null when it has none. */
  const ruleOf = (sel, props) => {
    if (sel.subject.pseudoElement) return null;
    const decls = sel.decls.filter((d) => props.has(d.prop));
    if (!decls.length || statesOf(sel.selector).pseudos.length) return null;
    return {
      sel,
      decl: decls.at(-1),
      specificity: specificity(sel.selector),
      tokens: sel.subject.opaque ? [] : [...sel.subject.classes.map((c) => tokenOf(sel, c)), ...sel.subject.globals.map((c) => "g\t" + c)],
      attrs: sel.subject.attrs,
      always: !sel.subject.opaque && !/@(media|container|supports|scope)\b/i.test(sel.context ?? ""),
      layered: /@layer\b/i.test(sel.context ?? ""),
    };
  };
  const indexOf = (props) => {
    const byEl = new Map();
    for (const sel of model.selectors) {
      const rule = ruleOf(sel, props);
      if (rule) for (const el of elementsMatching(model, sel)) push(byEl, el.index, rule);
    }
    return byEl;
  };
  const families = indexOf(FAMILY);
  const numerics = indexOf(NUMERIC_CASCADE);
  const features = indexOf(FEATURES_CASCADE);
  const setsOf = (el) => (el.wears?.length ? el.wears : [[]]);
  const applies = (rule, set) => rule.tokens.every((t) => set.includes(t));
  /** Whether every attribute a rule's subject asks for is written on the
   * element as a literal, so the rule holds for it whenever it applies. */
  const literalOn = (rule, el) =>
    rule.attrs.every((a) => {
      const v = el.attrs.get(a.name);
      return v !== undefined && v !== null && (a.op !== "=" || a.value === null || String(v) === a.value);
    });
  const outranks = (r, rule) => {
    if (r.layered !== rule.layered) return !r.layered;
    const c = cmp(r.specificity, rule.specificity);
    return c > 0 || (c === 0 && r.sel.file === rule.sel.file && r.decl.line > rule.decl.line);
  };
  /** Whether an element keeps what a rule gives it in some set of classes
   * it can wear: the rule's own last word on the property group gives it,
   * and no stronger rule that always holds for it gives another. */
  const keeps = (el, rule, index, same) =>
    same(rule.decl) &&
    setsOf(el).some((set) => applies(rule, set) && !(index.get(el.index) ?? []).some((r) => r !== rule && r.always && applies(r, set) && literalOn(r, el) && outranks(r, rule) && !same(r.decl)));
  /** The code styles set on an element, by property group. */
  const codeOn = new Map();
  for (const cs of model.codeStyles) for (const owner of cs.owners ?? []) push(codeOn, owner.index, cs);
  /** Whether a style set in code takes a property group off an element
   * whatever branch holds: a style set in code outranks every rule but an
   * important one, and this one always holds, with no value that gives
   * what `same` asks for. */
  const codeTakes = (el, codeProps, same) =>
    (codeOn.get(el.index) ?? []).some((cs) => codeProps.has(cs.prop) && cs.when === null && !cs.none && (cs.values?.length ? cs.values : [cs.value]).every((v) => !same({ prop: cs.prop, value: String(v) })));
  /** Whether an element sets a property group of its own at rest: a rule
   * that always holds for it in every set of classes it can wear, or a
   * style set in code that always holds, with a value that is not a
   * keyword (`inherit` takes the parent's). */
  const ownOf = (index, codeProps) => (el) => {
    const rules = (index.get(el.index) ?? []).filter((r) => r.always && literalOn(r, el) && !KEYWORD.test(r.decl.value.trim()));
    if (rules.length && setsOf(el).every((set) => rules.some((r) => applies(r, set)))) return true;
    return (codeOn.get(el.index) ?? []).some((cs) => codeProps.has(cs.prop) && cs.when === null && !cs.none && [cs.value, ...(cs.values ?? [])].every((v) => !KEYWORD.test(unquote(v))));
  };
  const ownFamily = ownOf(families, CODE_FAMILY);
  const ownNumeric = ownOf(numerics, CODE_NUMERIC_CASCADE);
  const ownFeatures = ownOf(features, CODE_FEATURES_CASCADE);
  /** Text inside some elements that takes a property group from them. The
   * browser sets a family on code marks itself, so they stop a family. */
  const inheritedFrom = (roots, own) => {
    const out = new Set();
    descend(model, roots, (el) => {
      if (isBox(el) && own(el)) return false;
      if (textual(el)) out.add(el);
      return true;
    });
    return [...out];
  };
  const isMark = (el) => el.dom && MARK_TAGS.test(el.tag);
  const familyStop = (el) => isMark(el) || ownFamily(el);

  /* Stylesheets: mono declarations and digits of one width. */
  for (const sel of model.selectors) {
    const pseudo = sel.subject.pseudoElement;
    const monoDecls = sel.decls.filter((d) => namesMono(d.prop, d.value, aliases));
    if (monoDecls.length) {
      const u = record("mono", ruleId(sel), { file: sel.file, line: monoDecls[0].line, origin: "css", value: monoDecls.map((d) => `${d.prop}: ${d.value}`).join("; ") });
      u.selectors.push(sel.selector);
      for (const d of monoDecls) if (!u.decls.includes(d)) u.decls.push(d);
      u.rule = sel;
      u.definition = u.decls.every((d) => d.prop.startsWith("--"));
      const lands = u.decls.filter((d) => FAMILY.has(d.prop));
      // A rule that only defines or rebinds a token puts no face on an
      // element: the rules that use the token do, and they are uses here.
      const matched = sel.subject.document || u.definition ? [] : elementsMatching(model, sel);
      // A stronger rule that sets another face, or `inherit`, takes the
      // element off this one, and so does a family set in code; a rule
      // under a state never decides.
      const kept = matched.filter((el) => {
        if (pseudo || !lands.length) return true;
        const same = (d) => namesMono(d.prop, d.value, aliases);
        if (!lands.every((d) => d.important) && codeTakes(el, CODE_FAMILY, same)) return false;
        const own = (families.get(el.index) ?? []).find((r) => r.sel === sel);
        return !own || keeps(el, own, families, same);
      });
      for (const el of kept) u.elements.set(ids.get(el.index), entry(el));
      if (lands.length && !pseudo) for (const el of inheritedFrom(kept, familyStop)) u.inherits.set(ids.get(el.index), entry(el));
    }
    const tabular = sel.decls.filter((d) => isTabular(d.prop, d.value));
    if (tabular.length && !pseudo) {
      const u = record("digits", ruleId(sel), { file: sel.file, line: tabular[0].line, origin: "css", value: tabular.map((d) => `${d.prop}: ${d.value}`).join("; ") });
      u.selectors.push(sel.selector);
      u.decls.push(...tabular);
      u.rule = sel;
      const byFeature = tabular.every((d) => FEATURES.has(d.prop));
      const index = byFeature ? features : numerics;
      const same = (d) => isTabular(d.prop, d.value);
      const matched = sel.subject.document ? [] : elementsMatching(model, sel);
      // A stronger rule, a later `font` shorthand or a style set in code
      // that sets the digits back takes them away.
      const kept = matched.filter((el) => {
        if (!tabular.every((d) => d.important) && codeTakes(el, byFeature ? CODE_FEATURES_CASCADE : CODE_NUMERIC_CASCADE, same)) return false;
        const own = (index.get(el.index) ?? []).find((r) => r.sel === sel);
        return !own || keeps(el, own, index, same);
      });
      for (const el of kept) u.elements.set(ids.get(el.index), entry(el));
      for (const el of inheritedFrom(kept, byFeature ? ownFeatures : ownNumeric)) u.inherits.set(ids.get(el.index), entry(el));
    }
  }

  /* Styles set in code: a family or a custom property that resolves to
   * mono, and digits of one width. */
  const codeLines = new Set();
  const codeId = (cs) => {
    const el = cs.element;
    const where = el ? `${ids.get(el.index).replace(/^.*? :: /, "")} ${cs.keys.join(" > ")}` : cs.keys.join(" > ");
    return `${cs.file} :: ${where}`;
  };
  for (const cs of model.codeStyles) {
    const values = [cs.value, ...(cs.values ?? [])].map(String);
    const family = CODE_FAMILY.has(cs.prop) && values.some((v) => isMono(v, aliases));
    const digits = [...CODE_NUMERIC, ...CODE_FEATURES].includes(cs.prop) && values.some((v) => isTabular(cs.prop, v));
    if (!family && !digits) continue;
    const u = record(family ? "mono" : "digits", codeId(cs), { file: cs.file, line: cs.line, origin: "code", value: `${cs.prop}: ${cs.value}`, keys: cs.keys, when: cs.when });
    if (family) codeLines.add(cs.file + ":" + cs.line);
    u.definition = false;
    const owners = cs.owners?.length ? cs.owners : cs.element ? [cs.element] : [];
    for (const el of owners) u.elements.set(ids.get(el.index), entry(el));
    const stop = family ? familyStop : CODE_FEATURES.has(cs.prop) ? ownFeatures : ownNumeric;
    for (const el of inheritedFrom(owners, stop)) u.inherits.set(ids.get(el.index), entry(el));
  }
  for (const cc of model.codeCustoms ?? []) {
    if (!(aliases.has(cc.prop) || cc.values.some((v) => isMono(v, aliases)))) continue;
    const u = record("mono", `${cc.file} :: ${cc.prop}`, { file: cc.file, line: cc.line, origin: "code", value: `${cc.prop}: ${cc.values.join(" | ")}` });
    codeLines.add(cc.file + ":" + cc.line);
    u.definition = true;
    for (const el of cc.owners ?? []) u.elements.set(ids.get(el.index), entry(el));
  }

  /* Any other line of TypeScript that names a mono face, outside its
   * comments: the font loaders, and whatever the collector does not read
   * as a style. */
  const tokenNamed = (line) => [...line.matchAll(/--[-\w]+/g)].some((m) => aliases.has(m[0]));
  for (const [file, text] of model.sources) {
    if (!/\.tsx?$/.test(file)) continue;
    const lines = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).split("\n");
    const raw = text.split("\n");
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (!(MONO_WRITTEN.test(code) || tokenNamed(code)) || codeLines.has(file + ":" + (i + 1))) return;
      const u = record("mono", `${file} :: ${raw[i].trim()}`, { file, line: i + 1, origin: "line", value: raw[i].trim() });
      u.definition = false;
    });
  }

  /* Code marks the browser sets its own monospace on: no rule gives them a
   * family in every set of classes they can wear, and no style set in code
   * does. */
  const marks = new Map();
  for (const el of model.elements) {
    if (!isMark(el)) continue;
    const rules = families.get(el.index) ?? [];
    const ruled = setsOf(el).every((set) => rules.some((r) => applies(r, set)));
    const coded = (codeOn.get(el.index) ?? []).some((cs) => CODE_FAMILY.has(cs.prop));
    if (ruled || coded) continue;
    const e = entry(el);
    marks.set(e.id, { layer: "mark", id: e.id, file: el.file, line: el.line, el, shows: e.shows });
  }

  for (const u of uses.values()) u.shows = [...u.elements.values(), ...u.inherits.values()].map((e) => e.shows).filter(Boolean);

  /* Elements whose classes cannot be read, where a module those classes
   * can come from sets mono or digits of one width: the modules the
   * expression names, or, when it names none, every module its file
   * imports (and those of the file a constant it cannot read comes from).
   * Such an element could wear a mono rule on a name, or lose its digits,
   * where no other check can see it. */
  const setting = new Set([...uses.values()].filter((u) => u.origin === "css").map((u) => u.file));
  const sheetsOf = (file) => model.files.get(file)?.sheets ?? new Map();
  const unread = new Map();
  for (const u of model.unresolved) {
    if (u.kind !== "class") continue;
    const sheets = sheetsOf(u.file);
    const named = [...sheets].filter(([name]) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(u.text)).map(([, f]) => f);
    const from = /^imported (\S+)/.exec(u.text)?.[1];
    const candidates = named.length ? named : [...sheets.values(), ...(from ? sheetsOf(from).values() : [])];
    const modules = [...new Set(candidates)].filter((f) => setting.has(f)).sort();
    if (!modules.length) continue;
    const id = `${u.element ? ids.get(u.element.index) : u.file} :: ${u.text}`;
    unread.set(id, { layer: "unread", id, file: u.file, line: u.line, text: u.text, modules });
  }

  /** What the kinds may ask of the model. */
  const context = {
    aliases,
    /** A rule by its identity. */
    rule: (id) => {
      const [file, ...rest] = id.split(" :: ");
      const prelude = rest.join(" :: ");
      return model.selectors.find((sel) => sel.file === file && (sel.prelude === prelude || sel.selector === prelude)) ?? null;
    },
    /** Whether an element, or something drawn inside it, is a qualifier
     * written before a name (the owner part of a SQL name). */
    qualified: (el) => {
      const isQualifier = (x) => x.wears.flat().some((t) => /qualif/i.test(t.split("\t").pop()));
      if (isQualifier(el)) return true;
      let found = false;
      descend(model, [el], (d) => {
        if (isQualifier(d)) found = true;
        return !found;
      });
      return found;
    },
    /** Whether a file loads fonts. */
    loadsFonts: (file) => /from\s+["']next\/font\//.test(model.sources.get(file) ?? ""),
    /**
     * Why a rule does not give a code mark its face where its markup is
     * shown, or null when it does. The collector does not follow the
     * markup there (a list it is held in, a function another file calls),
     * so the markup the mark sits in is drawn inside the element `hostId`
     * names for the question, and the rules that set a family on the mark
     * are read there: the rule must reach it, and no stronger rule that
     * always holds may set another face.
     */
    reaches: (sel, mark, hostId) => {
      const host = byId.get(hostId);
      if (!host) return `in names no element: ${hostId}`;
      const tops = new Set();
      const up = (e, depth) => {
        if (!e.parents.length || depth > 24) tops.add(e);
        else for (const p of e.parents) up(model.elements[p], depth + 1);
      };
      up(mark, 0);
      tops.delete(host);
      const saved = { cache: model.matchCache, children: host.children, parents: [...tops].map((t) => t.parents) };
      model.matchCache = new Map();
      host.children = [...host.children, ...[...tops].map((t) => t.index)];
      for (const t of tops) t.parents = [...t.parents, host.index];
      try {
        const here = model.selectors
          .map((s) => ruleOf(s, FAMILY))
          .filter((r) => r && compoundMatches(model, r.sel.subject, mark, r.sel) && elementsMatching(model, r.sel).includes(mark));
        const cited = here.filter((r) => r.sel.file === sel.file && r.sel.prelude === sel.prelude && r.sel.context === sel.context);
        const where = `${ruleId(sel)} does not reach it in ${hostId}`;
        if (!cited.length) return where;
        const index = new Map([[mark.index, here]]);
        const same = (d) => namesMono(d.prop, d.value, aliases);
        return cited.some((r) => keeps(mark, r, index, same)) ? null : `a stronger rule takes its face off it in ${hostId}`;
      } finally {
        model.matchCache = saved.cache;
        host.children = saved.children;
        [...tops].forEach((t, i) => (t.parents = saved.parents[i]));
      }
    },
  };
  return { uses, marks, unread, ids, aliases, context };
}

/* ---- kinds ---- */

/** A name read off a named thing: a dataset, a map, a workflow, a project,
 * a layer, a folder, as an expression shows it. A column's or a
 * parameter's name is not one of these. */
const NAME_READ = /(?:^|[^\w$.?])(?:table|tbl|t|dataset|ds|d|item|it|r|row|entry|listing|snapshot|folder|heading|map|workflow|wf|w|project|layer|member)\??\.name\b(?!\s*\()/;
/** A count, a size, a measure or a time, as the app formats one. */
const FACT_READ = /\b(?:formatCount|formatCompactCount|formatBytes|formatRelativeTime|formatDistance\w*|formatArea\w*|formatTimeMs|formatZoom|featureCountReadout|estimateLabel|timeOf|lastRun|day)\s*\(|\.(?:rowCount|sizeBytes|runtimeMs)\b|\bfmt\.format\(|\.toLocaleString\(/;
/** A geometry kind, as the app names one. */
const KIND_READ = /\b(?:geometryType|geometryLabel|geometryClass|geometryChipLabel|kindWord|spatialLabel|layerKind)\b|(?<![\w$.])geometry(?![\w$])/;
/** A sentence: three words or more, closed by a full stop, a question or
 * an exclamation mark. */
const isSentence = (t) => t.split(/\s+/).filter(Boolean).length >= 3 && /[\p{L}\p{N})][.!?](?=\s|$)/u.test(t.trim());

/** A field a number is typed into: a number input, a numeric keyboard, the
 * kit's number field. A code typed as digits names itself in its
 * placeholder (an EPSG code), and is an identifier, not a quantity. */
const isNumberField = (e) => {
  if (!e.field && e.el.tag !== "NumberInput") return false;
  const type = e.el.attrs.get("type");
  const mode = e.el.attrs.get("inputMode");
  const placeholder = e.el.attrs.get("placeholder");
  if (typeof placeholder === "string" && /\b(?:EPSG|SRID|code)\b/i.test(placeholder)) return false;
  return e.el.tag === "NumberInput" || type === "number" || mode === "numeric" || mode === "decimal";
};

/** The ways an entry can read as something the reading face is for: a
 * named thing's name (unless a qualifier is drawn with it, which makes it
 * the SQL form), a count, size or time, a geometry kind, a number field, a
 * sentence. */
function readings(e, ctx) {
  const out = [];
  if (e.exprs.some((x) => NAME_READ.test(x)) && !ctx?.qualified(e.el)) out.push("name");
  if (e.exprs.some((x) => FACT_READ.test(x))) out.push("fact");
  if (e.exprs.some((x) => KIND_READ.test(x))) out.push("kind");
  if (isNumberField(e)) out.push("number");
  if (e.texts.some(isSentence)) out.push("sentence");
  return out;
}
const SAID = {
  name: "shows a name read as a name",
  fact: "shows a count, a size or a time",
  kind: "shows a geometry kind",
  number: "is a number field",
  sentence: "shows a sentence",
};
/** A kind of code or data: it fails where what it reaches reads as one of
 * the reading face's roles it does not allow. */
const codeOrData = (allow = []) => (use, entries, _row, ctx) => {
  for (const e of entries) {
    const bad = readings(e, ctx).filter((r) => !allow.includes(r));
    if (bad.length) return `${e.id} ${SAID[bad[0]]}: ${e.shows}`;
  }
  return null;
};

/**
 * The kinds a mono row, or a part of one, can have, each a test of what it
 * reaches: a reason it fails, or null when it holds. `entries` are the
 * elements and inherited text the row gives this kind. The kinds of code
 * and data are told apart by the row that names them; what the source can
 * show of each is held here: none of them reaches a name read as a name,
 * a count, size or time, or a geometry kind; only addresses are typed as
 * numbers (a port), only SQL shows a count (a LIMIT), and only code and
 * engine errors reach sentences.
 *
 * @type {Record<string, (use: any, entries: any[], row?: any, ctx?: any) => string | null>}
 */
export const KINDS = {
  /** SQL: the editor's text and its completion list, saved and proposed
   * queries, a SQL parameter. A LIMIT shows its count. */
  sql: codeOrData(["fact"]),
  /** A dataset written as that page's SQL writes it, qualified as the SQL
   * needs; a field never shows one, it creates one. */
  "sql-name": (use, entries, row, ctx) => {
    const field = entries.find((e) => e.field);
    if (field) return `${field.id} is a field; a field that creates a dataset's name is new-dataset-name`;
    return codeOrData()(use, entries, row, ctx);
  },
  /** Column names, column types and cell values where a table's structure
   * or raw data is shown. */
  structure: codeOrData(),
  /** An engine's error, word for word. */
  "engine-error": codeOrData(["sentence"]),
  /** Code to copy as written: commands, configuration, markup, Markdown
   * source. */
  code: codeOrData(["sentence"]),
  /** Identifiers shown as identifiers: API methods, paths and parameter
   * names, operation and model identifiers, a person's SQL name, codes. */
  identifier: codeOrData(),
  /** Addresses and file paths; a port is typed as a number. */
  address: codeOrData(["number"]),
  /** The fields that create a dataset's SQL name: fields, every one. */
  "new-dataset-name"(_use, entries) {
    const other = entries.find((e) => !e.field);
    if (other) return `${other.id} is not a field`;
    return entries.length ? null : "it reaches no field";
  },
  /** The faces themselves: a rule that only defines or rebinds the mono
   * tokens, or a line that loads a face. */
  face(use, _entries, _row, ctx) {
    if (use.origin === "css") return use.definition ? null : "it sets a family on an element, not only a face's token";
    if (use.origin === "line") return ctx?.loadsFonts(use.file) ? null : "the file loads no font";
    return use.definition ? null : "a style set in code sets a family; it defines no face";
  },
  /** A use the rule does not name, which keeps today's face; the row says
   * what it is. It still reaches no name, fact or kind. */
  keeps(use, entries, row, ctx) {
    if (!row?.note) return "a use kept as it is must say what it is (note)";
    return codeOrData()(use, entries, row, ctx);
  },
  /** Mono today, set in the reading face by the rule: a later change
   * moves it, and drops it from the list. The row says what it is. */
  "to-reading-face"(_use, _entries, row) {
    return row?.note ? null : "a use the rule moves must say what it is (note)";
  },
  /** A rule no element wears: a later change deletes it. */
  unused(use) {
    return use.elements.size || use.inherits.size ? "it reaches elements" : null;
  },
};

/** The kinds a code mark that the browser sets its own monospace on can
 * have. `to-mono`: a later change gives it the surface's mono face.
 * `reached`: the collector cannot see the rule that reaches it in the page
 * (markup held in a list, or drawn by a function another file calls), so
 * the row names that rule (`rule`) and the element the markup is shown in
 * (`in`): the rule must exist, ask for the mark's tag, set a mono face,
 * and, with the markup drawn in that element, reach the mark and keep its
 * face there in the cascade. */
const MARK_KINDS = new Set(["to-mono", "reached"]);

/** Kinds that leave the list as the work moves them. */
export const PENDING_KINDS = new Set(["to-reading-face", "unused", "to-mono"]);

/* ---- the lists ---- */

/** A list row's key, the same as its use's. */
export const keyOf = (row) => row.layer + " :: " + row.id;

/** An element's identity, with what it shows when the identity does not
 * already say it. */
const described = (e) => (e.shows && !e.id.includes(e.shows) ? `${e.id} showing ${e.shows}` : e.id);

/** One line on a use that no list names: where it is set and what it reaches. */
function unlisted(use) {
  const where = `${use.origin === "code" ? "set in code" : use.origin === "line" ? "a line" : "a rule"} at ${use.file}:${use.line} (${use.value})`;
  const reached = [...use.elements.values(), ...use.inherits.values()];
  const shown = reached.find((e) => e.text) ?? reached[0];
  if (!shown) return `not listed: ${where}, reaching no element the collector can see`;
  return `not listed: ${where}, reaching ${reached.length} element(s), first ${described(shown)}`;
}

/**
 * Judge a model's uses and code marks against the allowed list.
 *
 * A mono row (`layer: "mono"`) carries a kind the use must still have, and
 * names the elements the use reaches and the text that inherits it, both
 * compared both ways: a new one is growth (a listed mono style put on a new
 * element), a missing one a stale row. Where a row's elements are of more
 * than one kind, `split` gives the others their kind by identity. A row
 * whose use reaches no element says why in `unseen`.
 *
 * A digits row (`layer: "digits"`) names the elements that keep digits of
 * one width and the text that inherits them, both ways: a listed number
 * that loses them, or is gone, fails.
 *
 * A mark row (`layer: "mark"`) names a code mark the browser sets its own
 * monospace on, with its kind; any other such mark fails, and a listed one
 * that gets a family, or is gone, is stale.
 *
 * An unread row (`layer: "unread"`) names an element whose classes cannot
 * be read where a module they can come from sets mono or digits, and says
 * what the classes are (note); any other such site fails, and a listed one
 * that is gone, or can be read now, is stale.
 *
 * Returns findings `{ check, key, message }`, `check` being one of
 * declaration, element, inheritance, kind, list, mark, digits or unread.
 *
 * @param {{ uses: Map<string, any>, marks: Map<string, any>, unread?: Map<string, any>, context: any }} found
 * @param {{ allowed?: any[] }} [lists]
 * @returns {{ check: string, key: string, message: string }[]}
 */
export function judge({ uses, marks, unread = new Map(), context }, { allowed = [] } = {}) {
  const out = [];
  const add = (check, key, message) => out.push({ check, key, message: `${key}: ${message}` });
  const listed = new Set();
  for (const row of allowed) {
    const key = keyOf(row);
    if (listed.has(key)) add("list", key, "listed twice");
    listed.add(key);
  }
  for (const [key, use] of uses) if (!listed.has(key)) add(use.layer === "digits" ? "digits" : "declaration", key, unlisted(use));
  for (const [id, mark] of marks) {
    if (!listed.has("mark :: " + id)) add("mark", "mark :: " + id, `${described(mark)} has no family of its own, so the browser sets its own monospace on it, at its own size`);
  }
  for (const [id, site] of unread) {
    if (!listed.has("unread :: " + id)) add("unread", "unread :: " + id, `its classes cannot be read, and ${site.modules.join(", ")} sets mono or digits of one width; read them, or name the site (${site.file}:${site.line})`);
  }

  const twoWay = (check, key, rows, found, verb) => {
    const named = new Set(rows);
    for (const [id, e] of found) if (!named.has(id)) add(check, key, `${described(e)} ${verb} and is not listed`);
    for (const id of named) if (!found.has(id)) add(check, key, `listed ${id} no longer ${verb}`);
  };
  for (const row of allowed) {
    const key = keyOf(row);
    if (row.layer === "unread") {
      if (!unread.has(row.id)) add("unread", key, "the listed site is gone, can be read now, or draws from no module that sets mono or digits; drop its row");
      else if (!row.note) add("unread", key, "a listed site whose classes cannot be read must say what they are (note)");
      continue;
    }
    if (row.layer === "mark") {
      if (!marks.has(row.id)) {
        add("mark", key, "the listed code mark is gone or has a family of its own now; drop its row");
        continue;
      }
      if (!MARK_KINDS.has(row.kind)) add("mark", key, `no code mark kind is called ${row.kind}`);
      else if (!row.note) add("mark", key, "a listed code mark must say what it is (note)");
      else if (row.kind === "reached") {
        const rule = row.rule ? context.rule(row.rule) : null;
        const tag = marks.get(row.id).el.tag.toLowerCase();
        if (!rule) add("mark", key, `rule names no rule: ${row.rule}`);
        else if (rule.subject.tag !== tag) add("mark", key, `${row.rule} does not ask for <${tag}>`);
        else if (!rule.decls.some((d) => FAMILY.has(d.prop) && isMono(d.value, context.aliases))) add("mark", key, `${row.rule} sets no mono face`);
        else if (!row.in) add("mark", key, "a reached code mark must name the element it is shown in (in)");
        else {
          const why = context.reaches(rule, marks.get(row.id).el, row.in);
          if (why) add("mark", key, why);
        }
      }
      continue;
    }
    const use = uses.get(key);
    if (!use) {
      add(row.layer === "digits" ? "digits" : "list", key, "the allowed row outlives its use");
      continue;
    }
    if (row.layer === "digits") {
      twoWay("digits", key, row.elements ?? [], use.elements, "wears digits of one width from it");
      twoWay("digits", key, row.inherits ?? [], use.inherits, "inherits digits of one width from it");
      if (!use.elements.size && !row.unseen) add("digits", key, "it reaches no element; the row must say why (unseen)");
      if (use.elements.size && row.unseen) add("digits", key, "it reaches elements now; drop its unseen note");
      continue;
    }
    twoWay("element", key, row.elements ?? [], use.elements, "wears it");
    twoWay("inheritance", key, row.inherits ?? [], use.inherits, "inherits it");
    const split = row.split ?? {};
    const reached = new Map([...use.elements, ...use.inherits]);
    for (const id of Object.keys(split)) if (!reached.has(id)) add("kind", key, `split names ${id}, which the use does not reach`);
    const byKind = new Map([[row.kind, []]]);
    for (const [id, e] of reached) {
      if (!e.text && !e.field) continue;
      push(byKind, split[id] ?? row.kind, e);
    }
    for (const [kind, entries] of byKind) {
      const test = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
      if (!test) {
        add("kind", key, `no kind is called ${kind}`);
        continue;
      }
      if (kind !== row.kind && !entries.length) continue;
      const why = test(use, entries, row, context);
      if (why) add("kind", key, `not ${kind}: ${why}`);
    }
    if (!use.elements.size && !row.unseen && row.kind !== "unused" && row.kind !== "face") add("kind", key, "it reaches no element; the row must say why (unseen)");
    if (use.elements.size && row.unseen) add("kind", key, "it reaches elements now; drop its unseen note");
  }
  return out.sort((a, b) => a.message.localeCompare(b.message, "en"));
}

/**
 * The uses the work still has to move: the elements and inherited text
 * listed as moving to the reading face (whole rows and split parts), the
 * rules no element wears, and the code marks still in the browser's
 * monospace. Each move drops its part from the list, and this count with it.
 */
export function pending(allowed) {
  let n = 0;
  for (const row of allowed) {
    if (row.layer === "mark") n += PENDING_KINDS.has(row.kind) ? 1 : 0;
    if (row.layer !== "mono") continue;
    const parts = [...(row.elements ?? []), ...(row.inherits ?? [])];
    if (PENDING_KINDS.has(row.kind)) n += Math.max(parts.filter((id) => !row.split?.[id] || PENDING_KINDS.has(row.split[id])).length, 1);
    else n += Object.values(row.split ?? {}).filter((k) => PENDING_KINDS.has(k)).length;
  }
  return n;
}
