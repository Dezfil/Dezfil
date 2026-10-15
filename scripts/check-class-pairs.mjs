/*
 * The class-pair sweep: elements that take classes from two CSS modules
 * which both set the same property at equal specificity.
 *
 * Within one stylesheet the later rule wins a tie. Across two module
 * stylesheets the tie is decided by which file the page loads last, and a
 * production build merges and orders the module chunks differently from
 * the development server: the same element can be styled one way in
 * development and the other in production. The builder's stage controls
 * once became an in-flow block that swallowed the map's top band that way
 * (the stack's own module set position: relative, the builder's set
 * position: absolute on the same element).
 *
 * The sweep reads every module stylesheet under src/ and every component
 * file, and works out, element by element, which module classes can stand
 * on it together:
 *
 *   - classes written into one element's className from two imported
 *     modules (a template, a concatenation, an array joined, a
 *     conditional's branches kept apart);
 *   - a class handed to a component through a prop that the component
 *     merges with its own class on an element (`className ? \`${s.btn}
 *     ${className}\` : s.btn`), followed through components that pass the
 *     prop on, by name or through a rest spread;
 *   - a class that composes a class from another module.
 *
 * For each pair it compares the rules whose subject carries each class.
 * A pair is a FINDING when two rules of equal specificity, one per module,
 * set the same property (a shorthand and its longhand count) to different
 * values, both selectors being the class alone in the same state (the same
 * pseudo-classes, attributes and pseudo-element, the same at-rule): then
 * whenever the element stands in that state, file order decides. A pair
 * whose two rules apply together only in some states (an ancestor, a
 * different pseudo-class or at-rule at equal specificity) is listed as
 * CONDITIONAL; one whose values agree as SAME, which file order cannot
 * change. Neither fails the run.
 *
 * Not seen: class names built at run time (`styles[name]`), classes from
 * global stylesheets, a component reached through anything but a named
 * import or its own file, and props passed through more than six
 * components.
 *
 * Usage: node scripts/check-class-pairs.mjs [rootDir] [--all] [--json]
 *   exits 1 when there is a finding; --all also prints the SAME pairs;
 *   --json prints the result as JSON.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/* ---- stylesheets ---- */

/** Comments blanked, line breaks kept so lines stay countable. */
const blank = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

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

/** Every style rule of a stylesheet: its selectors, the at-rules around it,
 * its declarations and its line. Grouping at-rules are read through;
 * keyframes, font faces and the like hold no element rules. */
export function parseRules(css) {
  const src = blank(css);
  const rules = [];
  const lineAt = (i) => src.slice(0, i).split("\n").length;
  const walk = (start, end, context) => {
    let head = start;
    for (let i = start; i < end; i += 1) {
      const ch = src[i];
      if (ch === ";" ) {
        head = i + 1;
        continue;
      }
      if (ch !== "{") continue;
      let depth = 1;
      let j = i + 1;
      for (; j < end && depth > 0; j += 1) {
        if (src[j] === "{") depth += 1;
        else if (src[j] === "}") depth -= 1;
      }
      const prelude = src.slice(head, i).trim();
      const at = head + (src.slice(head, i).length - src.slice(head, i).trimStart().length);
      if (prelude.startsWith("@")) {
        if (/^@(media|container|supports|layer|scope)\b/i.test(prelude)) {
          walk(i + 1, j - 1, [...context, prelude.replace(/\s+/g, " ")]);
        }
      } else if (prelude) {
        rules.push({
          selectors: splitTop(prelude, /,/).map((s) => s.replace(/\s+/g, " ")),
          context: context.join(" "),
          decls: declarationsOf(src.slice(i + 1, j - 1)),
          line: lineAt(at),
        });
      }
      i = j - 1;
      head = j;
    }
  };
  walk(0, src.length, []);
  return rules;
}

/** A selector's compounds, split at its top-level combinators. */
function compoundsOf(selector) {
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
function simplesOf(compound) {
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
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

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

/** The subject with one of its classes taken out: its state. */
const stateOf = (subject, cls) => subject.replace(new RegExp(`\\.${cls.replace(/[$\\]/g, "\\$&")}(?![-_a-zA-Z0-9])`), "");

/* Longhands a shorthand sets, where the prefix rule (`margin` sets
 * `margin-top`) does not tell it. */
const LONGHANDS = {
  inset: ["top", "right", "bottom", "left"],
  gap: ["row-gap", "column-gap"],
  "grid-gap": ["row-gap", "column-gap", "grid-row-gap", "grid-column-gap"],
  "place-items": ["align-items", "justify-items"],
  "place-content": ["align-content", "justify-content"],
  "place-self": ["align-self", "justify-self"],
  "flex-flow": ["flex-direction", "flex-wrap"],
  "border-block": ["border-top", "border-bottom"],
  "border-inline": ["border-left", "border-right"],
  "margin-block": ["margin-top", "margin-bottom"],
  "margin-inline": ["margin-left", "margin-right"],
  "padding-block": ["padding-top", "padding-bottom"],
  "padding-inline": ["padding-left", "padding-right"],
  overflow: ["overflow-x", "overflow-y"],
  container: ["container-name", "container-type"],
};
/** Longer names a prefix would wrongly count as part of a shorthand. */
const NOT_LONGHANDS = new Set([
  "border-radius", "border-collapse", "border-spacing", "flex-direction", "flex-wrap", "flex-flow",
  "outline-offset", "overflow-wrap", "font-variant-numeric", "font-feature-settings", "background-blend-mode",
  "grid-auto-flow", "grid-auto-rows", "grid-auto-columns", "text-decoration-skip-ink", "animation-composition",
]);

/** Whether setting one property can set the other. */
export function overlaps(a, b) {
  if (a === b) return true;
  if (a.startsWith("--") || b.startsWith("--")) return false;
  const sets = (short, long) =>
    (LONGHANDS[short] ?? []).some((p) => p === long || overlaps(p, long)) ||
    (long.startsWith(short + "-") && !NOT_LONGHANDS.has(long) && !short.endsWith("-radius"));
  return sets(a, b) || sets(b, a);
}

/** The sides a one-to-four value box shorthand gives each longhand. */
const BOXES = {
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  inset: ["top", "right", "bottom", "left"],
};
/** Two-value shorthands: the first longhand, then the second (the first again when alone). */
const PAIRS = {
  gap: ["row-gap", "column-gap"],
  "place-items": ["align-items", "justify-items"],
  "place-content": ["align-content", "justify-content"],
  "place-self": ["align-self", "justify-self"],
  overflow: ["overflow-x", "overflow-y"],
};
/** The flex shorthand's keyword and one-number forms. */
function flexParts(value) {
  if (value === "none") return ["0", "0", "auto"];
  if (value === "auto") return ["1", "1", "auto"];
  if (value === "initial") return ["0", "1", "auto"];
  if (/^\d+(\.\d+)?$/.test(value)) return [value, "1", "0%"];
  return null;
}

/** What a shorthand sets one of its longhands to, when the value says it plainly. */
function longhandValue(short, value, long) {
  const parts = splitTop(value, /\s/);
  if (BOXES[short]) {
    const at = BOXES[short].indexOf(long);
    if (at < 0 || parts.length > 4) return null;
    const [t, r = t, b = t, l = r] = parts;
    return [t, r, b, l][at];
  }
  if (PAIRS[short]) {
    const at = PAIRS[short].indexOf(long);
    if (at < 0 || parts.length > 2) return null;
    return parts[at] ?? parts[0];
  }
  if (short === "flex") {
    const at = ["flex-grow", "flex-shrink", "flex-basis"].indexOf(long);
    const f = flexParts(value);
    return at >= 0 && f ? f[at] : null;
  }
  return null;
}

/** Whether two overlapping declarations leave the element the same either way. */
function agree(a, b) {
  if (a.prop === b.prop) return a.value === b.value;
  const viaA = longhandValue(a.prop, a.value, b.prop);
  if (viaA !== null) return viaA === b.value;
  const viaB = longhandValue(b.prop, b.value, a.prop);
  return viaB !== null && viaB === a.value;
}

/** Every module stylesheet's rules by class, and what each class composes. */
function readStylesheets(root, files) {
  const byClass = new Map();
  const composes = new Map();
  for (const file of files) {
    for (const rule of parseRules(readFileSync(path.join(root, file), "utf8"))) {
      for (const selector of rule.selectors) {
        const subject = subjectOf(selector);
        for (const cls of subject.classes) {
          const key = file + "\t" + cls;
          if (!byClass.has(key)) byClass.set(key, []);
          byClass.get(key).push({
            selector,
            context: rule.context,
            line: rule.line,
            decls: rule.decls.filter((d) => d.prop !== "composes"),
            specificity: subject.specificity,
            ancestors: subject.ancestors,
            state: stateOf(subject.subject, cls),
          });
        }
        const single = /^\.([-_a-zA-Z0-9]+)$/.exec(selector);
        if (!single) continue;
        for (const d of rule.decls.filter((x) => x.prop === "composes")) {
          const m = /^(.*?)(?:\s+from\s+(["'])(.+)\2)?$/.exec(d.value);
          if (!m || m[3] === "global") continue;
          const from = m[3] ? path.posix.join(path.posix.dirname(file), m[3]) : file;
          const key = file + "\t" + single[1];
          if (!composes.has(key)) composes.set(key, []);
          for (const cls of m[1].trim().split(/\s+/)) composes.get(key).push(from + "\t" + cls);
        }
      }
    }
  }
  return { byClass, composes };
}

/* ---- components ---- */

const CAP = 256;
const EMPTY = [[]];
const union = (...lists) => {
  const seen = new Map();
  for (const list of lists) for (const alt of list) seen.set([...alt].sort().join("\n"), alt);
  return [...seen.values()];
};
function product(lists) {
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

function resolveImport(root, fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.posix.join("src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(fromFile), spec);
  else return null;
  if (base.endsWith(".css")) return base;
  for (const candidate of [base, base + ".tsx", base + ".ts", base + "/index.tsx", base + "/index.ts"]) {
    if (/\.(tsx?|jsx?)$/.test(candidate) && existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

const isComponentName = (name) => /^[A-Z]/.test(name);

/** The function a component is: itself, or the one wrapped by forwardRef or memo. */
function functionOf(node) {
  if (!node) return null;
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (ts.isCallExpression(node)) return node.arguments.map(functionOf).find(Boolean) ?? null;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return functionOf(node.expression);
  return null;
}

/** A component's props as its body reads them: each destructured prop's
 * local name, the rest binding, and a props identifier. */
function bindingsOf(fn) {
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

/** Read one component file: its stylesheet imports, its other imports, its
 * exports, its components, and every element a class can land on. */
function readComponents(root, file) {
  const text = readFileSync(path.join(root, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sheets = new Map();
  const imports = new Map();
  const reexports = new Map();
  const components = new Map();
  const exportsAs = new Map();
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = resolveImport(root, file, statement.moduleSpecifier.text);
      const clause = statement.importClause;
      if (!target || !clause) continue;
      if (target.endsWith(".module.css")) {
        if (clause.name) sheets.set(clause.name.text, target);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) sheets.set(clause.namedBindings.name.text, target);
        continue;
      }
      if (clause.name) imports.set(clause.name.text, { file: target, name: "default" });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = resolveImport(root, file, statement.moduleSpecifier.text);
      if (target && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          reexports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
        }
      } else if (target && !statement.exportClause) reexports.set("*" + target, { file: target, name: "*" });
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const el of statement.exportClause.elements) exportsAs.set(el.name.text, (el.propertyName ?? el.name).text);
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) exportsAs.set("default", statement.expression.text);
  }

  /** Each component defined at the top level, by its local name. */
  for (const statement of source.statements) {
    const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.name && isComponentName(statement.name.text)) {
      components.set(statement.name.text, { fn: statement });
      if (exported) exportsAs.set(isDefault ? "default" : statement.name.text, statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !isComponentName(decl.name.text)) continue;
        const fn = functionOf(decl.initializer);
        if (!fn) continue;
        components.set(decl.name.text, { fn });
        if (exported) exportsAs.set(decl.name.text, decl.name.text);
      }
    } else if (ts.isExportAssignment(statement)) {
      const fn = functionOf(statement.expression);
      if (fn) {
        components.set("default", { fn });
        exportsAs.set("default", "default");
      }
    }
  }

  const landings = [];
  const calls = [];
  let dynamic = 0;

  /** The constants a function and the functions inside it declare, by
   * name (a name declared twice keeps both readings). */
  const constantsOf = (fn) => {
    const consts = new Map();
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const name = node.name.text;
        consts.set(name, consts.has(name) ? [...[consts.get(name)].flat(), node.initializer] : node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    if (fn.body) ts.forEachChild(fn.body, visit);
    return consts;
  };

  /** The class sets an expression can produce. */
  const alts = (node, ctx, seen = new Set()) => {
    if (!node) return EMPTY;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression?.(node)) {
      return alts(node.expression, ctx, seen);
    }
    if (ts.isJsxExpression(node)) return alts(node.expression, ctx, seen);
    if (ts.isTemplateExpression(node)) return product(node.templateSpans.map((span) => alts(span.expression, ctx, seen)));
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) return product([alts(node.left, ctx, seen), alts(node.right, ctx, seen)]);
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return union(EMPTY, alts(node.right, ctx, seen));
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return union(alts(node.left, ctx, seen), alts(node.right, ctx, seen));
      }
      return EMPTY;
    }
    if (ts.isConditionalExpression(node)) return union(alts(node.whenTrue, ctx, seen), alts(node.whenFalse, ctx, seen));
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const owner = node.expression.text;
      if (sheets.has(owner)) return [["m\t" + sheets.get(owner) + "\t" + node.name.text]];
      if (ctx.bindings && (owner === ctx.bindings.whole || owner === ctx.bindings.rest)) return [["p\t" + node.name.text]];
      return EMPTY;
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && sheets.has(node.expression.text)) {
      const arg = node.argumentExpression;
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return [["m\t" + sheets.get(node.expression.text) + "\t" + arg.text]];
      dynamic += 1;
      return EMPTY;
    }
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (ctx.bindings?.props.has(name)) return [["p\t" + ctx.bindings.props.get(name)]];
      if (ctx.consts?.has(name) && !seen.has(name)) {
        const next = new Set([...seen, name]);
        return union(...[ctx.consts.get(name)].flat().map((init) => alts(init, ctx, next)));
      }
      return EMPTY;
    }
    if (ts.isArrayLiteralExpression(node)) {
      return product(node.elements.map((el) => (ts.isSpreadElement(el) ? alts(el.expression, ctx, seen) : alts(el, ctx, seen))));
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
        return product(node.arguments.map((arg) => {
          if (!ts.isObjectLiteralExpression(arg)) return alts(arg, ctx, seen);
          return product(arg.properties.map((p) => (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name) ? union(EMPTY, alts(p.name.expression, ctx, seen)) : EMPTY)));
        }));
      }
      return EMPTY;
    }
    return EMPTY;
  };

  /** Walk a function (or the file's top level) for elements. */
  const scan = (body, component, ctx) => {
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        const attrs = node.attributes.properties;
        const isDom = ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);
        if (isDom) {
          const cls = attrs.find((a) => ts.isJsxAttribute(a) && a.name.getText(source) === "className");
          if (cls?.initializer) landings.push({ component, line: lineOf(node), tag: tag.text, alts: alts(cls.initializer, ctx) });
        } else if (ts.isIdentifier(tag)) {
          const props = new Map();
          let spread = false;
          for (const a of attrs) {
            if (ts.isJsxAttribute(a) && a.initializer) {
              const found = alts(a.initializer, ctx);
              if (found.some((alt) => alt.length)) props.set(a.name.getText(source), found);
            } else if (ts.isJsxSpreadAttribute(a) && ts.isIdentifier(a.expression) && ctx.bindings &&
              (a.expression.text === ctx.bindings.rest || a.expression.text === ctx.bindings.whole)) {
              spread = true;
            }
          }
          if (props.size || spread) calls.push({ component, line: lineOf(node), tag: tag.text, props, spread });
        }
      }
      ts.forEachChild(node, visit);
    };
    // The body itself first: an arrow function without braces returns its
    // element as its body.
    visit(body);
  };

  for (const [name, { fn }] of components) {
    const bindings = bindingsOf(fn);
    components.get(name).bindings = bindings;
    if (fn.body) scan(fn.body, name, { bindings, consts: constantsOf(fn) });
  }
  // Elements outside every top-level component: helpers that draw markup.
  for (const statement of source.statements) {
    const inComponent =
      (ts.isFunctionDeclaration(statement) && statement.name && components.has(statement.name.text)) ||
      (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && components.has(d.name.text) && functionOf(d.initializer))) ||
      (ts.isExportAssignment(statement) && components.has("default"));
    if (!inComponent) scan(statement, null, { bindings: null, consts: new Map() });
  }

  return { file, sheets, imports, reexports, components, exportsAs, landings, calls, dynamic };
}

/* ---- the sweep ---- */

function walk(dir, keep, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

export function sweep(root) {
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  const src = path.join(root, "src");
  const sheetFiles = walk(src, (f) => f.endsWith(".module.css")).map(rel);
  const componentFiles = walk(src, (f) => f.endsWith(".tsx") && !/\.test\.tsx$/.test(f)).map(rel);
  const { byClass, composes } = readStylesheets(root, sheetFiles);
  const files = new Map(componentFiles.map((f) => [f, readComponents(root, f)]));

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
  const calleeOf = (info, tag) => {
    if (info.components.has(tag)) return { file: info.file, name: tag };
    const imported = info.imports.get(tag);
    return imported ? definition(imported.file, imported.name) : null;
  };

  /** One landing's class set with every prop a call hands the component put
   * in its place at once, since props merged onto one element stand there
   * together; each prop's alternatives multiply. */
  const fill = (alt, supplied) => {
    const given = alt.filter((t) => t.startsWith("p\t") && supplied.has(t.slice(2)));
    const own = alt.filter((t) => !given.includes(t));
    return product([[own], ...given.map((t) => supplied.get(t.slice(2)))]);
  };

  /** Where a prop handed to a component lands: each element alternative's
   * own module classes and the props still unbound there, with the path. */
  const memo = new Map();
  const landingsOf = (target, prop, depth = 0) => {
    const key = target.file + "\t" + target.name + "\t" + prop;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, []);
    const info = files.get(target.file);
    const out = [];
    if (info && depth <= 6) {
      const bound = info.components.get(target.name)?.bindings?.bound ?? new Set();
      for (const landing of info.landings.filter((l) => l.component === target.name)) {
        for (const alt of landing.alts) {
          if (alt.includes("p\t" + prop)) out.push({ alt, at: [`${target.file}:${landing.line} <${landing.tag}>`] });
        }
      }
      for (const call of info.calls.filter((c) => c.component === target.name)) {
        const callee = calleeOf(info, call.tag);
        if (!callee) continue;
        const via = [...call.props].filter(([, list]) => list.some((alt) => alt.includes("p\t" + prop))).map(([name]) => name);
        if (call.spread && !bound.has(prop) && !call.props.has(prop)) via.push(prop);
        // A prop passed on through a rest spread keeps its name, so the
        // landing's token for it already stands for this component's prop.
        for (const name of via) {
          for (const inner of landingsOf(callee, name, depth + 1)) {
            for (const alt of fill(inner.alt, call.props)) {
              out.push({ alt, at: [`${target.file}:${call.line} <${call.tag}>`, ...inner.at] });
            }
          }
        }
      }
    }
    memo.set(key, out);
    return out;
  };

  /** Every element's possible class sets, each with where it stands. */
  const elements = [];
  for (const info of files.values()) {
    for (const landing of info.landings) {
      for (const alt of landing.alts) elements.push({ alt, at: [`${info.file}:${landing.line} <${landing.tag}>`] });
    }
    for (const call of info.calls) {
      const callee = calleeOf(info, call.tag);
      if (!callee) continue;
      // A landing two props reach is read once, named after both.
      const seen = new Set();
      for (const prop of call.props.keys()) {
        for (const inner of landingsOf(callee, prop)) {
          const names = [...call.props.keys()].filter((name) => inner.alt.includes("p\t" + name));
          const at = [`${info.file}:${call.line} <${call.tag} ${(names.length ? names : [prop]).join(" ")}>`, ...inner.at];
          const key = at.join(" -> ") + "\n" + [...inner.alt].sort().join("\n");
          if (seen.has(key)) continue;
          seen.add(key);
          for (const alt of fill(inner.alt, call.props)) elements.push({ alt, at });
        }
      }
    }
  }

  /** A class with what it composes, transitively. */
  const expand = (token, seen = new Set()) => {
    if (seen.has(token)) return [];
    seen.add(token);
    const [, file, cls] = token.split("\t");
    const out = [{ token, via: null }];
    for (const target of composes.get(file + "\t" + cls) ?? []) {
      for (const t of expand("m\t" + target, seen)) out.push({ token: t.token, via: t.via ?? token });
    }
    return out;
  };

  const pairs = new Map();
  for (const element of elements) {
    const tokens = new Map();
    for (const t of element.alt.filter((x) => x.startsWith("m\t"))) {
      for (const e of expand(t)) if (!tokens.has(e.token)) tokens.set(e.token, e.via);
    }
    const list = [...tokens.keys()];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [, fileA, clsA] = list[i].split("\t");
        const [, fileB, clsB] = list[j].split("\t");
        if (fileA === fileB) continue;
        const [a, b] = fileA < fileB ? [[fileA, clsA, list[i]], [fileB, clsB, list[j]]] : [[fileB, clsB, list[j]], [fileA, clsA, list[i]]];
        const key = a[0] + "\t" + a[1] + "\t" + b[0] + "\t" + b[1];
        if (!pairs.has(key)) pairs.set(key, { a, b, sites: new Set(), composed: false });
        const pair = pairs.get(key);
        pair.sites.add(element.at.join(" -> "));
        if (tokens.get(a[2]) || tokens.get(b[2])) pair.composed = true;
      }
    }
  }

  const results = [];
  for (const pair of pairs.values()) {
    const rulesA = byClass.get(pair.a[0] + "\t" + pair.a[1]) ?? [];
    const rulesB = byClass.get(pair.b[0] + "\t" + pair.b[1]) ?? [];
    for (const ra of rulesA) {
      for (const rb of rulesB) {
        if (cmp(ra.specificity, rb.specificity) !== 0) continue;
        const always = ra.ancestors === "" && rb.ancestors === "" && ra.state === rb.state && ra.context === rb.context;
        const props = [];
        let differ = false;
        for (const da of ra.decls) {
          for (const db of rb.decls) {
            if (da.important !== db.important || !overlaps(da.prop, db.prop)) continue;
            const same = agree(da, db);
            differ ||= !same;
            props.push({ a: da, b: db, same });
          }
        }
        if (!props.length) continue;
        results.push({
          kind: !differ ? "SAME" : always ? "FINDING" : "CONDITIONAL",
          composed: pair.composed,
          a: { file: pair.a[0], cls: pair.a[1], selector: ra.selector, context: ra.context, line: ra.line },
          b: { file: pair.b[0], cls: pair.b[1], selector: rb.selector, context: rb.context, line: rb.line },
          props,
          sites: [...pair.sites].sort(),
        });
      }
    }
  }
  const order = { FINDING: 0, CONDITIONAL: 1, SAME: 2 };
  results.sort((x, y) => order[x.kind] - order[y.kind] || (x.a.file + x.a.cls + x.b.file + x.b.cls).localeCompare(y.a.file + y.a.cls + y.b.file + y.b.cls, "en"));
  const dynamic = [...files.values()].reduce((n, f) => n + f.dynamic, 0);
  return { results, stats: { sheets: sheetFiles.length, components: componentFiles.length, elements: elements.length, pairs: pairs.size, dynamic } };
}

function describe(r) {
  const side = (s, pick) =>
    `${s.file}:${s.line} ${s.context ? s.context + " " : ""}${s.selector} { ${r.props.filter((p) => !p.same).map((p) => `${p[pick].prop}: ${p[pick].value}`).join("; ") || r.props.map((p) => `${p[pick].prop}: ${p[pick].value}`).join("; ")} }`;
  const lines = [`${r.kind}${r.composed ? " (through composes)" : ""}: .${r.a.cls} and .${r.b.cls}`, `  ${side(r.a, "a")}`, `  ${side(r.b, "b")}`];
  const shown = r.sites.slice(0, 4);
  for (const site of shown) lines.push(`  on ${site}`);
  if (r.sites.length > shown.length) lines.push(`  and ${r.sites.length - shown.length} more element(s)`);
  return lines.join("\n");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  const started = performance.now();
  const { results, stats } = sweep(root);
  const ms = Math.round(performance.now() - started);
  const findings = results.filter((r) => r.kind === "FINDING");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ stats: { ...stats, ms }, results }, null, 2));
  } else {
    for (const r of results.filter((x) => x.kind !== "SAME" || args.includes("--all"))) console.log(describe(r) + "\n");
    const count = (kind) => results.filter((r) => r.kind === kind).length;
    console.log(
      `${findings.length ? "FAIL" : "PASS"} - ${count("FINDING")} finding(s), ${count("CONDITIONAL")} conditional, ${count("SAME")} same-value; ` +
        `${stats.pairs} class pair(s) over ${stats.elements} element class set(s) in ${stats.components} component files and ${stats.sheets} stylesheets` +
        `${stats.dynamic ? `, ${stats.dynamic} class name(s) built at run time not read` : ""}; ${ms} ms`,
    );
  }
  process.exit(findings.length ? 1 : 0);
}
