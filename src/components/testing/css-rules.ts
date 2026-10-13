import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HostElement } from "./dom-host";

/**
 * Which stylesheet rule can reach an element mounted in the DOM host, and
 * how strongly, for a test that holds a rule to the element it was written
 * for. The unit suite names a CSS module's class `_<name>_<hash>`, the hash
 * taken from the stylesheet's path, so a rule's `.name` matches only the
 * class its own stylesheet gave out. Enough for descendant selectors whose
 * compounds are an optional tag, classes, `[attr*="value"]` parts and
 * pseudo-classes; any other combinator or attribute form reaches nothing.
 * It computes no style and no cascade: a browser test holds what is drawn.
 */

export type CssRule = { file: string; selector: string; body: string };

/** Every plain rule of a stylesheet (a path from the repository's root),
 * one entry per selector of a list. */
export function cssRules(file: string): CssRule[] {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    for (const selector of m[1].split(",")) {
      out.push({ file, selector: selector.trim().replace(/\s+/g, " "), body: m[2] });
    }
  }
  return out;
}

/** The selector's specificity: ids, then classes, attributes and
 * pseudo-classes, then types and pseudo-elements. */
export function specificity(selector: string): [number, number, number] {
  const attrs = (selector.match(/\[[^\]]*\]/g) ?? []).length;
  let rest = selector.replace(/\[[^\]]*\]/g, "");
  const elements = (rest.match(/::[\w-]+/g) ?? []).length;
  rest = rest.replace(/::[\w-]+/g, "");
  const ids = (rest.match(/#[\w-]+/g) ?? []).length;
  const classes = (rest.match(/\.[\w-]+/g) ?? []).length;
  const pseudos = (rest.match(/:[\w-]+/g) ?? []).length;
  const types = (rest.match(/(?:^|\s)[a-zA-Z][\w-]*/g) ?? []).length;
  return [ids, classes + attrs + pseudos, types + elements];
}

/** Whether `a` is the stronger specificity. */
export function outranks(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The class the unit suite gives `name` from the stylesheet `file`. */
function moduleClass(name: string, file: string): string {
  return `_${name}_${createHash("sha1").update(file).digest("hex").slice(0, 6)}`;
}

function compoundMatches(compound: string, file: string, el: HostElement): boolean {
  if (/[>+~]/.test(compound) || /\[(?![\w-]+\*="[^"]*"\])/.test(compound)) return false;
  const tag = /^[a-zA-Z][\w-]*/.exec(compound)?.[0];
  if (tag && tag.toUpperCase() !== el.tagName.toUpperCase()) return false;
  const classes = el.className.split(/\s+/);
  const plain = compound.replace(/\[[^\]]*\]/g, "");
  for (const [, name] of plain.matchAll(/\.([\w-]+)/g)) {
    if (!classes.includes(moduleClass(name, file))) return false;
  }
  for (const [, attr, value] of compound.matchAll(/\[([\w-]+)\*="([^"]*)"\]/g)) {
    if (!(el.getAttribute(attr) ?? "").includes(value)) return false;
  }
  return true;
}

/**
 * Whether `rule` reaches `target` while `anchor` is in the state the
 * selector's `:<state>` compound names: that compound matches the anchor,
 * each compound before it a further ancestor in order, and the one
 * compound after it the target inside the anchor.
 */
export function reachesInState(
  rule: CssRule,
  state: string,
  anchor: HostElement,
  target: HostElement,
): boolean {
  const compounds = rule.selector.split(" ");
  const k = compounds.findIndex((c) => c.includes(`:${state}`));
  if (k < 0 || compounds.length !== k + 2) return false;
  const matches = (compound: string, el: HostElement) => compoundMatches(compound, rule.file, el);
  if (!matches(compounds[k], anchor) || !matches(compounds[k + 1], target)) return false;
  let inside = false;
  for (let n = target.parentElement; n; n = n.parentElement) if (n === anchor) inside = true;
  if (!inside) return false;
  let up = anchor.parentElement;
  for (let i = k - 1; i >= 0; i--) {
    while (up && !matches(compounds[i], up)) up = up.parentElement;
    if (!up) return false;
    up = up.parentElement;
  }
  return true;
}
